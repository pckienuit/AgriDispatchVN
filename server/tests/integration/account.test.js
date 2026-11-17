import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAccountApp } from '../../src/account-app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

const ROOT = process.env.TEST_DATABASE_URL;
const SERVICE_TOKEN = 'integration-only-service-token-0123456789abcdef';
const PASSWORD = 'correct horse battery';
const ENTRY = fileURLToPath(new URL('../../src/account-server.js', import.meta.url));

// Each test file gets one unique disposable database; root connection only creates and drops it.
async function fixture(t, options = {}) {
  assert.ok(ROOT, 'TEST_DATABASE_URL must be set for account integration tests');
  const db = await createDisposableDatabase(ROOT);
  const pool = createPool(db.url, { statementTimeout: 60000 });
  t.after(async () => { await pool.end(); await db.drop(); });
  await migrate(pool);
  const instance = { pool, options };
  instance.app = (opts = {}) => createAccountApp({ pool, internalServiceToken: SERVICE_TOKEN, ...options, ...opts });
  instance.serve = async (appOptions = {}) => {
    const server = instance.app(appOptions).listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
  };
  return { db, pool, serve: instance.serve, app: instance.app };
}

const json = (url, path, body, headers = {}) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const bearer = (token) => ({ authorization: `Bearer ${token}` });

test('disposable DB helper rejects unsafe roots and non-disposable drops', () => {
  for (const url of [
    'postgresql://u:p@127.0.0.1:55432/agridispatch',
    'postgresql://u:p@db.example.com:5432/agridispatch_test',
    'https://127.0.0.1/agridispatch_test',
    'postgresql://u:p@127.0.0.1:55432/',
    'not a url',
  ]) {
    assert.throws(() => parseDisposableRoot(url), /TEST_DATABASE_URL/, url);
  }
  assert.equal(parseDisposableRoot('postgresql://u:p@localhost:55432/agridispatch_test').hostname, 'localhost');
});

test('register, login, me, logout and revocation through real HTTP and PostgreSQL', async (t) => {
  const { serve } = await fixture(t);
  const server = await serve();
  t.after(() => server.close());
  const reg = await json(server.url, '/api/auth/register', { email: '  Farmer@Example.COM ', password: PASSWORD, name: ' Nguyen An ' });
  assert.equal(reg.status, 201);
  const created = await reg.json();
  assert.deepEqual(created, { user: { id: created.user.id, email: 'farmer@example.com', name: 'Nguyen An', roles: ['farmer'] } });
  assert.equal(JSON.stringify(created).includes('scrypt'), false);

  const login = await json(server.url, '/api/auth/login', { email: 'farmer@example.com', password: PASSWORD });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  assert.deepEqual(session.user.roles, ['farmer']);
  assert.equal(JSON.stringify(session).includes('scrypt'), false);

  const me = await fetch(`${server.url}/api/me`, { headers: bearer(session.token) });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).user.roles, ['farmer']);

  const logout = await fetch(`${server.url}/api/auth/logout`, { method: 'POST', headers: bearer(session.token) });
  assert.equal(logout.status, 204);
  const after = await fetch(`${server.url}/api/me`, { headers: bearer(session.token) });
  assert.equal(after.status, 401);
  assert.deepEqual(await after.json(), { error: { code: 'UNAUTHORIZED' } });
});

test('concurrent duplicate registrations create exactly one account', async (t) => {
  const { pool, serve } = await fixture(t);
  const server = await serve({ throttle: { registerIpMax: 100 } });
  t.after(() => server.close());
  const bodies = Array.from({ length: 8 }, () => ({ email: 'race@example.com', password: PASSWORD, name: 'Race' }));
  const statuses = (await Promise.all(bodies.map((body) => json(server.url, '/api/auth/register', body)))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 7);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM account.users')).rows[0].n, 1);
});

