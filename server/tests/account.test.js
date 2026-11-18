import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAccountApp } from '../src/account-app.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { readAccountConfig } from '../src/account-server.js';
import { deriveClientIdentityKey, signClientIdentity } from '../src/client-identity.js';

const SECRET = 'x'.repeat(32);
const DATABASE_URL = 'postgresql://user:local_test_only@localhost/accounts';

test('password hashes use a versioned scrypt format with a fresh salt', async () => {
  const first = await hashPassword('correct horse battery');
  const second = await hashPassword('correct horse battery');
  assert.match(first, /^scrypt:v1:N=16384:r=8:p=1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{86}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('correct horse battery', first), true);
  assert.equal(await verifyPassword('correct horse battery!', first), false);
});

test('malformed, foreign or weaker stored hashes never verify', async () => {
  const stored = [
    '',
    'plain-text',
    `scrypt:v2:N=16384:r=8:p=1:${'a'.repeat(22)}:${'a'.repeat(86)}`,
    `scrypt:v1:N=1024:r=8:p=1:${'a'.repeat(22)}:${'a'.repeat(86)}`,
  ];
  for (const value of stored) {
    assert.equal(await verifyPassword('correct horse battery', value), false);
  }
});

test('account config requires an adequate internal secret without echoing it', () => {
  assert.throws(() => readAccountConfig({ DATABASE_URL }), /INTERNAL_SERVICE_TOKEN/);
  const short = 'short-secret-value';
  assert.throws(
    () => readAccountConfig({ DATABASE_URL, INTERNAL_SERVICE_TOKEN: short }),
    (error) => /INTERNAL_SERVICE_TOKEN/.test(error.message) && !error.message.includes(short),
  );
  const config = readAccountConfig({ DATABASE_URL, INTERNAL_SERVICE_TOKEN: SECRET });
  assert.deepEqual(config, { port: 3001, databaseUrl: DATABASE_URL, internalServiceToken: SECRET, sessionTtlSeconds: 28800, requireSignedClientIdentity: false });
  assert.equal(readAccountConfig({ DATABASE_URL, INTERNAL_SERVICE_TOKEN: SECRET, REQUIRE_SIGNED_CLIENT_IDENTITY: 'true' }).requireSignedClientIdentity, true);
  assert.throws(() => readAccountConfig({ DATABASE_URL, INTERNAL_SERVICE_TOKEN: SECRET, REQUIRE_SIGNED_CLIENT_IDENTITY: 'yes' }), /REQUIRE_SIGNED_CLIENT_IDENTITY/);
});

test('session TTL and port are bounded', () => {
  const env = { DATABASE_URL, INTERNAL_SERVICE_TOKEN: SECRET };
  for (const SESSION_TTL_SECONDS of ['59', '86401', '3600.5', 'abc', '']) {
    assert.throws(() => readAccountConfig({ ...env, SESSION_TTL_SECONDS }), /SESSION_TTL_SECONDS/);
  }
  assert.equal(readAccountConfig({ ...env, SESSION_TTL_SECONDS: '3600' }).sessionTtlSeconds, 3600);
  assert.throws(() => readAccountConfig({ ...env, PORT: '0' }), /PORT/);
});

const SECRET_FOR_APP = 'x'.repeat(32);
const noDb = {
  query() { throw new Error('must not query'); },
  connect() { throw new Error('must not connect'); },
};

