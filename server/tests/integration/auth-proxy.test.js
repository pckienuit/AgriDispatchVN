import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { test } from 'node:test';
import { createAccountApp } from '../../src/account-app.js';
import { createAccountGateway } from '../../src/account-gateway.js';
import { deriveClientIdentityKey, signClientIdentity } from '../../src/client-identity.js';
import { createPool } from '../../src/db.js';
import { createRequestContext } from '../../src/observability.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const ROOT = process.env.TEST_DATABASE_URL;
const SERVICE_TOKEN = 'auth-proxy-integration-service-token-0123456789';
const PASSWORD = 'correct horse battery';

async function setupProxyStack(t, { trustedProxyHops = 1, trustedProxyCidrs = ['127.0.0.0/8'], accountOptions = {} } = {}) {
  assert.ok(ROOT, 'TEST_DATABASE_URL must be set for auth-proxy integration tests');
  const db = await createDisposableDatabase(ROOT);
  const pool = createPool(db.url, { statementTimeout: 60000 });
  const servers = [];
  const logs = [];
  t.after(async () => {
    for (const server of servers) {
      if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
    await pool.end();
    await db.drop();
  });
  await migrate(pool);

  const listen = async (app) => {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };

  const accountUrl = await listen(createAccountApp({
    pool,
    internalServiceToken: SERVICE_TOKEN,
    log: (entry) => logs.push(entry),
    ...accountOptions,
  }));

  const gatewayApp = express();
  gatewayApp.use(createRequestContext({ serviceName: 'booking-service', log: (entry) => logs.push(entry) }));
  gatewayApp.use(express.json({ limit: '64kb' }));
  gatewayApp.use(createAccountGateway({
    accountServiceUrl: accountUrl,
    internalServiceToken: SERVICE_TOKEN,
    trustedProxyHops,
    trustedProxyCidrs,
  }));
  gatewayApp.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  const gatewayUrl = await listen(gatewayApp);

  const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  return { pool, accountUrl, gatewayUrl, logs, post };
}

test('default limits isolate two gateway client identities and prevent victim email lockout across distinct IPs', async (t) => {
  const { gatewayUrl, logs, post } = await setupProxyStack(t);
  const victimEmail = 'victim-lockout@example.com';

  assert.equal((await post(gatewayUrl, '/api/auth/register', { email: victimEmail, password: PASSWORD, name: 'Victim' }, {
    'X-Forwarded-For': '203.0.113.20',
  })).status, 201);

  // Attacker fails 5 times (default loginEmailMax=5), trying to evade by prepending fake XFF hops.
  for (let i = 0; i < 5; i += 1) {
    const res = await post(gatewayUrl, '/api/auth/login', { email: victimEmail, password: 'wrong password 1' }, {
      'X-Forwarded-For': `192.0.2.${10 + i}, 198.51.100.10`,
    });
    assert.equal(res.status, 401);
  }
  const attackerBlocked = await post(gatewayUrl, '/api/auth/login', { email: victimEmail, password: PASSWORD }, {
    'X-Forwarded-For': '192.0.2.99, 198.51.100.10',
  });
  assert.equal(attackerBlocked.status, 429);

  // Legitimate user at a distinct client IP still signs in with 200.
  const legitOk = await post(gatewayUrl, '/api/auth/login', { email: victimEmail, password: PASSWORD }, {
    'X-Forwarded-For': '203.0.113.20',
  });
  assert.equal(legitOk.status, 200);
  const session = await legitOk.json();
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);

  // Legitimate login cleared only its own (email, 203.0.113.20) bucket; attacker IP stays throttled.
  const attackerStillBlocked = await post(gatewayUrl, '/api/auth/login', { email: victimEmail, password: PASSWORD }, {
    'X-Forwarded-For': '198.51.100.10',
  });
  assert.equal(attackerStillBlocked.status, 429);

  // Registration budget (10/900s) is isolated per signed client IP behind the gateway.
  for (let i = 0; i < 10; i += 1) {
    const reg = await post(gatewayUrl, '/api/auth/register', {
      email: `nat-user-${i}@example.com`,
      password: PASSWORD,
      name: `User ${i}`,
    }, { 'X-Forwarded-For': '198.51.100.55' });
    assert.equal(reg.status, 201);
  }
  assert.equal((await post(gatewayUrl, '/api/auth/register', {
    email: 'nat-user-10@example.com',
    password: PASSWORD,
    name: 'User 10',
  }, { 'X-Forwarded-For': '198.51.100.55' })).status, 429);
  assert.equal((await post(gatewayUrl, '/api/auth/register', {
    email: 'other-client@example.com',
    password: PASSWORD,
    name: 'Other Client',
  }, { 'X-Forwarded-For': '203.0.113.21' })).status, 201);

  const serializedLogs = JSON.stringify(logs);
  for (const sensitive of ['198.51.100.10', '203.0.113.20', '198.51.100.55', victimEmail, PASSWORD, SERVICE_TOKEN, session.token]) {
    assert.equal(serializedLogs.includes(sensitive), false, `log leaked ${sensitive}`);
  }
});

