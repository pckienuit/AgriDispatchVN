import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createDispatchRouter } from '../../src/dispatch.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

// Fail closed at load time: the root URL must be a loopback PostgreSQL URL naming a *_test database.
parseDisposableRoot(process.env.TEST_DATABASE_URL);

const FARMER_A = '10000000-0000-4000-8000-000000000001';
const FARMER_B = '10000000-0000-4000-8000-000000000002';
const COOP_A = '10000000-0000-4000-8000-000000000003';
const PROVIDER_A = '10000000-0000-4000-8000-000000000004';
const COOP_B = '10000000-0000-4000-8000-000000000005';
const FIELD_A = '40000000-0000-4000-8000-000000000001';
const FIELD_B = '40000000-0000-4000-8000-000000000002';
const FIELD_FAR = '40000000-0000-4000-8000-000000000003';
const FIELD_OTHER = '40000000-0000-4000-8000-000000000004';
const SOIL_SERVICE = '00000000-0000-4000-8000-000000000101';
const COMBINE_SERVICE = '00000000-0000-4000-8000-000000000102';
const MISSING = '60000000-0000-4000-8000-0000000000ff';
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;

// TEST SEAM ONLY: fixed bearer tokens mapped to synthetic actors. The parent app supplies the real
// cross-service authenticate middleware; this file never ships as runtime authentication.
const TEST_ACTORS = {
  'seam-farmer-a': { id: FARMER_A, roles: ['farmer'], name: 'Synthetic Farmer A' },
  'seam-farmer-b': { id: FARMER_B, roles: ['farmer'], name: 'Synthetic Farmer B' },
  'seam-coop-a': { id: COOP_A, roles: ['coop'], name: 'Synthetic Coop A' },
  'seam-coop-b': { id: COOP_B, roles: ['coop'], name: 'Synthetic Coop B' },
  'seam-provider-a': { id: PROVIDER_A, roles: ['provider'], name: 'Synthetic Provider A' },
};

function testSeamAuthenticate(req, res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!Object.hasOwn(TEST_ACTORS, token)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = TEST_ACTORS[token];
  return next();
}

// Fault seam: a wrapper client that throws on the grouping event insert, to prove the grouping write rolls back.
function faultyGroupingPool(pool) {
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        query(text, ...rest) {
          if (typeof text === 'string' && /INSERT INTO dispatch\.booking_events[\s\S]*'BOOKING_GROUPED'/.test(text)) {
            return Promise.reject(new Error('injected grouping fault'));
          }
          return client.query(text, ...rest);
        },
        release: (destroy) => client.release(destroy),
      };
    },
  };
}

const ctx = {};
const servers = [];

