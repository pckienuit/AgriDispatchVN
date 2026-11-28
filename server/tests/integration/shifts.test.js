import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createDispatchRouter } from '../../src/dispatch.js';
import { createSchedulingRouter } from '../../src/scheduling.js';
import { createShiftRouter } from '../../src/shifts.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

// Fail closed at load time: the root URL must be a loopback PostgreSQL URL naming a *_test database.
parseDisposableRoot(process.env.TEST_DATABASE_URL);

// All identities and rows below are synthetic fixtures created by SQL in this file.
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = id(1), COOP = id(2), PROVIDER = id(3), OTHER_PROVIDER = id(4), OPERATOR = id(5);
const OTHER_OPERATOR = id(6), OTHER_FARMER = id(7), OTHER_COOP = id(8);
const MACHINE = id(20);
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
const ALL_TRUE = { drained: true, mature: true, intakeReady: true };
const ACTORS = {
  [FARMER]: ['farmer'], [OTHER_FARMER]: ['farmer'], [COOP]: ['coop'], [OTHER_COOP]: ['coop'],
  [PROVIDER]: ['provider'], [OTHER_PROVIDER]: ['provider'], [OPERATOR]: ['operator'], [OTHER_OPERATOR]: ['operator'],
};

// TEST SEAM ONLY: bearer token equals a synthetic user ID. The parent app supplies real authentication.
function testAuthenticate(req, res, next) {
  const user = req.get('authorization')?.slice(7);
  if (!ACTORS[user]) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = { id: user, roles: ACTORS[user] };
  return next();
}

const ctx = {};
const servers = [];
let dayCounter = 0;
const nextDay = () => {
  dayCounter += 1;
  if (dayCounter > 28) throw new Error('synthetic fixture days exhausted');
  return dayCounter;
};
const dayAt = (day, hour) => `2026-12-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

async function call(method, path, actor, payload) {
  const headers = { authorization: `Bearer ${actor}` };
  let body;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const res = await fetch(`${ctx.url}${path}`, { method, headers, body });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json');
  return { status: res.status, body: isJson && text ? JSON.parse(text) : null, text };
}
const post = (path, payload, actor) => call('POST', path, actor, payload);
const get = (path, actor) => call('GET', path, actor);
const ready = (bookingId, value = ALL_TRUE, actor = FARMER) => post(`/api/bookings/${bookingId}/readiness`, value, actor);
const inspect = (bookingId, payload = { result: 'PASSED' }, actor = COOP) => post(`/api/bookings/${bookingId}/inspections`, payload, actor);
const start = (packageId, actor = OPERATOR) => post(`/api/packages/${packageId}/shifts/start`, undefined, actor);
const shiftAction = (shiftId, action, payload, actor = OPERATOR) => post(`/api/shifts/${shiftId}/${action}`, payload, actor);

async function consent(day) {
  const job = (await ctx.pool.query(
    "INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ($1, 'Synthetic recruitment', 'Demo', 2, $2, $3) RETURNING id",
    [PROVIDER, dayAt(day, 0), dayAt(day, 23)],
  )).rows[0].id;
  const application = (await ctx.pool.query(
    "INSERT INTO dispatch.applications (job_id, operator_id, status) VALUES ($1, $2, 'OFFERED') RETURNING id",
    [job, OPERATOR],
  )).rows[0].id;
  await ctx.pool.query(
    "INSERT INTO dispatch.offers (application_id, job_id, operator_id, status, responded_at) VALUES ($1, $2, $3, 'ACCEPTED', now())",
    [application, job, OPERATOR],
  );
}

// Synthetic booking: own field, tillage service, 10000 m2, same window for every booking of a package.
async function booking(day, { owner = FARMER, coordinator = COOP, start: from = 8, end: to = 12 } = {}) {
  const field = (await ctx.pool.query(
    "INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'Synthetic field', 'Demo', 10000) RETURNING id",
    [owner],
  )).rows[0].id;
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT $1, $2, id, $3, $4, 'Synthetic field', 10000, code, name, data_label, price_per_ha_vnd, price_per_ha_vnd, $5
       FROM dispatch.services WHERE code = 'tillage-tractor' RETURNING id`,
    [owner, field, dayAt(day, from), dayAt(day, to), coordinator],
  );
  return rows[0].id;
}