test('successful logins do not exhaust default 30/900s per-IP failure budget, while 30 failures still block that IP only', { timeout: 60000 }, async (t) => {
  const { gatewayUrl, post } = await setupProxyStack(t);
  const sharedNatIp = '203.0.113.50';
  const attackerIp = '198.51.100.88';

  const users = [];
  for (let i = 0; i < 6; i += 1) {
    const email = `shared-nat-${i}@example.com`;
    assert.equal((await post(gatewayUrl, '/api/auth/register', { email, password: PASSWORD, name: `Nat ${i}` }, {
      'X-Forwarded-For': `198.0.2.${i + 1}`,
    })).status, 201);
    users.push(email);
  }

  // 35 successful logins from the same NAT IP must all succeed under default loginIpMax=30.
  for (let i = 0; i < 35; i += 1) {
    const res = await post(gatewayUrl, '/api/auth/login', { email: users[i % users.length], password: PASSWORD }, {
      'X-Forwarded-For': sharedNatIp,
    });
    assert.equal(res.status, 200, `successful login #${i + 1} was blocked`);
  }

  // 30 failed logins from attackerIp across distinct emails exhaust loginIpMax=30 on the 31st request.
  for (let i = 0; i < 30; i += 1) {
    const res = await post(gatewayUrl, '/api/auth/login', { email: `spray-${Math.floor(i / 5)}@example.com`, password: 'wrong password 1' }, {
      'X-Forwarded-For': attackerIp,
    });
    assert.equal(res.status, 401, `failure #${i + 1}`);
  }
  assert.equal((await post(gatewayUrl, '/api/auth/login', { email: users[0], password: PASSWORD }, {
    'X-Forwarded-For': attackerIp,
  })).status, 429);

  // Distinct client IP remains unaffected.
  assert.equal((await post(gatewayUrl, '/api/auth/login', { email: users[0], password: PASSWORD }, {
    'X-Forwarded-For': sharedNatIp,
  })).status, 200);
});

