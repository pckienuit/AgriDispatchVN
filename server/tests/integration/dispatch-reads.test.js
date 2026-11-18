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
const COOP_A = '10000000-0000-4000-8000-000000000003';
const PROVIDER_A = '10000000-0000-4000-8000-000000000004';
const COOP_B = '10000000-0000-4000-8000-000000000005';
const PROVIDER_B = '10000000-0000-4000-8000-000000000006';
const COOP_NONE = '10000000-0000-4000-8000-000000000007';
const OPERATOR_A = '10000000-0000-4000-8000-000000000011';
const OPERATOR_B = '10000000-0000-4000-8000-000000000012';
const OPERATOR_C = '10000000-0000-4000-8000-000000000013';
const FORMER_OPERATOR = '10000000-0000-4000-8000-000000000014';
const FIELD_A = '40000000-0000-4000-8000-000000000001';
const FIELD_B = '40000000-0000-4000-8000-000000000002';
const FIELD_OTHER = '40000000-0000-4000-8000-000000000004';
const SOIL_SERVICE = '00000000-0000-4000-8000-000000000101';
const COMBINE_SERVICE = '00000000-0000-4000-8000-000000000102';
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;

// TEST SEAM ONLY: fixed bearer tokens mapped to synthetic actors. The parent app supplies the real
// cross-service authenticate middleware; this file never ships as runtime authentication.
const TEST_ACTORS = {
  'seam-farmer-a': { id: FARMER_A, roles: ['farmer'] },
  'seam-coop-a': { id: COOP_A, roles: ['coop'] },
  'seam-coop-b': { id: COOP_B, roles: ['coop'] },
  'seam-coop-none': { id: COOP_NONE, roles: ['coop'] },
  'seam-provider-a': { id: PROVIDER_A, roles: ['provider'] },
  'seam-provider-b': { id: PROVIDER_B, roles: ['provider'] },
  'seam-operator-a': { id: OPERATOR_A, roles: ['operator'] },
};

function testSeamAuthenticate(req, res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!Object.hasOwn(TEST_ACTORS, token)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = TEST_ACTORS[token];
  return next();
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

const iso = (hour, day = 25) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();

// Setup shortcut: a booking row with the same snapshot columns as G3, optionally delegated and moved through guarded states.
async function booking({ field = FIELD_A, service = SOIL_SERVICE, start = iso(8), end = iso(12), coordinator = null, state = 'REQUESTED' } = {}) {
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT f.owner_id, f.id, s.id, $3::timestamptz, $4::timestamptz, f.name, f.area_m2, s.code, s.name, s.data_label, s.price_per_ha_vnd,
       floor((s.price_per_ha_vnd::numeric * f.area_m2 + 5000) / 10000)::bigint, $5::uuid
       FROM dispatch.fields f, dispatch.services s WHERE f.id = $1 AND s.id = $2
     RETURNING id`,
    [field, service, start, end, coordinator],
  );
  const id = rows[0].id;
  if (state !== 'REQUESTED') await ctx.pool.query("UPDATE dispatch.bookings SET state = 'GROUPED' WHERE id = $1", [id]);
  if (state === 'CANCELLED') await ctx.pool.query("UPDATE dispatch.bookings SET state = 'CANCELLED' WHERE id = $1", [id]);
  return id;
}

// Setup shortcut: job, application and one offer in the given status. Returns the offer id.
async function offer({ jobId, operator, status }) {
  const app = await ctx.pool.query(
    `INSERT INTO dispatch.applications (job_id, operator_id, status) VALUES ($1, $2, 'OFFERED') RETURNING id`,
    [jobId, operator],
  );
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.offers (application_id, job_id, operator_id, status, responded_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [app.rows[0].id, jobId, operator, status, status === 'OFFERED' ? null : new Date().toISOString()],
  );
  return rows[0].id;
}

async function job({ provider, start, end, locality = 'Châu Thành' }) {
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at)
     VALUES ($1, 'Máy gặt', $2, 2, $3, $4) RETURNING id`,
    [provider, locality, start, end],
  );
  return rows[0].id;
}

