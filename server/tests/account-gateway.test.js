import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { test } from 'node:test';
import { createAccountGateway } from '../src/account-gateway.js';
import { deriveClientIdentityKey, verifyClientIdentity } from '../src/client-identity.js';

const GATEWAY_SECRET = 'gateway-test-internal-service-token-0123456789';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, handler, options = {}) {
  const peer = express(); peer.use(express.json()); peer.use(handler);
  const origin = await listen(t, peer);
  const app = express(); app.use(express.json());
  app.use(createAccountGateway({ accountServiceUrl: origin, ...options }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  return listen(t, app);
}

test('gateway forwards allowed auth body and session header, never service secrets or cookies', async (t) => {
  const url = await fixture(t, (req, res) => {
    assert.equal(req.path, '/api/auth/login');
    assert.deepEqual(req.body, { email: 'synthetic@example.com', password: 'test-only-passphrase' });
    assert.equal(req.get('Authorization'), 'Bearer test_session');
    assert.equal(req.get('X-Service-Token'), undefined);
    assert.equal(req.get('Cookie'), undefined);
    res.set('Set-Cookie', 'must-not-leak=1').json({ token: 'synthetic-token' });
  });
  const response = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_session', Cookie: 'private=1', 'X-Service-Token': 'spoof' }, body: JSON.stringify({ email: 'synthetic@example.com', password: 'test-only-passphrase' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token: 'synthetic-token' });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('gateway allowlists path and method, including internal endpoint blocked', async (t) => {
  let calls = 0;
  const url = await fixture(t, (req, res) => { calls++; res.json({}); });
  for (const [method, path] of [['POST', '/internal/introspect'], ['GET', '/api/auth/login'], ['DELETE', '/api/me'], ['POST', '/api/auth/login/extra']]) {
    assert.equal((await fetch(url + path, { method })).status, 404);
  }
  assert.equal(calls, 0);
});

test('gateway retains peer auth errors and retry-after; logout204 remains empty', async (t) => {
  const url = await fixture(t, (req, res) => {
    if (req.path === '/api/auth/logout') return res.sendStatus(204);
    return res.status(429).set('Retry-After', '60').json({ error: { code: 'RATE_LIMITED' } });
  });
  const response = await fetch(url + '/api/me');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await response.json(), { error: { code: 'RATE_LIMITED' } });
  const logout = await fetch(url + '/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 204);
  assert.equal(await logout.text(), '');
});

test('role queue gateway forwards only approved methods and bounded query keys',async t=>{
 const seen=[];
 const url=await fixture(t,(req,res)=>{seen.push(req.originalUrl);res.json({items:[],limit:20,offset:20});});
 const queue=await fetch(url+'/api/admin/role-requests?limit=20&offset=20');
 assert.equal(queue.status,200);assert.equal(seen[0],'/api/admin/role-requests?limit=20&offset=20');
 const id='10000000-0000-4000-8000-000000000001';
 for(const path of ['/api/role-requests',`/api/admin/role-requests/${id}/approve`,`/api/admin/role-requests/${id}/reject`])assert.equal((await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
 for(const path of ['/api/admin/role-requests/bad/approve',`/api/admin/role-requests/${id}/delete`])assert.equal((await fetch(url+path,{method:'POST'})).status,404);
 const before=seen.length;
 assert.equal((await fetch(url+'/api/admin/role-requests?host=evil')).status,400);
 assert.equal((await fetch(url+'/api/admin/role-requests?limit=20&limit=1')).status,400);
 assert.equal(seen.length,before);
});

test('gateway bounds slow, redirected, oversized or non-JSON peer replies', async (t) => {
  for (const handler of [() => {}, (req, res) => res.redirect('https://example.com'), (req, res) => res.send('private host error'), (req, res) => res.json({ text: 'x'.repeat(20000) })]) {
    const url = await fixture(t, handler, { timeoutMs: 50 });
    const response = await fetch(url + '/api/me');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'IDENTITY_UNAVAILABLE' } });
  }
});

test('gateway signs client identity over real socket IP and strips spoofed client or forwarding headers', async (t) => {
  const key = deriveClientIdentityKey(GATEWAY_SECRET);
  let verified;
  let seenHeaders;
  const url = await fixture(t, (req, res) => {
    seenHeaders = { ...req.headers };
    verified = verifyClientIdentity(req, { key });
    res.json({ ok: true });
  }, { internalServiceToken: GATEWAY_SECRET });

  const response = await fetch(url + '/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.77',
      'X-Real-IP': '198.51.100.88',
      Forwarded: 'for=198.51.100.99',
      'X-Client-Address': '198.51.100.66',
      'X-Client-Timestamp': '9999999999999',
      'X-Client-Signature': 'f'.repeat(64),
      'X-Service-Token': 'spoof-token',
    },
    body: JSON.stringify({ email: 'a@example.com', password: 'test-only-passphrase' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(verified, { present: true, ok: true, address: '127.0.0.1' });
  assert.equal(seenHeaders['x-forwarded-for'], undefined);
  assert.equal(seenHeaders['x-real-ip'], undefined);
  assert.equal(seenHeaders.forwarded, undefined);
  assert.equal(seenHeaders['x-service-token'], undefined);
});

test('gateway uses rightmost trustedProxyHops from X-Forwarded-For and enforces optional CIDR allowlist', async (t) => {
  const key = deriveClientIdentityKey(GATEWAY_SECRET);
  const seen = [];
  const trustedUrl = await fixture(t, (req, res) => {
    seen.push(verifyClientIdentity(req, { key }));
    res.json({ ok: true });
  }, { internalServiceToken: GATEWAY_SECRET, trustedProxyHops: 1, trustedProxyCidrs: ['127.0.0.0/8'] });

  const spoofedChain = await fetch(trustedUrl + '/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.1, 203.0.113.42:51000',
    },
    body: JSON.stringify({ email: 'a@example.com', password: 'test-only-passphrase' }),
  });
  assert.equal(spoofedChain.status, 200);
  assert.deepEqual(seen[0], { present: true, ok: true, address: '203.0.113.42' });

  const untrustedPeerUrl = await fixture(t, (req, res) => {
    seen.push(verifyClientIdentity(req, { key }));
    res.json({ ok: true });
  }, { internalServiceToken: GATEWAY_SECRET, trustedProxyHops: 1, trustedProxyCidrs: ['10.0.0.0/8'] });

  const directBypass = await fetch(untrustedPeerUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.42' },
    body: JSON.stringify({ email: 'a@example.com', password: 'test-only-passphrase' }),
  });
  assert.equal(directBypass.status, 200);
  assert.deepEqual(seen[1], { present: true, ok: true, address: '127.0.0.1' });
});

test('gateway validates internalServiceToken, trustedProxyHops and trustedProxyCidrs options', () => {
  assert.throws(() => createAccountGateway({ accountServiceUrl: 'http://127.0.0.1:3001', internalServiceToken: 'short' }), /INTERNAL_SERVICE_TOKEN/);
  assert.throws(() => createAccountGateway({ accountServiceUrl: 'http://127.0.0.1:3001', trustedProxyHops: -1 }), /trustedProxyHops/);
  assert.throws(() => createAccountGateway({ accountServiceUrl: 'http://127.0.0.1:3001', trustedProxyHops: '1' }), /trustedProxyHops/);
  assert.throws(() => createAccountGateway({ accountServiceUrl: 'http://127.0.0.1:3001', trustedProxyCidrs: ['bad-cidr'] }), /trustedProxyCidrs/);
});
