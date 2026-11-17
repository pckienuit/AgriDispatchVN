import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createCatalogRouter } from '../../src/catalog.js';
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
const PROVIDER_B = '10000000-0000-4000-8000-000000000005';
const OPERATOR_A = '10000000-0000-4000-8000-000000000006';
const ADMIN_A = '10000000-0000-4000-8000-000000000007';
const UNKNOWN_SERVICE = '20000000-0000-4000-8000-0000000000ff';
const SOIL_SERVICE = '00000000-0000-4000-8000-000000000101';
const INACTIVE_SERVICE = '00000000-0000-4000-8000-000000000104';

// TEST SEAM ONLY: fixed bearer tokens mapped to synthetic actors. The parent app supplies the real
// cross-service authenticate middleware; this file never ships as runtime authentication.
const TEST_ACTORS = {
  'seam-farmer-a': { id: FARMER_A, roles: ['farmer'], name: 'Synthetic Farmer A' },
  'seam-farmer-b': { id: FARMER_B, roles: ['farmer'], name: 'Synthetic Farmer B' },
  'seam-coop-a': { id: COOP_A, roles: ['coop'], name: 'Synthetic Coop A' },
  'seam-provider-a': { id: PROVIDER_A, roles: ['provider'], name: 'Synthetic Provider A' },
  'seam-provider-b': { id: PROVIDER_B, roles: ['provider'], name: 'Synthetic Provider B' },
  'seam-operator-a': { id: OPERATOR_A, roles: ['operator'], name: 'Synthetic Operator A' },
  'seam-admin-a': { id: ADMIN_A, roles: ['admin'], name: 'Synthetic Admin A' },
};

function testSeamAuthenticate(req, res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!Object.hasOwn(TEST_ACTORS, token)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = TEST_ACTORS[token];
  next();
}

const ctx = {};

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  ctx.applied = await migrate(ctx.pool);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(createCatalogRouter({ pool: ctx.pool, authenticate: testSeamAuthenticate }));
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  ctx.server = app.listen(0, '127.0.0.1');
  await once(ctx.server, 'listening');
  ctx.url = `http://127.0.0.1:${ctx.server.address().port}`;
});

