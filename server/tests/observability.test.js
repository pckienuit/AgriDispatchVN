import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { createRequestContext, sanitizeRequestId } from '../src/observability.js';

const { AbortController } = globalThis;
const SECRET = 'sekret_value_0123456789abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(10);
  }
}

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function start(t, options = {}) {
  const logs = [];
  let hung = false;
  const app = express();
  app.use(createRequestContext({ serviceName: 'booking-service', buildSha: 'abcdef1', log: (entry) => logs.push(entry), ...options }));
  app.get('/ok', (req, res) => res.status(201).json({ requestId: req.requestId }));
  app.get('/slow', async (req, res) => { await delay(30); res.json({ ok: true }); });
  app.get('/hang', () => { hung = true; });
  app.post('/submit', express.json(), (req, res) => res.json({ ok: true }));
  return { url: await listen(t, app), logs, hasHung: () => hung };
}

// Raw socket so two X-Request-ID header lines reach the server unmerged by fetch.
function rawGet(url, headerLines) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1');
    let data = '';
    socket.on('connect', () => socket.write(`GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n${headerLines.map((l) => `${l}\r\n`).join('')}Connection: close\r\n\r\n`));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

const responseId = (raw) => /^X-Request-ID: (.*)$/mi.exec(raw)?.[1].trim();

test('createRequestContext rejects invalid options at startup', () => {
  const log = () => {};
  assert.throws(() => createRequestContext({ serviceName: 'gateway', buildSha: 'abcdef1', log }), /serviceName/);
  assert.throws(() => createRequestContext({ serviceName: 'booking-service', buildSha: 'abc', log }), /buildSha/);
  assert.throws(() => createRequestContext({ serviceName: 'booking-service', buildSha: 'ABCDEF1', log }), /buildSha/);
  assert.throws(() => createRequestContext({ serviceName: 'booking-service', buildSha: 1234567, log }), /buildSha/);
  assert.throws(() => createRequestContext({ serviceName: 'booking-service', buildSha: 'abcdef1', log: { write() {} } }), /log/);
  assert.throws(() => createRequestContext({ serviceName: 'booking-service', buildSha: 'abcdef1', log, extra: true }), /option/);
  assert.equal(typeof createRequestContext({ serviceName: 'account-service', log }), 'function');
});

test('sanitizeRequestId accepts only bounded ASCII token and rejects header injection shapes', () => {
  assert.equal(sanitizeRequestId('abcdefgh'), 'abcdefgh');
  assert.equal(sanitizeRequestId('a'.repeat(64)), 'a'.repeat(64));
  assert.equal(sanitizeRequestId('a'.repeat(65)), null);
  assert.equal(sanitizeRequestId('abcdefg'), null);
  assert.equal(sanitizeRequestId('abc\r\nSet-Cookie: x=1'), null);
  assert.equal(sanitizeRequestId('abcdefgh\n'), null);
  assert.equal(sanitizeRequestId('abcdefgé'), null);
  assert.equal(sanitizeRequestId('abcdef gh'), null);
  assert.equal(sanitizeRequestId(['abcdefgh', 'ijklmnop']), null);
  assert.equal(sanitizeRequestId(undefined), null);
});

test('valid X-Request-ID is preserved on response, req and log', async (t) => {
  const { url, logs } = await start(t);
  const response = await fetch(`${url}/ok`, { headers: { 'X-Request-ID': 'client.req-0001' } });
  assert.equal(response.headers.get('x-request-id'), 'client.req-0001');
  assert.deepEqual(await response.json(), { requestId: 'client.req-0001' });
  await waitFor(() => logs.length === 1);
  assert.equal(logs[0].requestId, 'client.req-0001');
});

test('invalid, short, or duplicated X-Request-ID is replaced by a fresh UUID', async (t) => {
  const { url, logs } = await start(t);
  const short = await fetch(`${url}/ok`, { headers: { 'X-Request-ID': 'short' } });
  const shortId = short.headers.get('x-request-id');
  assert.notEqual(shortId, 'short');
  assert.match(shortId, UUID);
  const duplicate = await rawGet(url, ['X-Request-ID: validid123', 'X-Request-ID: validid456']);
  const dupId = responseId(duplicate);
  assert.match(dupId, UUID);
  assert.notEqual(dupId, shortId);
  await waitFor(() => logs.length === 2);
  assert.deepEqual(logs.map((entry) => entry.requestId), [shortId, dupId]);
});

