// Bounded local recruitment-write harness (CL-12). Disposable local PostgreSQL only. Not a cloud or SLA benchmark.
// One provider posts one job with fixed capacity. N operators apply (each twice, same payload), the provider offers
// every application, then all operators accept at once. The run counts invariant violations instead of hiding them.
// Business writes go through real HTTP sessions. SQL is used for migration, catalog seed, the trusted role grant
// (same fixture as the integration tests) and read-only invariant checks.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createAccountApp } from '../src/account-app.js';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { createDisposableDatabase } from '../tests/helpers/test-db.js';
import { migrate } from './migrate.js';
import { nearestRank, writeOutputs } from './benchmark-http.js';
import {
  HARNESS_DEADLINE_MS, OptionError, closeAll, isInsideRepo, listen, originOf, parseJson, parseLocalRoot, requestBookingHttp,
} from './benchmark-bookings.js';
import { seedCatalog } from './seed-catalog.js';

const SETUP_TIMEOUT_MS = 10000;
const LIMITS = { operators: [2, 40], capacity: [1, 40], concurrency: [1, 40], timeoutMs: [100, 10000] };
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const JOB_START = '2027-02-01T01:00:00Z';
const JOB_END = '2027-02-01T09:00:00Z';
// Setup registers 1 + operators accounts from one loopback IP, above the demo default of 10 per window.
// Raised only for this in-process harness and recorded in config; the app default is unchanged.
const HARNESS_THROTTLE = { registerIpMax: 100, loginIpMax: 100 };

export function validateRecruitmentOptions(options = {}) {
  const out = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = options[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new OptionError('INVALID_OPTION', `${key} phải là số nguyên trong [${min}, ${max}]`);
    }
    out[key] = value;
  }
  if (out.capacity > out.operators) throw new OptionError('INVALID_OPTION', 'capacity không được lớn hơn operators');
  out.root = parseLocalRoot(options.rootDatabaseUrl);
  return out;
}

// Expected end state. Every key is checked; each mismatch is one violation.
export function expectedRecruitment({ operators, capacity }) {
  return {
    applyCreated: operators,
    applyDuplicateRefused: operators,
    offerCreated: operators,
    acceptOk: capacity,
    acceptCapacityFull: operators - capacity,
    storedApplications: operators,
    distinctApplicants: operators,
    liveOffers: operators,
    acceptedOffers: capacity,
    overCapacity: 0,
    applicationEvents: operators,
    offerEvents: operators,
    acceptEvents: capacity,
    unauthorizedProbe: 401,
  };
}

export function findViolations(expected, observed) {
  if (!observed) return [{ invariant: 'observed', expected: 'present', actual: null }];
  return Object.entries(expected)
    .filter(([key, value]) => observed[key] !== value)
    .map(([key, value]) => ({ invariant: key, expected: value, actual: observed[key] ?? null }));
}

function summarize(rows) {
  const errors = {};
  const businessErrors = {};
  for (const row of rows) {
    if (row.error) errors[row.error] = (errors[row.error] ?? 0) + 1;
    if (row.businessError) businessErrors[row.businessError] = (businessErrors[row.businessError] ?? 0) + 1;
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
  };
}

const countWhere = (rows, phase, predicate) => rows.filter((row) => row.phase === phase && predicate(row)).length;