const ids = {};

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  await migrate(ctx.pool);
  await seedCatalog(ctx.pool);
  await ctx.pool.query(
    `INSERT INTO account.users (id, email, name, password_hash) VALUES
       ($1, 'farmer-a@example.com', 'Synthetic Farmer A', $2),
       ($3, 'coop-a@example.com', 'Synthetic Coop A', $2),
       ($4, 'coop-b@example.com', 'Synthetic Coop B', $2),
       ($5, 'coop-none@example.com', 'Synthetic Coop None', $2),
       ($6, 'provider-a@example.com', 'Synthetic Provider A', $2),
       ($7, 'provider-b@example.com', 'Synthetic Provider B', $2),
       ($8, 'operator-a@example.com', 'Synthetic Operator A', $2),
       ($9, 'operator-b@example.com', 'Synthetic Operator B', $2),
       ($10, 'operator-c@example.com', 'Synthetic Operator C', $2),
       ($11, 'former-operator@example.com', 'Synthetic Former Operator', $2)`,
    [FARMER_A, HASH, COOP_A, COOP_B, COOP_NONE, PROVIDER_A, PROVIDER_B,
      OPERATOR_A, OPERATOR_B, OPERATOR_C, FORMER_OPERATOR],
  );
  // FORMER_OPERATOR keeps only a farmer grant, so its ACCEPTED offer must not reach the operator list.
  await ctx.pool.query(
    `INSERT INTO account.user_roles (user_id, role) VALUES
       ($1, 'farmer'), ($2, 'coop'), ($3, 'coop'), ($4, 'coop'), ($5, 'provider'), ($6, 'provider'),
       ($7, 'operator'), ($8, 'operator'), ($9, 'operator'), ($10, 'farmer')`,
    [FARMER_A, COOP_A, COOP_B, COOP_NONE, PROVIDER_A, PROVIDER_B, OPERATOR_A, OPERATOR_B, OPERATOR_C, FORMER_OPERATOR],
  );
  await ctx.pool.query(
    `INSERT INTO dispatch.fields (id, owner_id, name, locality, area_m2) VALUES
       ($1, $2, 'Ruộng A', 'Châu Thành', 12000),
       ($3, $2, 'Ruộng B', 'Long Hồ', 8000),
       ($4, $5, 'Ruộng khác', 'Châu Thành', 5000)`,
    [FIELD_A, FARMER_A, FIELD_B, FIELD_OTHER, '20000000-0000-4000-8000-000000000009'],
  );
  // FIELD_OTHER belongs to a non-seeded owner id; fields carry no FK to account.users, so no user row is needed.
  ids.reqA1 = await booking({ coordinator: COOP_A, field: FIELD_A, service: SOIL_SERVICE, start: iso(8), end: iso(12) });
  ids.reqA2 = await booking({ coordinator: COOP_A, field: FIELD_B, service: COMBINE_SERVICE, start: iso(8, 26), end: iso(12, 26) });
  await booking({ coordinator: COOP_A, state: 'GROUPED' });
  await booking({ coordinator: COOP_A, state: 'CANCELLED' });
  await booking({ coordinator: null });
  ids.reqB = await booking({ coordinator: COOP_B, field: FIELD_OTHER });

  ids.jobA = await job({ provider: PROVIDER_A, start: iso(8, 27), end: iso(12, 27) });
  ids.jobB = await job({ provider: PROVIDER_A, start: iso(8, 28), end: iso(12, 28), locality: 'Long Hồ' });
  ids.jobOther = await job({ provider: PROVIDER_B, start: iso(8, 27), end: iso(12, 27) });
  ids.jobOpen = await job({ provider: PROVIDER_A, start: iso(8, 29), end: iso(12, 29) });
  ids.offerA = await offer({ jobId: ids.jobA, operator: OPERATOR_A, status: 'ACCEPTED' });
  ids.offerB = await offer({ jobId: ids.jobB, operator: OPERATOR_A, status: 'ACCEPTED' });
  await offer({ jobId: ids.jobA, operator: OPERATOR_B, status: 'DECLINED' });
  await offer({ jobId: ids.jobA, operator: OPERATOR_C, status: 'WITHDRAWN' });
  await offer({ jobId: ids.jobA, operator: FORMER_OPERATOR, status: 'ACCEPTED' });
  ids.offerOther = await offer({ jobId: ids.jobOther, operator: OPERATOR_B, status: 'ACCEPTED' });
  await offer({ jobId: ids.jobOpen, operator: OPERATOR_B, status: 'OFFERED' });

  ctx.url = await listen(ctx.pool);
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

async function call(path, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${ctx.url}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('GET /api/dispatch/bookings: coop sees only own REQUESTED delegated bookings', async () => {
  const res = await call('/api/dispatch/bookings', 'seam-coop-a');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.limit, 20);
  assert.deepEqual(res.body.offset, 0);
  assert.deepEqual(res.body.items.map((item) => item.id).sort(), [ids.reqA1, ids.reqA2].sort());
  const reqA1 = res.body.items.find((item) => item.id === ids.reqA1);
  assert.deepEqual(reqA1, {
    id: ids.reqA1,
    fieldName: 'Ruộng A',
    locality: 'Châu Thành',
    serviceId: SOIL_SERVICE,
    serviceName: reqA1.serviceName,
    areaM2: 12000,
    startAt: iso(8),
    endAt: iso(12),
  });
  assert.equal(typeof reqA1.serviceName, 'string');
  const reqA2 = res.body.items.find((item) => item.id === ids.reqA2);
  assert.equal(reqA2.locality, 'Long Hồ');
  assert.equal(reqA2.areaM2, 8000);
});

