import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const serviceToken = 'local-contract-test-service-token-00000000';
const password = 'local-contract-test-password';
const fieldInput = { name: 'Demo field', locality: 'Synthetic', areaM2: 12000 };
const missing = '00000000-0000-4000-8000-000000000000';
const inactiveService = '00000000-0000-4000-8000-000000000104';
const serviceId = '00000000-0000-4000-8000-000000000102';
const bookingInput = { serviceId, startAt: '2026-12-06T01:00:00Z', endAt: '2026-12-06T05:00:00Z' };
const servers = [];
let db, pool, accountUrl, bookingUrl, farmer, neighbor, provider, operator;

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(method, path, { token, input, key, url = bookingUrl } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (input !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(url + path, { method, headers, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}

async function register(label, { role, name = label } = {}) {
  const email = `${label}@example.com`;
  const created = await call('POST', '/api/auth/register', { input: { email, password, name } });
  assert.equal(created.status, 201);
  if (role) {
    const id = created.body.user.id;
    // Synthetic actor with only the named role so real role guards can reject it.
    await pool.query("UPDATE account.user_roles SET role = $2 WHERE user_id = $1 AND role = 'farmer'", [id, role]);
  }
  const login = await call('POST', '/api/auth/login', { input: { email, password } });
  assert.equal(login.status, 200);
  return login.body;
}

before(async () => {
  db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  pool = createPool(db.url);
  await migrate(pool);
  await seedCatalog(pool);
  accountUrl = await listen(createAccountApp({ pool, internalServiceToken: serviceToken, log: () => {} }));
  bookingUrl = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: serviceToken, log: () => {} }));
  farmer = await register('farmer');
  neighbor = await register('neighbor');
  provider = await register('provider', { role: 'provider' });
  operator = await register('operator', { role: 'operator' });
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (pool) await pool.end();
  if (db) await db.drop();
});

function expectError(result, status, code, field) {
  assert.deepEqual(result, { status, body: { error: { code, ...(field ? { field } : {}) } } });
}

async function count(table, ownerId) {
  return (await pool.query(`SELECT count(*)::int AS n FROM dispatch.${table} WHERE owner_id = $1`, [ownerId])).rows[0].n;
}

async function createField(token) {
  const created = await call('POST', '/api/fields', { token, input: fieldInput });
  assert.equal(created.status, 201);
  return created.body.field.id;
}

test('fields and bookings return real status/code pairs without storing rejected writes', async () => {
  const { token, user } = farmer;
  const fieldId = await createField(token);
  const input = { ...bookingInput, fieldId };
  const key = 'contract-key-00000001';
  expectError(await call('POST', '/api/fields', { token, input: { ...fieldInput, areaM2: 0 } }), 400, 'VALIDATION_FAILED', 'areaM2');
  expectError(await call('POST', '/api/fields', { token: provider.token, input: fieldInput }), 403, 'FORBIDDEN');
  const detailsPath = `/api/fields/${fieldId}/details`;
  expectError(await call('GET', '/api/fields?limit=0', { token }), 400, 'INVALID_PAGINATION');
  expectError(await call('GET', '/api/fields/not-a-uuid/details', { token }), 400, 'INVALID_ID');
  expectError(await call('GET', detailsPath, { token: neighbor.token }), 404, 'NOT_FOUND');
  const coordinates = [[105.8, 10], [105.801, 10], [105.801, 10.001], [105.8, 10]];
  expectError(await call('PUT', detailsPath, { token, input: { coordinates } }), 403, 'LOCATION_CONSENT_REQUIRED');
  assert.equal(await count('fields', user.id), 1);
  assert.equal(await count('fields', provider.user.id), 0);
  expectError(await call('POST', '/api/bookings', { token, input }), 400, 'VALIDATION_FAILED', 'Idempotency-Key');
  expectError(await call('POST', '/api/bookings', { token, input: { ...input, endAt: input.startAt }, key }), 400, 'VALIDATION_FAILED', 'endAt');
  expectError(await call('POST', '/api/bookings', { token: provider.token, input, key }), 403, 'FORBIDDEN');
  expectError(await call('POST', '/api/bookings', { token: neighbor.token, input, key }), 404, 'NOT_FOUND');
  expectError(await call('POST', '/api/bookings', { token, input: { ...input, fieldId: missing }, key }), 404, 'NOT_FOUND');
  expectError(await call('POST', '/api/bookings', { token, input: { ...input, serviceId: inactiveService }, key }), 404, 'NOT_FOUND');
  assert.equal(await count('bookings', user.id), 0);
  assert.equal(await count('bookings', neighbor.user.id), 0);
  assert.equal(await count('bookings', provider.user.id), 0);
  const created = await call('POST', '/api/bookings', { token, input, key });
  assert.equal(created.status, 201);
  assert.deepEqual(await call('POST', '/api/bookings', { token, input, key }), created);
  expectError(await call('POST', '/api/bookings', { token, input: { ...input, cropVariety: 'Changed' }, key }), 409, 'IDEMPOTENCY_CONFLICT');
  expectError(await call('GET', '/api/bookings/' + created.body.booking.id, { token: neighbor.token }), 404, 'NOT_FOUND');
  assert.equal(await count('bookings', user.id), 1);
});