// Builds a package through the real coop grouping route and, unless claim is false, the real provider claim route.
async function fixture({ bookings = 2, claim = true } = {}) {
  const day = nextDay();
  await consent(day);
  const bookingIds = [];
  for (let i = 0; i < bookings; i += 1) bookingIds.push(await booking(day));
  const created = await post('/api/packages', { bookingIds }, COOP);
  assert.equal(created.status, 201);
  const packageId = created.body.package.id;
  if (claim) {
    const claimed = await post(`/api/packages/${packageId}/claim`, { machineId: MACHINE, operatorId: OPERATOR }, PROVIDER);
    assert.equal(claimed.status, 200);
  }
  return { packageId, bookingIds, day };
}

async function startedFixture(options) {
  const f = await fixture(options);
  for (const bookingId of f.bookingIds) {
    assert.equal((await ready(bookingId)).status, 200);
    assert.equal((await inspect(bookingId)).status, 201);
  }
  const started = await start(f.packageId);
  assert.equal(started.status, 201);
  return { ...f, shiftId: started.body.shift.id };
}

async function count(sql, params) {
  return (await ctx.pool.query(sql, params)).rows[0].n;
}

function listen(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(createDispatchRouter({ pool, authenticate: testAuthenticate }));
  app.use(createSchedulingRouter({ pool, authenticate: testAuthenticate }));
  app.use(createShiftRouter({ pool, authenticate: testAuthenticate }));
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  return once(server, 'listening').then(() => `http://127.0.0.1:${server.address().port}`);
}

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  await migrate(ctx.pool);
  await seedCatalog(ctx.pool);
  const users = [
    [FARMER, 'farmer'], [OTHER_FARMER, 'farmer'], [COOP, 'coop'], [OTHER_COOP, 'coop'],
    [PROVIDER, 'provider'], [OTHER_PROVIDER, 'provider'], [OPERATOR, 'operator'], [OTHER_OPERATOR, 'operator'],
  ];
  for (const [user, role] of users) {
    await ctx.pool.query('INSERT INTO account.users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [user, `${user}@example.com`, `Synthetic ${role}`, HASH]);
    await ctx.pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user, role]);
  }
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic tractor', 'tractor')",
    [MACHINE, PROVIDER]);
  ctx.url = await listen(ctx.pool);
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

test('readiness is owner-only, strict, and keeps every confirmation until the shift starts', async () => {
  const open = await fixture({ claim: false });
  assert.equal((await ready(open.bookingIds[0])).status, 200);
  assert.equal((await post(`/api/bookings/${open.bookingIds[0]}/readiness`, ALL_TRUE, OTHER_FARMER)).status, 404);

  const f = await fixture();
  const [b0] = f.bookingIds;
  const path = `/api/bookings/${b0}/readiness`;
  const before = await get(path, FARMER);
  assert.equal(before.status, 200);
  assert.equal(before.body.readiness, null);
  assert.equal(before.body.canConfirm, true);
  assert.equal((await get(path, OTHER_FARMER)).status, 404);
  assert.equal((await get(path, PROVIDER)).status, 403);
  assert.equal((await post(path, ALL_TRUE, OTHER_FARMER)).status, 404);
  assert.equal((await post(path, ALL_TRUE, COOP)).status, 403);
  assert.equal((await post(path, ALL_TRUE, OTHER_COOP)).status, 403);
  assert.equal((await post(path, ALL_TRUE, PROVIDER)).status, 403);
  assert.equal((await post(`/api/bookings/${id(999)}/readiness`, ALL_TRUE, FARMER)).status, 404);
  assert.equal((await post('/api/bookings/not-a-uuid/readiness', ALL_TRUE, FARMER)).status, 400);
  for (const bad of [{ drained: true, mature: true }, { ...ALL_TRUE, extra: 1 }, { ...ALL_TRUE, mature: 'yes' }, [], { ...ALL_TRUE, operatorId: OPERATOR }]) {
    assert.equal((await post(path, bad, FARMER)).status, 400);
  }
  const first = await post(path, { drained: true, mature: true, intakeReady: false }, FARMER);
  assert.equal(first.status, 200);
  assert.equal(first.body.readiness.intakeReady, false);
  assert.deepEqual((await get(path, FARMER)).body.readiness, first.body.readiness);
  assert.equal((await ready(b0)).body.readiness.intakeReady, true);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.readiness_events WHERE booking_id = $1', [b0]), 2);

  const loose = await booking(nextDay());
  assert.equal((await get(`/api/bookings/${loose}/readiness`, FARMER)).body.canConfirm, false);
  assert.equal((await ready(loose)).status, 409);
  assert.equal((await ready(loose)).body.error.code, 'BOOKING_UNAVAILABLE');
});