after(async () => {
  if (ctx.server) await new Promise((resolve, reject) => ctx.server.close((error) => (error ? reject(error) : resolve())));
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${ctx.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function count(sql, params = []) {
  return Number((await ctx.pool.query(sql, params)).rows[0].n);
}

test('migration 002 creates dispatch tables, indexes and no pretend identity FK', async () => {
  assert.ok(ctx.applied.includes('002_catalog.sql'));
  assert.deepEqual(await migrate(ctx.pool), []);
  const tables = (await ctx.pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'dispatch' ORDER BY table_name",
  )).rows.map((row) => row.table_name);
  assert.deepEqual(tables, ['fields', 'machines', 'services']);
  const indexes = (await ctx.pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'dispatch' ORDER BY indexname")).rows.map((row) => row.indexname);
  for (const name of ['fields_owner_created_idx', 'machines_owner_created_idx', 'services_active_order_idx']) {
    assert.ok(indexes.includes(name), name);
  }
  assert.equal(await count("SELECT count(*)::text AS n FROM information_schema.table_constraints WHERE table_schema = 'dispatch' AND constraint_type = 'FOREIGN KEY'"), 0);
});

test('direct SQL rejects invalid catalog and asset rows', async () => {
  const cases = [
    ["INSERT INTO dispatch.services (id, code, name, price_per_ha_vnd, data_label) VALUES ('30000000-0000-4000-8000-000000000001', 'zero-price', 'x', 0, 'synthetic')", '23514'],
    ["INSERT INTO dispatch.services (id, code, name, price_per_ha_vnd, data_label) VALUES ('30000000-0000-4000-8000-000000000002', 'bad-label', 'x', 1, 'live')", '23514'],
    ["INSERT INTO dispatch.services (id, code, name, price_per_ha_vnd, data_label) VALUES ('30000000-0000-4000-8000-000000000003', 'Bad Code', 'x', 1, 'synthetic')", '23514'],
    [`INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ('${FARMER_A}', 'x', 'y', 0)`, '23514'],
    [`INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ('${FARMER_A}', 'x', 'y', 10000001)`, '23514'],
    [`INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ('${FARMER_A}', '   ', 'y', 10)`, '23514'],
    ["INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES (NULL, 'x', 'y', 10)", '23502'],
    [`INSERT INTO dispatch.machines (owner_id, name, machine_type) VALUES ('${PROVIDER_A}', 'm', 'boat')`, '23514'],
    [`INSERT INTO dispatch.machines (owner_id, name, machine_type, status) VALUES ('${PROVIDER_A}', 'm', 'drone', 'retired')`, '23514'],
    ["INSERT INTO dispatch.machines (owner_id, name, machine_type) VALUES (NULL, 'm', 'drone')", '23502'],
  ];
  for (const [sql, code] of cases) {
    await assert.rejects(ctx.pool.query(sql), (error) => error.code === code, sql);
  }
});

test('seed inserts synthetic services, reruns keep counts and operational rows', async () => {
  await ctx.pool.query(`INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ('${FARMER_A}', 'Seed survivor', 'Cần Thơ', 500)`);
  const first = await seedCatalog(ctx.pool);
  assert.deepEqual(first, { services: 4, activeServices: 3 });
  // Operator edits a seeded row; rerun must restore the predictable seed values without truncating.
  await ctx.pool.query("UPDATE dispatch.services SET name = 'edited' WHERE id = $1", [SOIL_SERVICE]);
  const second = await seedCatalog(ctx.pool);
  assert.deepEqual(second, first);
  assert.equal((await ctx.pool.query('SELECT name FROM dispatch.services WHERE id = $1', [SOIL_SERVICE])).rows[0].name, 'Cày, xới đất bằng máy kéo (giả lập)');
  assert.equal(await count("SELECT count(*)::text AS n FROM dispatch.services WHERE data_label = 'synthetic'"), 4);
  assert.equal(await count("SELECT count(*)::text AS n FROM dispatch.fields WHERE name = 'Seed survivor'"), 1);
  assert.equal((await ctx.pool.query('SELECT price_per_ha_vnd::text AS price FROM dispatch.services WHERE id = $1', [SOIL_SERVICE])).rows[0].price, '900000');
});

test('public services list is active only, bounded and paginated', async () => {
  const all = await call('/api/services');
  assert.equal(all.status, 200);
  assert.equal(all.body.limit, 20);
  assert.equal(all.body.offset, 0);
  assert.equal(all.body.items.length, 3);
  assert.ok(all.body.items.every((item) => /^\d+$/.test(item.pricePerHaVnd) && item.dataLabel === 'synthetic'));
  assert.equal(all.body.items.some((item) => item.id === INACTIVE_SERVICE), false);
  const page1 = await call('/api/services?limit=2&offset=0');
  const page2 = await call('/api/services?limit=2&offset=2');
  assert.equal(page1.body.items.length, 2);
  assert.equal(page2.body.items.length, 1);
  assert.deepEqual([...page1.body.items, ...page2.body.items].map((item) => item.id), all.body.items.map((item) => item.id));
  for (const path of ['/api/services?limit=101', '/api/services?offset=10001', '/api/services?limit=-1']) {
    assert.deepEqual(await call(path), { status: 400, body: { error: { code: 'INVALID_PAGINATION' } } }, path);
  }
});

test('service detail returns active rows and hides inactive, missing and malformed IDs', async () => {
  const active = await call(`/api/services/${SOIL_SERVICE}`);
  assert.equal(active.status, 200);
  assert.equal(active.body.service.pricePerHaVnd, '900000');
  assert.deepEqual(await call(`/api/services/${INACTIVE_SERVICE}`), { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.deepEqual(await call(`/api/services/${UNKNOWN_SERVICE}`), { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.deepEqual(await call('/api/services/not-a-uuid'), { status: 400, body: { error: { code: 'INVALID_ID' } } });
});

test('farmer and coop see only their own fields, with bounded pagination', async () => {
  const created = [];
  for (const area of [100, 200, 300]) {
    const response = await call('/api/fields', { method: 'POST', token: 'seam-farmer-a', body: { name: `Ruộng ${area}`, locality: 'Châu Thành', areaM2: area } });
    assert.equal(response.status, 201);
    assert.equal(response.body.field.areaM2, area);
    created.push(response.body.field.id);
  }
  const other = await call('/api/fields', { method: 'POST', token: 'seam-farmer-b', body: { name: 'Ruộng B', locality: 'Phụng Hiệp', areaM2: 400 } });
  assert.equal(other.status, 201);
  const rows = await ctx.pool.query('SELECT id, owner_id FROM dispatch.fields WHERE id = ANY($1::uuid[])', [created]);
  assert.ok(rows.rows.every((row) => row.owner_id === FARMER_A));

  const listed = await call('/api/fields', { token: 'seam-farmer-a' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 4);
  assert.equal(listed.body.items.some((item) => item.id === other.body.field.id), false);
  const page = await call('/api/fields?limit=2&offset=3', { token: 'seam-farmer-a' });
  assert.equal(page.body.items.length, 1);
  assert.deepEqual(await call('/api/fields?limit=101', { token: 'seam-farmer-a' }), { status: 400, body: { error: { code: 'INVALID_PAGINATION' } } });

  const coopBefore = await call('/api/fields', { token: 'seam-coop-a' });
  assert.deepEqual(coopBefore.body.items, []);
  const coopField = await call('/api/fields', { method: 'POST', token: 'seam-coop-a', body: { name: 'HTX lô 1', locality: 'Long Hồ', areaM2: 5000 } });
  assert.equal(coopField.status, 201);
  const coopAfter = await call('/api/fields', { token: 'seam-coop-a' });
  assert.deepEqual(coopAfter.body.items.map((item) => item.id), [coopField.body.field.id]);
});

test('field writes reject privilege injection, bad area and wrong roles before persisting', async () => {
  const before = await count('SELECT count(*)::text AS n FROM dispatch.fields');
  const valid = { name: 'Lô kiểm thử', locality: 'Vĩnh Thạnh', areaM2: 1000 };
  assert.deepEqual(await call('/api/fields', { method: 'POST', token: 'seam-farmer-a', body: { ...valid, ownerId: FARMER_B } }),
    { status: 400, body: { error: { code: 'UNKNOWN_FIELD' } } });
  assert.deepEqual(await call('/api/fields', { method: 'POST', token: 'seam-farmer-a', body: { ...valid, roles: ['admin'] } }),
    { status: 400, body: { error: { code: 'UNKNOWN_FIELD' } } });
  assert.deepEqual(await call('/api/fields', { method: 'POST', token: 'seam-farmer-a', body: { ...valid, areaM2: '1000' } }),
    { status: 400, body: { error: { code: 'VALIDATION_FAILED', field: 'areaM2' } } });
  assert.deepEqual(await call('/api/fields', { method: 'POST', token: 'seam-farmer-a', body: { ...valid, areaM2: 10000001 } }),
    { status: 400, body: { error: { code: 'VALIDATION_FAILED', field: 'areaM2' } } });
  assert.equal((await call('/api/fields', { method: 'POST', token: 'seam-provider-a', body: valid })).status, 403);
  assert.equal((await call('/api/fields', { method: 'POST', token: 'seam-admin-a', body: valid })).status, 403);
  assert.equal((await call('/api/fields', { method: 'POST', body: valid })).status, 401);
  assert.equal((await call('/api/fields', { token: 'seam-operator-a' })).status, 403);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.fields'), before);

  const boundary = await call('/api/fields', { method: 'POST', token: 'seam-farmer-a', body: { ...valid, areaM2: 10000000 } });
  assert.equal(boundary.status, 201);
});

test('provider owns machines, status stays server-controlled and lists are scoped', async () => {
  const harvester = await call('/api/machines', { method: 'POST', token: 'seam-provider-a', body: { name: 'Máy gặt 01', type: 'harvester' } });
  assert.equal(harvester.status, 201);
  assert.deepEqual(Object.keys(harvester.body.machine).sort(), ['createdAt', 'id', 'name', 'status', 'type']);
  assert.equal(harvester.body.machine.status, 'available');
  assert.equal(harvester.body.machine.type, 'harvester');
  assert.equal((await call('/api/machines', { method: 'POST', token: 'seam-provider-a', body: { name: 'Drone 01', type: 'drone' } })).status, 201);
  assert.deepEqual(await call('/api/machines', { method: 'POST', token: 'seam-provider-a', body: { name: 'Máy lạ', type: 'boat' } }),
    { status: 400, body: { error: { code: 'VALIDATION_FAILED', field: 'type' } } });
  assert.deepEqual(await call('/api/machines', { method: 'POST', token: 'seam-provider-a', body: { name: 'Máy', type: 'tractor', status: 'unavailable' } }),
    { status: 400, body: { error: { code: 'UNKNOWN_FIELD' } } });
  assert.equal((await call('/api/machines', { method: 'POST', token: 'seam-admin-a', body: { name: 'x', type: 'tractor' } })).status, 403);
  assert.equal((await call('/api/machines', { method: 'POST', token: 'seam-farmer-a', body: { name: 'x', type: 'tractor' } })).status, 403);
  assert.equal((await call('/api/machines', { method: 'POST', body: { name: 'x', type: 'tractor' } })).status, 401);

  await call('/api/machines', { method: 'POST', token: 'seam-provider-b', body: { name: 'Máy B', type: 'tractor' } });
  const mine = await call('/api/machines', { token: 'seam-provider-a' });
  assert.equal(mine.body.items.length, 2);
  assert.equal(mine.body.items.some((item) => item.name === 'Máy B'), false);
  const theirs = await call('/api/machines', { token: 'seam-provider-b' });
  assert.deepEqual(theirs.body.items.map((item) => item.name), ['Máy B']);
  const page = await call('/api/machines?limit=1&offset=1', { token: 'seam-provider-a' });
  assert.equal(page.body.items.length, 1);
  assert.equal((await call('/api/machines', { token: 'seam-farmer-a' })).status, 403);
  assert.equal((await call('/api/machines', { token: 'seam-admin-a' })).status, 403);
});

test('unreachable database returns 503 DB_UNAVAILABLE on real connection failure', async () => {
  const deadPool = createPool('postgresql://agridispatch:disposable_test_only@127.0.0.1:1/unreachable_test');
  const app = express().use(createCatalogRouter({ pool: deadPool, authenticate: testSeamAuthenticate }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/services`);
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(text), { error: { code: 'DB_UNAVAILABLE' } });
    assert.equal(text.includes('127.0.0.1'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await deadPool.end();
  }
});
