import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createBookingRouter } from '../../src/booking.js';
import { createFieldDetailsRouter } from '../../src/field-details.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

parseDisposableRoot(process.env.TEST_DATABASE_URL);

// Synthetic fixtures only.
const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = id(1);
const OTHER_FARMER = id(2);
const COOP = id(3);
const ACTORS = { [FARMER]: ['farmer'], [OTHER_FARMER]: ['farmer'], [COOP]: ['coop'] };
const KEY = 'synthetic-key-0000000001';
const ring = [[105.8, 10], [105.801, 10], [105.801, 10.001], [105.8, 10.001], [105.8, 10]];
const moved = [[105.8, 10], [105.8012, 10], [105.8012, 10.001], [105.8, 10.001], [105.8, 10]];

function testAuthenticate(req, res, next) {
  const user = req.get('authorization')?.slice(7);
  if (!ACTORS[user]) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = { id: user, roles: ACTORS[user] };
  return next();
}

const ctx = {};
const servers = [];

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(method, path, actor, payload, headers = {}) {
  const out = { ...headers };
  if (actor) out.authorization = `Bearer ${actor}`;
  let body;
  if (payload !== undefined) {
    out['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const res = await fetch(`${ctx.url}${path}`, { method, headers: out, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cache: res.headers.get('cache-control') };
}

async function field(owner, name = 'Synthetic paddy') {
  return (await ctx.pool.query(
    "INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, $2, 'An Giang', 12000) RETURNING id",
    [owner, name],
  )).rows[0].id;
}

function bookingBody(fieldId, serviceId, extra = {}) {
  return {
    fieldId,
    serviceId,
    startAt: '2026-12-10T08:00:00Z',
    endAt: '2026-12-10T12:00:00Z',
    ...extra,
  };
}

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  await migrate(ctx.pool);
  await seedCatalog(ctx.pool);
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(createFieldDetailsRouter({ pool: ctx.pool, authenticate: testAuthenticate }));
  app.use(createBookingRouter({ pool: ctx.pool, authenticate: testAuthenticate }));
  ctx.url = await listen(app);
  ctx.service = (await ctx.pool.query("SELECT id FROM dispatch.services WHERE code = 'harvest-combine'")).rows[0].id;
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

test('booking stores optional crop facts as calendar dates and rejects invalid ones at the boundary', async () => {
  const fieldId = await field(FARMER);
  const cropBody = bookingBody(fieldId, ctx.service, { cropVariety: 'OM5451', sowDate: '2026-08-01', harvestDate: '2026-11-30' });
  const created = await call('POST', '/api/bookings', FARMER, cropBody, { 'Idempotency-Key': KEY });
  assert.equal(created.status, 201);
  assert.equal(created.body.booking.cropVariety, 'OM5451');
  assert.equal(created.body.booking.sowDate, '2026-08-01', 'DATE returns as calendar text, no timezone shift');
  assert.equal(created.body.booking.harvestDate, '2026-11-30');
  assert.equal(created.body.booking.totalVnd, '1440000', 'price and total unchanged by harvest facts');

  const read = await call('GET', `/api/bookings/${created.body.booking.id}`, FARMER);
  assert.equal(read.status, 200);
  assert.equal(read.body.booking.sowDate, '2026-08-01');
  assert.equal(read.body.booking.harvestDate, '2026-11-30');

  const plainField = await field(FARMER, 'Synthetic plain');
  const plain = await call('POST', '/api/bookings', FARMER, bookingBody(plainField, ctx.service), { 'Idempotency-Key': 'synthetic-key-0000000002' });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.booking.cropVariety, null);
  assert.equal(plain.body.booking.sowDate, null);
  assert.equal(plain.body.booking.harvestDate, null);

  for (const extra of [{ sowDate: '2026-02-30' }, { sowDate: '2026-12-01', harvestDate: '2026-11-01' }, { cropVariety: 'x'.repeat(81) }, { surprise: 1 }]) {
    const res = await call('POST', '/api/bookings', FARMER, bookingBody(fieldId, ctx.service, extra), { 'Idempotency-Key': `synthetic-key-bad-${JSON.stringify(extra).length}` });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  const count = (await ctx.pool.query('SELECT count(*)::int AS n FROM dispatch.bookings WHERE field_id = $1', [fieldId])).rows[0].n;
  assert.equal(count, 1, 'rejected crop facts create no booking');
});

test('same idempotency key replays the booking, but different crop facts conflict instead of silently replaying', async () => {
  const fieldId = await field(FARMER, 'Synthetic retry');
  const key = 'synthetic-key-retry-0001';
  const first = await call('POST', '/api/bookings', FARMER, bookingBody(fieldId, ctx.service, { cropVariety: 'OM18' }), { 'Idempotency-Key': key });
  assert.equal(first.status, 201);

  const replay = await call('POST', '/api/bookings', FARMER, bookingBody(fieldId, ctx.service, { cropVariety: 'OM18' }), { 'Idempotency-Key': key });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.booking.id, first.body.booking.id);

  const changed = await call('POST', '/api/bookings', FARMER, bookingBody(fieldId, ctx.service, { cropVariety: 'ST25' }), { 'Idempotency-Key': key });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const omitted = await call('POST', '/api/bookings', FARMER, bookingBody(fieldId, ctx.service), { 'Idempotency-Key': key });
  assert.equal(omitted.status, 409, 'dropping a crop fact on retry is a different request');
  const rows = (await ctx.pool.query('SELECT count(*)::int AS n FROM dispatch.bookings WHERE field_id = $1', [fieldId])).rows[0].n;
  assert.equal(rows, 1);
});

test('booking owner scope hides other farmers bookings and coop cannot create bookings', async () => {
  const fieldId = await field(FARMER, 'Synthetic scoped');
  const created = await call('POST', '/api/bookings', FARMER, bookingBody(fieldId, ctx.service, { cropVariety: 'OM5451' }), { 'Idempotency-Key': 'synthetic-key-scope-0001' });
  const bookingId = created.body.booking.id;
  assert.equal((await call('GET', `/api/bookings/${bookingId}`, OTHER_FARMER)).status, 404);
  const coopCreate = await call('POST', '/api/bookings', COOP, bookingBody(fieldId, ctx.service), { 'Idempotency-Key': 'synthetic-key-coop-0001' });
  assert.equal(coopCreate.status, 404, 'field is owned by another actor, so the same 404 hides it');
});

test('field boundary requires active consent, stays owner-only, and withdrawal clears coordinates but keeps area', async () => {
  const fieldId = await field(FARMER, 'Synthetic boundary');
  const path = `/api/fields/${fieldId}/details`;

  const noConsent = await call('PUT', path, FARMER, { coordinates: ring });
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.body.error.code, 'LOCATION_CONSENT_REQUIRED');

  const consent = await call('POST', '/api/location-consent', FARMER, { consent: true, version: 'field-boundary-v1' });
  assert.equal(consent.status, 201);
  assert.equal(consent.cache, 'no-store');

  const saved = await call('PUT', path, FARMER, { coordinates: ring });
  assert.equal(saved.status, 200);
  const areaBefore = saved.body.field.area_m2;
  assert.ok(areaBefore > 12000 && areaBefore < 12400, `derived area ${areaBefore}`);
  assert.equal((await ctx.pool.query('SELECT area_m2 FROM dispatch.fields WHERE id = $1', [fieldId])).rows[0].area_m2, areaBefore);

  const details = await call('GET', path, FARMER);
  assert.deepEqual(details.body.details.coordinates, ring);
  assert.equal(details.body.details.locationConsent, true);

  // Another farmer cannot read or write the boundary of a field they do not own.
  const foreignRead = await call('GET', path, OTHER_FARMER);
  assert.equal(foreignRead.status, 404);
  assert.equal((await call('PUT', path, OTHER_FARMER, { coordinates: moved })).status, 404);
  assert.equal((await call('GET', '/api/location-consent', OTHER_FARMER)).body.consent, null);
  const coopRead = await call('GET', path, COOP);
  assert.equal(coopRead.status, 403, 'only farmers may read boundaries');

  // Edit the saved boundary, then withdraw consent.
  const edited = await call('PUT', path, FARMER, { coordinates: moved });
  assert.equal(edited.status, 200);
  assert.notEqual(edited.body.field.area_m2, areaBefore, 'edited ring recomputes area');
  const editedArea = edited.body.field.area_m2;

  const withdrawn = await call('DELETE', '/api/location-consent', FARMER);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.withdrawn, true);
  const after = await call('GET', path, FARMER);
  assert.equal(after.body.details.coordinates, null);
  assert.equal(after.body.details.locationConsent, false);
  assert.equal(after.body.details.areaM2, editedArea, 'area survives withdrawal');
  assert.equal((await ctx.pool.query('SELECT boundary FROM dispatch.fields WHERE id = $1', [fieldId])).rows[0].boundary, null);

  assert.equal((await call('PUT', path, FARMER, { coordinates: ring })).body.error.code, 'LOCATION_CONSENT_REQUIRED', 'writes stay blocked after withdrawal');
  const reconsent = await call('POST', '/api/location-consent', FARMER, { consent: true, version: 'field-boundary-v1' });
  assert.equal(reconsent.status, 201);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM dispatch.location_consents WHERE owner_id = $1', [FARMER])).rows[0].n, 1, 'one consent row per owner');
});

test('access-only update leaves boundary and area untouched and rejects bad enums', async () => {
  const fieldId = await field(FARMER, 'Synthetic access');
  const path = `/api/fields/${fieldId}/details`;
  const access = { roadWidthM: 2.5, bridgeLoadT: 4, soil: 'soft', hasBoatDock: false };
  const ok = await call('PUT', path, FARMER, { access });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.field.area_m2, 12000);
  const details = await call('GET', path, FARMER);
  assert.deepEqual(details.body.details.access, access);
  assert.equal(details.body.details.coordinates, null);
  assert.equal((await call('PUT', path, FARMER, { access: { ...access, soil: 'rock' } })).body.error.code, 'VALIDATION_FAILED');
  assert.equal((await call('PUT', path, OTHER_FARMER, { access })).status, 404);
});
