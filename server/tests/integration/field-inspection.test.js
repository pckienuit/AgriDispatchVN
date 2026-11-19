import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import express from 'express';
import { createDispatchRouter } from '../../src/dispatch.js';
import { createSchedulingRouter } from '../../src/scheduling.js';
import { createShiftRouter } from '../../src/shifts.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

// H-04 HTX field inspection gate. Fail closed at load time: the root URL must be a loopback *_test database.
parseDisposableRoot(process.env.TEST_DATABASE_URL);

// All identities and rows below are synthetic fixtures created by SQL in this file.
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = id(1), COOP = id(2), PROVIDER = id(3), OTHER_PROVIDER = id(4), OPERATOR = id(5);
const OTHER_OPERATOR = id(6), OTHER_FARMER = id(7), OTHER_COOP = id(8), MACHINE = id(20);
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
const ALL_TRUE = { drained: true, mature: true, intakeReady: true };
const PASS = { result: 'PASSED' };
const FAIL = (reason = 'Synthetic: đường vào hẹp') => ({ result: 'FAILED', reason });
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
  return dayCounter;
};
// Day n of December 2026 (UTC), continuing into January for larger n. Each package gets its own day so
// machine and operator allocations never overlap across fixtures.
const at = (day, hour) => new Date(Date.UTC(2026, 11, day, hour)).toISOString();

async function request(base, method, path, actor, payload) {
  const headers = actor ? { authorization: `Bearer ${actor}` } : {};
  let body;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json');
  return { status: res.status, body: isJson && text ? JSON.parse(text) : null, text };
}
const call = (method, path, actor, payload) => request(ctx.url, method, path, actor, payload);
const get = (path, actor) => call('GET', path, actor);
const post = (path, payload, actor) => call('POST', path, actor, payload);
const ready = (bookingId, value = ALL_TRUE, actor = FARMER) => post(`/api/bookings/${bookingId}/readiness`, value, actor);
const inspect = (bookingId, body = PASS, actor = COOP) => post(`/api/bookings/${bookingId}/inspections`, body, actor);
const inspections = (bookingId, actor = COOP) => get(`/api/bookings/${bookingId}/inspections`, actor);
const start = (packageId, actor = OPERATOR) => post(`/api/packages/${packageId}/shifts/start`, undefined, actor);
const shiftAction = (shiftId, action, payload, actor = OPERATOR) => post(`/api/shifts/${shiftId}/${action}`, payload, actor);

async function count(sql, params, db = ctx.pool) {
  return (await db.query(sql, params)).rows[0].n;
}