async function serve(t, options) {
  const server = createAccountApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('registration rejects role fields and invalid shapes before touching the DB', async (t) => {
  const url = await serve(t, { pool: noDb, internalServiceToken: SECRET_FOR_APP });
  const valid = { email: 'farmer@example.com', password: 'correct horse battery', name: 'Nguyen Van An' };
  const bad = [
    { ...valid, roles: ['admin'] },
    { ...valid, role: 'admin' },
    { ...valid, email: 'not-an-email' },
    { ...valid, password: 'short' },
    { ...valid, password: 'x'.repeat(129) },
    { ...valid, name: '' },
    { ...valid, name: 'n'.repeat(121) },
    { email: valid.email, password: valid.password },
    [valid],
  ];
  for (const body of bad) {
    const response = await post(url, '/api/auth/register', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_REQUEST' } });
  }
  const proto = await post(url, '/api/auth/register', '{"email":"farmer@example.com","password":"correct horse battery","name":"A","__proto__":{"roles":["admin"]}}');
  assert.equal(proto.status, 400);
});

test('login rejects extra fields and oversized passwords before DB work', async (t) => {
  const url = await serve(t, { pool: noDb, internalServiceToken: SECRET_FOR_APP });
  for (const body of [{ email: 'a@example.com', password: 'x', roles: ['admin'] }, { email: 'a@example.com', password: 'x'.repeat(129) }, { email: 'a@example.com' }]) {
    const response = await post(url, '/api/auth/login', body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_REQUEST' } });
  }
});

test('protected routes reject missing or malformed bearer tokens without DB access', async (t) => {
  const url = await serve(t, { pool: noDb, internalServiceToken: SECRET_FOR_APP });
  const headerSets = [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer short' }, { authorization: `Bearer ${'a'.repeat(43)} extra` }];
  for (const headers of headerSets) {
    for (const [method, path] of [['GET', '/api/me'], ['POST', '/api/auth/logout']]) {
      const response = await fetch(`${url}${path}`, { method, headers });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: { code: 'UNAUTHORIZED' } });
    }
  }
});

test('introspection requires the exact service credential and rejects malformed tokens without DB access', async (t) => {
  const url = await serve(t, { pool: noDb, internalServiceToken: SECRET_FOR_APP });
  for (const headers of [{}, { 'x-service-token': 'wrong' }, { 'x-service-token': `${SECRET_FOR_APP}x` }]) {
    const response = await post(url, '/internal/introspect', { token: 'a'.repeat(43) }, headers);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { code: 'SERVICE_FORBIDDEN' } });
  }
  const malformed = await post(url, '/internal/introspect', { token: 'short' }, { 'x-service-token': SECRET_FOR_APP });
  assert.equal(malformed.status, 401);
  assert.deepEqual(await malformed.json(), { error: { code: 'UNAUTHORIZED' } });
});

test('database outage returns 503 without leaking driver details', async (t) => {
  const failing = {
    async query() { throw new Error('private-db-host password=secret'); },
    async connect() { throw new Error('private-db-host'); },
  };
  const url = await serve(t, { pool: failing, internalServiceToken: SECRET_FOR_APP });
  const register = await post(url, '/api/auth/register', { email: 'farmer@example.com', password: 'correct horse battery', name: 'A' });
  assert.equal(register.status, 503);
  const login = await post(url, '/api/auth/login', { email: 'farmer@example.com', password: 'correct horse battery' });
  assert.equal(login.status, 503);
  const text = (await register.text()) + (await login.text());
  assert.equal(text.includes('private-db-host'), false);
  assert.equal(text.includes('secret'), false);
});

test('readiness reports unavailable when account schema query fails', async (t) => {
  const failing = { async query() { throw new Error('relation account.users does not exist'); }, async connect() { throw new Error('DB unavailable'); } };
  const url = await serve(t, { pool: failing, internalServiceToken: SECRET_FOR_APP });
  const response = await fetch(`${url}/ready`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable' });
  const live = await fetch(`${url}/health`);
  assert.equal(live.status, 200);
});

test('oversized and malformed JSON fail with bounded codes', async (t) => {
  const url = await serve(t, { pool: noDb, internalServiceToken: SECRET_FOR_APP });
  const invalid = await post(url, '/api/auth/register', '{');
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: { code: 'INVALID_JSON' } });
  const large = await post(url, '/api/auth/register', { name: 'x'.repeat(70000) });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { error: { code: 'PAYLOAD_TOO_LARGE' } });
});

test('app refuses weak internal credential and unbounded session TTL without echoing secrets', () => {
  assert.throws(() => createAccountApp({ pool: noDb, internalServiceToken: 'short-secret-value' }), (error) => /INTERNAL_SERVICE_TOKEN/.test(error.message) && !error.message.includes('short-secret-value'));
  assert.throws(() => createAccountApp({ pool: noDb, internalServiceToken: SECRET_FOR_APP, sessionTtlSeconds: 10 }), /SESSION_TTL_SECONDS/);
});

