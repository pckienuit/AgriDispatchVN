import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { test } from 'node:test';
import { createAccountGateway } from '../src/account-gateway.js';

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
