import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createAcceptanceRouter } from '../../src/acceptance.js';
import { createShiftRouter } from '../../src/shifts.js';
import { createDispatchRouter } from '../../src/dispatch.js';
import { createSchedulingRouter } from '../../src/scheduling.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

parseDisposableRoot(process.env.TEST_DATABASE_URL);

// Synthetic fixtures only.
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = id(1), COOP = id(2), PROVIDER = id(3), OTHER_PROVIDER = id(4), OPERATOR = id(5);
const OTHER_OPERATOR = id(6), OTHER_FARMER = id(7), OTHER_COOP = id(8), HTX = id(9), DUAL = id(10);
const MACHINE = id(20), MACHINE_DUAL = id(21);
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
const ALL_TRUE = { drained: true, mature: true, intakeReady: true };
const ACTORS = {
  [FARMER]: ['farmer'], [OTHER_FARMER]: ['farmer'], [COOP]: ['coop'], [OTHER_COOP]: ['coop'], [HTX]: ['coop'],
  [PROVIDER]: ['provider'], [OTHER_PROVIDER]: ['provider'], [OPERATOR]: ['operator'], [OTHER_OPERATOR]: ['operator'],
  [DUAL]: ['farmer', 'provider'],
};

// TEST SEAM ONLY: bearer token equals a synthetic user ID.
function testAuthenticate(req, res, next) {
  const user = req.get('authorization')?.slice(7);
  if (!ACTORS[user]) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = { id: user, roles: ACTORS[user] };
  return next();
}

const ctx = {};
const servers = [];
let dayCounter = 0;
const nextDay = () => { dayCounter += 1; if (dayCounter > 28) throw new Error('synthetic fixture days exhausted'); return dayCounter; };
const dayAt = (day, hour) => `2026-12-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

async function call(method, path, actor, payload) {
  const headers = { authorization: `Bearer ${actor}` };
  let body;
  if (payload !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(payload); }
  const res = await fetch(`${ctx.url}${path}`, { method, headers, body });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json');
  return { status: res.status, body: isJson && text ? JSON.parse(text) : null, text };
}
const post = (path, payload, actor) => call('POST', path, actor, payload);
const get = (path, actor) => call('GET', path, actor);
const ready = (bookingId, actor = FARMER) => post(`/api/bookings/${bookingId}/readiness`, ALL_TRUE, actor);
const start = (packageId, actor = OPERATOR) => post(`/api/packages/${packageId}/shifts/start`, undefined, actor);
const complete = (shiftId, areaM2, actor = OPERATOR) => post(`/api/shifts/${shiftId}/complete`, { areaM2 }, actor);
const acceptancePath = (bookingId) => `/api/bookings/${bookingId}/acceptance`;

async function consentRecruitment(day, provider = PROVIDER) {
  const job = (await ctx.pool.query(
    "INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ($1, 'Synthetic recruitment', 'Demo', 2, $2, $3) RETURNING id",
    [provider, dayAt(day, 0), dayAt(day, 23)],
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

async function booking(day, { owner = FARMER, coordinator = COOP, area = 10000, total = null } = {}) {
  const field = (await ctx.pool.query(
    "INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'Synthetic field', 'Demo', $2) RETURNING id",
    [owner, area],
  )).rows[0].id;
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT $1, $2, id, $3, $4, 'Synthetic field', $5::int, code, name, data_label, price_per_ha_vnd,
       COALESCE($6::bigint, floor((price_per_ha_vnd::numeric * $5::int + 5000) / 10000)::bigint), $7
       FROM dispatch.services WHERE code = 'tillage-tractor' RETURNING id`,
    [owner, field, dayAt(day, 8), dayAt(day, 12), area, total, coordinator],
  );
  return rows[0].id;
}

