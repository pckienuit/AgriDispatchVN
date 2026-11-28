import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  BENCHMARK_PATHS,
  nearestRank,
  runBenchmark,
  summarize,
  toCsv,
  validateOptions,
  writeOutputs,
} from '../scripts/benchmark-http.js';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/benchmark-http.js', import.meta.url));

async function serve(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    hits.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const row = (over) => ({ path: '/health', phase: 'measure', offsetMs: 0, durationMs: 10, status: 200, error: null, bytes: 2, ...over });

test('numeric limits reject out-of-range and non-integer values', () => {
  const ok = { baseUrl: 'http://127.0.0.1:3000', concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 100, maxRequests: 1 };
  assert.doesNotThrow(() => validateOptions(ok));
  assert.doesNotThrow(() => validateOptions({ ...ok, concurrency: 100, durationMs: 300000, warmupMs: 30000, timeoutMs: 30000, maxRequests: 100000 }));
  const bad = [
    ['concurrency', 0], ['concurrency', 101], ['concurrency', 1.5], ['concurrency', '2'],
    ['durationMs', 999], ['durationMs', 300001],
    ['warmupMs', -1], ['warmupMs', 30001],
    ['timeoutMs', 99], ['timeoutMs', 30001],
    ['maxRequests', 0], ['maxRequests', 100001], ['maxRequests', NaN],
  ];
  for (const [key, value] of bad) {
    assert.throws(() => validateOptions({ ...ok, [key]: value }), (error) => error instanceof RangeError && error.code === 'INVALID_OPTION', key);
  }
});

test('remote targets need allowRemote, HTTPS and an origin-only URL', () => {
  const ok = { concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 100, maxRequests: 1 };
  assert.throws(() => validateOptions({ ...ok, baseUrl: 'https://api.example.test' }), { code: 'REMOTE_NOT_ALLOWED' });
  assert.throws(() => validateOptions({ ...ok, baseUrl: 'http://api.example.test', allowRemote: true }), { code: 'INSECURE_REMOTE' });
  assert.throws(() => validateOptions({ ...ok, baseUrl: 'https://api.example.test:8443', allowRemote: true }), { code: 'REMOTE_HOST_NOT_APPROVED' });
  const remote = validateOptions({ ...ok, baseUrl: 'https://api.example.test:8443', allowRemote: true, allowedHosts: ['api.example.test'] });
  assert.equal(remote.origin, 'https://api.example.test:8443');
  assert.equal(remote.scope, 'remote');
  for (const baseUrl of ['https://u:p@api.example.test', 'http://127.0.0.1:3000/health', 'http://127.0.0.1:3000?x=1', 'http://127.0.0.1:3000#f', 'ftp://127.0.0.1:3000', 'not a url']) {
    assert.throws(() => validateOptions({ ...ok, baseUrl, allowRemote: true }), { code: 'INVALID_BASE_URL' }, baseUrl);
  }
  for (const baseUrl of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000']) {
    assert.equal(validateOptions({ ...ok, baseUrl }).scope, 'loopback', baseUrl);
  }
});

test('runBenchmark rejects a remote target before any request', async () => {
  await assert.rejects(runBenchmark({ baseUrl: 'https://api.example.test', concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 100, maxRequests: 1 }), { code: 'REMOTE_NOT_ALLOWED' });
});

test('nearest-rank percentiles use sorted numeric values', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(nearestRank(hundred, 50), 50);
  assert.equal(nearestRank(hundred, 95), 95);
  assert.equal(nearestRank([40, 10, 30, 20], 50), 20);
  assert.equal(nearestRank([40, 10, 30, 20], 95), 40);
  assert.equal(nearestRank([7], 95), 7);
  assert.equal(nearestRank([], 50), null);
});

test('summary excludes warmup and counts each outcome separately', () => {
  const rows = [
    row({ offsetMs: 0, durationMs: 10 }),
    row({ offsetMs: 100, durationMs: 20, status: 404 }),
    row({ offsetMs: 200, durationMs: 30, status: 503 }),
    row({ offsetMs: 300, durationMs: 40, status: 302, error: 'REDIRECT_REFUSED' }),
    row({ offsetMs: 400, durationMs: 1000, status: null, error: 'TIMEOUT' }),
    row({ offsetMs: 0, durationMs: 5000, status: null, error: 'NETWORK', phase: 'warmup' }),
  ];
  const s = summarize(rows);
  assert.equal(s.attempted, 5);
  assert.equal(s.completed, 3);
  assert.equal(s.http2xx, 1);
  assert.equal(s.http4xx, 1);
  assert.equal(s.http5xx, 1);
  assert.equal(s.redirectRefused, 1);
  assert.equal(s.timeouts, 1);
  assert.equal(s.network, 0);
  assert.equal(s.bodyLimit, 0);
  assert.equal(s.p50Ms, 20);
  assert.equal(s.p95Ms, 30);
  assert.equal(s.measuredSeconds, 1.4);
  assert.equal(s.throughputRps, 2.143);
  const empty = summarize([]);
  assert.equal(empty.attempted, 0);
  assert.equal(empty.p50Ms, null);
  assert.equal(empty.throughputRps, null);
});

