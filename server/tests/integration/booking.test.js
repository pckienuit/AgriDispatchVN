import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createBookingRouter } from '../../src/booking.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseRootDatabaseUrl } from '../helpers/catalog-db.js';

// Fail closed at load time: the root URL must be a loopback PostgreSQL URL naming a *_test database.
parseRootDatabaseUrl(process.env.TEST_DATABASE_URL);

const FARMER_A = '10000000-0000-4000-8000-000000000001';
const FARMER_B = '10000000-0000-4000-8000-000000000002';
const COOP_A = '10000000-0000-4000-8000-000000000003';
const PROVIDER_A = '10000000-0000-4000-8000-000000000004';
const FIELD_A = '40000000-0000-4000-8000-000000000001';
const FIELD_B = '40000000-0000-4000-8000-000000000002';
const FIELD_COOP = '40000000-0000-4000-8000-000000000003';
const SOIL_SERVICE = '00000000-0000-4000-8000-000000000101';
const INACTIVE_SERVICE = '00000000-0000-4000-8000-000000000104';
const MISSING_FIELD = '40000000-0000-4000-8000-0000000000ff';
const ROUNDING_SERVICE = '50000000-0000-4000-8000-000000000001';
const MUTABLE_SERVICE = '50000000-0000-4000-8000-000000000002';
const KEY = 'integration-key-0001';

// TEST SEAM ONLY: fixed bearer tokens mapped to synthetic actors. The parent app supplies the real
// cross-service authenticate middleware; this file never ships as runtime authentication.
const TEST_ACTORS = {
  'seam-farmer-a': { id: FARMER_A, roles: ['farmer'], name: 'Synthetic Farmer A' },
  'seam-farmer-b': { id: FARMER_B, roles: ['farmer'], name: 'Synthetic Farmer B' },
  'seam-coop-a': { id: COOP_A, roles: ['coop'], name: 'Synthetic Coop A' },
  'seam-provider-a': { id: PROVIDER_A, roles: ['provider'], name: 'Synthetic Provider A' },
};

function testSeamAuthenticate(req, res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!Object.hasOwn(TEST_ACTORS, token)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = TEST_ACTORS[token];
  return next();
}