// Full chain: grouped package, claimed by provider, readiness, shift started and completed.
async function completedPackage({ bookings = 1, area = 10000, claim = true, owner = FARMER, provider = PROVIDER } = {}) {
  const day = nextDay();
  await consentRecruitment(day, provider);
  const bookingIds = [];
  for (let i = 0; i < bookings; i += 1) bookingIds.push(await booking(day, { area, owner }));
  const created = await post('/api/packages', { bookingIds }, COOP);
  assert.equal(created.status, 201);
  const packageId = created.body.package.id;
  if (claim) {
    const machineId = provider === DUAL ? MACHINE_DUAL : MACHINE;
    const claimed = await post(`/api/packages/${packageId}/claim`, { machineId, operatorId: OPERATOR }, provider);
    assert.equal(claimed.status, 200);
  }
  return { packageId, bookingIds, day };
}

async function completedShift(options) {
  const f = await completedPackage(options);
  for (const bookingId of f.bookingIds) assert.equal((await ready(bookingId, options?.owner ?? FARMER)).status, 200);
  const started = await start(f.packageId);
  assert.equal(started.status, 201);
  const shiftId = started.body.shift.id;
  const done = await complete(shiftId, options?.area ?? 10000);
  assert.equal(done.status, 200);
  return { ...f, shiftId };
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
  app.use(createAcceptanceRouter({ pool, authenticate: testAuthenticate }));
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
  for (const [user, roles] of Object.entries(ACTORS)) {
    await ctx.pool.query('INSERT INTO account.users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [user, `${user}@example.com`, `Synthetic ${roles[0]}`, HASH]);
    for (const role of roles) await ctx.pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user, role]);
  }
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic tractor', 'tractor')",
    [MACHINE, PROVIDER]);
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic tractor', 'tractor')",
    [MACHINE_DUAL, DUAL]);
  ctx.url = await listen(ctx.pool);
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

test('proposal requires completed shift, assigned provider, and area and total within booking limits', async () => {
  const pending = await completedPackage();
  assert.equal((await post(acceptancePath(pending.bookingIds[0]), { areaM2: 100, totalVnd: '1000' }, PROVIDER)).status, 409);

  const f = await completedShift();
  const [b0] = f.bookingIds;
  const body = { areaM2: 10000, totalVnd: '90000' };
  assert.equal((await post(acceptancePath(b0), body, FARMER)).status, 403);
  assert.equal((await post(acceptancePath(b0), body, OTHER_PROVIDER)).status, 404);
  assert.equal((await post(acceptancePath(b0), body, COOP)).status, 403);
  assert.equal((await post(acceptancePath(id(999)), body, PROVIDER)).status, 404);
  for (const bad of [
    { areaM2: 0, totalVnd: '1' }, { areaM2: 10001, totalVnd: '1' }, { areaM2: 1.5, totalVnd: '1' },
    { areaM2: 100, totalVnd: 1 }, { areaM2: 100, totalVnd: '-1' }, { areaM2: 100, totalVnd: '1.5' },
    { areaM2: 100, totalVnd: '900001' }, { areaM2: 10001, totalVnd: '1' }, { areaM2: 100 },
    { areaM2: 100, totalVnd: '1', extra: 1 }, [],
  ]) {
    assert.equal((await post(acceptancePath(b0), bad, PROVIDER)).status, 400);
  }
  const first = await post(acceptancePath(b0), { ...body, note: ' Synthetic ' }, PROVIDER);
  assert.equal(first.status, 201);
  assert.equal(first.body.acceptance.version, 1);
  assert.equal(first.body.acceptance.totalVnd, '90000');
  assert.equal(first.body.acceptance.note, 'Synthetic');
});