async function listen(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(createDispatchRouter({ pool, authenticate: testSeamAuthenticate }));
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  ctx.applied = await migrate(ctx.pool);
  await seedCatalog(ctx.pool);
  await ctx.pool.query(
    `INSERT INTO account.users (id, email, name, password_hash) VALUES
       ($1, 'farmer-a@example.com', 'Synthetic Farmer A', $2),
       ($3, 'farmer-b@example.com', 'Synthetic Farmer B', $2),
       ($4, 'coop-a@example.com', 'Synthetic Coop A', $2),
       ($5, 'coop-b@example.com', 'Synthetic Coop B', $2),
       ($6, 'provider-a@example.com', 'Synthetic Provider A', $2)`,
    [FARMER_A, HASH, FARMER_B, COOP_A, COOP_B, PROVIDER_A],
  );
  await ctx.pool.query(
    `INSERT INTO account.user_roles (user_id, role) VALUES
       ($1, 'farmer'), ($2, 'farmer'), ($3, 'coop'), ($4, 'coop'), ($5, 'provider')`,
    [FARMER_A, FARMER_B, COOP_A, COOP_B, PROVIDER_A],
  );
  await ctx.pool.query(
    `INSERT INTO dispatch.fields (id, owner_id, name, locality, area_m2) VALUES
       ($1, $2, 'Ruộng A', 'Châu Thành', 12000),
       ($3, $2, 'Ruộng B', 'Châu Thành', 8000),
       ($4, $2, 'Ruộng xa', 'Long Hồ', 9000),
       ($5, $6, 'Ruộng khác', 'Châu Thành', 5000)`,
    [FIELD_A, FARMER_A, FIELD_B, FIELD_FAR, FIELD_OTHER, FARMER_B],
  );
  ctx.url = await listen(ctx.pool);
  ctx.faultyUrl = await listen(faultyGroupingPool(ctx.pool));
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

const iso = (hour, day = 25) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();

async function call(method, path, token, payload, base = ctx.url) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Seeds a booking through the same snapshot columns as G3, then optionally delegates it (setup shortcut).
async function booking({ field = FIELD_A, service = SOIL_SERVICE, start = iso(8), end = iso(12), coordinator = null } = {}) {
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT f.owner_id, f.id, s.id, $3::timestamptz, $4::timestamptz, f.name, f.area_m2, s.code, s.name, s.data_label, s.price_per_ha_vnd,
       floor((s.price_per_ha_vnd::numeric * f.area_m2 + 5000) / 10000)::bigint, $5::uuid
       FROM dispatch.fields f, dispatch.services s WHERE f.id = $1 AND s.id = $2
     RETURNING id`,
    [field, service, start, end, coordinator],
  );
  await ctx.pool.query(
    `INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id)
     VALUES ($1, 'BOOKING_REQUESTED', 'REQUESTED', $2)`,
    [rows[0].id, FARMER_A],
  );
  return rows[0].id;
}

async function count(sql, params = []) {
  return Number((await ctx.pool.query(sql, params)).rows[0].n);
}

async function bookingRows(ids) {
  const { rows } = await ctx.pool.query(
    `SELECT id, state, coordinator_id, owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd::text AS price, total_vnd::text AS total
       FROM dispatch.bookings WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  return rows;
}

async function coopPackageCount(coop) {
  return count('SELECT count(*)::text AS n FROM dispatch.packages WHERE coop_id = $1', [coop]);
}

