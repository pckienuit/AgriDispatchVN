// Bounded local booking-write load harness (G12). Disposable local PostgreSQL only. Not a cloud or SLA benchmark.
// Account and booking HTTP apps run in this process on random 127.0.0.1 ports. Writes use a real session token.
// SQL runs only as read-only invariant checks. Remote targets are not supported.
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createAccountApp } from '../src/account-app.js';
import { createApp } from '../src/app.js';
import { quoteTotalVnd } from '../src/booking.js';
import { createPool } from '../src/db.js';
import { createDisposableDatabase, parseDisposableRoot } from '../tests/helpers/test-db.js';
import { migrate } from './migrate.js';
import { nearestRank, writeOutputs } from './benchmark-http.js';
import { seedCatalog } from './seed-catalog.js';

export const HARNESS_DEADLINE_MS = 60000;
const SETUP_TIMEOUT_MS = 10000;
const BODY_LIMIT_BYTES = 256 * 1024;
const LIMITS = { count: [1, 300], concurrency: [1, 20], timeoutMs: [100, 10000] };
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVICE_CODE = 'tillage-tractor';
const FIELD_AREA_M2 = 12000;
const SCHEDULE_START_MS = Date.UTC(2027, 0, 1, 8);
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_MS = 4 * 60 * 60 * 1000;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export class OptionError extends RangeError {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export function parseLocalRoot(value) {
  const invalid = () => new OptionError('INVALID_ROOT', 'TEST_DATABASE_URL phải là PostgreSQL loopback tới DB *_test chuyên dụng');
  if (typeof value !== 'string' || value === '') throw invalid();
  let root;
  try {
    root = parseDisposableRoot(value);
  } catch {
    throw invalid();
  }
  if (!LOOPBACK_HOSTS.has(root.hostname)) throw invalid();
  return root;
}

export function validateBookingOptions(options = {}) {
  const out = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = options[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new OptionError('INVALID_OPTION', `${key} phải là số nguyên trong [${min}, ${max}]`);
    }
    out[key] = value;
  }
  out.root = parseLocalRoot(options.rootDatabaseUrl);
  return out;
}

// Expected end state for count logical bookings: one row, one event, one completed key each, plus a 401 probe.
export function expectedInvariants(count) {
  return {
    storedBookings: count,
    bookingsTotal: count,
    bookingEvents: count,
    idempotencyTotal: count,
    idempotencyComplete: count,
    quoteConsistent: count,
    replaySameId: count,
    distinctBookings: count,
    unauthorizedProbe: 401,
  };
}

export function judgeBookingRun({ count, rows, invariants }) {
  if (!invariants || rows.length !== 2 * count) return false;
  if (!rows.every((row) => row.error === null && row.status >= 200 && row.status < 300)) return false;
  return Object.entries(expectedInvariants(count)).every(([key, value]) => invariants[key] === value);
}

export const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const elapsed = (started) => Math.round(performance.now() - started);
const auth = (token) => ({ authorization: `Bearer ${token}` });
const idempotencyKey = (prefix, index) => `${prefix}-${String(index).padStart(4, '0')}`;

function scheduleBody(fieldId, serviceId, index) {
  const start = SCHEDULE_START_MS + index * DAY_MS;
  return { fieldId, serviceId, startAt: new Date(start).toISOString(), endAt: new Date(start + SLOT_MS).toISOString() };
}

async function readBounded(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > BODY_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => {});
    return { text: '', bytes: 0, error: 'BODY_LIMIT' };
  }
  if (!response.body) return { text: '', bytes: 0, error: null };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > BODY_LIMIT_BYTES) {
      await reader.cancel().catch(() => {});
      return { text: '', bytes, error: 'BODY_LIMIT' };
    }
    bytes += value.byteLength;
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, error: null };
}