// Fault seam: a wrapper client that throws on the event insert, to prove the booking write rolls back.
// The real pooled client is never mutated, so later requests on the same connection see the real query().
function faultyEventPool(pool) {
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        query(text, ...rest) {
          if (typeof text === 'string' && /INSERT INTO dispatch\.booking_events/.test(text)) {
            return Promise.reject(new Error('injected event fault'));
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
  app.use(createBookingRouter({ pool, authenticate: testSeamAuthenticate }));
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
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL, { label: 'booking' });
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  ctx.applied = await migrate(ctx.pool);
  await seedCatalog(ctx.pool);
  await ctx.pool.query(
    `INSERT INTO dispatch.fields (id, owner_id, name, locality, area_m2) VALUES
       ($1, $2, 'Ruộng A', 'Châu Thành', 12000),
       ($3, $4, 'Ruộng B', 'Phụng Hiệp', 8000),
       ($5, $6, 'HTX lô 3', 'Long Hồ', 20000)`,
    [FIELD_A, FARMER_A, FIELD_B, FARMER_B, FIELD_COOP, COOP_A],
  );
  await ctx.pool.query(
    `INSERT INTO dispatch.services (id, code, name, price_per_ha_vnd, data_label, active) VALUES
       ($1, 'rounding-test', 'Dịch vụ làm tròn (giả lập)', 905555, 'synthetic', true),
       ($2, 'mutable-test', 'Dịch vụ đổi giá (giả lập)', 1000000, 'synthetic', true)`,
    [ROUNDING_SERVICE, MUTABLE_SERVICE],
  );
  ctx.url = await listen(ctx.pool);
  ctx.faultyUrl = await listen(faultyEventPool(ctx.pool));
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

function post(url, token, body, key = KEY) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key !== undefined) headers['idempotency-key'] = key;
  return fetch(`${url}/api/bookings`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function get(path, token) {
  return fetch(`${ctx.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

function body(overrides = {}) {
  return {
    fieldId: FIELD_A,
    serviceId: SOIL_SERVICE,
    startAt: '2026-11-25T08:00:00Z',
    endAt: '2026-11-25T12:00:00Z',
    ...overrides,
  };
}

async function count(sql, params = []) {
  return Number((await ctx.pool.query(sql, params)).rows[0].n);
}

test('migration 003 applies after 002 and rerun is a no-op', async () => {
  assert.ok(ctx.applied.includes('003_bookings.sql'));
  assert.deepEqual(await migrate(ctx.pool), []);
  const tables = (await ctx.pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'dispatch' ORDER BY table_name",
  )).rows.map((row) => row.table_name);
  for (const name of ['bookings', 'booking_events', 'idempotency_keys']) assert.ok(tables.includes(name), name);
  assert.equal(await count(
    "SELECT count(*)::text AS n FROM pg_constraint WHERE conname = 'bookings_field_owner_fk' AND contype = 'f'",
  ), 1);
});

test('direct SQL enforces quote invariant, schedule bounds, owner pairing and append-only history', async () => {
  const bookingId = (await ctx.pool.query(
    `INSERT INTO dispatch.bookings (id, owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd)
     VALUES (gen_random_uuid(), $1, $2, $3, '2026-11-25T08:00:00Z', '2026-11-25T12:00:00Z', 'Ruộng A', 12000,
       'soil', 'Cày', 'synthetic', 900000, 1080000) RETURNING id`,
    [FARMER_A, FIELD_A, SOIL_SERVICE],
  )).rows[0].id;
  const base = {
    owner: FARMER_A, field: FIELD_A, service: SOIL_SERVICE, start: '2026-11-25T08:00:00Z', end: '2026-11-25T12:00:00Z',
  };
  const insert = (over = {}) => {
    const v = { ...base, ...over };
    return ctx.pool.query(
      `INSERT INTO dispatch.bookings (id, owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
         service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'Ruộng A', 12000, 'soil', 'Cày', 'synthetic', 900000, $6)`,
      [v.owner, v.field, v.service, v.start, v.end, v.total ?? '1080000'],
    );
  };
  await assert.rejects(insert({ total: '1080001' }), (error) => error.code === '23514', 'total must equal quote');
  await assert.rejects(insert({ end: base.start }), (error) => error.code === '23514', 'end must follow start');
  await assert.rejects(insert({ end: '2026-12-26T08:00:00Z' }), (error) => error.code === '23514', 'span bound');
  await assert.rejects(insert({ owner: FARMER_B }), (error) => error.code === '23503', 'field owner pairing');
  await assert.rejects(insert({ service: MISSING_FIELD }), (error) => error.code === '23503', 'service FK');
  await assert.rejects(
    ctx.pool.query("UPDATE dispatch.bookings SET total_vnd = 1 WHERE id = $1", [bookingId]),
    (error) => error.code === '23001',
    'booking rows are immutable',
  );
  await assert.rejects(
    ctx.pool.query('DELETE FROM dispatch.bookings WHERE id = $1', [bookingId]),
    (error) => error.code === '23001',
    'booking rows cannot be deleted',
  );
  await assert.rejects(
    ctx.pool.query("INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id) VALUES ($1, 'BOOKING_REQUESTED', 'CONFIRMED', $2)", [bookingId, FARMER_A]),
    (error) => error.code === '23514',
    'only REQUESTED state exists in G3',
  );
  await ctx.pool.query("INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id) VALUES ($1, 'BOOKING_REQUESTED', 'REQUESTED', $2)", [bookingId, FARMER_A]);
  await assert.rejects(
    ctx.pool.query("UPDATE dispatch.booking_events SET to_state = 'REQUESTED' WHERE booking_id = $1", [bookingId]),
    (error) => error.code === '23001',
    'events are append-only',
  );
  await assert.rejects(
    ctx.pool.query('DELETE FROM dispatch.booking_events WHERE booking_id = $1', [bookingId]),
    (error) => error.code === '23001',
    'events cannot be deleted',
  );
});

test('farmer POST persists booking, BOOKING_REQUESTED event and key with integer VND total', async () => {
  const response = await post(ctx.url, 'seam-farmer-a', body());
  assert.equal(response.status, 201);
  const json = await response.json();
  assert.deepEqual(Object.keys(json), ['booking']);
  assert.equal(json.booking.state, 'REQUESTED');
  assert.equal(json.booking.fieldId, FIELD_A);
  assert.equal(json.booking.serviceId, SOIL_SERVICE);
  assert.equal(json.booking.startAt, '2026-11-25T08:00:00.000Z');
  assert.equal(json.booking.endAt, '2026-11-25T12:00:00.000Z');
  assert.deepEqual(json.booking.field, { name: 'Ruộng A', areaM2: 12000 });
  assert.deepEqual(json.booking.service, { code: 'tillage-tractor', name: 'Cày, xới đất bằng máy kéo (giả lập)', dataLabel: 'synthetic', pricePerHaVnd: '900000' });
  assert.equal(json.booking.totalVnd, '1080000');
  const rows = (await ctx.pool.query('SELECT id, owner_id FROM dispatch.bookings WHERE id = $1', [json.booking.id])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_id, FARMER_A);
  const events = (await ctx.pool.query('SELECT event_type, to_state, actor_id FROM dispatch.booking_events WHERE booking_id = $1', [json.booking.id])).rows;
  assert.deepEqual(events, [{ event_type: 'BOOKING_REQUESTED', to_state: 'REQUESTED', actor_id: FARMER_A }]);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.idempotency_keys WHERE actor_id = $1 AND idempotency_key = $2', [FARMER_A, KEY]), 1);
});

test('quote rounds half up to whole dong using the stored price and area', async () => {
  // 905555 VND per ha * 12345 m2 = 11179076475; (x + 5000) / 10000 floors to 1117908.
  await ctx.pool.query('UPDATE dispatch.fields SET area_m2 = 12345 WHERE id = $1', [FIELD_A]);
  const response = await post(ctx.url, 'seam-farmer-a', body({ serviceId: ROUNDING_SERVICE }), 'rounding-key-000001');
  assert.equal(response.status, 201);
  assert.equal((await response.json()).booking.totalVnd, '1117908');
  await ctx.pool.query('UPDATE dispatch.fields SET area_m2 = 12000 WHERE id = $1', [FIELD_A]);
});

test('concurrent identical requests with one key create exactly one booking and one event', async () => {
  const payload = body({ startAt: '2026-11-26T08:00:00Z', endAt: '2026-11-26T10:00:00Z' });
  const responses = await Promise.all(Array.from({ length: 8 }, () => post(ctx.url, 'seam-farmer-a', payload, 'concurrent-key-00001')));
  assert.deepEqual(responses.map((r) => r.status), Array(8).fill(201));
  const texts = await Promise.all(responses.map((r) => r.text()));
  assert.equal(new Set(texts).size, 1, 'every response is the same original response');
  const bookingId = JSON.parse(texts[0]).booking.id;
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.bookings WHERE start_at = $1 AND field_id = $2', ['2026-11-26T08:00:00Z', FIELD_A]), 1);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.booking_events WHERE booking_id = $1', [bookingId]), 1);
  assert.equal(await count("SELECT count(*)::text AS n FROM dispatch.idempotency_keys WHERE idempotency_key = 'concurrent-key-00001'"), 1);
});

test('concurrent same key with different payloads yields one success and one 409', async () => {
  const first = body({ startAt: '2026-11-27T08:00:00Z', endAt: '2026-11-27T09:00:00Z' });
  const second = body({ startAt: '2026-11-27T10:00:00Z', endAt: '2026-11-27T11:00:00Z' });
  const responses = await Promise.all([
    post(ctx.url, 'seam-farmer-a', first, 'race-key-0000000001'),
    post(ctx.url, 'seam-farmer-a', second, 'race-key-0000000001'),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const loser = await responses.find((r) => r.status === 409).json();
  assert.deepEqual(loser, { error: { code: 'IDEMPOTENCY_CONFLICT' } });
  assert.equal(await count("SELECT count(*)::text AS n FROM dispatch.bookings WHERE start_at IN ('2026-11-27T08:00:00Z', '2026-11-27T10:00:00Z') AND field_id = $1", [FIELD_A]), 1);
});

test('retry with same key returns the original response after source price and area change', async () => {
  const payload = body({ serviceId: MUTABLE_SERVICE, startAt: '2026-11-28T08:00:00Z', endAt: '2026-11-28T12:00:00Z' });
  const first = await (await post(ctx.url, 'seam-farmer-a', payload, 'retry-key-00000001')).json();
  // 1,000,000 VND/ha * 12000 m2 = 1,200,000 VND.
  assert.equal(first.booking.totalVnd, '1200000');
  await ctx.pool.query('UPDATE dispatch.services SET price_per_ha_vnd = 2000000 WHERE id = $1', [MUTABLE_SERVICE]);
  await ctx.pool.query('UPDATE dispatch.fields SET area_m2 = 500 WHERE id = $1', [FIELD_A]);
  const retry = await post(ctx.url, 'seam-farmer-a', payload, 'retry-key-00000001');
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), first);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.idempotency_keys WHERE idempotency_key = $1', ['retry-key-00000001']), 1);
  // A new key quotes from the live source (2,000,000 VND/ha * 500 m2 = 100,000 VND); the old booking keeps its snapshot.
  const fresh = await (await post(ctx.url, 'seam-farmer-a', payload, 'retry-key-00000002')).json();
  assert.equal(fresh.booking.totalVnd, '100000');
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.bookings WHERE service_id = $1 AND field_id = $2', [MUTABLE_SERVICE, FIELD_A]), 2);
  assert.equal((await get(`/api/bookings/${first.booking.id}`, 'seam-farmer-a').then((r) => r.json())).booking.totalVnd, '1200000');
  await ctx.pool.query("UPDATE dispatch.services SET price_per_ha_vnd = 1000000 WHERE id = $1", [MUTABLE_SERVICE]);
  await ctx.pool.query('UPDATE dispatch.fields SET area_m2 = 12000 WHERE id = $1', [FIELD_A]);
});

test('same key with a different canonical payload returns 409 and writes nothing', async () => {
  const before = await count('SELECT count(*)::text AS n FROM dispatch.bookings');
  const original = await post(ctx.url, 'seam-farmer-a', body({ startAt: '2026-11-29T08:00:00Z', endAt: '2026-11-29T09:00:00Z' }), 'conflict-key-000001');
  assert.equal(original.status, 201);
  for (const patch of [{ endAt: '2026-11-29T10:00:00Z' }, { serviceId: ROUNDING_SERVICE }]) {
    const response = await post(ctx.url, 'seam-farmer-a', body({ startAt: '2026-11-29T08:00:00Z', endAt: '2026-11-29T09:00:00Z', ...patch }), 'conflict-key-000001');
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: { code: 'IDEMPOTENCY_CONFLICT' } });
  }
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.bookings'), before + 1);
});

test('equivalent timestamp spellings share one canonical payload and replay', async () => {
  const first = await post(ctx.url, 'seam-farmer-a', body({ startAt: '2026-11-30T08:00:00Z', endAt: '2026-11-30T09:00:00Z' }), 'canonical-key-00001');
  const second = await post(ctx.url, 'seam-farmer-a', body({ startAt: '2026-11-30T08:00:00.000Z', endAt: '2026-11-30T09:00:00.000Z' }), 'canonical-key-00001');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), await first.json());
});

test('another farmer cannot book a field they do not own, and the response does not disclose ownership', async () => {
  const before = await count('SELECT count(*)::text AS n FROM dispatch.bookings');
  const foreign = await post(ctx.url, 'seam-farmer-b', body({ fieldId: FIELD_A }), 'cross-user-key-0001');
  const missing = await post(ctx.url, 'seam-farmer-b', body({ fieldId: MISSING_FIELD }), 'cross-user-key-0002');
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  const foreignBody = await foreign.text();
  assert.equal(foreignBody, await missing.text());
  assert.deepEqual(JSON.parse(foreignBody), { error: { code: 'NOT_FOUND' } });
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.bookings'), before);
});

test('idempotency scope is per actor: the same key from another actor is an independent operation', async () => {
  const response = await post(ctx.url, 'seam-farmer-b', body({ fieldId: FIELD_B, startAt: '2026-12-01T08:00:00Z', endAt: '2026-12-01T09:00:00Z' }), KEY);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).booking.fieldId, FIELD_B);
});

test('inactive or missing service returns 404 and writes nothing', async () => {
  const before = await count('SELECT count(*)::text AS n FROM dispatch.bookings');
  const inactive = await post(ctx.url, 'seam-farmer-a', body({ serviceId: INACTIVE_SERVICE }), 'inactive-key-000001');
  const missing = await post(ctx.url, 'seam-farmer-a', body({ serviceId: MISSING_FIELD }), 'inactive-key-000002');
  assert.deepEqual(await inactive.json(), { error: { code: 'NOT_FOUND' } });
  assert.deepEqual(await missing.json(), { error: { code: 'NOT_FOUND' } });
  assert.equal(inactive.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.bookings'), before);
});

test('coop books its own field; provider and unauthenticated callers are refused before any write', async () => {
  const coop = await post(ctx.url, 'seam-coop-a', body({ fieldId: FIELD_COOP, startAt: '2026-12-02T08:00:00Z', endAt: '2026-12-02T09:00:00Z' }), 'coop-key-00000001');
  assert.equal(coop.status, 201);
  assert.equal((await coop.json()).booking.totalVnd, '1800000');
  const before = await count('SELECT count(*)::text AS n FROM dispatch.bookings');
  const provider = await post(ctx.url, 'seam-provider-a', body(), 'provider-key-000001');
  assert.equal(provider.status, 403);
  assert.deepEqual(await provider.json(), { error: { code: 'FORBIDDEN' } });
  const anonymous = await post(ctx.url, undefined, body(), 'anon-key-00000001');
  assert.equal(anonymous.status, 401);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.bookings'), before);
});

test('an event insert failure rolls back booking and key, and the same key later succeeds once', async () => {
  const payload = body({ startAt: '2026-12-03T08:00:00Z', endAt: '2026-12-03T09:00:00Z' });
  const failed = await post(ctx.faultyUrl, 'seam-farmer-a', payload, 'rollback-key-000001');
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: { code: 'INTERNAL_ERROR' } });
  assert.equal(await count("SELECT count(*)::text AS n FROM dispatch.bookings WHERE start_at = '2026-12-03T08:00:00Z'"), 0);
  assert.equal(await count("SELECT count(*)::text AS n FROM dispatch.idempotency_keys WHERE idempotency_key = 'rollback-key-000001'"), 0);
  const retry = await post(ctx.url, 'seam-farmer-a', payload, 'rollback-key-000001');
  assert.equal(retry.status, 201);
  assert.equal(await count("SELECT count(*)::text AS n FROM dispatch.bookings WHERE start_at = '2026-12-03T08:00:00Z'"), 1);
});

test('list is scoped to the caller, paginated, and empty for roles without bookings', async () => {
  const mine = await (await get('/api/bookings?limit=100', 'seam-farmer-a')).json();
  assert.equal(mine.limit, 100);
  assert.equal(mine.offset, 0);
  assert.ok(mine.items.length >= 8);
  assert.ok(mine.items.every((item) => item.fieldId === FIELD_A));
  const page1 = await (await get('/api/bookings?limit=2&offset=0', 'seam-farmer-a')).json();
  const page2 = await (await get('/api/bookings?limit=2&offset=2', 'seam-farmer-a')).json();
  assert.equal(page1.items.length, 2);
  assert.deepEqual([...page1.items, ...page2.items].map((item) => item.id), mine.items.slice(0, 4).map((item) => item.id));
  const theirs = await (await get('/api/bookings', 'seam-farmer-b')).json();
  assert.deepEqual(theirs.items.map((item) => item.fieldId), [FIELD_B]);
  assert.deepEqual(await (await get('/api/bookings', 'seam-provider-a')).json(), { items: [], limit: 20, offset: 0 });
  assert.deepEqual(await (await get('/api/bookings?limit=101', 'seam-farmer-a')).json(), { error: { code: 'INVALID_PAGINATION' } });
});

test('detail returns record and ordered events for the owner only, with a generic 404 for others', async () => {
  const created = await (await post(ctx.url, 'seam-farmer-a', body({ startAt: '2026-12-04T08:00:00Z', endAt: '2026-12-04T09:00:00Z' }), 'detail-key-0000001')).json();
  const owner = await get(`/api/bookings/${created.booking.id}`, 'seam-farmer-a');
  assert.equal(owner.status, 200);
  const json = await owner.json();
  assert.equal(json.booking.id, created.booking.id);
  assert.equal(json.booking.totalVnd, created.booking.totalVnd);
  assert.equal(json.events.length, 1);
  assert.deepEqual(Object.keys(json.events[0]).sort(), ['createdAt', 'sequence', 'state', 'type']);
  assert.equal(json.events[0].type, 'BOOKING_REQUESTED');
  assert.equal(json.events[0].state, 'REQUESTED');
  const other = await get(`/api/bookings/${created.booking.id}`, 'seam-farmer-b');
  const absent = await get('/api/bookings/60000000-0000-4000-8000-000000000001', 'seam-farmer-b');
  assert.equal(other.status, 404);
  assert.equal(await other.text(), await absent.text());
  assert.deepEqual(await (await get('/api/bookings/not-a-uuid', 'seam-farmer-a')).json(), { error: { code: 'INVALID_ID' } });
});

test('stored quote and service snapshot do not change after later source edits', async () => {
  const id = (await (await post(ctx.url, 'seam-farmer-a', body({ serviceId: MUTABLE_SERVICE, startAt: '2026-12-05T08:00:00Z', endAt: '2026-12-05T09:00:00Z' }), 'snapshot-key-000001')).json()).booking.id;
  await ctx.pool.query("UPDATE dispatch.services SET name = 'Đổi tên', price_per_ha_vnd = 1 WHERE id = $1", [MUTABLE_SERVICE]);
  await ctx.pool.query("UPDATE dispatch.fields SET name = 'Đổi tên ruộng', area_m2 = 1 WHERE id = $1", [FIELD_A]);
  const detail = (await (await get(`/api/bookings/${id}`, 'seam-farmer-a')).json()).booking;
  assert.equal(detail.field.name, 'Ruộng A');
  assert.equal(detail.field.areaM2, 12000);
  assert.equal(detail.service.name, 'Dịch vụ đổi giá (giả lập)');
  assert.equal(detail.service.pricePerHaVnd, '1000000');
  assert.equal(detail.totalVnd, '1200000');
  await ctx.pool.query("UPDATE dispatch.services SET name = 'Dịch vụ đổi giá (giả lập)', price_per_ha_vnd = 1000000 WHERE id = $1", [MUTABLE_SERVICE]);
  await ctx.pool.query("UPDATE dispatch.fields SET name = 'Ruộng A', area_m2 = 12000 WHERE id = $1", [FIELD_A]);
});
