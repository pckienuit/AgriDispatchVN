import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { probeOnce } from './health.js';
const { Response } = globalThis;
const sha = 'a'.repeat(40);

test('readiness body deadline remains active after headers', async (t) => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'X-Build-SHA': sha }); res.write('{'); }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const started = Date.now();
  assert.equal((await probeOnce(`http://127.0.0.1:${server.address().port}`, sha, { timeoutMs: 100 })).ok, false);
  assert.ok(Date.now() - started < 1500);
});

test('readiness rejects an oversized response even when status and SHA match', async () => {
  const result = await probeOnce('https://example.invalid', sha, { fetchImpl: async () => new Response(JSON.stringify({ status: 'ready', extra: 'x'.repeat(10000) }), { headers: { 'X-Build-SHA': sha } }) });
  assert.equal(result.ok, false);
});