// One HTTP call. Aborted by its own timeout or by the global harness deadline; never throws.
export async function requestBookingHttp(deadline, { method, url, headers = {}, body, timeoutMs }) {
  const controller = new globalThis.AbortController();
  const abortOnDeadline = () => controller.abort();
  if (deadline.signal.aborted) controller.abort();
  else deadline.signal.addEventListener('abort', abortOnDeadline, { once: true });
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const started = performance.now();
  const init = { method, headers, signal: controller.signal, redirect: 'manual' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json', ...headers };
    init.body = JSON.stringify(body);
  }
  try {
    const response = await fetch(url, init);
    const read = await readBounded(response);
    const redirected = response.status >= 300 && response.status < 400;
    return {
      status: response.status,
      bytes: read.bytes,
      text: read.text,
      error: read.error ?? (redirected ? 'REDIRECT_REFUSED' : null),
      durationMs: elapsed(started),
    };
  } catch {
    const error = timedOut ? 'TIMEOUT' : deadline.signal.aborted ? 'DEADLINE' : 'NETWORK';
    return { status: null, bytes: 0, text: '', error, durationMs: elapsed(started) };
  } finally {
    globalThis.clearTimeout(timer);
    deadline.signal.removeEventListener('abort', abortOnDeadline);
  }
}

export async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

export const originOf = (server) => `http://127.0.0.1:${server.address().port}`;

function summarizeWrites(rows, count) {
  const errors = {};
  const businessErrors = {};
  for (const row of rows) {
    if (row.error) errors[row.error] = (errors[row.error] ?? 0) + 1;
    if (row.businessError) businessErrors[row.businessError] = (businessErrors[row.businessError] ?? 0) + 1;
  }
  const byKey = new Map(rows.map((row) => [`${row.index}:${row.attempt}`, row]));
  // Duplicate pair raced when their [offset, offset+duration] windows overlap. Informational, not a pass criterion.
  let racedPairs = 0;
  for (let index = 0; index < count; index += 1) {
    const a = byKey.get(`${index}:1`);
    const b = byKey.get(`${index}:2`);
    if (a && b && a.offsetMs < b.offsetMs + b.durationMs && b.offsetMs < a.offsetMs + a.durationMs) racedPairs += 1;
  }
  const completed = rows.filter((row) => row.error === null).map((row) => row.durationMs);
  const status = (min, max) => rows.filter((row) => row.status >= min && row.status < max).length;
  return {
    attempted: rows.length,
    http2xx: status(200, 300),
    http4xx: status(400, 500),
    http5xx: status(500, 600),
    errors,
    businessErrors,
    p50Ms: nearestRank(completed, 50),
    p95Ms: nearestRank(completed, 95),
    racedPairs,
  };
}

export async function closeAll(state) {
  const cleanup = {
    childDatabase: state.child?.name ?? null,
    serversClosed: 0,
    poolEnded: state.pool === null,
    childDropped: state.child ? false : null,
  };
  let failed = false;
  for (const server of state.servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    cleanup.serversClosed += 1;
  }
  if (state.pool) {
    try {
      await state.pool.end();
      cleanup.poolEnded = true;
    } catch {
      failed = true;
    }
  }
  if (state.child) {
    try {
      await state.child.drop();
      cleanup.childDropped = true;
    } catch {
      failed = true;
    }
  }
  return { cleanup, failed };
}

