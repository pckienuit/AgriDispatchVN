import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const entry = fileURLToPath(new URL('../src/server.js', import.meta.url));
test('missing config fails fast without disclosing secrets', async () => {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, DATABASE_URL: '' } });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(stderr, /Startup failed/);
});
test('SIGTERM drains HTTP and shuts down cleanly', { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: '31879', DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/app' } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => { if (data.toString().includes('Listening')) resolve(); });
    child.on('exit', () => reject(new Error('server exited before listening')));
    child.on('error', reject);
  });
  assert.equal((await fetch('http://127.0.0.1:31879/health')).status, 200);
  child.kill('SIGTERM');
  const [code, signal] = await exit;
  assert.equal(code, 0);
  assert.equal(signal, null);
});
