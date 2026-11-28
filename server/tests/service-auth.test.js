import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { test } from 'node:test';
import { createAccountAuth } from '../src/service-auth.js';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function harness(t, handler, options = {}) {
  const identity = express();
  identity.use(express.json());
  identity.post('/internal/introspect', handler);
  const url = await listen(t, identity);
  const app = express();
  const auth = createAccountAuth({ accountServiceUrl: url, internalServiceToken: 'test_service_credential_long_enough', ...options });
  app.get('/protected', auth, (req, res) => res.json({ actor: req.actor }));
  return listen(t, app);
}

test('auth uses verified remote identity and sends internal credential', async (t) => {
  const user = { id: '13815c27-60de-4b3d-ae9a-83e1783e5643', name: 'Test farmer', roles: ['farmer'] };
  const url = await harness(t, (req, res) => {
    assert.equal(req.get('X-Service-Token'), 'test_service_credential_long_enough');
    assert.deepEqual(req.body, { token: 'test_session_token_abcdefghijklmnopqrstuvwxyz' });
    res.json({ user });
  });
  const response = await fetch(`${url}/protected`, { headers: { Authorization: 'Bearer test_session_token_abcdefghijklmnopqrstuvwxyz' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { actor: user });
});

test('missing bearer never contacts identity service', async (t) => {
  let calls = 0;
  const url = await harness(t, (req, res) => { calls++; res.sendStatus(500); });
  const response = await fetch(`${url}/protected`);
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('remote invalid session returns 401 without identity details', async (t) => {
  const url = await harness(t, (req, res) => res.status(401).json({ private: 'secret' }));
  const response = await fetch(`${url}/protected`, { headers: { Authorization: 'Bearer invalid_session_token' } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: 'UNAUTHENTICATED' } });
});

test('remote failure and malformed identity fail closed', async (t) => {
  for (const payload of [{ user: { id: 'bad', roles: ['admin'] } }, { user: { id: '13815c27-60de-4b3d-ae9a-83e1783e5643', roles: ['invented-role'] } }]) {
    const url = await harness(t, (req, res) => res.json(payload));
    const response = await fetch(`${url}/protected`, { headers: { Authorization: 'Bearer test_session_token' } });
    assert.equal(response.status, 503);
  }
  const url = await harness(t, (req, res) => res.status(500).send('secret host'));
  const response = await fetch(`${url}/protected`, { headers: { Authorization: 'Bearer test_session_token' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'IDENTITY_UNAVAILABLE' } });
});

test('slow account service is bounded and returns 503', async (t) => {
  const url = await harness(t, () => {}, { timeoutMs: 30 });
  const response = await fetch(`${url}/protected`, { headers: { Authorization: 'Bearer test_session_token' } });
  assert.equal(response.status, 503);
});

test('unsafe account URLs and weak internal credentials are rejected', () => {
  for (const url of ['file:///etc/passwd', 'https://user:pw@example.com', 'https://example.com/path', 'https://example.com?token=secret']) {
    assert.throws(() => createAccountAuth({ accountServiceUrl: url, internalServiceToken: 'test_service_credential_long_enough' }));
  }
  assert.throws(() => createAccountAuth({ accountServiceUrl: 'http://127.0.0.1:3001', internalServiceToken: 'short' }));
});