test('CSV quotes commas, quotes and newlines and writes null as empty', () => {
  const csv = toCsv([row({ path: '/a,"b"\nc', phase: 'measure', offsetMs: 0, durationMs: 1, status: null, error: 'NETWORK', bytes: 0 })]);
  assert.equal(csv, 'phase,path,offsetMs,durationMs,status,error,bytes\nmeasure,"/a,""b""\nc",0,1,,NETWORK,0\n');
});

test('output files are exclusive and existing outputs stay untouched', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-out-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = { rows: [row()] };

  const ok = path.join(dir, 'ok');
  const files = await writeOutputs(ok, report);
  assert.deepEqual(files, [`${ok}.json`, `${ok}.csv`]);
  assert.equal(JSON.parse(await readFile(`${ok}.json`, 'utf8')).rows.length, 1);
  await assert.rejects(writeOutputs(ok, report), { code: 'EEXIST' });

  const csvOnly = path.join(dir, 'csv-only');
  await writeFile(`${csvOnly}.csv`, 'keep');
  await assert.rejects(writeOutputs(csvOnly, report), { code: 'EEXIST' });
  assert.equal(await readFile(`${csvOnly}.csv`, 'utf8'), 'keep');
  await assert.rejects(access(`${csvOnly}.json`), { code: 'ENOENT' });

  const jsonOnly = path.join(dir, 'json-only');
  await writeFile(`${jsonOnly}.json`, 'keep');
  await assert.rejects(writeOutputs(jsonOnly, report), { code: 'EEXIST' });
  assert.equal(await readFile(`${jsonOnly}.json`, 'utf8'), 'keep');
  await assert.rejects(access(`${jsonOnly}.csv`), { code: 'ENOENT' });
});

test('runner sends only fixed unauthenticated GET reads', async (t) => {
  const { url, hits } = await serve(t, (req, res) => json(res, 200, { ok: true }));
  const report = await runBenchmark({ baseUrl: url, concurrency: 2, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 9 });
  assert.equal(hits.length, 9);
  for (const hit of hits) {
    assert.equal(hit.method, 'GET');
    assert.equal(hit.headers.authorization, undefined);
    assert.equal(hit.headers.cookie, undefined);
    assert.ok(BENCHMARK_PATHS.includes(hit.url), hit.url);
  }
  assert.deepEqual(Object.keys(report.perPath).sort(), [...BENCHMARK_PATHS].sort());
  for (const p of BENCHMARK_PATHS) assert.equal(report.perPath[p].attempted, 3, p);
  assert.equal(report.aggregates.completed, 9);
  assert.equal(report.target.origin, url);
  assert.equal(report.target.scope, 'loopback');
});

test('mixed HTTP statuses are counted by class and per path', async (t) => {
  const { url } = await serve(t, (req, res) => {
    if (req.url.startsWith('/health')) json(res, 200, { status: 'ok' });
    else if (req.url.startsWith('/api/services')) json(res, 404, { error: { code: 'NOT_FOUND' } });
    else json(res, 503, { error: { code: 'DOWN' } });
  });
  const report = await runBenchmark({ baseUrl: url, concurrency: 3, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 30 });
  assert.equal(report.aggregates.completed, 30);
  assert.equal(report.aggregates.http2xx, 10);
  assert.equal(report.aggregates.http4xx, 10);
  assert.equal(report.aggregates.http5xx, 10);
  assert.equal(report.perPath['/health'].http2xx, 10);
  assert.equal(report.perPath['/api/services?limit=20'].http4xx, 10);
  assert.equal(report.perPath['/api/jobs?limit=20'].http5xx, 10);
});

test('concurrency cap bounds in-flight requests at the server', async (t) => {
  let inflight = 0;
  let peak = 0;
  const { url } = await serve(t, (req, res) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    setTimeout(() => {
      inflight -= 1;
      json(res, 200, {});
    }, 30);
  });
  const report = await runBenchmark({ baseUrl: url, concurrency: 3, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 12 });
  assert.equal(report.aggregates.completed, 12);
  assert.ok(peak <= 3, `peak in-flight ${peak}`);
  assert.ok(peak >= 1);
});