test('generated IDs are distinct and match req.requestId', async (t) => {
  const { url, logs } = await start(t);
  const first = await fetch(`${url}/ok`);
  const second = await fetch(`${url}/ok`);
  const a = await first.json();
  const b = await second.json();
  assert.match(first.headers.get('x-request-id'), UUID);
  assert.equal(a.requestId, first.headers.get('x-request-id'));
  assert.equal(b.requestId, second.headers.get('x-request-id'));
  assert.notEqual(a.requestId, b.requestId);
  await waitFor(() => logs.length === 2);
});

test('access log has exactly one structured entry per finished request', async (t) => {
  const { url, logs } = await start(t);
  const response = await fetch(`${url}/slow`, { method: 'GET' });
  const body = await response.json();
  assert.deepEqual(body, { ok: true });
  await waitFor(() => logs.length >= 1);
  await delay(100);
  assert.equal(logs.length, 1);
  const [entry] = logs;
  assert.deepEqual(Object.keys(entry).sort(), ['buildSha', 'durationMs', 'method', 'requestId', 'service', 'status']);
  assert.equal(entry.service, 'booking-service');
  assert.equal(entry.buildSha, 'abcdef1');
  assert.equal(entry.requestId, response.headers.get('x-request-id'));
  assert.equal(entry.method, 'GET');
  assert.equal(entry.status, 200);
  assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 20, `durationMs ${entry.durationMs}`);
});

test('log logs real status for created and not-found responses', async (t) => {
  const { url, logs } = await start(t);
  await fetch(`${url}/ok`);
  await fetch(`${url}/missing-route`);
  await waitFor(() => logs.length === 2);
  assert.deepEqual(logs.map((entry) => entry.status), [201, 404]);
});

test('development buildSha default is logged when omitted', async (t) => {
  const logs = [];
  const app = express();
  app.use(createRequestContext({ serviceName: 'account-service', log: (entry) => logs.push(entry) }));
  app.get('/ok', (req, res) => res.sendStatus(204));
  const url = await listen(t, app);
  await fetch(`${url}/ok`);
  await waitFor(() => logs.length === 1);
  assert.equal(logs[0].buildSha, 'development');
  assert.equal(logs[0].service, 'account-service');
});

test('log entries exclude URL, query, body, IP, headers and identity secrets', async (t) => {
  const { url, logs } = await start(t);
  const response = await fetch(`${url}/submit?token=${SECRET}&email=farmer@example.test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET}`,
      Cookie: `session=${SECRET}`,
      'X-Service-Token': SECRET,
      'X-Forwarded-For': '10.20.30.40',
    },
    body: JSON.stringify({ email: 'farmer@example.test', password: SECRET, note: SECRET }),
  });
  assert.equal(response.status, 200);
  await waitFor(() => logs.length === 1);
  const serialized = JSON.stringify(logs);
  for (const forbidden of [SECRET, 'farmer@example.test', '10.20.30.40', '/submit', 'token=', 'password', 'Cookie', 'Authorization', 'url', 'query', 'body']) {
    assert.equal(serialized.includes(forbidden), false, `log leaked ${forbidden}`);
  }
  assert.equal(logs[0].method, 'POST');
  assert.equal(logs[0].status, 200);
});

test('logged method is the native request method, not a method-override header', async (t) => {
  const { url, logs } = await start(t);
  const { port } = new URL(url);
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(port), method: 'PROPFIND', path: '/ok', headers: { 'X-HTTP-Method-Override': 'DELETE' } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end();
  });
  await waitFor(() => logs.length === 1);
  assert.equal(logs[0].method, 'PROPFIND');
});

test('client abort before response logs one aborted 499 entry', async (t) => {
  const { url, logs, hasHung } = await start(t);
  const controller = new AbortController();
  const pending = fetch(`${url}/hang`, { signal: controller.signal }).catch(() => {});
  await waitFor(hasHung);
  controller.abort();
  await pending;
  await waitFor(() => logs.length >= 1);
  await delay(100);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 499);
  assert.equal(logs[0].aborted, true);
  assert.equal(logs[0].method, 'GET');
});

test('a throwing logger does not crash the request path', async (t) => {
  let calls = 0;
  const { url } = await start(t, { log: () => { calls++; throw new Error('sink down'); } });
  const first = await fetch(`${url}/ok`);
  assert.equal(first.status, 201);
  const second = await fetch(`${url}/ok`);
  assert.equal(second.status, 201);
  await waitFor(() => calls === 2);
});