const ENTRY = fileURLToPath(new URL('../src/account-server.js', import.meta.url));

test('account process refuses to start without an adequate internal secret', async () => {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, DATABASE_URL, PORT: '31881' } });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(stderr, /Account startup failed/);
  assert.doesNotMatch(stderr, /local_test_only/);
});

test('account process drains HTTP and exits 0 on SIGTERM', { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://test:local_test_only@127.0.0.1:1/accounts', INTERNAL_SERVICE_TOKEN: SECRET_FOR_APP, PORT: '31882' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => { if (data.toString().includes('listening')) resolve(); });
    child.on('exit', () => reject(new Error('account process exited before listening')));
    child.on('error', reject);
  });
  const health = await fetch('http://127.0.0.1:31882/health');
  assert.equal(health.status, 200);
  child.kill('SIGTERM');
  const [code, signal] = await exit;
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test('account app rejects invalid, expired, partial or mismatched signed client identity headers with 400 before DB work', async (t) => {
  const url = await serve(t, { pool: noDb, internalServiceToken: SECRET_FOR_APP });
  const key = deriveClientIdentityKey(SECRET_FOR_APP);
  const validLoginHeaders = signClientIdentity({
    key,
    address: '203.0.113.9',
    method: 'POST',
    path: '/api/auth/login',
    requestId: 'trace-id-0001',
  });
  const expiredHeaders = signClientIdentity({
    key,
    address: '203.0.113.9',
    method: 'POST',
    path: '/api/auth/login',
    requestId: 'trace-id-0001',
    timestampMs: Date.now() - 61_000,
  });
  const wrongPathHeaders = signClientIdentity({
    key,
    address: '203.0.113.9',
    method: 'POST',
    path: '/api/auth/register',
    requestId: 'trace-id-0001',
  });
  const wrongMethodHeaders = signClientIdentity({
    key,
    address: '203.0.113.9',
    method: 'POST',
    path: '/api/me',
    requestId: 'trace-id-0001',
  });

  for (const headers of [
    { 'X-Client-Address': '203.0.113.9' },
    { ...validLoginHeaders, 'X-Client-Signature': '0'.repeat(64) },
    { ...validLoginHeaders, 'X-Client-Address': '1'.repeat(101) },
    { ...expiredHeaders, 'X-Request-ID': 'trace-id-0001' },
    { ...wrongPathHeaders, 'X-Request-ID': 'trace-id-0001' },
    { ...validLoginHeaders, 'X-Request-ID': 'different-trace-id' },
  ]) {
    const response = await post(url, '/api/auth/login', { email: 'a@example.com', password: 'correct horse battery' }, headers);
    assert.equal(response.status, 400, JSON.stringify(headers));
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_CLIENT_IDENTITY' } });
  }

  const meMismatch = await fetch(`${url}/api/me`, {
    method: 'GET',
    headers: { ...wrongMethodHeaders, 'X-Request-ID': 'trace-id-0001', authorization: `Bearer ${'a'.repeat(43)}` },
  });
  assert.equal(meMismatch.status, 400);
  assert.deepEqual(await meMismatch.json(), { error: { code: 'INVALID_CLIENT_IDENTITY' } });
});

test('account app can require signed client identity on /api/* while keeping /health open', async (t) => {
  assert.throws(
    () => createAccountApp({ pool: noDb, internalServiceToken: SECRET_FOR_APP, requireSignedClientIdentity: 'yes' }),
    /requireSignedClientIdentity/,
  );
  const url = await serve(t, { pool: noDb, internalServiceToken: SECRET_FOR_APP, requireSignedClientIdentity: true });
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const unsigned = await post(url, '/api/auth/login', { email: 'a@example.com', password: 'correct horse battery' });
  assert.equal(unsigned.status, 400);
  assert.deepEqual(await unsigned.json(), { error: { code: 'INVALID_CLIENT_IDENTITY' } });
});
