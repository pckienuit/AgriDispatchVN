// Bounded HTTP read-load runner. Fixed GET paths only, no auth, no writes.
// Run from the CLI against loopback by default. Remote needs --allow-remote and --allowed-host.
import { writeFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const BENCHMARK_PATHS = Object.freeze(['/health', '/api/services?limit=20', '/api/jobs?limit=20']);
export const BODY_LIMIT_BYTES = 256 * 1024;
const LIMITS = {
  concurrency: [1, 100],
  durationMs: [1000, 300000],
  warmupMs: [0, 30000],
  timeoutMs: [100, 30000],
  maxRequests: [1, 100000],
};
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_ROWS = 100000;
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export class OptionError extends RangeError {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export function validateOptions(options) {
  const out = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = options[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new OptionError('INVALID_OPTION', `${key} phải là số nguyên trong [${min}, ${max}]`);
    }
    out[key] = value;
  }
  out.warmupMaxRequests = options.warmupMaxRequests ?? Math.min(10000, MAX_ROWS - out.maxRequests);
  if (!Number.isInteger(out.warmupMaxRequests) || out.warmupMaxRequests < 0 || out.warmupMaxRequests > 10000
    || out.maxRequests + out.warmupMaxRequests > MAX_ROWS) {
    throw new OptionError('INVALID_OPTION', `warmupMaxRequests phải trong [0, 10000] và tổng dòng <= ${MAX_ROWS}`);
  }
  return { ...out, ...validateOrigin(options) };
}

// Shared target guard: loopback by default; a remote host needs allowRemote, HTTPS and an approved host name.
export function validateOrigin({ baseUrl, allowRemote, allowedHosts }) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw new OptionError('INVALID_BASE_URL', 'baseUrl không hợp lệ');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new OptionError('INVALID_BASE_URL', 'baseUrl chỉ gồm scheme, host và port');
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return { scope: 'loopback', origin: url.origin };
  if (allowRemote !== true) throw new OptionError('REMOTE_NOT_ALLOWED', 'host từ xa cần --allow-remote');
  if (url.protocol !== 'https:') throw new OptionError('INSECURE_REMOTE', 'host từ xa phải dùng HTTPS');
  const approved = (allowedHosts ?? []).map((host) => String(host).toLowerCase());
  if (!approved.includes(url.hostname)) throw new OptionError('REMOTE_HOST_NOT_APPROVED', 'host từ xa chưa được phê duyệt');
  return { scope: 'remote', origin: url.origin };
}

export function nearestRank(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p * sorted.length) / 100);
  return sorted[Math.max(0, rank - 1)];
}

const round = (value, digits) => Number(value.toFixed(digits));

export function summarize(allRows) {
  const rows = allRows.filter((r) => r.phase === 'measure');
  const done = rows.filter((r) => r.error === null);
  const count = (error) => rows.filter((r) => r.error === error).length;
  const start = rows.length ? Math.min(...rows.map((r) => r.offsetMs)) : 0;
  const end = rows.length ? Math.max(...rows.map((r) => r.offsetMs + r.durationMs)) : 0;
  const measuredSeconds = rows.length ? round((end - start) / 1000, 3) : null;
  const durations = done.map((r) => r.durationMs);
  return {
    attempted: rows.length,
    completed: done.length,
    http2xx: done.filter((r) => r.status >= 200 && r.status < 300).length,
    http4xx: done.filter((r) => r.status >= 400 && r.status < 500).length,
    http5xx: done.filter((r) => r.status >= 500 && r.status < 600).length,
    redirectRefused: count('REDIRECT_REFUSED'),
    timeouts: count('TIMEOUT'),
    network: count('NETWORK'),
    bodyLimit: count('BODY_LIMIT'),
    p50Ms: nearestRank(durations, 50),
    p95Ms: nearestRank(durations, 95),
    measuredSeconds,
    throughputRps: measuredSeconds ? round(done.length / measuredSeconds, 3) : null,
  };
}

const csvField = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function toCsv(rows) {
  const header = ['phase', 'path', 'offsetMs', 'durationMs', 'status', 'error', 'bytes'];
  const lines = rows.map((r) => header.map((key) => csvField(r[key])).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}

async function readBounded(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > BODY_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => {});
    return { bytes: 0, error: 'BODY_LIMIT' };
  }
  if (!response.body) return { bytes: 0, error: null };
  const reader = response.body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes, error: null };
    if (bytes + value.byteLength > BODY_LIMIT_BYTES) {
      await reader.cancel().catch(() => {});
      return { bytes, error: 'BODY_LIMIT' };
    }
    bytes += value.byteLength;
  }
}