export async function runBookingBenchmark(input = {}) {
  const { count, concurrency, timeoutMs, root } = validateBookingOptions({ count: 30, concurrency: 4, timeoutMs: 3000, ...input });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const deadline = new globalThis.AbortController();
  const deadlineTimer = globalThis.setTimeout(() => deadline.abort(), HARNESS_DEADLINE_MS);
  const runId = randomBytes(6).toString('hex');
  const prefix = `g12-${runId}`;
  const state = { child: null, pool: null, servers: [] };
  const rows = [];
  const got = new Map();
  const counts = { setup: 0, probe: 0 };
  let stage = 'create-database';
  let error = null;
  let invariants = null;

  try {
    state.child = await createDisposableDatabase(root.href);
    stage = 'migrate';
    state.pool = createPool(state.child.url, { statementTimeout: 10000 });
    await migrate(state.pool);
    stage = 'seed';
    await seedCatalog(state.pool);

    stage = 'start-services';
    const internalServiceToken = randomBytes(32).toString('base64url');
    const accountServer = await listen(createAccountApp({ pool: state.pool, internalServiceToken }));
    state.servers.push(accountServer);
    const accountUrl = originOf(accountServer);
    const bookingServer = await listen(createApp({ pool: state.pool, accountServiceUrl: accountUrl, internalServiceToken }));
    state.servers.push(bookingServer);
    const bookingUrl = originOf(bookingServer);

    const setupCall = (options) => {
      counts.setup += 1;
      return requestBookingHttp(deadline, { ...options, timeoutMs: SETUP_TIMEOUT_MS });
    };
    const unexpected = (code) => Object.assign(new Error('unexpected response'), { code });

    stage = 'register';
    const email = `g12-${runId}@bench.example.test`;
    const password = randomBytes(18).toString('base64url');
    const registered = await setupCall({ method: 'POST', url: `${accountUrl}/api/auth/register`, body: { email, password, name: 'Tài khoản tổng hợp G12' } });
    const userId = parseJson(registered.text)?.user?.id;
    if (registered.status !== 201 || !userId) throw unexpected(`REGISTER_${registered.status}`);

    stage = 'login';
    const login = await setupCall({ method: 'POST', url: `${accountUrl}/api/auth/login`, body: { email, password } });
    const token = parseJson(login.text)?.token;
    if (login.status !== 200 || typeof token !== 'string') throw unexpected(`LOGIN_${login.status}`);

    stage = 'create-field';
    const field = await setupCall({ method: 'POST', url: `${bookingUrl}/api/fields`, headers: auth(token), body: { name: 'Ruộng tổng hợp G12', locality: 'Dữ liệu giả lập', areaM2: FIELD_AREA_M2 } });
    const fieldId = parseJson(field.text)?.field?.id;
    if (field.status !== 201 || !fieldId) throw unexpected(`FIELD_${field.status}`);

    stage = 'load-service';
    const catalog = await setupCall({ method: 'GET', url: `${bookingUrl}/api/services?limit=20` });
    const service = parseJson(catalog.text)?.items?.find((item) => item.code === SERVICE_CODE);
    if (catalog.status !== 200 || !service) throw unexpected(`SERVICES_${catalog.status}`);
    const expectedTotal = quoteTotalVnd(service.pricePerHaVnd, FIELD_AREA_M2).toString();

    // Pairs sit next to each other in the queue, so two workers usually pick them up together and race.
    stage = 'writes';
    const tasks = [];
    for (let index = 0; index < count; index += 1) tasks.push({ index, attempt: 1 }, { index, attempt: 2 });
    let next = 0;
    const worker = async () => {
      while (next < tasks.length && !deadline.signal.aborted) {
        const { index, attempt } = tasks[next];
        next += 1;
        const offsetMs = Math.round(performance.now() - started);
        const result = await requestBookingHttp(deadline, {
          method: 'POST',
          url: `${bookingUrl}/api/bookings`,
          headers: { ...auth(token), 'idempotency-key': idempotencyKey(prefix, index) },
          body: scheduleBody(fieldId, service.id, index),
          timeoutMs,
        });
        const json = parseJson(result.text);
        const success = result.status >= 200 && result.status < 300 && result.error === null;
        const booking = success ? json?.booking : undefined;
        if (booking?.id) got.set(`${index}:${attempt}`, { bookingId: booking.id });
        rows.push({
          phase: 'write',
          path: '/api/bookings',
          index,
          attempt,
          offsetMs,
          status: result.status,
          error: result.error ?? (success && !booking?.id ? 'BAD_BODY' : null),
          durationMs: result.durationMs,
          bytes: result.bytes,
          businessError: result.status >= 400 ? (json?.error?.code ?? null) : null,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

    // Unauthenticated write must be refused before any row or key is created.
    stage = 'probe';
    counts.probe += 1;
    const unauth = await requestBookingHttp(deadline, {
      method: 'POST',
      url: `${bookingUrl}/api/bookings`,
      headers: { 'idempotency-key': `${prefix}-probe` },
      body: scheduleBody(fieldId, service.id, 0),
      timeoutMs,
    });

    // Read-only SQL, scoped to the synthetic owner.
    stage = 'invariants';
    const scalar = async (sql, params = []) => Number((await state.pool.query(sql, params)).rows[0].n);
    const pairs = Array.from({ length: count }, (_, index) => [got.get(`${index}:1`), got.get(`${index}:2`)]);
    invariants = {
      storedBookings: await scalar('SELECT count(*)::int AS n FROM dispatch.bookings WHERE owner_id = $1', [userId]),
      bookingsTotal: await scalar('SELECT count(*)::int AS n FROM dispatch.bookings'),
      bookingEvents: await scalar(
        `SELECT count(*)::int AS n FROM dispatch.booking_events e JOIN dispatch.bookings b ON b.id = e.booking_id
          WHERE b.owner_id = $1 AND e.event_type = 'BOOKING_REQUESTED'`,
        [userId],
      ),
      idempotencyTotal: await scalar(
        `SELECT count(*)::int AS n FROM dispatch.idempotency_keys WHERE actor_id = $1 AND operation = 'booking.create'`,
        [userId],
      ),
      idempotencyComplete: await scalar(
        `SELECT count(*)::int AS n FROM dispatch.idempotency_keys
          WHERE actor_id = $1 AND operation = 'booking.create' AND booking_id IS NOT NULL AND response IS NOT NULL`,
        [userId],
      ),
      quoteConsistent: await scalar(
        `SELECT count(*)::int AS n FROM dispatch.bookings
          WHERE owner_id = $1 AND total_vnd = $2::bigint AND price_per_ha_vnd = $3::bigint
            AND field_area_m2 = $4 AND service_code = $5`,
        [userId, expectedTotal, service.pricePerHaVnd, FIELD_AREA_M2, SERVICE_CODE],
      ),
      replaySameId: pairs.filter(([a, b]) => a && b && a.bookingId === b.bookingId).length,
      distinctBookings: new Set([...got.values()].map((value) => value.bookingId)).size,
      unauthorizedProbe: unauth.status,
    };
  } catch (caught) {
    const runPhase = ['writes', 'probe', 'invariants'].includes(stage);
    error = { code: runPhase ? 'RUN_FAILED' : 'SETUP_FAILED', step: stage, cause: caught.code ?? caught.name ?? 'ERROR' };
  }

  const reachedWrites = ['writes', 'probe', 'invariants'].includes(stage);
  const aggregates = reachedWrites ? summarizeWrites(rows, count) : null;
  const verified = error === null && judgeBookingRun({ count, rows, invariants });
  const { cleanup, failed: cleanupFailed } = await closeAll(state);
  globalThis.clearTimeout(deadlineTimer);

  if (deadline.signal.aborted && !verified) error = { code: 'DEADLINE_EXCEEDED', step: stage, cause: 'DEADLINE' };
  if (error === null && cleanupFailed) error = { code: 'CLEANUP_FAILED', step: 'cleanup', cause: 'CLEANUP' };
  if (error === null && !verified) error = { code: 'INCOMPLETE', step: 'verify', cause: null };
  rows.sort((a, b) => a.index - b.index || a.attempt - b.attempt);

  return {
    tool: 'benchmark-bookings',
    schemaVersion: 1,
    ok: error === null && verified && !cleanupFailed,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: elapsed(started),
    target: { scope: 'local-disposable', transport: 'in-process HTTP on 127.0.0.1 random ports' },
    config: {
      count,
      concurrency,
      timeoutMs,
      setupTimeoutMs: SETUP_TIMEOUT_MS,
      deadlineMs: HARNESS_DEADLINE_MS,
      bodyLimitBytes: BODY_LIMIT_BYTES,
      schedule: 'synthetic future dates, 4 h slots from 2027-01-01T08:00Z',
    },
    requests: { setup: counts.setup, writesPlanned: 2 * count, writesIssued: rows.length, probe: counts.probe },
    aggregates,
    invariants,
    cleanup,
    error,
    rows,
  };
}

export function isInsideRepo(file) {
  const rel = path.relative(REPO_ROOT, file);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      count: { type: 'string', default: '30' },
      concurrency: { type: 'string', default: '4' },
      'timeout-ms': { type: 'string', default: '3000' },
      output: { type: 'string' },
    },
  });
  if (!values.output) throw new OptionError('OUTPUT_REQUIRED', '--output là tiền tố file, nên đặt ngoài repo');
  const prefix = path.resolve(values.output);
  if (isInsideRepo(prefix)) throw new OptionError('OUTPUT_IN_REPO', 'không ghi kết quả vào trong repo');
  const report = await runBookingBenchmark({
    rootDatabaseUrl: process.env.TEST_DATABASE_URL,
    count: Number(values.count),
    concurrency: Number(values.concurrency),
    timeoutMs: Number(values['timeout-ms']),
  });
  // BUILD_SHA is declared by the operator, not verified against git. Recorded only when it looks like a SHA.
  const sha = process.env.BUILD_SHA ?? '';
  report.provenance = { buildSha: SHA_PATTERN.test(sha) ? sha : null, source: 'env BUILD_SHA, khai báo không xác minh' };
  const outputs = await writeOutputs(prefix, report);
  const { rows, ...summary } = report;
  console.log(JSON.stringify({ ...summary, outputs, rowCount: rows.length }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
    process.exitCode = error instanceof OptionError ? 2 : 1;
  });
}