test('hung responses time out and the run stays bounded', async (t) => {
  const { url } = await serve(t, () => {});
  const started = Date.now();
  const report = await runBenchmark({ baseUrl: url, concurrency: 3, durationMs: 1000, warmupMs: 0, timeoutMs: 100, maxRequests: 3 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(report.aggregates.timeouts, 3);
  assert.equal(report.aggregates.completed, 0);
  assert.equal(report.aggregates.p50Ms, null);
  assert.ok(report.elapsedMs < 1000 + 100 + 1500, `elapsed ${report.elapsedMs}`);
});

test('a body that stalls after headers is a timeout, not a success', async (t) => {
  const { url } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-length': '100', 'content-type': 'application/json' });
    res.write('{');
  });
  const report = await runBenchmark({ baseUrl: url, concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 150, maxRequests: 1 });
  assert.equal(report.rows[0].status, 200);
  assert.equal(report.rows[0].error, 'TIMEOUT');
  assert.equal(report.aggregates.completed, 0);
});

test('run deadline aborts in-flight requests instead of waiting for a longer request timeout', async (t) => {
  const {url}=await serve(t,()=>{});
  const started=Date.now();
  const report=await runBenchmark({baseUrl:url,concurrency:1,durationMs:1000,warmupMs:0,timeoutMs:4000,maxRequests:1});
  assert.ok(Date.now()-started<2500,'Global deadline must bound in-flight requests');
  assert.equal(report.aggregates.timeouts,1);
  assert.ok(Number.isFinite(Date.parse(report.startedAt)));
  assert.ok(Number.isFinite(Date.parse(report.finishedAt)));
});

test('duration includes the body: a delayed body is measured', async (t) => {
  const body = JSON.stringify({ status: 'ok' });
  const { url } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
    setTimeout(() => res.end(body), 150);
  });
  const report = await runBenchmark({ baseUrl: url, concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 1 });
  assert.equal(report.rows[0].error, null);
  assert.equal(report.rows[0].bytes, body.length);
  assert.ok(report.rows[0].durationMs >= 140, `durationMs ${report.rows[0].durationMs}`);
});

test('oversize bodies stop at the 256 KiB cap in streaming and declared-length forms', async (t) => {
  const chunk = 'x'.repeat(64 * 1024);
  const streamed = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    for (let i = 0; i < 5; i += 1) res.write(chunk);
    res.end();
  });
  const first = await runBenchmark({ baseUrl: streamed.url, concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 1 });
  assert.equal(first.rows[0].error, 'BODY_LIMIT');
  assert.equal(first.rows[0].status, 200);
  assert.ok(first.rows[0].bytes > 0 && first.rows[0].bytes <= 256 * 1024);
  assert.equal(first.aggregates.bodyLimit, 1);
  assert.equal(first.aggregates.completed, 0);

  const declared = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-length': String(300 * 1024) });
    res.end('x'.repeat(300 * 1024));
  });
  const second = await runBenchmark({ baseUrl: declared.url, concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 1 });
  assert.equal(second.rows[0].error, 'BODY_LIMIT');
  assert.equal(second.rows[0].bytes, 0);
});

test('redirects are refused and the target is never requested', async (t) => {
  const { url, hits } = await serve(t, (req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    } else {
      json(res, 200, {});
    }
  });
  const report = await runBenchmark({ baseUrl: url, concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits.filter((hit) => hit.url === '/elsewhere').length, 0);
  assert.equal(report.rows[0].status, 302);
  assert.equal(report.rows[0].error, 'REDIRECT_REFUSED');
  assert.equal(report.aggregates.redirectRefused, 1);
  assert.equal(report.aggregates.completed, 0);
});

test('warmup requests are recorded but excluded from aggregates', async (t) => {
  const { url, hits } = await serve(t, (req, res) => setTimeout(() => json(res, 200, {}), 10));
  const report = await runBenchmark({ baseUrl: url, concurrency: 2, durationMs: 1000, warmupMs: 300, timeoutMs: 2000, maxRequests: 500 });
  const warmup = report.rows.filter((r) => r.phase === 'warmup');
  const measure = report.rows.filter((r) => r.phase === 'measure');
  assert.ok(warmup.length > 0);
  assert.equal(report.warmupAttempted, warmup.length);
  assert.equal(report.aggregates.attempted, measure.length);
  assert.equal(report.aggregates.completed + report.aggregates.timeouts, measure.length);
  assert.ok(report.aggregates.completed > 0);
  assert.ok(hits.length <= report.rows.length);
});

test('warmup does not consume the measured-request budget', async (t) => {
  const { url } = await serve(t, (req, res) => json(res, 200, {}));
  const report = await runBenchmark({ baseUrl: url, concurrency: 2, durationMs: 1000, warmupMs: 200, timeoutMs: 2000, maxRequests: 5 });
  assert.equal(report.aggregates.attempted, 5);
  assert.equal(report.aggregates.completed, 5);
  assert.ok(report.warmupAttempted > 0);
});

