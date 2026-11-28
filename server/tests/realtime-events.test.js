import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

const userId = '00000000-0000-4000-8000-000000000001';
const secret = 'synthetic-internal-service-test-token-00';

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('notification endpoints authenticate and reject invalid cursors and ambiguous read targets before SQL', async t => {
  const { createServer } = await import('node:http');
  const identity = await serve(t, { listen: (...args) => createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ user: { id: userId, name: 'Synthetic', roles: ['farmer'] } }));
  }).listen(...args) });
  let calls = 0;
  const pool = { connect() { calls++; }, query() { calls++; } };
  const url = await serve(t, createApp({ pool, accountServiceUrl: identity, internalServiceToken: secret }));
  assert.equal((await fetch(`${url}/api/events/stream`)).status, 401);
  const headers = { Authorization: 'Bearer ' + 'a'.repeat(43), 'Content-Type': 'application/json' };
  for (const cursor of ['-1', '9223372036854775808', '1e3', '5,6']) {
    const result = await fetch(`${url}/api/events/stream?lastEventId=0`, { headers: { ...headers, 'Last-Event-ID': cursor } });
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error.code, 'INVALID_EVENT_CURSOR');
  }
  for (const selector of [{}, { id: '1', all: true }, { all: false }, { upToId: 9007199254740992 }]) {
    const result = await fetch(`${url}/api/notifications/read`, { method: 'POST', headers, body: JSON.stringify(selector) });
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error.code, 'INVALID_READ_TARGET');
  }
  assert.equal(calls, 0);
});

test('notifications reuse agri_session and reject cross-origin cookie mutations', async t => {
  const { createServer } = await import('node:http');
  let introspections = 0;
  const identity = await serve(t, { listen: (...args) => createServer((req, res) => {
    introspections++;
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ user: { id: userId, name: 'Synthetic', roles: ['farmer'] }, expiresAt: new Date().toISOString() }));
  }).listen(...args) });
  const pool = { connect() {}, query() { throw new Error('Unexpected query'); } };
  const url = await serve(t, createApp({ pool, accountServiceUrl: identity, internalServiceToken: secret }));
  const cookie = `agri_session=${'a'.repeat(43)}`;
  const invalid = await fetch(`${url}/api/events/stream?lastEventId=-1`, { headers: { Cookie: cookie } });
  assert.equal(invalid.status, 400);
  const crossed = await fetch(`${url}/api/notifications/read`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://outside.invalid' } });
  assert.equal(crossed.status, 403);
  assert.equal((await crossed.json()).error.code, 'CROSS_ORIGIN_REQUEST');
  assert.equal((await fetch(`${url}/api/notifications`, { headers: { Cookie: cookie, Authorization: 'invalid' } })).status, 401);
  assert.equal(introspections, 1);
});

test('SSE keepalive runs every 20 seconds and stops at disconnect', async t => {
  const { EventEmitter } = await import('node:events');
  const { createRealtimeRouter } = await import('../src/realtime-events.js');
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const frames = [];
  const queries = [];
  const res = Object.assign(new EventEmitter(), { set() {}, flushHeaders() {}, end() {}, write(frame) { frames.push(frame); return true; } });
  const router = createRealtimeRouter({ pool: { options: { max: 1 }, async query(sql) {
    queries.push(sql);
    return { rows: sql.includes('unreadCount') ? [{ unreadCount: 0 }] : [] };
  } }, authenticate() {} });
  const work = router.stack.find(layer => layer.route.path === '/api/events/stream').route.stack.at(-1).handle;
  await work({ actor: { id: userId }, get() {}, query: {}, on() {} }, res, assert.fail);
  t.mock.timers.tick(19999);
  assert.equal(frames.includes(': keepalive\n\n'), false);
  t.mock.timers.tick(1);
  assert.equal(frames.filter(frame => frame === ': keepalive\n\n').length, 1);
  res.emit('close');
  const before = queries.length;
  t.mock.timers.tick(40000);
  assert.equal(frames.filter(frame => frame === ': keepalive\n\n').length, 1);
  assert.equal(queries.length, before);
});