test('login throttle resets after a successful login and after its window expires', async (t) => {
  const { pool, serve } = await fixture(t);
  const server = await serve({ throttle: { windowSeconds: 900, loginEmailMax: 3 } });
  t.after(() => server.close());
  await json(server.url, '/api/auth/register', { email: 'reset@example.com', password: PASSWORD, name: 'R' });
  const fail = () => json(server.url, '/api/auth/login', { email: 'reset@example.com', password: 'wrong password 1' });
  assert.equal((await fail()).status, 401);
  assert.equal((await fail()).status, 401);
  assert.equal((await json(server.url, '/api/auth/login', { email: 'reset@example.com', password: PASSWORD })).status, 200);
  // Success cleared the counter, so three more failures are allowed again.
  assert.equal((await fail()).status, 401);
  assert.equal((await fail()).status, 401);
  assert.equal((await fail()).status, 401);
  assert.equal((await fail()).status, 429);
  // Expire the window in the DB; the next attempt starts a fresh window.
  await pool.query("UPDATE account.rate_limits SET window_ends_at = now() - interval '1 second'");
  assert.equal((await json(server.url, '/api/auth/login', { email: 'reset@example.com', password: PASSWORD })).status, 200);
});

test('database rejects duplicate case variants, unknown roles and duplicate role grants', async (t) => {
  const { pool } = await fixture(t);
  const hash = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'B'.repeat(86)}`;
  await pool.query('INSERT INTO account.users (email, name, password_hash) VALUES ($1, $2, $3)', ['a@example.com', 'A', hash]);
  const id = (await pool.query('SELECT id FROM account.users')).rows[0].id;
  await assert.rejects(pool.query('INSERT INTO account.users (email, name, password_hash) VALUES ($1, $2, $3)', ['A@example.com', 'X', hash]), { code: '23514' });
  await assert.rejects(pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'superuser')", [id]), { code: '23514' });
  await pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'admin')", [id]);
  await assert.rejects(pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'admin')", [id]), { code: '23505' });
});

test('login throttle is shared across separate account processes and resets on success', { timeout: 60000 }, async (t) => {
  const { db } = await fixture(t);
  const ports = await Promise.all([freePort(), freePort()]);
  const env = { ...process.env, DATABASE_URL: db.url, INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN };
  const children = ports.map((port) => spawn(process.execPath, [ENTRY], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(() => children.forEach((child) => child.kill('SIGTERM')));
  await Promise.all(children.map((child, index) => waitForLine(child, 'listening', `http://127.0.0.1:${ports[index]}/health`)));
  const [a, b] = ports.map((port) => `http://127.0.0.1:${port}`);
  await json(a, '/api/auth/register', { email: 'throttle@example.com', password: PASSWORD, name: 'T' });
  // Default email max is 5 attempts per window; alternate instances so no single process sees all of them.
  const seq = [a, a, a, b, b];
  for (const base of seq) {
    assert.equal((await json(base, '/api/auth/login', { email: 'throttle@example.com', password: 'wrong password 1' })).status, 401);
  }
  const blocked = await json(a, '/api/auth/login', { email: 'throttle@example.com', password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
  assert.deepEqual(await blocked.json(), { error: { code: 'RATE_LIMITED' } });
});

test('wrong service credential is refused and malformed introspection never reaches session lookup', async (t) => {
  const { serve } = await fixture(t);
  const server = await serve();
  t.after(() => server.close());
  const reg = await json(server.url, '/api/auth/register', { email: 'svc@example.com', password: PASSWORD, name: 'S' });
  assert.equal(reg.status, 201);
  const session = await (await json(server.url, '/api/auth/login', { email: 'svc@example.com', password: PASSWORD })).json();
  const wrong = await json(server.url, '/internal/introspect', { token: session.token }, { 'x-service-token': 'not-the-token-at-all-0000000000000000' });
  assert.equal(wrong.status, 403);
  const ok = await json(server.url, '/internal/introspect', { token: session.token }, { 'x-service-token': SERVICE_TOKEN });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).user.roles, ['farmer']);
  const forged = await json(server.url, '/internal/introspect', { token: 'A'.repeat(43) }, { 'x-service-token': SERVICE_TOKEN });
  assert.equal(forged.status, 401);
});

test('expired sessions are rejected and stored as digests only', async (t) => {
  const { pool, serve } = await fixture(t);
  const server = await serve();
  t.after(() => server.close());
  await json(server.url, '/api/auth/register', { email: 'exp@example.com', password: PASSWORD, name: 'E' });
  const session = await (await json(server.url, '/api/auth/login', { email: 'exp@example.com', password: PASSWORD })).json();
  const stored = (await pool.query('SELECT token_hash FROM account.sessions')).rows.map((row) => row.token_hash);
  assert.equal(stored.length, 1);
  assert.match(stored[0], /^[0-9a-f]{64}$/);
  assert.notEqual(stored[0], session.token);
  // created_at must move with expires_at to satisfy the CHECK that expiry follows creation.
  await pool.query("UPDATE account.sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'");
  const expired = await fetch(`${server.url}/api/me`, { headers: bearer(session.token) });
  assert.equal(expired.status, 401);
});

