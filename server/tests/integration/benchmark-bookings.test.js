import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import { requestBookingHttp } from '../../scripts/benchmark-bookings.js';
import { createPool } from '../../src/db.js';
import { expectedInvariants, judgeBookingRun, runBookingBenchmark, validateBookingOptions } from '../../scripts/benchmark-bookings.js';

const execFileAsync = promisify(execFile);
const ROOT = process.env.TEST_DATABASE_URL;
const LOOPBACK_ROOT = 'postgresql://bench:not-used@127.0.0.1:1/agridispatch_test';
const REMOTE_ROOT = 'postgresql://bench:not-used@db.example.com:5432/agridispatch_test';
const SCRIPT = fileURLToPath(new URL('../../scripts/benchmark-bookings.js', import.meta.url));

const row = (index, attempt, over = {}) => ({
  index, attempt, status: 201, error: null, durationMs: 5, bytes: 300, businessError: null, bookingId: 'b', totalVnd: '1', ...over,
});
const GOOD = expectedInvariants(2);

test('option bounds and loopback *_test root are checked before any connection', () => {
  const base = { rootDatabaseUrl: 'postgresql://u:p@127.0.0.1:55432/agridispatch_test', count: 6, concurrency: 4, timeoutMs: 3000 };
  assert.doesNotThrow(() => validateBookingOptions(base));
  assert.doesNotThrow(() => validateBookingOptions({ ...base, count: 300, concurrency: 20, timeoutMs: 10000 }));
  for (const bad of [{ count: 0 }, { count: 301 }, { count: 1.5 }, { count: '6' }, { concurrency: 0 }, { concurrency: 21 }, { timeoutMs: 99 }, { timeoutMs: 10001 }]) {
    assert.throws(() => validateBookingOptions({ ...base, ...bad }), { code: 'INVALID_OPTION' }, JSON.stringify(bad));
  }
  for (const rootDatabaseUrl of [REMOTE_ROOT, 'postgresql://u:p@127.0.0.1:55432/agridispatch', undefined]) {
    assert.throws(() => validateBookingOptions({ ...base, rootDatabaseUrl }), { code: 'INVALID_ROOT' });
  }
});

test('bounded HTTP helper rejects a stalled response body and observes the run abort', async (t) => {
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-length':'100'});res.write('{');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url=`http://127.0.0.1:${server.address().port}/api/bookings`;
  const timeout=await requestBookingHttp(new globalThis.AbortController(),{method:'POST',url,body:{synthetic:true},timeoutMs:100});
  assert.equal(timeout.error,'TIMEOUT');
  assert.equal(timeout.text,'');
  const deadline=new globalThis.AbortController();
  const timer=setTimeout(()=>deadline.abort(),50);
  try {
    const result=await requestBookingHttp(deadline,{method:'POST',url,body:{synthetic:true},timeoutMs:4000});
    assert.equal(result.error,'DEADLINE');
    assert.ok(result.durationMs<2000);
  } finally {clearTimeout(timer);}
});

test('remote root is refused before any connection is attempted', async () => {
  await assert.rejects(runBookingBenchmark({ rootDatabaseUrl: REMOTE_ROOT, count: 1 }), { code: 'INVALID_ROOT' });
});

test('CLI needs an output prefix and refuses prefixes inside the repo', async () => {
  const env = { ...process.env, TEST_DATABASE_URL: LOOPBACK_ROOT };
  await assert.rejects(execFileAsync(process.execPath, [SCRIPT, '--count', '1'], { env }),
    (error) => error.code === 2 && /OUTPUT_REQUIRED/.test(error.stderr));
  await assert.rejects(execFileAsync(process.execPath, [SCRIPT, '--count', '1', '--output', './bench-out'], { env }),
    (error) => error.code === 2 && /OUTPUT_IN_REPO/.test(error.stderr));
});

test('judge fails any run with a timeout, non-2xx or broken invariant', () => {
  const clean = [row(0, 1), row(0, 2), row(1, 1), row(1, 2)];
  assert.equal(judgeBookingRun({ count: 2, rows: clean, invariants: GOOD }), true);
  const timedOut = [...clean.slice(0, 3), row(1, 2, { status: null, error: 'TIMEOUT' })];
  assert.equal(judgeBookingRun({ count: 2, rows: timedOut, invariants: GOOD }), false);
  const serverError = [...clean.slice(0, 3), row(1, 2, { status: 500 })];
  assert.equal(judgeBookingRun({ count: 2, rows: serverError, invariants: GOOD }), false);
  assert.equal(judgeBookingRun({ count: 2, rows: clean, invariants: { ...GOOD, storedBookings: 3 } }), false);
  assert.equal(judgeBookingRun({ count: 2, rows: clean, invariants: { ...GOOD, unauthorizedProbe: 201 } }), false);
});

test('dependency that cannot be reached yields a failed report and still no throw', async () => {
  const report = await runBookingBenchmark({ rootDatabaseUrl: LOOPBACK_ROOT, count: 1, concurrency: 1, timeoutMs: 500 });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'SETUP_FAILED');
  assert.equal(report.aggregates, null);
});

test('real HTTP run with duplicate-key pairs stores exactly one booking per key and drops its database', async () => {
  assert.ok(ROOT, 'TEST_DATABASE_URL must be set for booking benchmark integration tests');
  const report = await runBookingBenchmark({ rootDatabaseUrl: ROOT, count: 6, concurrency: 4, timeoutMs: 3000 });
  assert.equal(report.ok, true, JSON.stringify({ error: report.error, invariants: report.invariants }));
  assert.equal(report.aggregates.attempted, 12);
  assert.equal(report.aggregates.http2xx, 12);
  assert.deepEqual(report.invariants, expectedInvariants(6));
  assert.equal(report.cleanup.childDropped, true);

  const text = JSON.stringify(report);
  assert.equal(text.includes(ROOT), false);
  assert.equal(/bearer|password|idempotency-key|authorization/i.test(text), false);

  const pool = createPool(ROOT);
  try {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [report.cleanup.childDatabase]);
    assert.equal(rows[0].n, 0);
  } finally {
    await pool.end();
  }
});