test('GET /api/dispatch/bookings: no PII, owner or contact in returned rows', async () => {
  const res = await call('/api/dispatch/bookings', 'seam-coop-a');
  const text = JSON.stringify(res.body);
  for (const forbidden of [FARMER_A, 'farmer-a@example.com', 'ownerId', 'owner_id', 'email', 'Synthetic Farmer A']) {
    assert.ok(!text.includes(forbidden), `leaked ${forbidden}`);
  }
  for (const item of res.body.items) {
    assert.deepEqual(Object.keys(item).sort(), ['areaM2', 'endAt', 'fieldName', 'id', 'locality', 'serviceId', 'serviceName', 'startAt']);
  }
});

test('GET /api/dispatch/bookings: foreign coop and coop with no delegated bookings get no leak', async () => {
  const foreign = await call('/api/dispatch/bookings', 'seam-coop-b');
  assert.equal(foreign.status, 200);
  assert.deepEqual(foreign.body.items.map((item) => item.id), [ids.reqB]);
  const empty = await call('/api/dispatch/bookings', 'seam-coop-none');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, []);
});

test('GET /api/dispatch/bookings: pagination limit and offset are honored', async () => {
  const first = await call('/api/dispatch/bookings?limit=1&offset=0', 'seam-coop-a');
  const second = await call('/api/dispatch/bookings?limit=1&offset=1', 'seam-coop-a');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.items.length, 1);
  assert.equal(second.body.items.length, 1);
  assert.notEqual(first.body.items[0].id, second.body.items[0].id);
  assert.equal(second.body.limit, 1);
  assert.equal(second.body.offset, 1);
});

test('GET /api/dispatch/bookings: wrong role is 403, missing or unknown token is 401', async () => {
  assert.equal((await call('/api/dispatch/bookings', 'seam-farmer-a')).status, 403);
  assert.equal((await call('/api/dispatch/bookings', 'seam-provider-a')).status, 403);
  assert.equal((await call('/api/dispatch/bookings', 'seam-operator-a')).status, 403);
  assert.equal((await call('/api/dispatch/bookings')).status, 401);
  assert.equal((await call('/api/dispatch/bookings', 'seam-unknown')).status, 401);
});

test('GET /api/dispatch/bookings: invalid pagination is 400', async () => {
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'offset=10001']) {
    const res = await call(`/api/dispatch/bookings?${query}`, 'seam-coop-a');
    assert.equal(res.status, 400, query);
    assert.deepEqual(res.body, { error: { code: 'INVALID_PAGINATION' } }, query);
  }
});

test('GET /api/dispatch/operators: provider sees accepted commitments only, one per job', async () => {
  const res = await call('/api/dispatch/operators', 'seam-provider-a');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, [
    { id: OPERATOR_A, name: 'Synthetic Operator A', startAt: iso(8, 27), endAt: iso(12, 27), jobId: ids.jobA },
    { id: OPERATOR_A, name: 'Synthetic Operator A', startAt: iso(8, 28), endAt: iso(12, 28), jobId: ids.jobB },
  ]);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.offset, 0);
});

test('GET /api/dispatch/operators: declined, withdrawn, open offers and no-role operators are excluded', async () => {
  const res = await call('/api/dispatch/operators', 'seam-provider-a');
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(OPERATOR_B), 'declined or open-offer operator leaked');
  assert.ok(!text.includes(OPERATOR_C), 'withdrawn operator leaked');
  assert.ok(!text.includes(FORMER_OPERATOR), 'operator without live operator role leaked');
  assert.ok(!text.includes('Synthetic Former Operator'));
});

test('GET /api/dispatch/operators: foreign provider sees only own jobs', async () => {
  const res = await call('/api/dispatch/operators', 'seam-provider-b');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, [
    { id: OPERATOR_B, name: 'Synthetic Operator B', startAt: iso(8, 27), endAt: iso(12, 27), jobId: ids.jobOther },
  ]);
});

test('GET /api/dispatch/operators: pagination honored and invalid pagination is 400', async () => {
  const page = await call('/api/dispatch/operators?limit=1&offset=1', 'seam-provider-a');
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.items[0].jobId, ids.jobB);
  for (const query of ['limit=0', 'limit=101', 'offset=10001', 'offset=x']) {
    const res = await call(`/api/dispatch/operators?${query}`, 'seam-provider-a');
    assert.equal(res.status, 400, query);
    assert.deepEqual(res.body, { error: { code: 'INVALID_PAGINATION' } }, query);
  }
});

test('GET /api/dispatch/operators: wrong role is 403, missing or unknown token is 401', async () => {
  assert.equal((await call('/api/dispatch/operators', 'seam-coop-a')).status, 403);
  assert.equal((await call('/api/dispatch/operators', 'seam-farmer-a')).status, 403);
  assert.equal((await call('/api/dispatch/operators', 'seam-operator-a')).status, 403);
  assert.equal((await call('/api/dispatch/operators')).status, 401);
  assert.equal((await call('/api/dispatch/operators', 'seam-unknown')).status, 401);
});