test('a proposal is an immutable versioned row, consent is per party and per exact version', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  assert.equal((await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER)).status, 201);
  const v1 = await post(`${path}/1/consent`, {}, FARMER);
  assert.equal(v1.status, 200);
  assert.equal((await post(`${path}/1/consent`, {}, FARMER)).status, 200);
  assert.equal((await post(`${path}/1/consent`, {}, PROVIDER)).status, 200);
  // Coops that are not booking owner or assigned provider are out of scope: 404.
  assert.equal((await post(`${path}/1/consent`, {}, COOP)).status, 404);
  assert.equal((await post(`${path}/1/consent`, {}, HTX)).status, 404);
  assert.equal((await post(`${path}/1/consent`, {}, OTHER_FARMER)).status, 404);
  assert.equal((await post(`${path}/9/consent`, {}, FARMER)).status, 404);

  // Fully consented: a new version is refused.
  assert.equal((await post(path, { areaM2: 8000, totalVnd: '72000' }, PROVIDER)).status, 409);

  const rows = await ctx.pool.query('SELECT version, area_m2 FROM dispatch.acceptances WHERE booking_id=$1 ORDER BY version', [b0]);
  assert.deepEqual(rows.rows.map((r) => [r.version, r.area_m2]), [[1, 9000]]);
});

test('a superseded version keeps its row, its consent cannot be reused, and new version needs unconsented state', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  assert.equal((await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER)).status, 201);
  assert.equal((await post(`${path}/1/consent`, {}, FARMER)).status, 200);
  assert.equal((await post(path, { areaM2: 8000, totalVnd: '72000' }, PROVIDER)).status, 201);
  assert.equal((await post(`${path}/1/consent`, {}, PROVIDER)).status, 409);
  assert.equal((await post(`${path}/2/consent`, {}, FARMER)).status, 200);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.acceptances WHERE booking_id=$1', [b0]), 2);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.acceptance_consents WHERE booking_id=$1', [b0]), 2);
});

test('stale consent with an old version number is refused with 409', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  assert.equal((await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER)).status, 201);
  assert.equal((await post(path, { areaM2: 8000, totalVnd: '72000' }, PROVIDER)).status, 201);
  const stale = await post(`${path}/1/consent`, {}, FARMER);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STALE_VERSION');
});

test('get acceptance returns current proposal and status for owner and provider, 404 for others', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  for (const actor of [FARMER, PROVIDER, COOP]) {
    const res = await get(path, actor);
    assert.equal(res.status, 200);
    assert.equal(res.body.acceptance.version, 1);
    assert.equal(res.body.acceptance.consents.owner, true);
    assert.equal(res.body.acceptance.consents.provider, false);
    assert.equal(res.body.acceptance.agreed, false);
  }
  assert.equal((await get(path, HTX)).status, 404);
  assert.equal((await get(path, OTHER_FARMER)).status, 404);
  assert.equal((await get(path, OTHER_PROVIDER)).status, 404);
});

test('concurrent consent and supersede serialize: no new version after both agree', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  const [consent, supersede] = await Promise.all([
    post(`${path}/1/consent`, {}, PROVIDER),
    post(path, { areaM2: 8000, totalVnd: '72000' }, PROVIDER),
  ]);
  // Serial outcomes only: consent first (200, then supersede 409) or supersede first (201, then consent 409 stale).
  const consentFirst = consent.status === 200 && supersede.status === 409;
  const supersedeFirst = supersede.status === 201 && consent.status === 409 && consent.body.error.code === 'STALE_VERSION';
  assert.ok(consentFirst || supersedeFirst, `consent=${consent.status} supersede=${supersede.status}`);
  const versions = await count('SELECT count(*)::int AS n FROM dispatch.acceptances WHERE booking_id=$1', [b0]);
  assert.equal(versions, consentFirst ? 1 : 2);
});

test('owner equal to assigned provider is a party conflict and cannot propose', async () => {
  const f = await completedShift({ owner: DUAL, provider: DUAL });
  const [b0] = f.bookingIds;
  assert.equal((await post(acceptancePath(b0), { areaM2: 100, totalVnd: '1' }, DUAL)).body.error.code, 'PARTY_CONFLICT');
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.acceptances WHERE booking_id=$1', [b0]), 0);
});