test('migration 005 applies after 004 and rerun is a no-op', async () => {
  assert.ok(ctx.applied.includes('005_dispatch.sql'));
  assert.deepEqual(await migrate(ctx.pool), []);
  assert.equal(await count(
    `SELECT count(*)::text AS n FROM information_schema.tables
      WHERE table_schema = 'dispatch' AND table_name IN ('packages', 'package_bookings')`,
  ), 2);
  assert.equal(await count(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = 'dispatch' AND table_name = 'bookings' AND column_name = 'coordinator_id' AND is_nullable = 'YES'`,
  ), 1);
});

test('booking guard allows only state and coordinator changes; grouped coordinator is fixed; delete stays forbidden', async () => {
  const id = await booking();
  await assert.rejects(ctx.pool.query('UPDATE dispatch.bookings SET total_vnd = 1 WHERE id = $1', [id]), { code: '23001' });
  await assert.rejects(ctx.pool.query('UPDATE dispatch.bookings SET field_name = $2 WHERE id = $1', [id, 'x']), { code: '23001' });
  await assert.rejects(ctx.pool.query('DELETE FROM dispatch.bookings WHERE id = $1', [id]), { code: '23001' });
  await assert.rejects(ctx.pool.query("UPDATE dispatch.bookings SET state = 'CONFIRMED' WHERE id = $1", [id]), { code: '23001' });
  await assert.rejects(ctx.pool.query("UPDATE dispatch.bookings SET state = 'GROUPED' WHERE id = $1", [id]), { code: '23514' });
  await ctx.pool.query('UPDATE dispatch.bookings SET coordinator_id = $2 WHERE id = $1', [id, COOP_A]);
  await ctx.pool.query("UPDATE dispatch.bookings SET state = 'GROUPED' WHERE id = $1", [id]);
  await assert.rejects(
    ctx.pool.query('UPDATE dispatch.bookings SET coordinator_id = $2 WHERE id = $1', [id, COOP_B]),
    { code: '23001' },
    'grouped booking keeps its coordinator',
  );
  await assert.rejects(
    ctx.pool.query("UPDATE dispatch.bookings SET state = 'REQUESTED' WHERE id = $1", [id]),
    { code: '23001' },
    'grouped booking cannot return to REQUESTED',
  );
});

test('event constraints accept coordinator and grouping events and reject unknown states', async () => {
  const id = await booking();
  await ctx.pool.query(
    "INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id) VALUES ($1, 'COORDINATOR_ASSIGNED', 'REQUESTED', $2)",
    [id, FARMER_A],
  );
  await ctx.pool.query(
    "INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id) VALUES ($1, 'BOOKING_GROUPED', 'GROUPED', $2)",
    [id, COOP_A],
  );
  await assert.rejects(
    ctx.pool.query("INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id) VALUES ($1, 'BOOKING_GROUPED', 'CONFIRMED', $2)", [id, COOP_A]),
    { code: '23514' },
  );
  await assert.rejects(
    ctx.pool.query("INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id) VALUES ($1, 'BOOKING_CLAIMED', 'REQUESTED', $2)", [id, COOP_A]),
    { code: '23514' },
  );
});

test('package membership allows one package per booking at the database level', async () => {
  const id = await booking({ coordinator: COOP_A });
  const pkg = (await ctx.pool.query(
    `INSERT INTO dispatch.packages (coop_id, service_id, locality, window_start_at, window_end_at)
     VALUES ($1, $2, 'Châu Thành', $3, $4) RETURNING id`,
    [COOP_A, SOIL_SERVICE, iso(8), iso(12)],
  )).rows[0].id;
  await ctx.pool.query('INSERT INTO dispatch.package_bookings (package_id, booking_id) VALUES ($1, $2)', [pkg, id]);
  const other = (await ctx.pool.query(
    `INSERT INTO dispatch.packages (coop_id, service_id, locality, window_start_at, window_end_at)
     VALUES ($1, $2, 'Châu Thành', $3, $4) RETURNING id`,
    [COOP_A, SOIL_SERVICE, iso(8), iso(12)],
  )).rows[0].id;
  await assert.rejects(
    ctx.pool.query('INSERT INTO dispatch.package_bookings (package_id, booking_id) VALUES ($1, $2)', [other, id]),
    { code: '23505' },
  );
  await assert.rejects(
    ctx.pool.query(
      `INSERT INTO dispatch.packages (coop_id, service_id, locality, window_start_at, window_end_at, status)
       VALUES ($1, $2, 'Châu Thành', $3, $4, 'DONE')`,
      [COOP_A, SOIL_SERVICE, iso(8), iso(12)],
    ),
    { code: '23514' },
  );
});

test('owner assigns a coop coordinator and the event is recorded in the same request', async () => {
  const id = await booking();
  const res = await call('POST', `/api/bookings/${id}/coordinator`, 'seam-farmer-a', { coordinatorId: COOP_A });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { booking: { id, state: 'REQUESTED', coordinatorId: COOP_A } });
  const { rows } = await ctx.pool.query(
    'SELECT event_type, to_state, actor_id FROM dispatch.booking_events WHERE booking_id = $1 ORDER BY sequence',
    [id],
  );
  assert.deepEqual(rows.map((row) => [row.event_type, row.to_state, row.actor_id]), [
    ['BOOKING_REQUESTED', 'REQUESTED', FARMER_A],
    ['COORDINATOR_ASSIGNED', 'REQUESTED', FARMER_A],
  ]);
});

test('foreign farmer and non-owner coop cannot assign; booking stays unchanged', async () => {
  const id = await booking();
  const foreign = await call('POST', `/api/bookings/${id}/coordinator`, 'seam-farmer-b', { coordinatorId: COOP_A });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'NOT_FOUND');
  const nonOwnerCoop = await call('POST', `/api/bookings/${id}/coordinator`, 'seam-coop-a', { coordinatorId: COOP_A });
  assert.equal(nonOwnerCoop.status, 404);
  const missing = await call('POST', `/api/bookings/${MISSING}/coordinator`, 'seam-farmer-a', { coordinatorId: COOP_A });
  assert.equal(missing.status, 404);
  const [row] = await bookingRows([id]);
  assert.equal(row.coordinator_id, null);
  assert.equal(await count("SELECT count(*)::text AS n FROM dispatch.booking_events WHERE booking_id = $1 AND event_type = 'COORDINATOR_ASSIGNED'", [id]), 0);
});

test('non-coop, unknown and malformed coordinator targets are rejected with no write', async () => {
  const id = await booking();
  const cases = [
    [{ coordinatorId: FARMER_B }, 400, 'INVALID_COORDINATOR'],
    [{ coordinatorId: PROVIDER_A }, 400, 'INVALID_COORDINATOR'],
    [{ coordinatorId: MISSING }, 400, 'INVALID_COORDINATOR'],
    [{ coordinatorId: 'not-a-uuid' }, 400, 'VALIDATION_FAILED'],
    [{ coordinatorId: COOP_A, owner: FARMER_A }, 400, 'UNKNOWN_FIELD'],
    [{}, 400, 'VALIDATION_FAILED'],
  ];
  for (const [payload, status, code] of cases) {
    const res = await call('POST', `/api/bookings/${id}/coordinator`, 'seam-farmer-a', payload);
    assert.equal(res.status, status, JSON.stringify(payload));
    assert.equal(res.body.error.code, code, JSON.stringify(payload));
  }
  const bad = await call('POST', '/api/bookings/not-an-id/coordinator', 'seam-farmer-a', { coordinatorId: COOP_A });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_ID');
  const [row] = await bookingRows([id]);
  assert.equal(row.coordinator_id, null);
});

test('coordinator change is refused once the booking is grouped', async () => {
  const id = await booking({ coordinator: COOP_A });
  const grouped = await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [id] });
  assert.equal(grouped.status, 201);
  const res = await call('POST', `/api/bookings/${id}/coordinator`, 'seam-farmer-a', { coordinatorId: COOP_B });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'BOOKING_NOT_REQUESTED');
  const [row] = await bookingRows([id]);
  assert.equal(row.coordinator_id, COOP_A);
  assert.equal(row.state, 'GROUPED');
});

test('coop groups delegated compatible bookings into one package with events and unchanged snapshots', async () => {
  const b1 = await booking({ coordinator: COOP_A });
  const b2 = await booking({ field: FIELD_B, start: iso(10), end: iso(14), coordinator: COOP_A });
  const before = await bookingRows([b1, b2]);
  const res = await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [b2, b1] });
  assert.equal(res.status, 201);
  const pkg = res.body.package;
  assert.equal(pkg.status, 'OPEN');
  assert.equal(pkg.serviceId, SOIL_SERVICE);
  assert.equal(pkg.locality, 'Châu Thành');
  assert.deepEqual(pkg.window, { startAt: iso(10), endAt: iso(12) });
  assert.equal(pkg.bookingCount, 2);
  assert.equal(Object.hasOwn(pkg, 'coopId'), false);

  const members = await ctx.pool.query('SELECT booking_id FROM dispatch.package_bookings WHERE package_id = $1 ORDER BY booking_id', [pkg.id]);
  assert.deepEqual(members.rows.map((row) => row.booking_id), [b1, b2].sort());

  const after = await bookingRows([b1, b2]);
  assert.deepEqual(after.map((row) => row.state), ['GROUPED', 'GROUPED']);
  assert.deepEqual(after.map((row) => row.coordinator_id), [COOP_A, COOP_A]);
  const strip = (rows) => rows.map((row) => {
    const snapshot = { ...row };
    delete snapshot.state;
    delete snapshot.coordinator_id;
    return snapshot;
  });
  assert.deepEqual(strip(after), strip(before));

  const events = await ctx.pool.query(
    "SELECT booking_id, event_type, to_state, actor_id FROM dispatch.booking_events WHERE event_type = 'BOOKING_GROUPED' AND booking_id = ANY($1::uuid[])",
    [[b1, b2]],
  );
  assert.equal(events.rows.length, 2);
  for (const row of events.rows) {
    assert.equal(row.to_state, 'GROUPED');
    assert.equal(row.actor_id, COOP_A);
  }
});

test('coop cannot group a booking delegated to another coop; nothing is written', async () => {
  const id = await booking({ coordinator: COOP_A });
  const before = await coopPackageCount(COOP_B);
  const res = await call('POST', '/api/packages', 'seam-coop-b', { bookingIds: [id] });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
  assert.equal(await coopPackageCount(COOP_B), before);
  const [row] = await bookingRows([id]);
  assert.equal(row.state, 'REQUESTED');
});

test('missing booking in the list fails the whole request and leaves valid bookings ungrouped', async () => {
  const id = await booking({ coordinator: COOP_A });
  const before = await coopPackageCount(COOP_A);
  const res = await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [id, MISSING] });
  assert.equal(res.status, 404);
  assert.equal(await coopPackageCount(COOP_A), before);
  const [row] = await bookingRows([id]);
  assert.equal(row.state, 'REQUESTED');
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.package_bookings WHERE booking_id = $1', [id]), 0);
});

test('incompatible sets return 409 PACKAGE_INCOMPATIBLE and write nothing', async () => {
  const cases = [
    ['disjoint time window', { start: iso(8, 26), end: iso(12, 26) }, {}],
    ['touching window only', { start: iso(12), end: iso(16) }, {}],
    ['different service', { service: COMBINE_SERVICE }, {}],
    ['different locality', { field: FIELD_FAR }, {}],
  ];
  for (const [label, override] of cases) {
    const anchor = await booking({ coordinator: COOP_A });
    const other = await booking({ coordinator: COOP_A, ...override });
    const before = await coopPackageCount(COOP_A);
    const res = await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [anchor, other] });
    assert.equal(res.status, 409, label);
    assert.equal(res.body.error.code, 'PACKAGE_INCOMPATIBLE', label);
    assert.equal(await coopPackageCount(COOP_A), before, label);
    const rows = await bookingRows([anchor, other]);
    assert.deepEqual(rows.map((row) => row.state), ['REQUESTED', 'REQUESTED'], label);
  }
});

test('grouping an already grouped booking returns 409 BOOKING_NOT_REQUESTED', async () => {
  const id = await booking({ coordinator: COOP_A });
  assert.equal((await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [id] })).status, 201);
  const again = await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [id] });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'BOOKING_NOT_REQUESTED');
});

test('concurrent groupings of the same bookings: exactly one succeeds, no booking is reused', async () => {
  for (let round = 0; round < 5; round += 1) {
    const b1 = await booking({ coordinator: COOP_A });
    const b2 = await booking({ field: FIELD_B, coordinator: COOP_A });
    const [first, second] = await Promise.all([
      call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [b1, b2] }),
      call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [b2, b1] }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409], `round ${round}`);
    const loser = first.status === 409 ? first : second;
    assert.equal(loser.body.error.code, 'BOOKING_NOT_REQUESTED');
    assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.package_bookings WHERE booking_id = ANY($1::uuid[])', [[b1, b2]]), 2);
  }
});

test('grouping event failure rolls back package, memberships and booking states', async () => {
  const b1 = await booking({ coordinator: COOP_A });
  const b2 = await booking({ field: FIELD_B, coordinator: COOP_A });
  const before = await coopPackageCount(COOP_A);
  const res = await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [b1, b2] }, ctx.faultyUrl);
  assert.equal(res.status, 500);
  assert.equal(await coopPackageCount(COOP_A), before);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.package_bookings WHERE booking_id = ANY($1::uuid[])', [[b1, b2]]), 0);
  assert.deepEqual((await bookingRows([b1, b2])).map((row) => row.state), ['REQUESTED', 'REQUESTED']);
  // The same pool connection still serves real requests after the rollback.
  const retry = await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [b1, b2] });
  assert.equal(retry.status, 201);
});

test('package input is strict: count, shape, UUID and duplicate checks', async () => {
  const id = await booking({ coordinator: COOP_A });
  const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const cases = [
    [{}, 'VALIDATION_FAILED'],
    [{ bookingIds: [] }, 'VALIDATION_FAILED'],
    [{ bookingIds: many }, 'VALIDATION_FAILED'],
    [{ bookingIds: 'x' }, 'VALIDATION_FAILED'],
    [{ bookingIds: ['not-a-uuid'] }, 'VALIDATION_FAILED'],
    [{ bookingIds: [id, id.toUpperCase()] }, 'VALIDATION_FAILED'],
    [{ bookingIds: [id], status: 'OPEN' }, 'UNKNOWN_FIELD'],
    [[id], 'INVALID_BODY'],
  ];
  for (const [payload, code] of cases) {
    const res = await call('POST', '/api/packages', 'seam-coop-a', payload);
    assert.equal(res.status, 400, JSON.stringify(payload).slice(0, 80));
    assert.equal(res.body.error.code, code, JSON.stringify(payload).slice(0, 80));
  }
  const raw = await call('POST', '/api/packages', 'seam-coop-a', '{"bookingIds":');
  assert.equal(raw.status, 400);
  assert.equal(raw.body.error.code, 'INVALID_JSON');
  assert.equal((await bookingRows([id]))[0].state, 'REQUESTED');
});

test('package creation is limited to coop role', async () => {
  const id = await booking({ coordinator: COOP_A });
  for (const token of ['seam-farmer-a', 'seam-provider-a']) {
    const res = await call('POST', '/api/packages', token, { bookingIds: [id] });
    assert.equal(res.status, 403, token);
    assert.equal(res.body.error.code, 'FORBIDDEN', token);
  }
  const anonymous = await call('POST', '/api/packages', undefined, { bookingIds: [id] });
  assert.equal(anonymous.status, 401);
});

test('package reads: coop sees own packages, provider sees OPEN only, identities never returned', async () => {
  const mine = await booking({ coordinator: COOP_A });
  const created = await call('POST', '/api/packages', 'seam-coop-a', { bookingIds: [mine] });
  assert.equal(created.status, 201);
  const pkgId = created.body.package.id;
  const cancelled = (await ctx.pool.query(
    `INSERT INTO dispatch.packages (coop_id, service_id, locality, window_start_at, window_end_at, status)
     VALUES ($1, $2, 'Châu Thành', $3, $4, 'CANCELLED') RETURNING id`,
    [COOP_A, SOIL_SERVICE, iso(8), iso(12)],
  )).rows[0].id;

  const coopList = await call('GET', '/api/packages?limit=100', 'seam-coop-a');
  assert.equal(coopList.status, 200);
  const coopIds = coopList.body.items.map((item) => item.id);
  assert.ok(coopIds.includes(pkgId));
  assert.ok(coopIds.includes(cancelled));
  assert.equal((await call('GET', '/api/packages?limit=100', 'seam-coop-b')).body.items.length, 0);

  const providerList = await call('GET', '/api/packages?limit=100', 'seam-provider-a');
  assert.equal(providerList.status, 200);
  const providerIds = providerList.body.items.map((item) => item.id);
  assert.ok(providerIds.includes(pkgId));
  assert.ok(!providerIds.includes(cancelled));
  assert.equal(JSON.stringify(providerList.body).includes(COOP_A), false);
  assert.equal(JSON.stringify(providerList.body).includes(FARMER_A), false);

  const ownDetail = await call('GET', `/api/packages/${pkgId}`, 'seam-coop-a');
  assert.equal(ownDetail.status, 200);
  assert.deepEqual(ownDetail.body.package.bookingIds, [mine]);
  const providerDetail = await call('GET', `/api/packages/${pkgId}`, 'seam-provider-a');
  assert.equal(providerDetail.status, 200);
  assert.equal(JSON.stringify(providerDetail.body).includes(COOP_A), false);
  assert.equal((await call('GET', `/api/packages/${pkgId}`, 'seam-coop-b')).status, 404);
  assert.equal((await call('GET', `/api/packages/${cancelled}`, 'seam-provider-a')).status, 404);
  assert.equal((await call('GET', `/api/packages/${MISSING}`, 'seam-coop-a')).status, 404);
  assert.equal((await call('GET', '/api/packages/not-an-id', 'seam-coop-a')).body.error.code, 'INVALID_ID');
  assert.equal((await call('GET', '/api/packages', 'seam-farmer-a')).status, 403);
  assert.equal((await call('GET', `/api/packages/${pkgId}`, 'seam-farmer-a')).status, 403);
  assert.equal((await call('GET', '/api/packages?limit=0', 'seam-coop-a')).body.error.code, 'INVALID_PAGINATION');
});