export async function runRecruitmentBenchmark(input = {}) {
  const { operators, capacity, concurrency, timeoutMs, root } = validateRecruitmentOptions({
    operators: 10, capacity: 3, concurrency: 10, timeoutMs: 3000, ...input,
  });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const deadline = new globalThis.AbortController();
  const deadlineTimer = globalThis.setTimeout(() => deadline.abort(), HARNESS_DEADLINE_MS);
  const runId = randomBytes(6).toString('hex');
  const state = { child: null, pool: null, servers: [] };
  const rows = [];
  const counts = { setup: 0, probe: 0 };
  let stage = 'create-database';
  let error = null;
  let observed = null;

  const call = (options) => requestBookingHttp(deadline, options);
  const unexpected = (code) => Object.assign(new Error('unexpected response'), { code });
  const runPool = async (tasks, work) => {
    let next = 0;
    const worker = async () => {
      while (next < tasks.length && !deadline.signal.aborted) {
        const task = tasks[next];
        next += 1;
        await work(task);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  };

  try {
    state.child = await createDisposableDatabase(root.href);
    stage = 'migrate';
    state.pool = createPool(state.child.url, { statementTimeout: 10000 });
    await migrate(state.pool);
    stage = 'seed';
    await seedCatalog(state.pool);

    stage = 'start-services';
    const internalServiceToken = randomBytes(32).toString('base64url');
    const accountServer = await listen(createAccountApp({ pool: state.pool, internalServiceToken, throttle: HARNESS_THROTTLE }));
    state.servers.push(accountServer);
    const accountUrl = originOf(accountServer);
    const bookingServer = await listen(createApp({ pool: state.pool, accountServiceUrl: accountUrl, internalServiceToken }));
    state.servers.push(bookingServer);
    const appUrl = originOf(bookingServer);

    const setupCall = (options) => {
      counts.setup += 1;
      return call({ ...options, timeoutMs: SETUP_TIMEOUT_MS });
    };
    const session = async (label, role) => {
      const email = `cl12-${runId}-${label}@bench.example.test`;
      const password = randomBytes(18).toString('base64url');
      const registered = await setupCall({ method: 'POST', url: `${accountUrl}/api/auth/register`, body: { email, password, name: `Tài khoản tổng hợp ${label}` } });
      const userId = parseJson(registered.text)?.user?.id;
      if (registered.status !== 201 || !userId) throw unexpected(`REGISTER_${registered.status}`);
      // Trusted setup grant, same as the integration fixture. Clients never choose their own role.
      await state.pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [userId, role]);
      const login = await setupCall({ method: 'POST', url: `${accountUrl}/api/auth/login`, body: { email, password } });
      const token = parseJson(login.text)?.token;
      if (login.status !== 200 || typeof token !== 'string') throw unexpected(`LOGIN_${login.status}`);
      return { userId, token };
    };

    stage = 'register';
    const provider = await session('provider', 'provider');
    const workers = [];
    for (let index = 0; index < operators; index += 1) workers.push(await session(`operator-${index}`, 'operator'));

    stage = 'create-job';
    const created = await setupCall({
      method: 'POST', url: `${appUrl}/api/jobs`, headers: { authorization: `Bearer ${provider.token}` },
      body: { title: 'Tin tuyển tổng hợp CL-12', locality: 'Dữ liệu giả lập', capacity, startAt: JOB_START, endAt: JOB_END },
    });
    const jobId = parseJson(created.text)?.job?.id;
    if (created.status !== 201 || !jobId) throw unexpected(`JOB_${created.status}`);

    const measured = async (phase, pathLabel, index, attempt, { url, token }) => {
      const offsetMs = Math.round(performance.now() - started);
      const result = await call({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, body: {}, timeoutMs });
      const json = parseJson(result.text);
      const row = {
        phase, path: pathLabel, index, attempt, offsetMs, status: result.status, error: result.error,
        durationMs: result.durationMs, bytes: result.bytes, businessError: result.status >= 400 ? (json?.error?.code ?? null) : null,
      };
      rows.push(row);
      return json;
    };

    // Each operator applies twice back to back, so workers race on the unique (job, operator) index.
    stage = 'apply';
    const applicationIds = new Map();
    const applyTasks = [];
    for (let index = 0; index < operators; index += 1) applyTasks.push({ index, attempt: 1 }, { index, attempt: 2 });
    await runPool(applyTasks, async ({ index, attempt }) => {
      const json = await measured('apply', '/api/jobs/:id/applications', index, attempt, { url: `${appUrl}/api/jobs/${jobId}/applications`, token: workers[index].token });
      if (json?.application?.id) applicationIds.set(index, json.application.id);
    });

    stage = 'offer';
    const offerIds = new Map();
    await runPool([...applicationIds.entries()], async ([index, applicationId]) => {
      const json = await measured('offer', '/api/applications/:id/offers', index, 1, { url: `${appUrl}/api/applications/${applicationId}/offers`, token: provider.token });
      if (json?.offer?.id) offerIds.set(index, json.offer.id);
    });

    // All accepts start together. Only `capacity` may win; the rest must get CAPACITY_FULL.
    stage = 'accept';
    await runPool([...offerIds.entries()], async ([index, offerId]) => {
      await measured('accept', '/api/offers/:id/accept', index, 1, { url: `${appUrl}/api/offers/${offerId}/accept`, token: workers[index].token });
    });

    stage = 'probe';
    counts.probe += 1;
    const unauth = await call({ method: 'POST', url: `${appUrl}/api/jobs/${jobId}/applications`, body: {}, timeoutMs });

    stage = 'invariants';
    const scalar = async (sql, params) => Number((await state.pool.query(sql, params)).rows[0].n);
    const events = (action) => scalar(
      `SELECT count(*)::int AS n FROM dispatch.recruitment_events e
        WHERE e.action = $2 AND (
          (e.entity_type = 'application' AND e.entity_id IN (SELECT id FROM dispatch.applications WHERE job_id = $1)) OR
          (e.entity_type = 'offer' AND e.entity_id IN (SELECT id FROM dispatch.offers WHERE job_id = $1)))`,
      [jobId, action],
    );
    const acceptedOffers = await scalar("SELECT count(*)::int AS n FROM dispatch.offers WHERE job_id = $1 AND status = 'ACCEPTED'", [jobId]);
    observed = {
      applyCreated: countWhere(rows, 'apply', (row) => row.status === 201),
      applyDuplicateRefused: countWhere(rows, 'apply', (row) => row.status === 409 && row.businessError === 'DUPLICATE_APPLICATION'),
      offerCreated: countWhere(rows, 'offer', (row) => row.status === 201),
      acceptOk: countWhere(rows, 'accept', (row) => row.status === 200),
      acceptCapacityFull: countWhere(rows, 'accept', (row) => row.status === 409 && row.businessError === 'CAPACITY_FULL'),
      storedApplications: await scalar('SELECT count(*)::int AS n FROM dispatch.applications WHERE job_id = $1', [jobId]),
      distinctApplicants: await scalar('SELECT count(DISTINCT operator_id)::int AS n FROM dispatch.applications WHERE job_id = $1', [jobId]),
      liveOffers: await scalar("SELECT count(*)::int AS n FROM dispatch.offers WHERE job_id = $1 AND status IN ('OFFERED', 'ACCEPTED')", [jobId]),
      acceptedOffers,
      overCapacity: Math.max(0, acceptedOffers - capacity),
      applicationEvents: await events('application.created'),
      offerEvents: await events('offer.created'),
      acceptEvents: await events('offer.accepted'),
      unauthorizedProbe: unauth.status,
    };
  } catch (caught) {
    const runPhase = ['apply', 'offer', 'accept', 'probe', 'invariants'].includes(stage);
    error = { code: runPhase ? 'RUN_FAILED' : 'SETUP_FAILED', step: stage, cause: caught.code ?? caught.name ?? 'ERROR' };
  }

  const expected = expectedRecruitment({ operators, capacity });
  const violations = error === null ? findViolations(expected, observed) : [];
  const transportErrors = rows.filter((row) => row.error !== null).length;
  const { cleanup, failed: cleanupFailed } = await closeAll(state);
  globalThis.clearTimeout(deadlineTimer);

  if (deadline.signal.aborted && error === null) error = { code: 'DEADLINE_EXCEEDED', step: stage, cause: 'DEADLINE' };
  if (error === null && cleanupFailed) error = { code: 'CLEANUP_FAILED', step: 'cleanup', cause: 'CLEANUP' };
  if (error === null && transportErrors > 0) error = { code: 'INCOMPLETE', step: 'verify', cause: 'TRANSPORT_ERRORS' };
  rows.sort((a, b) => a.offsetMs - b.offsetMs || a.index - b.index || a.attempt - b.attempt);
  const phases = ['apply', 'offer', 'accept'];

  return {
    tool: 'benchmark-recruitment',
    schemaVersion: 1,
    // measurementValid: the harness ran to the end and every request got a response. Violations are reported separately.
    measurementValid: error === null,
    ok: error === null && violations.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started),
    target: { scope: 'local-disposable', transport: 'in-process HTTP on 127.0.0.1 random ports' },
    config: { operators, capacity, concurrency, timeoutMs, setupTimeoutMs: SETUP_TIMEOUT_MS, deadlineMs: HARNESS_DEADLINE_MS, throttle: HARNESS_THROTTLE, job: { startAt: JOB_START, endAt: JOB_END } },
    requests: { setup: counts.setup, writesIssued: rows.length, probe: counts.probe },
    aggregates: rows.length ? summarize(rows) : null,
    perPhase: Object.fromEntries(phases.map((phase) => [phase, summarize(rows.filter((row) => row.phase === phase))])),
    expected,
    observed,
    violationCount: violations.length,
    violations,
    cleanup,
    error,
    rows,
  };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      operators: { type: 'string', default: '10' },
      capacity: { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '10' },
      'timeout-ms': { type: 'string', default: '3000' },
      output: { type: 'string' },
    },
  });
  if (!values.output) throw new OptionError('OUTPUT_REQUIRED', '--output là tiền tố file, nên đặt ngoài repo');
  const prefix = path.resolve(values.output);
  if (isInsideRepo(prefix)) throw new OptionError('OUTPUT_IN_REPO', 'không ghi kết quả vào trong repo');
  const report = await runRecruitmentBenchmark({
    rootDatabaseUrl: process.env.TEST_DATABASE_URL,
    operators: Number(values.operators),
    capacity: Number(values.capacity),
    concurrency: Number(values.concurrency),
    timeoutMs: Number(values['timeout-ms']),
  });
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