test('payments need both party consents on the current version and a payer that is the owner', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  const pay = `/api/bookings/${b0}/payments`;
  assert.equal((await post(pay, { amountVnd: '1000', reference: 'REF-0001' }, FARMER)).status, 409);
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  assert.equal((await post(pay, { amountVnd: '1000', reference: 'REF-0001' }, FARMER)).status, 409);
  await post(`${path}/1/consent`, {}, PROVIDER);
  assert.equal((await post(pay, { amountVnd: '1000', reference: 'REF-0001' }, PROVIDER)).status, 403);
  assert.equal((await post(pay, { amountVnd: '1000', reference: 'REF-0001' }, OTHER_FARMER)).status, 404);
  const ok = await post(pay, { amountVnd: '1000', reference: 'REF-0001' }, FARMER);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.payment.status, 'REPORTED');
  assert.equal(ok.body.summary.confirmedVnd, '0');
  assert.equal(ok.body.summary.reportedVnd, '1000');
  assert.equal(ok.body.summary.outstandingVnd, '81000');
  assert.equal(ok.body.summary.availableToReportVnd, '80000');
});

test('payment amount is a positive integer string bounded by outstanding minus pending and confirmed', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  const pay = `/api/bookings/${b0}/payments`;
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  await post(`${path}/1/consent`, {}, PROVIDER);
  for (const bad of ['0', '-5', '1.5', 'abc', 1000, '']) {
    assert.equal((await post(pay, { amountVnd: bad, reference: 'REF-BAD-001' }, FARMER)).status, 400);
  }
  assert.equal((await post(pay, { amountVnd: '81001', reference: 'REF-BAD-002' }, FARMER)).status, 409);
  assert.equal((await post(pay, { amountVnd: '50000', reference: 'REF-OK-0001' }, FARMER)).status, 201);
  assert.equal((await post(pay, { amountVnd: '31001', reference: 'REF-OK-0002' }, FARMER)).status, 409);
  assert.equal((await post(pay, { amountVnd: '31000', reference: 'REF-OK-0003' }, FARMER)).status, 201);
});

test('retry with same payload is idempotent, same reference with different payload is a 409', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  const pay = `/api/bookings/${b0}/payments`;
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  await post(`${path}/1/consent`, {}, PROVIDER);
  const first = await post(pay, { amountVnd: '1000', reference: 'REF-RETRY-1' }, FARMER);
  const again = await post(pay, { amountVnd: '1000', reference: 'REF-RETRY-1' }, FARMER);
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.payment.id, first.body.payment.id);
  assert.equal((await post(pay, { amountVnd: '2000', reference: 'REF-RETRY-1' }, FARMER)).status, 409);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.payments WHERE booking_id=$1', [b0]), 1);
});

test('concurrent overclaim is bounded by total, never exceeded', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  const pay = `/api/bookings/${b0}/payments`;
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  await post(`${path}/1/consent`, {}, PROVIDER);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    post(pay, { amountVnd: '10000', reference: `REF-RACE-${String(i).padStart(3, '0')}` }, FARMER)));
  const accepted = results.filter((r) => r.status === 201).length;
  assert.equal(accepted, 8);
  assert.equal(results.filter((r) => r.status === 409).length, 2);
  assert.equal(await count('SELECT COALESCE(SUM(amount_vnd),0)::int AS n FROM dispatch.payments WHERE booking_id=$1', [b0]), 80000);
});