test('start needs the assigned operator, a claimed package and every booking ready', async () => {
  const f = await fixture();
  const [b0, b1] = f.bookingIds;
  assert.equal((await start(f.packageId, FARMER)).status, 403);
  assert.equal((await start(f.packageId, OTHER_OPERATOR)).status, 404);
  assert.equal((await start(id(999))).status, 404);
  assert.equal((await start(f.packageId)).body.error.code, 'READINESS_INCOMPLETE');
  assert.equal((await ready(b0)).status, 200);
  assert.equal((await start(f.packageId)).body.error.code, 'READINESS_INCOMPLETE');
  assert.equal((await ready(b1, { drained: true, mature: true, intakeReady: false })).status, 200);
  assert.equal((await start(f.packageId)).body.error.code, 'READINESS_INCOMPLETE');
  assert.equal((await ready(b1)).status, 200);
  assert.equal((await start(f.packageId)).body.error.code, 'FIELD_INSPECTION_REQUIRED');
  assert.equal((await inspect(b0)).status, 201);
  assert.equal((await start(f.packageId)).body.error.code, 'FIELD_INSPECTION_REQUIRED');
  assert.equal((await inspect(b1)).status, 201);
  assert.equal((await start(f.packageId)).status, 201);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.shifts WHERE package_id = $1', [f.packageId]), 1);

  const cancelled = await fixture();
  const cancel = await post(`/api/packages/${cancelled.packageId}/cancel`, { reason: 'Synthetic weather delay' }, COOP);
  assert.equal(cancel.status, 200);
  assert.equal((await start(cancelled.packageId)).body.error.code, 'PACKAGE_NOT_CLAIMED');
  assert.equal((await ready(cancelled.bookingIds[0])).body.error.code, 'BOOKING_UNAVAILABLE');
});

test('competing starts create exactly one shift and readiness freezes once started', async () => {
  const f = await fixture();
  for (const bookingId of f.bookingIds) {
    assert.equal((await ready(bookingId)).status, 200);
    assert.equal((await inspect(bookingId)).status, 201);
  }
  const races = await Promise.all([start(f.packageId), start(f.packageId)]);
  assert.deepEqual(races.map((r) => r.status).sort(), [201, 409]);
  assert.equal(races.find((r) => r.status === 409).body.error.code, 'SHIFT_ALREADY_STARTED');
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.shifts WHERE package_id = $1', [f.packageId]), 1);

  const eventCount = () => count('SELECT count(*)::int AS n FROM dispatch.readiness_events WHERE booking_id = ANY($1::uuid[])', [f.bookingIds]);
  const before = await eventCount();
  const late = await ready(f.bookingIds[0], { drained: false, mature: false, intakeReady: false });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'SHIFT_STARTED');
  assert.equal(await eventCount(), before);
});