test('gateway rejects malformed role-request decision paths without forwarding them', async () => {
  const { token } = await register('role-admin', { role: 'admin' });
  const path = '/api/admin/role-requests/not-a-uuid/approve';
  expectError(await call('POST', path, { token, input: {}, url: accountUrl }), 400, 'INVALID_ID');
  expectError(await call('POST', path, { token, input: {} }), 404, 'NOT_FOUND');
  expectError(await call('POST', `/api/admin/role-requests/${missing}/approve`, { token, input: {} }), 404, 'NOT_FOUND');
});

test('clock-expired unrevoked session fails closed on account, gateway and protected writes', async () => {
  const { token, expiresAt, user } = await register('expiry');
  const fieldId = await createField(token);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  assert.equal((await call('GET', '/api/me', { token })).status, 200);
  const before = (await pool.query('SELECT expires_at, revoked_at FROM account.sessions WHERE token_hash = $1', [tokenHash])).rows[0];
  assert.equal(before.expires_at.toISOString(), expiresAt);
  assert.equal(before.revoked_at, null);
  const updated = await pool.query(`UPDATE account.sessions
    SET created_at = now() - interval '2 seconds', expires_at = now()
    WHERE token_hash = $1 RETURNING expires_at <= now() AS expired, revoked_at`, [tokenHash]);
  assert.deepEqual(updated.rows, [{ expired: true, revoked_at: null }]);
  expectError(await call('GET', '/api/me', { token, url: accountUrl }), 401, 'UNAUTHORIZED');
  expectError(await call('GET', '/api/me', { token }), 401, 'UNAUTHORIZED');
  expectError(await call('POST', '/api/fields', { token, input: fieldInput }), 401, 'UNAUTHENTICATED');
  const key = 'contract-expiry-00000001';
  expectError(await call('POST', '/api/bookings', { token, input: { ...bookingInput, fieldId }, key }), 401, 'UNAUTHENTICATED');
  assert.equal(await count('fields', user.id), 1);
  assert.equal(await count('bookings', user.id), 0);
  const idempotency = await pool.query('SELECT idempotency_key FROM dispatch.idempotency_keys WHERE actor_id = $1', [user.id]);
  assert.equal(idempotency.rowCount, 0);
});

function expectNullByteError(result) {
  const { status, body } = result;
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.match(body.error.message, /NUL/);
}

test('JSON guard rejects NUL in job text, nested values and object keys on both services', async () => {
  const { token } = provider;
  const input = { title: 'Demo job', locality: 'Synthetic', capacity: 1, startAt: bookingInput.startAt, endAt: bookingInput.endAt };
  const jobs = () => pool.query('SELECT id FROM dispatch.jobs WHERE provider_id = $1', [provider.user.id]);
  const before = (await jobs()).rows;
  expectNullByteError(await call('POST', '/api/jobs', { token, input: { ...input, title: 'Demo\u0000 job' } }));
  expectNullByteError(await call('POST', '/api/jobs', { token, input: { ...input, requiredSkills: ['Gặt\u0000'] } }));
  assert.deepEqual((await jobs()).rows, before);

  // No token or credentials: the JSON guard must run before auth or route validation.
  const nestedKey = { metadata: [{ ['label\u0000']: 'Demo' }] };
  expectNullByteError(await call('POST', '/api/jobs', { input: nestedKey }));
  expectNullByteError(await call('POST', '/api/auth/login', { input: nestedKey, url: accountUrl }));
});

test('fields reject NUL in PostgreSQL text inputs before writing', async () => {
  const { token, user } = farmer;
  const beforeCount = await count('fields', user.id);
  for (const field of ['name', 'locality']) {
    expectNullByteError(await call('POST', '/api/fields', { token, input: { ...fieldInput, [field]: 'Demo\0 text' } }));
  }
  assert.equal(await count('fields', user.id), beforeCount);
});

test('field creation has no replay contract, even if the caller repeats an idempotency key', async () => {
  const { token, user } = neighbor;
  const beforeCount = await count('fields', user.id);
  const options = { token, input: fieldInput, key: 'field-replay-00000001' };
  const first = await call('POST', '/api/fields', options);
  const second = await call('POST', '/api/fields', options);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.field.id, second.body.field.id);
  assert.equal(await count('fields', user.id), beforeCount + 2);
});

test('bookings reject NUL in crop variety before claiming a key', async () => {
  const fieldId = await createField(neighbor.token);
  const input = { ...bookingInput, fieldId };
  const key = 'contract-crop-00000001';
  expectNullByteError(await call('POST', '/api/bookings', { token: neighbor.token, input: { ...input, cropVariety: 'Rice\0 variety' }, key }));
  assert.equal((await call('POST', '/api/bookings', { token: neighbor.token, input, key })).status, 201);
});

test('shift, acceptance and dispute routes reject NUL in notes before using them', async () => {
  const text = 'Note\0 text';
  expectNullByteError(await call('POST', `/api/shifts/${missing}/pause`, { token: operator.token, input: { reason: text } }));
  expectNullByteError(await call('POST', `/api/bookings/${missing}/acceptance`, { token: provider.token, input: { areaM2: 100, totalVnd: '100', note: text } }));
  expectNullByteError(await call('POST', `/api/bookings/${missing}/disputes`, { token: farmer.token, input: { reason: 'OTHER', details: text } }));
});

test('introspection accepts valid display names using the registration code-point limit', async () => {
  const { token } = await register('unicode', { name: '🌾'.repeat(120) });
  assert.equal((await call('POST', '/api/fields', { token, input: fieldInput })).status, 201);
});
