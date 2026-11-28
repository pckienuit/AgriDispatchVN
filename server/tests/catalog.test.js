import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import {
  MAX_FIELD_AREA_M2,
  createCatalogRouter,
  parsePagination,
  validateFieldInput,
  validateMachineInput,
} from '../src/catalog.js';
import { assertSeedAllowed } from '../scripts/seed-catalog.js';
import { parseRootDatabaseUrl } from './helpers/catalog-db.js';

const FARMER_ID = '11111111-1111-4111-8111-111111111111';
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

// TEST SEAM ONLY: static bearer tokens stand in for the parent's cross-service auth.
// Never used as runtime authentication.
function testAuthenticate(req, res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  const actors = {
    'tok-farmer': { id: FARMER_ID, roles: ['farmer'], name: 'Farmer' },
    'tok-provider': { id: PROVIDER_ID, roles: ['provider'], name: 'Provider' },
    'tok-no-actor': null,
  };
  if (!Object.hasOwn(actors, token)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  if (actors[token]) req.actor = actors[token];
  next();
}

function appWith(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(createCatalogRouter({ pool, authenticate: testAuthenticate }));
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  return app;
}

async function serve(t, pool) {
  const server = appWith(pool).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return `http://127.0.0.1:${server.address().port}`;
}

function noDbPool() {
  const calls = [];
  return {
    calls,
    async query(...args) {
      calls.push(args);
      throw new Error('DB must not be queried');
    },
  };
}

test('router factory requires a pool and an authenticate middleware', () => {
  assert.throws(() => createCatalogRouter({ authenticate: testAuthenticate }), TypeError);
  assert.throws(() => createCatalogRouter({ pool: {}, authenticate: testAuthenticate }), TypeError);
  assert.throws(() => createCatalogRouter({ pool: noDbPool() }), TypeError);
});

test('pagination defaults to limit 20 offset 0 and enforces bounds', () => {
  assert.deepEqual(parsePagination({}), { limit: 20, offset: 0 });
  assert.deepEqual(parsePagination({ limit: '100', offset: '10000' }), { limit: 100, offset: 10000 });
  for (const query of [
    { limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '-1' }, { limit: 'x' }, { limit: '' },
    { limit: ['1', '2'] }, { offset: '10001' }, { offset: '-1' }, { offset: '' },
  ]) {
    assert.throws(() => parsePagination(query), { status: 400, code: 'INVALID_PAGINATION' }, JSON.stringify(query));
  }
});

test('field input is trimmed, area must be a safe positive integer within the demo bound', () => {
  const valid = { name: '  Ruộng A  ', locality: 'Cần Thơ', areaM2: 12000 };
  assert.deepEqual(validateFieldInput(valid), { name: 'Ruộng A', locality: 'Cần Thơ', areaM2: 12000 });
  assert.equal(validateFieldInput({ ...valid, areaM2: MAX_FIELD_AREA_M2 }).areaM2, MAX_FIELD_AREA_M2);
  for (const areaM2 of [0, -5, 1.5, '12000', null, MAX_FIELD_AREA_M2 + 1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateFieldInput({ ...valid, areaM2 }), { status: 400, code: 'VALIDATION_FAILED', field: 'areaM2' }, String(areaM2));
  }
  for (const patch of [{ name: '   ' }, { name: 'x'.repeat(121) }, { name: 42 }, { locality: '' }, { locality: 'x'.repeat(201) }]) {
    assert.throws(() => validateFieldInput({ ...valid, ...patch }), { status: 400, code: 'VALIDATION_FAILED' });
  }
});

test('field and machine input reject privilege-carrying keys', () => {
  assert.throws(() => validateFieldInput({ name: 'A', locality: 'B', areaM2: 1, ownerId: OTHER_ID }), { status: 400, code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateFieldInput({ name: 'A', locality: 'B', areaM2: 1, roles: ['admin'] }), { status: 400, code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateMachineInput({ name: 'M', type: 'drone', status: 'retired' }), { status: 400, code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateMachineInput({ name: 'M', type: 'drone', ownerId: OTHER_ID }), { status: 400, code: 'UNKNOWN_FIELD' });
});

test('machine type is limited to harvester, tractor or drone', () => {
  for (const type of ['harvester', 'tractor', 'drone']) {
    assert.deepEqual(validateMachineInput({ name: 'Máy 01', type }), { name: 'Máy 01', type });
  }
  for (const type of ['boat', 'Tractor', '', undefined]) {
    assert.throws(() => validateMachineInput({ name: 'Máy 01', type }), { status: 400, code: 'VALIDATION_FAILED', field: 'type' });
  }
});

test('protected routes fail closed and invalid requests fail before any DB query', async (t) => {
  const pool = noDbPool();
  const url = await serve(t, pool);
  const cases = [
    ['GET', '/api/fields', undefined, 401, 'UNAUTHENTICATED'],
    ['GET', '/api/fields', 'tok-no-actor', 401, 'UNAUTHENTICATED'],
    ['GET', '/api/fields', 'tok-bad', 401, 'UNAUTHENTICATED'],
    ['GET', '/api/machines', 'tok-farmer', 403, 'FORBIDDEN'],
    ['POST', '/api/machines', 'tok-farmer', 403, 'FORBIDDEN'],
    ['POST', '/api/fields', 'tok-provider', 403, 'FORBIDDEN'],
    ['GET', '/api/services/not-a-uuid', undefined, 400, 'INVALID_ID'],
    ['GET', '/api/services?limit=0', undefined, 400, 'INVALID_PAGINATION'],
    ['GET', '/api/fields?limit=500', 'tok-farmer', 400, 'INVALID_PAGINATION'],
  ];
  for (const [method, path, token, status, code] of cases) {
    const response = await fetch(`${url}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, status, `${method} ${path} ${token}`);
    assert.deepEqual(await response.json(), { error: { code } });
  }
  const post = (body, extra = {}) => fetch(`${url}/api/fields`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-farmer', 'content-type': 'application/json', ...extra },
    body,
  });
  const valid = { name: 'A', locality: 'B', areaM2: 100 };
  let response = await post(JSON.stringify({ ...valid, ownerId: OTHER_ID }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'UNKNOWN_FIELD' } });
  response = await post(JSON.stringify({ ...valid, areaM2: 0 }));
  assert.deepEqual(await response.json(), { error: { code: 'VALIDATION_FAILED', field: 'areaM2' } });
  response = await fetch(`${url}/api/fields`, { method: 'POST', headers: { authorization: 'Bearer tok-farmer', 'content-type': 'text/plain' }, body: 'plain' });
  assert.deepEqual(await response.json(), { error: { code: 'INVALID_BODY' } });
  response = await fetch(`${url}/api/machines`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-provider', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'M', type: 'boat' }),
  });
  assert.deepEqual(await response.json(), { error: { code: 'VALIDATION_FAILED', field: 'type' } });
  assert.deepEqual(pool.calls, []);
});

test('DB connection outage maps to 503 without leaking host details', async (t) => {
  const pool = {
    async query() {
      throw Object.assign(new Error('connect ECONNREFUSED 10.9.8.7:5432'), { code: 'ECONNREFUSED' });
    },
  };
  const url = await serve(t, pool);
  const read = await fetch(`${url}/api/services`);
  const text = await read.text();
  assert.equal(read.status, 503);
  assert.deepEqual(JSON.parse(text), { error: { code: 'DB_UNAVAILABLE' } });
  assert.equal(text.includes('10.9.8.7'), false);
  const write = await fetch(`${url}/api/fields`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-farmer', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'A', locality: 'B', areaM2: 100 }),
  });
  assert.equal(write.status, 503);
});

test('unexpected DB errors are not reported as outages', async (t) => {
  const pool = { async query() { throw Object.assign(new Error('syntax'), { code: '42601' }); } };
  const url = await serve(t, pool);
  const response = await fetch(`${url}/api/services`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR' } });
});

test('seed gate refuses production, non-local hosts and unconfirmed runs', () => {
  const local = { DATABASE_URL: 'postgresql://app:pw@127.0.0.1:5432/agridispatch', SEED_CATALOG_CONFIRM: 'local-synthetic' };
  assert.equal(assertSeedAllowed(local), '127.0.0.1');
  assert.throws(() => assertSeedAllowed({ ...local, DATABASE_URL: local.DATABASE_URL + '?host=db.example.net' }), { code: 'SEED_REFUSED' });
  assert.throws(() => assertSeedAllowed({ ...local, NODE_ENV: 'production' }), { code: 'SEED_REFUSED' });
  assert.throws(() => assertSeedAllowed({ ...local, DATABASE_URL: 'postgresql://app:pw@db.example.net:5432/agridispatch' }), { code: 'SEED_REFUSED' });
  assert.throws(() => assertSeedAllowed({ ...local, DATABASE_URL: 'not a url' }), { code: 'SEED_REFUSED' });
  assert.throws(() => assertSeedAllowed({ DATABASE_URL: local.DATABASE_URL }), { code: 'SEED_NOT_CONFIRMED' });
  assert.throws(() => assertSeedAllowed({ ...local, SEED_CATALOG_CONFIRM: 'yes' }), { code: 'SEED_NOT_CONFIRMED' });
});

test('disposable database root must be a PostgreSQL URL naming a *_test database', () => {
  assert.equal(parseRootDatabaseUrl('postgresql://app:pw@127.0.0.1:55432/agridispatch_test').database, 'agridispatch_test');
  for (const root of [
    undefined,
    '',
    'mysql://app:pw@127.0.0.1/agridispatch_test',
    'postgresql://app:pw@127.0.0.1:55432/agridispatch',
    'postgresql://app:pw@127.0.0.1:55432/',
    'postgresql://app:pw@127.0.0.1:55432/_test',
    'postgresql://app:pw@127.0.0.1:55432/a/b_test',
    'postgresql://app:pw@127.0.0.1:55432/x%22_test',
    'postgresql:///agridispatch_test',
    'postgresql://app:p@127.0.0.1:55432/agridispatch_test?host=db.example.net',
    'postgresql://app:p@127.0.0.1:55432/agridispatch_test?dbname=production',
    'postgresql://app:pw@db.example.net:5432/agridispatch_test',
    'postgresql://app:pw@10.0.0.5:5432/agridispatch_test',
  ]) {
    assert.throws(() => parseRootDatabaseUrl(root), Error, String(root));
  }
});

test('service list cache serves repeats from memory until the TTL ends, per page, and is off by default', async (t) => {
  const row = (name) => ({ id: '00000000-0000-4000-8000-000000000101', code: 'tillage-tractor', name, price_per_ha_vnd: '900000', data_label: 'synthetic' });
  let queries = 0;
  let name = 'v1';
  const pool = { async query() { queries += 1; return { rows: [row(name)] }; } };
  let clock = 1000;
  const listen = async (router) => {
    const app = express();
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const cachedUrl = await listen(createCatalogRouter({ pool, authenticate: testAuthenticate, servicesCacheMs: 30000, now: () => clock }));
  const names = async (path) => (await (await fetch(cachedUrl + path)).json()).items.map((item) => item.name);

  assert.deepEqual(await names('/api/services'), ['v1']);
  name = 'v2';
  assert.deepEqual(await names('/api/services'), ['v1'], 'within TTL the cached body is served');
  assert.equal(queries, 1);
  assert.deepEqual(await names('/api/services?limit=5'), ['v2'], 'each page has its own entry');
  assert.equal(queries, 2);
  clock += 30001;
  assert.deepEqual(await names('/api/services'), ['v2'], 'after TTL the list is read again');
  assert.equal(queries, 3);

  queries = 0;
  const plainUrl = await listen(createCatalogRouter({ pool, authenticate: testAuthenticate }));
  await fetch(plainUrl + '/api/services');
  await fetch(plainUrl + '/api/services');
  assert.equal(queries, 2, 'default servicesCacheMs is 0, every request reads the DB');

  for (const servicesCacheMs of [-1, 1.5, 300001, '30000']) {
    assert.throws(() => createCatalogRouter({ pool, authenticate: testAuthenticate, servicesCacheMs }), TypeError);
  }
});

test('failed service list reads are not cached', async (t) => {
  let fail = true;
  const pool = { async query() { if (fail) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); return { rows: [] }; } };
  const app = express();
  app.use(createCatalogRouter({ pool, authenticate: testAuthenticate, servicesCacheMs: 30000 }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/services`;
  assert.equal((await fetch(url)).status, 503);
  fail = false;
  assert.equal((await fetch(url)).status, 200);
});