test('pause and resume follow RUNNING, PAUSED, RUNNING with strict bodies and append-only events', async () => {
  const f = await startedFixture();
  for (const bad of [{}, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 'Synthetic', operatorId: OPERATOR }, { reason: 5 }]) {
    assert.equal((await shiftAction(f.shiftId, 'pause', bad)).status, 400);
  }
  assert.equal((await shiftAction(f.shiftId, 'resume', {})).body.error.code, 'INVALID_TRANSITION');
  assert.equal((await shiftAction(f.shiftId, 'pause', { reason: 'Synthetic rain' }, COOP)).status, 403);
  assert.equal((await shiftAction(f.shiftId, 'pause', { reason: 'Synthetic rain' }, OTHER_OPERATOR)).status, 404);

  const paused = await shiftAction(f.shiftId, 'pause', { reason: '  Synthetic rain  ' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.shift.status, 'PAUSED');
  assert.equal((await shiftAction(f.shiftId, 'pause', { reason: 'Again' })).body.error.code, 'INVALID_TRANSITION');
  assert.equal((await shiftAction(f.shiftId, 'resume', { spoof: true })).status, 400);
  const resumed = await shiftAction(f.shiftId, 'resume', {});
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.shift.status, 'RUNNING');
  assert.equal((await shiftAction(f.shiftId, 'resume', {})).body.error.code, 'INVALID_TRANSITION');

  const events = (await ctx.pool.query(
    'SELECT event_type, from_state, to_state, actor_id, reason FROM dispatch.shift_events WHERE shift_id = $1 ORDER BY sequence',
    [f.shiftId],
  )).rows;
  assert.deepEqual(events.map((e) => [e.event_type, e.from_state, e.to_state]), [
    ['SHIFT_STARTED', null, 'RUNNING'],
    ['SHIFT_PAUSED', 'RUNNING', 'PAUSED'],
    ['SHIFT_RESUMED', 'PAUSED', 'RUNNING'],
  ]);
  assert.equal(events[1].reason, 'Synthetic rain');
  assert.ok(events.every((e) => e.actor_id === OPERATOR));
  await assert.rejects(ctx.pool.query("UPDATE dispatch.shift_events SET reason = 'edited' WHERE shift_id = $1", [f.shiftId]), /append-only/);
  await assert.rejects(ctx.pool.query('DELETE FROM dispatch.shift_events WHERE shift_id = $1', [f.shiftId]), /append-only/);
});