async function consent(day) {
  const job = (await ctx.pool.query(
    "INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ($1, 'Synthetic recruitment', 'Demo', 2, $2, $3) RETURNING id",
    [PROVIDER, at(day, 0), at(day, 23)],
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

// Synthetic booking: own field, tillage service, 10000 m2, coordinated by COOP unless overridden.
async function booking(day, { owner = FARMER, coordinator = COOP } = {}) {
  const field = (await ctx.pool.query(
    "INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'Synthetic field', 'Demo', 10000) RETURNING id",
    [owner],
  )).rows[0].id;
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT $1, $2, id, $3, $4, 'Synthetic field', 10000, code, name, data_label, price_per_ha_vnd, price_per_ha_vnd, $5
       FROM dispatch.services WHERE code = 'tillage-tractor' RETURNING id`,
    [owner, field, at(day, 8), at(day, 12), coordinator],
  );
  return rows[0].id;
}

// Builds a package through the real coop grouping route and the real provider claim route.
async function fixture({ bookings = 2 } = {}) {
  const day = nextDay();
  await consent(day);
  const bookingIds = [];
  for (let i = 0; i < bookings; i += 1) bookingIds.push(await booking(day));
  const created = await post('/api/packages', { bookingIds }, COOP);
  assert.equal(created.status, 201);
  const packageId = created.body.package.id;
  const claimed = await post(`/api/packages/${packageId}/claim`, { machineId: MACHINE, operatorId: OPERATOR }, PROVIDER);
  assert.equal(claimed.status, 200);
  return { packageId, bookingIds };
}

// Farmer readiness and HTX pass for every booking, then the real start route.
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

function serve(pool, mount) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  mount(app, pool);
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  return once(server, 'listening').then(() => `http://127.0.0.1:${server.address().port}`);
}

const mountAll = (app, pool) => {
  app.use(createDispatchRouter({ pool, authenticate: testAuthenticate }));
  app.use(createSchedulingRouter({ pool, authenticate: testAuthenticate }));
  app.use(createShiftRouter({ pool, authenticate: testAuthenticate }));
};

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
  ctx.url = await serve(ctx.pool, mountAll);
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

test('HTX inspection is recorded only by the package coop, after farmer readiness, with strict bodies', async () => {
  const f = await fixture();
  const [b0] = f.bookingIds;
  // The HTX inspects a declared field: no farmer readiness yet means nothing to assess.
  assert.equal((await inspect(b0)).body.error.code, 'READINESS_MISSING');
  assert.equal((await ready(b0)).status, 200);
  for (const actor of [FARMER, OTHER_FARMER, OPERATOR, PROVIDER]) assert.equal((await inspect(b0, PASS, actor)).status, 403);
  assert.equal((await inspect(b0, PASS, OTHER_COOP)).status, 404);
  assert.equal((await inspect(id(999))).status, 404);
  assert.equal((await post('/api/bookings/not-a-uuid/inspections', PASS, COOP)).status, 400);
  for (const bad of [{}, { result: 'MAYBE' }, { result: 'FAILED' }, { result: 'FAILED', reason: '   ' },
    { result: 'FAILED', reason: 'x'.repeat(501) }, { result: 'PASSED', reason: 5 }, { ...PASS, extra: 1 },
    { ...PASS, reviewerId: OTHER_COOP }, [], 'PASSED']) {
    assert.equal((await inspect(b0, bad)).status, 400);
  }

  const ok = await inspect(b0);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.inspection.result, 'PASSED');
  assert.equal(ok.body.inspection.reason, null);
  assert.equal(ok.body.inspection.reviewerName, 'Synthetic coop');
  assert.equal(ok.body.inspection.bookingId, b0);
  const rows = (await ctx.pool.query('SELECT reviewer_id, package_id FROM dispatch.field_inspections WHERE booking_id = $1', [b0])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reviewer_id, COOP);
  assert.equal(rows[0].package_id, f.packageId);
});

test('start needs a current HTX pass for every booking; FAILED blocks and explicit re-inspection clears it', async () => {
  const f = await fixture();
  const [b0, b1] = f.bookingIds;
  for (const bookingId of f.bookingIds) assert.equal((await ready(bookingId)).status, 200);
  assert.equal((await start(f.packageId)).body.error.code, 'INSPECTION_INCOMPLETE');

  assert.equal((await inspect(b0)).status, 201);
  assert.equal((await start(f.packageId)).body.error.code, 'INSPECTION_INCOMPLETE');
  const operatorView = (await get('/api/shift-packages', OPERATOR)).body.packages.find((p) => p.id === f.packageId);
  assert.equal(operatorView.ready, true);
  assert.equal(operatorView.inspected, false);

  assert.equal((await inspect(b1, FAIL())).status, 201);
  assert.equal((await start(f.packageId)).body.error.code, 'INSPECTION_INCOMPLETE');
  const failed = await inspections(b1, FARMER);
  assert.equal(failed.body.passed, false);
  assert.equal(failed.body.latest.result, 'FAILED');
  assert.equal(failed.body.latest.reason, 'Synthetic: đường vào hẹp');

  assert.equal((await inspect(b1)).status, 201);
  assert.equal((await inspections(b1)).body.passed, true);
  assert.deepEqual((await inspections(b1)).body.history.map((row) => row.result), ['PASSED', 'FAILED']);
  assert.equal((await get('/api/shift-packages', OPERATOR)).body.packages.find((p) => p.id === f.packageId).inspected, true);
  assert.equal((await start(f.packageId)).status, 201);
});

test('farmer readiness stays independent of HTX, and any later readiness edit makes a pass stale', async () => {
  const f = await fixture();
  const [b0, b1] = f.bookingIds;
  assert.equal((await ready(b0)).status, 200);
  assert.equal((await ready(b1)).status, 200);
  assert.equal((await inspect(b0, FAIL())).status, 201);
  // Farmer can still confirm readiness while HTX has failed the field; the HTX record is not overwritten.
  assert.equal((await ready(b0)).status, 200);
  assert.equal((await get(`/api/bookings/${b0}/readiness`, FARMER)).body.readiness.drained, true);
  assert.equal((await inspections(b0, FARMER)).body.latest.result, 'FAILED');

  assert.equal((await inspect(b0)).status, 201);
  assert.equal((await inspect(b1)).status, 201);
  assert.equal((await inspections(b0)).body.passed, true);
  assert.equal((await ready(b0, { ...ALL_TRUE, intakeReady: false })).status, 200);
  assert.equal((await start(f.packageId)).body.error.code, 'READINESS_INCOMPLETE');
  assert.equal((await ready(b0)).status, 200);
  // The same flags as before are a new readiness event, so the earlier PASS no longer matches.
  assert.equal((await inspections(b0)).body.passed, false);
  assert.equal((await start(f.packageId)).body.error.code, 'INSPECTION_INCOMPLETE');

  assert.equal((await inspect(b0)).status, 201);
  assert.equal((await start(f.packageId)).status, 201);
});

test('a schedule change after HTX pass makes the pass stale until re-inspection', async () => {
  const f = await fixture();
  for (const bookingId of f.bookingIds) {
    assert.equal((await ready(bookingId)).status, 200);
    assert.equal((await inspect(bookingId)).status, 201);
  }
  // Stands in for an applied postponement, which changes the package window. Postponement routes have their own suite.
  await ctx.pool.query("UPDATE dispatch.packages SET window_start_at = window_start_at + interval '1 hour' WHERE id = $1", [f.packageId]);
  assert.equal((await start(f.packageId)).body.error.code, 'INSPECTION_INCOMPLETE');
  assert.equal((await inspections(f.bookingIds[0])).body.passed, false);
  for (const bookingId of f.bookingIds) assert.equal((await inspect(bookingId)).status, 201);
  assert.equal((await start(f.packageId)).status, 201);
});

test('a started shift refuses new inspections, keeps its earlier pass, and pause/resume still work', async () => {
  const f = await startedFixture();
  const [b0] = f.bookingIds;
  assert.equal((await inspect(b0, FAIL())).body.error.code, 'SHIFT_STARTED');
  await assert.rejects(
    ctx.pool.query(
      `INSERT INTO dispatch.field_inspections (booking_id, package_id, reviewer_id, result, reason, readiness_sequence, window_start_at, window_end_at)
       SELECT $1, pb.package_id, $2, 'FAILED', 'Synthetic', (SELECT max(sequence) FROM dispatch.readiness_events WHERE booking_id = $1),
              p.window_start_at, p.window_end_at
         FROM dispatch.package_bookings pb JOIN dispatch.packages p ON p.id = pb.package_id WHERE pb.booking_id = $1`,
      [b0, COOP],
    ),
    { code: '23001' },
  );
  const read = await inspections(b0);
  assert.equal(read.status, 200);
  assert.equal(read.body.canInspect, false);
  assert.equal(read.body.passed, true);
  assert.equal(read.body.latest.result, 'PASSED');
  assert.equal((await shiftAction(f.shiftId, 'pause', { reason: 'Synthetic rain' })).status, 200);
  assert.equal((await shiftAction(f.shiftId, 'resume', {})).status, 200);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.field_inspections WHERE package_id = $1', [f.packageId]), 2);
});

test('start and HTX inspection serialize on the package lock; the outcome is always one consistent state', async () => {
  for (let round = 0; round < 3; round += 1) {
    const f = await fixture();
    for (const bookingId of f.bookingIds) {
      assert.equal((await ready(bookingId)).status, 200);
      assert.equal((await inspect(bookingId)).status, 201);
    }
    const [started, late] = await Promise.all([start(f.packageId), inspect(f.bookingIds[0], FAIL())]);
    const shifts = await count('SELECT count(*)::int AS n FROM dispatch.shifts WHERE package_id = $1', [f.packageId]);
    if (started.status === 201) {
      assert.equal(late.status, 409);
      assert.equal(late.body.error.code, 'SHIFT_STARTED');
      assert.equal(shifts, 1);
    } else {
      // Inspection won the lock: the start must see the fresh FAILED result.
      assert.equal(started.status, 409);
      assert.equal(started.body.error.code, 'INSPECTION_INCOMPLETE');
      assert.equal(late.status, 201);
      assert.equal(shifts, 0);
    }
  }
});

test('inspection reads show the farmer owner and the package coop only, with no reviewer ID for the farmer', async () => {
  const f = await fixture({ bookings: 1 });
  const [b0] = f.bookingIds;
  assert.equal((await ready(b0)).status, 200);
  assert.equal((await inspect(b0, FAIL('Synthetic: đất chưa cứng'))).status, 201);
  const url = `/api/bookings/${b0}/inspections`;

  const owner = await get(url, FARMER);
  assert.equal(owner.status, 200);
  assert.equal(owner.body.canInspect, false);
  assert.equal(owner.body.latest.result, 'FAILED');
  assert.ok(!owner.text.includes(COOP));
  assert.equal((await get(url, OTHER_FARMER)).status, 404);

  const coop = await get(url, COOP);
  assert.equal(coop.status, 200);
  assert.equal(coop.body.canInspect, true);
  assert.equal((await get(url, OTHER_COOP)).status, 404);
  for (const actor of [OPERATOR, PROVIDER]) assert.equal((await get(url, actor)).status, 403);
  assert.equal((await get(`/api/bookings/${id(999)}/inspections`, FARMER)).status, 404);
  assert.equal((await get('/api/bookings/not-a-uuid/inspections', FARMER)).status, 400);
  assert.equal((await request(ctx.url, 'GET', url)).status, 401);
});

test('migration 019 adds no pass rows; unstarted pre-existing packages need a fresh HTX inspection; started shifts keep running', async (t) => {
  const disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(disposable.url, { statementTimeout: 60000 });
  const dir = await mkdtemp(join(tmpdir(), 'h04-migrations-'));
  const servers2 = [];
  t.after(async () => {
    for (const server of servers2) {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
    await pool.end();
    await disposable.drop();
    await rm(dir, { recursive: true, force: true });
  });

  // Schema exactly as before H-04: every migration below 019 applied, nothing else.
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql') && file < '019_')) {
    await copyFile(join(MIGRATIONS, name), join(dir, name));
  }
  await migrate(pool, dir);
  await seedCatalog(pool);
  for (const [user, role] of [[FARMER, 'farmer'], [COOP, 'coop'], [PROVIDER, 'provider'], [OPERATOR, 'operator']]) {
    await pool.query('INSERT INTO account.users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [user, `${user}@example.com`, `Synthetic ${role}`, HASH]);
    await pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user, role]);
  }
  await pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic tractor', 'tractor')", [MACHINE, PROVIDER]);

  // Legacy package: claimed, farmer-ready, no HTX row. Legacy started package: shift already RUNNING.
  async function legacyPackage(day, started) {
    const field = (await pool.query("INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'Synthetic field', 'Demo', 10000) RETURNING id", [FARMER])).rows[0].id;
    const bookingId = (await pool.query(
      `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
         service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id, state)
       SELECT $1, $2, id, $3, $4, 'Synthetic field', 10000, code, name, data_label, price_per_ha_vnd, price_per_ha_vnd, $5, 'ASSIGNED'
         FROM dispatch.services WHERE code = 'tillage-tractor' RETURNING id`,
      [FARMER, field, at(day, 8), at(day, 12), COOP],
    )).rows[0].id;
    const packageId = (await pool.query(
      `INSERT INTO dispatch.packages (coop_id, service_id, locality, window_start_at, window_end_at, status, provider_id, machine_id, operator_id)
       SELECT $1, id, 'Demo', $2, $3, 'CLAIMED', $4, $5, $6 FROM dispatch.services WHERE code = 'tillage-tractor' RETURNING id`,
      [COOP, at(day, 8), at(day, 12), PROVIDER, MACHINE, OPERATOR],
    )).rows[0].id;
    await pool.query('INSERT INTO dispatch.package_bookings (package_id, booking_id) VALUES ($1, $2)', [packageId, bookingId]);
    await pool.query('INSERT INTO dispatch.readiness_events (booking_id, actor_id, drained, mature, intake_ready) VALUES ($1, $2, true, true, true)', [bookingId, FARMER]);
    let shiftId = null;
    if (started) {
      shiftId = (await pool.query("INSERT INTO dispatch.shifts (package_id, status) VALUES ($1, 'RUNNING') RETURNING id", [packageId])).rows[0].id;
      await pool.query("INSERT INTO dispatch.shift_events (shift_id, event_type, from_state, to_state, actor_id) VALUES ($1, 'SHIFT_STARTED', NULL, 'RUNNING', $2)", [shiftId, OPERATOR]);
    }
    return { packageId, bookingId, shiftId };
  }
  const pending = await legacyPackage(1, false);
  const running = await legacyPackage(2, true);

  // Exercise only the 018-to-019 upgrade; later migrations have their own tests.
  const migration = '019_field_inspections.sql';
  await copyFile(join(MIGRATIONS, migration), join(dir, migration));
  assert.deepEqual(await migrate(pool, dir), [migration]);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.field_inspections', [], pool), 0);

  const url = await serve(pool, (app, db) => app.use(createShiftRouter({ pool: db, authenticate: testAuthenticate })));
  servers2.push(...servers.splice(servers.length - 1, 1));
  const api = (method, path, actor, payload) => request(url, method, path, actor, payload);

  // Started shift keeps running and its controls still work after the migration.
  assert.equal((await api('POST', `/api/shifts/${running.shiftId}/pause`, OPERATOR, { reason: 'Synthetic rain' })).status, 200);
  assert.equal((await api('POST', `/api/shifts/${running.shiftId}/resume`, OPERATOR, {})).status, 200);

  // Unstarted legacy package: readiness is kept, but no pass is implied.
  assert.equal((await api('POST', `/api/packages/${pending.packageId}/shifts/start`, OPERATOR, {})).body.error.code, 'INSPECTION_INCOMPLETE');
  assert.equal((await api('GET', `/api/bookings/${pending.bookingId}/inspections`, COOP)).body.passed, false);
  assert.equal((await api('GET', `/api/bookings/${pending.bookingId}/inspections`, FARMER)).body.passed, false);
  assert.equal((await api('POST', `/api/bookings/${pending.bookingId}/inspections`, COOP, PASS)).status, 201);
  assert.equal((await api('POST', `/api/packages/${pending.packageId}/shifts/start`, OPERATOR, {})).status, 201);
});

test('ungrouped and cancelled bookings refuse inspection writes while preserving read history, and harvest-combine packages pass end-to-end', async () => {
  const day = nextDay();
  const loose = await booking(day);
  const looseRead = await inspections(loose, COOP);
  assert.equal(looseRead.status, 200);
  assert.equal(looseRead.body.canInspect, false);
  assert.equal(looseRead.body.passed, false);
  assert.equal((await inspect(loose, PASS, COOP)).body.error.code, 'BOOKING_UNAVAILABLE');

  const f = await fixture({ bookings: 1 });
  const [b0] = f.bookingIds;
  assert.equal((await ready(b0)).status, 200);
  assert.equal((await inspect(b0)).status, 201);
  assert.equal((await post(`/api/packages/${f.packageId}/cancel`, { reason: 'Synthetic cancel' }, COOP)).status, 200);
  assert.equal((await inspect(b0, FAIL())).body.error.code, 'BOOKING_UNAVAILABLE');
  const afterCancel = await inspections(b0, FARMER);
  assert.equal(afterCancel.status, 200);
  assert.equal(afterCancel.body.canInspect, false);
  assert.equal(afterCancel.body.latest.result, 'PASSED');

  // Harvest service package (harvest-combine + harvester machine) + concurrent readiness edit vs inspection.
  const hDay = nextDay();
  await consent(hDay);
  const harvester = id(21);
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic combine', 'harvester')", [harvester, PROVIDER]);
  const field = (await ctx.pool.query("INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'Synthetic paddy', 'Demo', 12000) RETURNING id", [FARMER])).rows[0].id;
  const hBooking = (await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT $1, $2, id, $3, $4, 'Synthetic paddy', 12000, code, name, data_label, price_per_ha_vnd, (12000 * price_per_ha_vnd + 5000) / 10000, $5
       FROM dispatch.services WHERE code = 'harvest-combine' RETURNING id`,
    [FARMER, field, at(hDay, 8), at(hDay, 12), COOP],
  )).rows[0].id;
  const hPkg = (await post('/api/packages', { bookingIds: [hBooking] }, COOP)).body.package.id;
  assert.equal((await post(`/api/packages/${hPkg}/claim`, { machineId: harvester, operatorId: OPERATOR }, PROVIDER)).status, 200);
  assert.equal((await ready(hBooking)).status, 200);
  // Concurrent readiness false edit vs HTX pass: neither order can allow shift start.
  const [editRes, passRes] = await Promise.all([
    ready(hBooking, { ...ALL_TRUE, intakeReady: false }),
    inspect(hBooking, PASS),
  ]);
  assert.equal(editRes.status, 200);
  assert.equal(passRes.status, 201);
  assert.equal((await start(hPkg)).status, 409);
  assert.equal((await ready(hBooking)).status, 200);
  assert.equal((await inspect(hBooking)).status, 201);
  assert.equal((await start(hPkg)).status, 201);
});