test('direct untrusted XFF is ignored, expired or mismatched signed headers are rejected, and canonical IPv6 normalizes', async (t) => {
  const { accountUrl, gatewayUrl, post } = await setupProxyStack(t, { trustedProxyHops: 0 });
  const email = 'spoof-check@example.com';
  assert.equal((await post(gatewayUrl, '/api/auth/register', { email, password: PASSWORD, name: 'Spoof' })).status, 201);

  // With trustedProxyHops=0, gateway ignores X-Forwarded-For and signs socket IP 127.0.0.1.
  // 5 failures with varying spoofed XFF still throttle 127.0.0.1.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await post(gatewayUrl, '/api/auth/login', { email, password: 'wrong password 1' }, {
      'X-Forwarded-For': `203.0.113.${i + 10}`,
    })).status, 401);
  }
  assert.equal((await post(gatewayUrl, '/api/auth/login', { email, password: PASSWORD }, {
    'X-Forwarded-For': '203.0.113.250',
  })).status, 429);

  // Direct call to account-app ignoring XFF shares the same 127.0.0.1 bucket (already 429).
  assert.equal((await post(accountUrl, '/api/auth/login', { email, password: PASSWORD }, {
    'X-Forwarded-For': '203.0.113.251',
  })).status, 429);

  // Expired / wrong-method / wrong-path signatures sent directly to account-app are rejected with 400.
  const key = deriveClientIdentityKey(SERVICE_TOKEN);
  const expired = signClientIdentity({
    key,
    address: '203.0.113.77',
    method: 'POST',
    path: '/api/auth/login',
    requestId: 'expired-req-0001',
    timestampMs: Date.now() - 61_000,
  });
  assert.equal((await post(accountUrl, '/api/auth/login', { email, password: PASSWORD }, {
    ...expired,
    'X-Request-ID': 'expired-req-0001',
  })).status, 400);

  const wrongPath = signClientIdentity({
    key,
    address: '203.0.113.77',
    method: 'POST',
    path: '/api/auth/register',
    requestId: 'mismatch-req-001',
  });
  assert.equal((await post(accountUrl, '/api/auth/login', { email, password: PASSWORD }, {
    ...wrongPath,
    'X-Request-ID': 'mismatch-req-001',
  })).status, 400);

  // IPv6 canonicalization: 2001:0db8::1 and 2001:DB8::1 share one bucket on account-app.
  for (let i = 0; i < 5; i += 1) {
    const addr = i % 2 === 0 ? '2001:0db8::1' : '2001:DB8::1';
    const hdrs = signClientIdentity({ key, address: addr, method: 'POST', path: '/api/auth/login', requestId: `v6-req-${i}-00001` });
    assert.equal((await post(accountUrl, '/api/auth/login', { email, password: 'wrong password 1' }, {
      ...hdrs,
      'X-Request-ID': `v6-req-${i}-00001`,
    })).status, 401);
  }
  const v6Blocked = signClientIdentity({ key, address: '2001:db8:0:0::1', method: 'POST', path: '/api/auth/login', requestId: 'v6-req-6-00001' });
  assert.equal((await post(accountUrl, '/api/auth/login', { email, password: PASSWORD }, {
    ...v6Blocked,
    'X-Request-ID': 'v6-req-6-00001',
  })).status, 429);

  // IPv4-mapped IPv6 canonicalizes to IPv4 and shares one bucket.
  for (let i = 0; i < 5; i += 1) {
    const addr = i % 2 === 0 ? '::ffff:198.51.100.77' : '198.51.100.77';
    const hdrs = signClientIdentity({ key, address: addr, method: 'POST', path: '/api/auth/login', requestId: `v4m-req-${i}-0001` });
    assert.equal((await post(accountUrl, '/api/auth/login', { email, password: 'wrong password 1' }, {
      ...hdrs,
      'X-Request-ID': `v4m-req-${i}-0001`,
    })).status, 401);
  }
  const v4MappedBlocked = signClientIdentity({ key, address: '198.51.100.77', method: 'POST', path: '/api/auth/login', requestId: 'v4m-req-6-0001' });
  assert.equal((await post(accountUrl, '/api/auth/login', { email, password: PASSWORD }, {
    ...v4MappedBlocked,
    'X-Request-ID': 'v4m-req-6-0001',
  })).status, 429);
});

test('gateway ignores XFF from untrusted peer CIDR and fail-closed account app rejects unsigned direct /api calls', async (t) => {
  const { accountUrl, gatewayUrl, post } = await setupProxyStack(t, {
    trustedProxyHops: 1,
    trustedProxyCidrs: ['10.0.0.0/8'],
    accountOptions: { requireSignedClientIdentity: true },
  });

  // Direct unsigned call to fail-closed account-app is rejected with 400.
  const directUnsigned = await post(accountUrl, '/api/auth/register', {
    email: 'failclosed@example.com',
    password: PASSWORD,
    name: 'Fail Closed',
  });
  assert.equal(directUnsigned.status, 400);
  assert.deepEqual(await directUnsigned.json(), { error: { code: 'INVALID_CLIENT_IDENTITY' } });

  // Gateway call succeeds because gateway signs client identity; however peer 127.0.0.1 is NOT in 10.0.0.0/8,
  // so spoofed XFF is ignored and 127.0.0.1 is signed consistently across varying XFF values.
  assert.equal((await post(gatewayUrl, '/api/auth/register', {
    email: 'failclosed@example.com',
    password: PASSWORD,
    name: 'Fail Closed',
  }, { 'X-Forwarded-For': '203.0.113.10' })).status, 201);

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await post(gatewayUrl, '/api/auth/login', {
      email: 'failclosed@example.com',
      password: 'wrong password 1',
    }, { 'X-Forwarded-For': `203.0.113.${20 + i}` })).status, 401);
  }
  assert.equal((await post(gatewayUrl, '/api/auth/login', {
    email: 'failclosed@example.com',
    password: PASSWORD,
  }, { 'X-Forwarded-For': '203.0.113.99' })).status, 429);
});