test('payee confirms payment; payer cannot self-confirm; confirm is idempotent and sums are bounded', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  const pay = `/api/bookings/${b0}/payments`;
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  await post(`${path}/1/consent`, {}, PROVIDER);
  const p1 = (await post(pay, { amountVnd: '60000', reference: 'REF-CONF-1' }, FARMER)).body.payment.id;
  assert.equal((await post(`/api/payments/${p1}/confirm`, {}, FARMER)).status, 403);
  assert.equal((await post(`/api/payments/${p1}/confirm`, {}, OTHER_PROVIDER)).status, 404);
  const ok = await post(`/api/payments/${p1}/confirm`, {}, PROVIDER);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.payment.status, 'CONFIRMED');
  assert.equal((await post(`/api/payments/${p1}/confirm`, {}, PROVIDER)).status, 200);
  assert.equal(await count("SELECT count(*)::int AS n FROM dispatch.payment_events WHERE payment_id=$1 AND event_type='PAYMENT_CONFIRMED'", [p1]), 1);
  const p2 = (await post(pay, { amountVnd: '21000', reference: 'REF-CONF-2' }, FARMER)).body.payment.id;
  assert.equal((await post(`/api/payments/${p2}/confirm`, {}, PROVIDER)).status, 200);
  assert.equal((await post(pay, { amountVnd: '1', reference: 'REF-CONF-3' }, FARMER)).status, 409);
  const view = await get(pay, FARMER);
  assert.equal(view.status, 200);
  assert.equal(view.body.summary.confirmedVnd, '81000');
  assert.equal(view.body.summary.outstandingVnd, '0');
  assert.ok(!view.text.includes('REF-CONF'));
});

test('payments read is scoped to owner and provider only, no references exposed', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  const pay = `/api/bookings/${b0}/payments`;
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  await post(`${path}/1/consent`, {}, PROVIDER);
  await post(pay, { amountVnd: '1000', reference: 'REF-VIEW-1' }, FARMER);
  assert.equal((await get(pay, OTHER_FARMER)).status, 404);
  assert.equal((await get(pay, OTHER_PROVIDER)).status, 404);
  const asProvider = await get(pay, PROVIDER);
  assert.equal(asProvider.status, 200);
  assert.ok(!asProvider.text.includes('REF-VIEW-1'));
});

test('acceptance and payment never move booking state or settle; snapshot total unchanged', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  assert.equal((await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER)).status, 201);
  assert.equal((await post(`${path}/1/consent`, {}, FARMER)).status, 200);
  assert.equal((await post(`${path}/1/consent`, {}, PROVIDER)).status, 200);
  assert.equal((await post(`/api/bookings/${b0}/payments`, { amountVnd: '81000', reference: 'REF-SETTLE-1' }, FARMER)).status, 201);
  const row = (await ctx.pool.query('SELECT state, total_vnd FROM dispatch.bookings WHERE id=$1', [b0])).rows[0];
  assert.equal(row.state, 'ASSIGNED');
  // Snapshot total is the booking quote (10000 m2 at 900000 VND/ha), not the agreed amount.
  assert.equal(row.total_vnd, '900000');
  assert.equal(await count("SELECT count(*)::int AS n FROM dispatch.bookings WHERE state='SETTLED'", []), 0);
});

test('acceptance and payment history is append-only at the database', async () => {
  const f = await completedShift();
  const [b0] = f.bookingIds;
  const path = acceptancePath(b0);
  await post(path, { areaM2: 9000, totalVnd: '81000' }, PROVIDER);
  await post(`${path}/1/consent`, {}, FARMER);
  await post(`${path}/1/consent`, {}, PROVIDER);
  const paid = await post(`/api/bookings/${b0}/payments`, { amountVnd: '1000', reference: 'REF-APPEND-1' }, FARMER);
  assert.equal(paid.status, 201);
  await assert.rejects(ctx.pool.query('UPDATE dispatch.acceptances SET area_m2=1 WHERE booking_id=$1', [b0]), { code: '23001' });
  await assert.rejects(ctx.pool.query('DELETE FROM dispatch.acceptance_consents WHERE booking_id=$1', [b0]), { code: '23001' });
  await assert.rejects(ctx.pool.query('UPDATE dispatch.payment_events SET event_type=event_type WHERE payment_id=$1', [paid.body.payment.id]), { code: '23001' });
  await assert.rejects(ctx.pool.query('DELETE FROM dispatch.payments WHERE id=$1', [paid.body.payment.id]), { code: '23001' });
});
