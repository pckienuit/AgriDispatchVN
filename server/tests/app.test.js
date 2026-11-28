import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

async function serve(t, pool) {
  const server = createApp({ pool }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

test('liveness does not query DB', async (t) => {
  const url = await serve(t, { query() { throw new Error('must not query'); } });
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('readiness queries DB and returns success', async (t) => {
  let sql;
  const url = await serve(t, { async query(value) { sql = value; } });
  const response = await fetch(`${url}/ready`);
  assert.equal(response.status, 200);
  assert.equal(sql, 'SELECT 1');
  assert.deepEqual(await response.json(), { status: 'ready' });
});
test('DB outage returns 503 without leaking internal details', async (t) => {
  const url = await serve(t, { async query() { throw new Error('private-db-host'); } });
  const response = await fetch(`${url}/ready`);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('private-db-host'), false);
});
test('frontend loads while unconfigured business routes and private files stay unavailable', async (t) => {
  const url = await serve(t, {});
  const home = await fetch(url + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /<html lang="vi"/);
  for (const path of ['/api/bookings', '/.env', '/../package.json']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: 'NOT_FOUND' } });
  }
});
test('malformed and oversized JSON fail without exposing internals', async (t) => {
  const url = await serve(t, {});
  const invalid = await fetch(`${url}/api/unknown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: { code: 'INVALID_JSON' } });
  const large = await fetch(`${url}/api/unknown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(70000) }) });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { error: { code: 'PAYLOAD_TOO_LARGE' } });
});