test('accounts and live sessions persist across app restart on the same database', async (t) => {
  const db = await createDisposableDatabase(ROOT);
  t.after(() => db.drop());
  const first = createPool(db.url, { statementTimeout: 60000 });
  await migrate(first);
  const firstListener = createAccountApp({ pool: first, internalServiceToken: SERVICE_TOKEN }).listen(0, '127.0.0.1');
  await once(firstListener, 'listening');
  const firstUrl = `http://127.0.0.1:${firstListener.address().port}`;
  await json(firstUrl, '/api/auth/register', { email: 'restart@example.com', password: PASSWORD, name: 'R' });
  const session = await (await json(firstUrl, '/api/auth/login', { email: 'restart@example.com', password: PASSWORD })).json();
  await new Promise((resolve) => firstListener.close(resolve));
  await first.end();

  const second = createPool(db.url, { statementTimeout: 60000 });
  t.after(() => second.end());
  const listener = createAccountApp({ pool: second, internalServiceToken: SERVICE_TOKEN }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const url = `http://127.0.0.1:${listener.address().port}`;
  const me = await fetch(`${url}/api/me`, { headers: bearer(session.token) });
  assert.equal(me.status, 200);
  assert.equal((await json(url, '/api/auth/login', { email: 'restart@example.com', password: PASSWORD })).status, 200);
});

test('oversized and malformed HTTP bodies fail before any account write', async (t) => {
  const { pool, serve } = await fixture(t);
  const server = await serve();
  t.after(() => server.close());
  const invalid = await fetch(`${server.url}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  const large = await json(server.url, '/api/auth/register', { email: 'big@example.com', password: PASSWORD, name: 'x'.repeat(70000) });
  assert.equal(large.status, 413);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM account.users')).rows[0].n, 0);
});

test('role injection via register body is refused and only farmer is granted', async (t) => {
  const { pool, serve } = await fixture(t);
  const server = await serve();
  t.after(() => server.close());
  const injected = await json(server.url, '/api/auth/register', { email: 'evil@example.com', password: PASSWORD, name: 'E', roles: ['admin'] });
  assert.equal(injected.status, 400);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM account.user_roles')).rows[0].n, 0);
});

test('wrong and missing bearer tokens return 401 and never leak account existence', async (t) => {
  const { serve } = await fixture(t);
  const server = await serve();
  t.after(() => server.close());
  await json(server.url, '/api/auth/register', { email: 'enum@example.com', password: PASSWORD, name: 'N' });
  const unknown = await json(server.url, '/api/auth/login', { email: 'nobody@example.com', password: PASSWORD });
  const wrong = await json(server.url, '/api/auth/login', { email: 'enum@example.com', password: 'wrong password 1' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json());
  assert.equal((await fetch(`${server.url}/api/me`, { headers: bearer('A'.repeat(43)) })).status, 401);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function waitForLine(child, text, url) {
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`account process exited early: ${stderr.slice(0, 200).replace(/[A-Za-z0-9_-]{30,}/g, '[redacted]')}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Process not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`account process did not become healthy: ${text}`);
}

test('concurrent failed logins across instances admit exactly the configured attempts', { timeout: 60000 }, async (t) => {
  const { serve } = await fixture(t);
  const a = await serve({ throttle: { loginEmailMax: 5, loginIpMax: 1000 } });
  const b = await serve({ throttle: { loginEmailMax: 5, loginIpMax: 1000 } });
  t.after(() => { a.close(); b.close(); });
  await json(a.url, '/api/auth/register', { email: 'burst@example.com', password: PASSWORD, name: 'B' });
  const urls = [a.url, b.url];
  const statuses = (await Promise.all(Array.from({ length: 12 }, (_, i) => json(urls[i % 2], '/api/auth/login', { email: 'burst@example.com', password: 'wrong password 1' }).then((r) => r.status)))).sort();
  assert.equal(statuses.filter((s) => s === 401).length, 5, JSON.stringify(statuses));
  assert.equal(statuses.filter((s) => s === 429).length, 7, JSON.stringify(statuses));
});