test('warmup row cap stops warmup early, waits out the window, then measures', async (t) => {
  const { url } = await serve(t, (req, res) => json(res, 200, {}));
  const started = Date.now();
  const report = await runBenchmark({ baseUrl: url, concurrency: 1, durationMs: 1000, warmupMs: 300, timeoutMs: 2000, maxRequests: 2, warmupMaxRequests: 3 });
  assert.equal(report.warmupAttempted, 3);
  assert.equal(report.aggregates.attempted, 2);
  assert.equal(report.aggregates.completed, 2);
  assert.ok(Date.now() - started >= 280, 'warmup window must still elapse');
});

test('warmup budget is capped so total retained rows stay within 100000', () => {
  const ok = { baseUrl: 'http://127.0.0.1:3000', concurrency: 1, durationMs: 1000, warmupMs: 0, timeoutMs: 100 };
  assert.equal(validateOptions({ ...ok, maxRequests: 1 }).warmupMaxRequests, 10000);
  assert.equal(validateOptions({ ...ok, maxRequests: 95000 }).warmupMaxRequests, 5000);
  assert.equal(validateOptions({ ...ok, maxRequests: 100000 }).warmupMaxRequests, 0);
  assert.throws(() => validateOptions({ ...ok, maxRequests: 1, warmupMaxRequests: 10001 }), { code: 'INVALID_OPTION' });
});

test('maxRequests caps total attempts exactly', async (t) => {
  const { url, hits } = await serve(t, (req, res) => json(res, 200, {}));
  const report = await runBenchmark({ baseUrl: url, concurrency: 4, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 7 });
  assert.equal(hits.length, 7);
  assert.equal(report.rows.length, 7);
  assert.equal(report.aggregates.attempted, 7);
});

test('connection refused is counted as a network error', async () => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const report = await runBenchmark({ baseUrl: `http://127.0.0.1:${deadPort}`, concurrency: 2, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 3 });
  assert.equal(report.aggregates.network, 3);
  assert.equal(report.rows[0].status, null);
});

test('injected clock bounds the run: a passed deadline sends nothing', async (t) => {
  const { url, hits } = await serve(t, (req, res) => json(res, 200, {}));
  let calls = 0;
  const now = () => (calls++ === 0 ? 0 : 1e9);
  const report = await runBenchmark({ baseUrl: url, concurrency: 2, durationMs: 1000, warmupMs: 0, timeoutMs: 2000, maxRequests: 5, now });
  assert.equal(hits.length, 0);
  assert.equal(report.rows.length, 0);
  assert.equal(report.aggregates.attempted, 0);
});

test('CLI refuses an output inside the repository', async () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT, '--base-url', 'http://127.0.0.1:1', '--output', path.join(repo, 'bench-should-not-exist')]),
    (error) => error.code === 2 && /OUTPUT_IN_REPO/.test(error.stderr),
  );
  await assert.rejects(access(path.join(repo, 'bench-should-not-exist.json')), { code: 'ENOENT' });
});

test('CLI refuses a remote target without --allow-remote and a missing --output', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT, '--base-url', 'https://api.example.test', '--output', path.join(tmpdir(), 'never')]),
    (error) => error.code === 2 && /REMOTE_NOT_ALLOWED/.test(error.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT, '--base-url', 'http://127.0.0.1:1']),
    (error) => error.code === 2 && /OUTPUT_REQUIRED/.test(error.stderr),
  );
});

test('CLI writes JSON and CSV once and refuses to overwrite on rerun', async (t) => {
  const { url } = await serve(t, (req, res) => json(res, 200, {}));
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefix = path.join(dir, 'run1');
  const args = [SCRIPT, '--base-url', url, '--concurrency', '2', '--duration-ms', '1000', '--warmup-ms', '0', '--timeout-ms', '1000', '--max-requests', '6', '--output', prefix];
  const { stdout } = await execFileAsync(process.execPath, args);
  const summary = JSON.parse(stdout);
  assert.equal(summary.aggregates.completed, 6);
  assert.equal(summary.target.scope, 'loopback');
  const saved = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
  assert.equal(saved.rows.length, 6);
  assert.match(await readFile(`${prefix}.csv`, 'utf8'), /^phase,path,offsetMs,durationMs,status,error,bytes\n/);
  const before = await readFile(`${prefix}.json`, 'utf8');
  await assert.rejects(execFileAsync(process.execPath, args), (error) => error.code === 1 && /EEXIST/.test(error.stderr));
  assert.equal(await readFile(`${prefix}.json`, 'utf8'), before);
});