async function request(origin, urlPath, timeoutMs, now) {
  const controller = new globalThis.AbortController();
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const started = now();
  let status = null;
  let bytes = 0;
  let error;
  try {
    const response = await fetch(new URL(urlPath, origin), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => {});
      error = 'REDIRECT_REFUSED';
    } else {
      ({ bytes, error } = await readBounded(response));
    }
  } catch {
    error = 'NETWORK';
  } finally {
    globalThis.clearTimeout(timer);
  }
  if (timedOut) error = 'TIMEOUT';
  return { status, bytes, error, durationMs: Math.round(now() - started) };
}

export async function runBenchmark(input) {
  const { allowRemote = false, allowedHosts = [], now = () => performance.now(), ...rest } = input;
  const opts = validateOptions({ ...rest, allowRemote, allowedHosts });
  const startedAt = new Date().toISOString();
  const runStart = now();
  const measureStart = runStart + opts.warmupMs;
  const stopAt = measureStart + opts.durationMs;
  const rows = [];
  let seq = 0;
  let warmupIssued = 0;
  let measureIssued = 0;

  const worker = async () => {
    for (;;) {
      const tick = now();
      if (tick >= stopAt) return;
      if (tick < measureStart) {
        if (warmupIssued >= opts.warmupMaxRequests) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, measureStart - tick));
          continue;
        }
        warmupIssued += 1;
      } else {
        if (measureIssued >= opts.maxRequests) return;
        measureIssued += 1;
      }
      const urlPath = BENCHMARK_PATHS[seq % BENCHMARK_PATHS.length];
      seq += 1;
      const row = { path: urlPath, phase: tick < measureStart ? 'warmup' : 'measure', offsetMs: Math.round(tick - runStart) };
      rows.push(row);
      Object.assign(row, await request(opts.origin, urlPath, Math.max(1, Math.min(opts.timeoutMs, stopAt - tick)), now));
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  const measure = rows.filter((r) => r.phase === 'measure');
  return {
    tool: 'benchmark-http',
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    target: { origin: opts.origin, scope: opts.scope },
    config: {
      concurrency: opts.concurrency,
      durationMs: opts.durationMs,
      warmupMs: opts.warmupMs,
      timeoutMs: opts.timeoutMs,
      maxRequests: opts.maxRequests,
      warmupMaxRequests: opts.warmupMaxRequests,
      paths: [...BENCHMARK_PATHS],
      bodyLimitBytes: BODY_LIMIT_BYTES,
    },
    elapsedMs: Math.round(now() - runStart),
    warmupAttempted: rows.length - measure.length,
    aggregates: summarize(measure),
    perPath: Object.fromEntries(BENCHMARK_PATHS.map((p) => [p, summarize(measure.filter((r) => r.path === p))])),
    rows,
  };
}

export async function writeOutputs(prefix, report) {
  const files = [
    [`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`],
    [`${prefix}.csv`, toCsv(report.rows)],
  ];
  const created = [];
  try {
    for (const [file, data] of files) {
      await writeFile(file, data, { flag: 'wx' });
      created.push(file);
    }
  } catch (error) {
    // Remove only files this call created. EEXIST means the file belongs to someone else.
    await Promise.all(created.map((file) => rm(file, { force: true })));
    throw error;
  }
  return created;
}

function isInsideRepo(file) {
  const rel = path.relative(REPO_ROOT, file);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'base-url': { type: 'string', default: 'http://127.0.0.1:3000' },
      concurrency: { type: 'string', default: '4' },
      'duration-ms': { type: 'string', default: '10000' },
      'warmup-ms': { type: 'string', default: '2000' },
      'timeout-ms': { type: 'string', default: '5000' },
      'max-requests': { type: 'string', default: '10000' },
      'allow-remote': { type: 'boolean', default: false },
      'allowed-host': { type: 'string', multiple: true, default: [] },
      output: { type: 'string' },
    },
  });
  if (!values.output) throw new OptionError('OUTPUT_REQUIRED', '--output là tiền tố file, nên đặt ngoài repo');
  const prefix = path.resolve(values.output);
  if (isInsideRepo(prefix)) throw new OptionError('OUTPUT_IN_REPO', 'không ghi kết quả vào trong repo');
  const report = await runBenchmark({
    baseUrl: values['base-url'],
    concurrency: Number(values.concurrency),
    durationMs: Number(values['duration-ms']),
    warmupMs: Number(values['warmup-ms']),
    timeoutMs: Number(values['timeout-ms']),
    maxRequests: Number(values['max-requests']),
    allowRemote: values['allow-remote'],
    allowedHosts: values['allowed-host'],
  });
  const outputs = await writeOutputs(prefix, report);
  const { rows, ...summary } = report;
  console.log(JSON.stringify({ ...summary, outputs, rowCount: rows.length }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
    process.exitCode = error instanceof OptionError ? 2 : 1;
  });
}