test('complete records area and note once, repeats are idempotent, and no settlement state changes', async () => {
  const f = await startedFixture(); // two 10000 m2 bookings, so the area ceiling is 20000
  const eventCount = (shiftId) => count('SELECT count(*)::int AS n FROM dispatch.shift_events WHERE shift_id = $1', [shiftId]);
  for (const bad of [{ areaM2: 0 }, { areaM2: '5' }, { areaM2: 1.5 }, { areaM2: 9000, note: '   ' },
    { areaM2: 9000, note: 5 }, { areaM2: 9000, ownerId: OPERATOR }, {}]) {
    assert.equal((await shiftAction(f.shiftId, 'complete', bad)).status, 400);
  }
  // Ceiling uses stored booking areas (2 x 10000 m2), so it is a state conflict, not body validation.
  const over = await shiftAction(f.shiftId, 'complete', { areaM2: 20001 });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'AREA_EXCEEDS_BOOKINGS');
  await shiftAction(f.shiftId, 'pause', { reason: 'Synthetic pause' });
  assert.equal((await shiftAction(f.shiftId, 'complete', { areaM2: 9000 })).body.error.code, 'INVALID_TRANSITION');
  await shiftAction(f.shiftId, 'resume', {});

  const done = await shiftAction(f.shiftId, 'complete', { areaM2: 18000, note: 'Synthetic note' });
  assert.equal(done.status, 200);
  assert.equal(done.body.shift.status, 'COMPLETED');
  assert.equal(done.body.shift.areaM2, 18000);
  assert.equal(done.body.shift.note, 'Synthetic note');
  const before = await eventCount(f.shiftId);
  const repeat = await shiftAction(f.shiftId, 'complete', { areaM2: 18000, note: 'Synthetic note' });
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body, done.body);
  assert.equal((await shiftAction(f.shiftId, 'complete', { areaM2: 17000, note: 'Synthetic note' })).body.error.code, 'SHIFT_ALREADY_COMPLETED');
  assert.equal((await shiftAction(f.shiftId, 'complete', { areaM2: 18000 })).status, 409);
  assert.equal((await shiftAction(f.shiftId, 'pause', { reason: 'Late' })).body.error.code, 'INVALID_TRANSITION');
  assert.equal(await eventCount(f.shiftId), before);

  const g = await startedFixture();
  assert.equal((await shiftAction(g.shiftId, 'complete', { areaM2: 5000 })).status, 200);
  assert.equal((await shiftAction(g.shiftId, 'complete', { areaM2: 5000 })).status, 200);
  assert.equal((await shiftAction(g.shiftId, 'complete', { areaM2: 5000, note: 'Late note' })).status, 409);

  const states = (await ctx.pool.query('SELECT state FROM dispatch.bookings WHERE id = ANY($1::uuid[])', [f.bookingIds])).rows;
  assert.ok(states.every((row) => row.state === 'ASSIGNED'));
  assert.equal((await ctx.pool.query('SELECT status FROM dispatch.packages WHERE id = $1', [f.packageId])).rows[0].status, 'CLAIMED');
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.payments WHERE booking_id = ANY($1::uuid[])', [f.bookingIds]), 0);
});

test('shift reads are limited to the assigned operator, claimed provider and package coop', async () => {
  const f = await startedFixture();
  const url = `/api/shifts/${f.shiftId}`;
  for (const actor of [OPERATOR, COOP, PROVIDER]) {
    const list = await get('/api/shifts', actor);
    assert.equal(list.status, 200);
    assert.ok(list.body.shifts.some((shift) => shift.id === f.shiftId));
    const detail = await get(url, actor);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.shift.events.map((event) => event.eventType), ['SHIFT_STARTED']);
    assert.ok(!detail.text.includes(FARMER));
  }
  for (const actor of [OTHER_OPERATOR, OTHER_PROVIDER, OTHER_COOP]) {
    assert.deepEqual((await get('/api/shifts', actor)).body.shifts, []);
    assert.equal((await get(url, actor)).status, 404);
  }
  assert.equal((await get('/api/shifts', FARMER)).status, 403);
  assert.equal((await get(url, FARMER)).status, 403);
  assert.equal((await get(`/api/shifts/${id(999)}`, OPERATOR)).status, 404);
  assert.equal((await get('/api/shifts/not-a-uuid', OPERATOR)).status, 400);
  assert.equal((await get('/api/shifts?limit=0', OPERATOR)).status, 400);
});

test('a started shift blocks scheduling cancellation at the database and keeps allocations', async () => {
  const f = await startedFixture();
  const cancel = await post(`/api/packages/${f.packageId}/cancel`, { reason: 'Synthetic cancel' }, COOP);
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.error.code, 'SHIFT_ACTIVE');
  await assert.rejects(
    ctx.pool.query("UPDATE dispatch.packages SET status = 'CANCELLED' WHERE id = $1", [f.packageId]),
    { code: '23001' },
  );
  assert.equal((await ctx.pool.query('SELECT status FROM dispatch.packages WHERE id = $1', [f.packageId])).rows[0].status, 'CLAIMED');
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.allocations WHERE package_id = $1 AND released_at IS NULL', [f.packageId]), 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM dispatch.bookings WHERE id = ANY($1::uuid[]) AND state = 'ASSIGNED'", [f.bookingIds]), 2);
});
