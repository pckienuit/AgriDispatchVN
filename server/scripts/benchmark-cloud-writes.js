// CL-12 write cases over the public API, for an approved staging host or a local server.
// Unlike the local harnesses, nothing here touches the database: accounts register through the API, roles come from
// role requests an admin approves, and invariants are read back through the API. Credentials live in a JSON file
// outside the repo; passwords and tokens never go to stdout or result files.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { quoteTotalVnd } from '../src/booking.js';
import { OptionError, isInsideRepo, parseJson, requestBookingHttp } from './benchmark-bookings.js';
import { nearestRank, validateOrigin, writeOutputs } from './benchmark-http.js';

export const RUN_DEADLINE_MS = 120000;
const SETUP_TIMEOUT_MS = 15000;
const SERVICE_CODE = 'tillage-tractor';
const FIELD_AREA_M2 = 12000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIMITS = {
  booking: { count: [1, 50], concurrency: [1, 20], timeoutMs: [100, 30000] },
  recruitment: { capacity: [1, 40], concurrency: [1, 40], timeoutMs: [100, 30000] },
};
const EMAIL_DOMAIN = 'bench.example.test';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const elapsed = (started) => Math.round(performance.now() - started);
const bearer = (token) => ({ authorization: `Bearer ${token}` });

function checkLimits(kind, options) {
  const out = {};
  for (const [key, [min, max]] of Object.entries(LIMITS[kind])) {
    const value = options[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new OptionError('INVALID_OPTION', `${key} phải là số nguyên trong [${min}, ${max}]`);
    out[key] = value;
  }
  return out;
}

// ---- Credentials file -------------------------------------------------------------------------------------------

const newAccount = (label) => ({
  label,
  email: `cl12-bench-${label}-${randomBytes(4).toString('hex')}@${EMAIL_DOMAIN}`,
  password: randomBytes(18).toString('base64url'),
  registered: false,
});

export function createCredentials(origin, operators) {
  return {
    schemaVersion: 1,
    origin,
    createdAt: new Date().toISOString(),
    farmer: newAccount('farmer'),
    provider: newAccount('provider'),
    operators: Array.from({ length: operators }, (_, index) => newAccount(`operator-${String(index + 1).padStart(2, '0')}`)),
  };
}

export function validateCredentials(creds, origin) {
  const bad = (why) => new OptionError('INVALID_CREDENTIALS', `file tài khoản không hợp lệ: ${why}`);
  if (!creds || creds.schemaVersion !== 1) throw bad('schemaVersion');
  if (creds.origin !== origin) throw bad(`file thuộc ${creds.origin}, không phải ${origin}`);
  const accounts = [creds.farmer, creds.provider, ...(Array.isArray(creds.operators) ? creds.operators : [])];
  if (!Array.isArray(creds.operators) || creds.operators.length < 2) throw bad('cần ít nhất 2 thợ');
  for (const account of accounts) {
    if (typeof account?.email !== 'string' || !account.email.endsWith(`@${EMAIL_DOMAIN}`) || typeof account.password !== 'string' || account.password.length < 12) throw bad('tài khoản thiếu email hoặc mật khẩu');
  }
  return creds;
}

function credentialsPath(file) {
  if (!file) throw new OptionError('CREDENTIALS_REQUIRED', '--credentials là file JSON nằm ngoài repo');
  const resolved = path.resolve(file);
  if (isInsideRepo(resolved)) throw new OptionError('CREDENTIALS_IN_REPO', 'file tài khoản không được nằm trong repo');
  return resolved;
}

export async function loadCredentials(file, origin) {
  let text;
  try {
    text = await readFile(credentialsPath(file), 'utf8');
  } catch (error) {
    if (error instanceof OptionError) throw error;
    throw new OptionError('CREDENTIALS_MISSING', 'chưa có file tài khoản; chạy lệnh setup trước');
  }
  return validateCredentials(parseJson(text), origin);
}

// ---- Sessions (one login per account per process; staging limits failed logins, sessions last 8 h) --------------

const sessions = new Map();

async function login(deadline, origin, account) {
  const key = `${origin}|${account.email}`;
  if (sessions.has(key)) return sessions.get(key);
  const result = await requestBookingHttp(deadline, { method: 'POST', url: `${origin}/api/auth/login`, body: { email: account.email, password: account.password }, timeoutMs: SETUP_TIMEOUT_MS });
  const json = parseJson(result.text);
  if (result.status !== 200 || typeof json?.token !== 'string') throw Object.assign(new Error('login failed'), { code: `LOGIN_${result.status ?? result.error}` });
  const session = { token: json.token, userId: json.user?.id, roles: json.user?.roles ?? [] };
  sessions.set(key, session);
  return session;
}

export function clearSessions() {
  sessions.clear();
}

// ---- setup / status ---------------------------------------------------------------------------------------------

// Registers missing accounts and files role requests. Stops cleanly on 429 so it can be rerun after the window.
export async function setupAccounts({ origin, creds, save, log = () => {} }) {
  const deadline = new globalThis.AbortController();
  const all = [creds.farmer, creds.provider, ...creds.operators];
  for (const account of all) {
    if (account.registered) continue;
    const result = await requestBookingHttp(deadline, { method: 'POST', url: `${origin}/api/auth/register`, body: { email: account.email, password: account.password, name: `Tài khoản tổng hợp CL-12 ${account.label}` }, timeoutMs: SETUP_TIMEOUT_MS });
    if (result.status === 429) {
      await save();
      return { done: false, reason: 'REGISTER_RATE_LIMITED' };
    }
    if (result.status !== 201 && result.status !== 409) throw Object.assign(new Error('register failed'), { code: `REGISTER_${result.status ?? result.error}` });
    account.registered = true;
    await save();
    log(`${account.label}: đã đăng ký`);
  }
  const wanted = [[creds.provider, 'provider'], ...creds.operators.map((account) => [account, 'operator'])];
  for (const [account, role] of wanted) {
    const session = await login(deadline, origin, account);
    if (session.roles.includes(role)) continue;
    const result = await requestBookingHttp(deadline, { method: 'POST', url: `${origin}/api/role-requests`, headers: bearer(session.token), body: { role }, timeoutMs: SETUP_TIMEOUT_MS });
    const code = parseJson(result.text)?.error?.code;
    if (result.status !== 201 && !['REQUEST_PENDING', 'ROLE_ALREADY_GRANTED'].includes(code)) throw Object.assign(new Error('role request failed'), { code: `ROLE_REQUEST_${result.status ?? result.error}` });
    log(`${account.label}: đã gửi yêu cầu vai trò ${role}`);
  }
  return { done: true };
}

// Logs in fresh (roles are read at login) and reports which accounts still wait for admin approval.
export async function accountStatus({ origin, creds }) {
  clearSessions();
  const deadline = new globalThis.AbortController();
  const rows = [];
  const check = async (account, role) => {
    if (!account.registered) return rows.push({ label: account.label, needs: role, ready: false, state: 'chưa đăng ký' });
    const session = await login(deadline, origin, account);
    const ready = role === 'farmer' || session.roles.includes(role);
    return rows.push({ label: account.label, needs: role, ready, state: ready ? 'sẵn sàng' : 'chờ admin duyệt' });
  };
  await check(creds.farmer, 'farmer');
  await check(creds.provider, 'provider');
  for (const account of creds.operators) await check(account, 'operator');
  return rows;
}

// ---- shared run helpers -----------------------------------------------------------------------------------------

function summarize(rows) {
  const errors = {};
  const businessErrors = {};
  for (const row of rows) {
    if (row.error) errors[row.error] = (errors[row.error] ?? 0) + 1;
    if (row.businessError) businessErrors[row.businessError] = (businessErrors[row.businessError] ?? 0) + 1;
  }
  const completed = rows.filter((row) => row.error === null).map((row) => row.durationMs);
  const status = (min, max) => rows.filter((row) => row.status >= min && row.status < max).length;
  return { attempted: rows.length, http2xx: status(200, 300), http4xx: status(400, 500), http5xx: status(500, 600), errors, businessErrors, p50Ms: nearestRank(completed, 50), p95Ms: nearestRank(completed, 95) };
}

export function findViolations(expected, observed) {
  if (!observed) return [{ invariant: 'observed', expected: 'present', actual: null }];
  return Object.entries(expected).filter(([key, value]) => observed[key] !== value).map(([key, value]) => ({ invariant: key, expected: value, actual: observed[key] ?? null }));
}

async function pool(items, concurrency, deadline, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !deadline.signal.aborted) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function baseReport(tool, startedAt, started, scope, origin) {
  return { tool, schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), elapsedMs: elapsed(started), target: { scope, origin, transport: 'public HTTP API' } };
}

function finish({ tool, startedAt, started, target, config, rows, expected, observed, error, deadline, extra = {} }) {
  if (deadline.signal.aborted && error === null) error = { code: 'DEADLINE_EXCEEDED', step: 'run', cause: 'DEADLINE' };
  if (error === null && rows.some((row) => row.error !== null)) error = { code: 'INCOMPLETE', step: 'verify', cause: 'TRANSPORT_ERRORS' };
  const violations = error === null ? findViolations(expected, observed) : [];
  rows.sort((a, b) => a.offsetMs - b.offsetMs || a.index - b.index || a.attempt - b.attempt);
  return {
    ...baseReport(tool, startedAt, started, target.scope, target.origin),
    measurementValid: error === null,
    ok: error === null && violations.length === 0,
    config,
    aggregates: rows.length ? summarize(rows) : null,
    ...extra,
    expected,
    observed,
    violationCount: violations.length,
    violations,
    error,
    rows,
  };
}

function measuredCall(deadline, started, rows, timeoutMs) {
  return async ({ phase, pathLabel, index, attempt, method = 'POST', url, token, headers = {}, body = {} }) => {
    const offsetMs = elapsed(started);
    const result = await requestBookingHttp(deadline, { method, url, headers: { ...bearer(token), ...headers }, body, timeoutMs });
    const json = parseJson(result.text);
    rows.push({ phase, path: pathLabel, index, attempt, offsetMs, status: result.status, error: result.error, durationMs: result.durationMs, bytes: result.bytes, businessError: result.status >= 400 ? (json?.error?.code ?? null) : null });
    return { status: result.status, json };
  };
}

// ---- booking case -----------------------------------------------------------------------------------------------

const prepared = new Map();

export async function runCloudBookingBenchmark(input) {
  const target = validateOrigin(input);
  const { count, concurrency, timeoutMs } = checkLimits('booking', { count: 10, concurrency: 4, timeoutMs: 5000, ...input });
  const creds = validateCredentials(input.creds, target.origin);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const deadline = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => deadline.abort(), RUN_DEADLINE_MS);
  const runId = randomBytes(6).toString('hex');
  const rows = [];
  const config = { count, concurrency, timeoutMs, deadlineMs: RUN_DEADLINE_MS, fieldAreaM2: FIELD_AREA_M2, serviceCode: SERVICE_CODE };
  const expected = { writesOk: 2 * count, replaySameId: count, distinctBookings: count, quoteConsistent: count, readbackOk: count, requestedEvents: count, unauthorizedProbe: 401 };
  let observed = null;
  let error = null;
  let stage = 'login';
  try {
    const session = await login(deadline, target.origin, creds.farmer);
    stage = 'prepare';
    // One field and one service lookup per process and host: the run measures writes, not setup.
    let ready = prepared.get(target.origin);
    if (!ready) {
      const catalog = await requestBookingHttp(deadline, { method: 'GET', url: `${target.origin}/api/services?limit=20`, timeoutMs: SETUP_TIMEOUT_MS });
      const service = parseJson(catalog.text)?.items?.find((item) => item.code === SERVICE_CODE);
      if (catalog.status !== 200 || !service) throw Object.assign(new Error('service missing'), { code: `SERVICES_${catalog.status}` });
      const field = await requestBookingHttp(deadline, { method: 'POST', url: `${target.origin}/api/fields`, headers: bearer(session.token), body: { name: 'Ruộng tổng hợp CL-12', locality: 'Dữ liệu giả lập', areaM2: FIELD_AREA_M2 }, timeoutMs: SETUP_TIMEOUT_MS });
      const fieldId = parseJson(field.text)?.field?.id;
      if (field.status !== 201 || !fieldId) throw Object.assign(new Error('field failed'), { code: `FIELD_${field.status}` });
      ready = { fieldId, serviceId: service.id, expectedTotal: quoteTotalVnd(service.pricePerHaVnd, FIELD_AREA_M2).toString() };
      prepared.set(target.origin, ready);
    }
    stage = 'writes';
    const call = measuredCall(deadline, started, rows, timeoutMs);
    const runStart = Date.UTC(2028, 0, 1, 8) + (parseInt(runId.slice(0, 6), 16) % 3000) * DAY_MS;
    const tasks = [];
    for (let index = 0; index < count; index += 1) tasks.push({ index, attempt: 1 }, { index, attempt: 2 });
    const got = new Map();
    await pool(tasks, concurrency, deadline, async ({ index, attempt }) => {
      const start = runStart + index * DAY_MS;
      const { status, json } = await call({
        phase: 'write', pathLabel: '/api/bookings', index, attempt, url: `${target.origin}/api/bookings`, token: session.token,
        headers: { 'idempotency-key': `cl12c-${runId}-${String(index).padStart(3, '0')}` },
        body: { fieldId: ready.fieldId, serviceId: ready.serviceId, startAt: iso(start), endAt: iso(start + 4 * 60 * 60 * 1000) },
      });
      if (status >= 200 && status < 300 && json?.booking?.id) got.set(`${index}:${attempt}`, json.booking);
    });
    stage = 'readback';
    const ids = [...new Set([...got.values()].map((booking) => booking.id))];
    const readback = new Map();
    await pool(ids, concurrency, deadline, async (id) => {
      const result = await requestBookingHttp(deadline, { method: 'GET', url: `${target.origin}/api/bookings/${id}`, headers: bearer(session.token), timeoutMs: SETUP_TIMEOUT_MS });
      if (result.status === 200) readback.set(id, parseJson(result.text));
    });
    stage = 'probe';
    const probe = await requestBookingHttp(deadline, { method: 'POST', url: `${target.origin}/api/bookings`, headers: { 'idempotency-key': `cl12c-${runId}-probe` }, body: { fieldId: ready.fieldId, serviceId: ready.serviceId, startAt: iso(runStart), endAt: iso(runStart + 3600000) }, timeoutMs });
    const pairs = Array.from({ length: count }, (_, index) => [got.get(`${index}:1`), got.get(`${index}:2`)]);
    observed = {
      writesOk: rows.filter((row) => row.status >= 200 && row.status < 300).length,
      replaySameId: pairs.filter(([a, b]) => a && b && a.id === b.id).length,
      distinctBookings: ids.length,
      quoteConsistent: ids.filter((id) => [...got.values()].find((booking) => booking.id === id)?.totalVnd?.toString() === ready.expectedTotal).length,
      readbackOk: ids.filter((id) => readback.get(id)?.booking?.id === id).length,
      requestedEvents: ids.filter((id) => (readback.get(id)?.events ?? []).filter((event) => event.type === 'BOOKING_REQUESTED').length === 1).length,
      unauthorizedProbe: probe.status,
    };
  } catch (caught) {
    error = { code: ['writes', 'readback', 'probe'].includes(stage) ? 'RUN_FAILED' : 'SETUP_FAILED', step: stage, cause: caught.code ?? caught.name ?? 'ERROR' };
  } finally {
    globalThis.clearTimeout(timer);
  }
  return finish({ tool: 'benchmark-cloud-booking', startedAt, started, target, config, rows, expected, observed, error, deadline });
}

// ---- recruitment case -------------------------------------------------------------------------------------------

export async function runCloudRecruitmentBenchmark(input) {
  const target = validateOrigin(input);
  const creds = validateCredentials(input.creds, target.origin);
  const operators = creds.operators.length;
  const { capacity, concurrency, timeoutMs } = checkLimits('recruitment', { capacity: 3, concurrency: operators, timeoutMs: 5000, ...input });
  if (capacity > operators) throw new OptionError('INVALID_OPTION', 'capacity không được lớn hơn số thợ');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const deadline = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => deadline.abort(), RUN_DEADLINE_MS);
  const runId = randomBytes(6).toString('hex');
  const rows = [];
  const config = { operators, capacity, concurrency, timeoutMs, deadlineMs: RUN_DEADLINE_MS };
  const expected = {
    applyCreated: operators, applyDuplicateRefused: operators, offerCreated: operators, acceptOk: capacity, acceptCapacityFull: operators - capacity,
    storedApplications: operators, distinctApplicants: operators, liveOffers: operators, acceptedOffers: capacity, overCapacity: 0, unauthorizedProbe: 401,
  };
  let observed = null;
  let error = null;
  let stage = 'login';
  let cleanup = { jobClosed: null };
  try {
    const provider = await login(deadline, target.origin, creds.provider);
    const workers = [];
    for (const account of creds.operators) workers.push(await login(deadline, target.origin, account));
    if (!provider.roles.includes('provider') || workers.some((worker) => !worker.roles.includes('operator'))) throw Object.assign(new Error('roles missing'), { code: 'ROLE_MISSING' });
    stage = 'create-job';
    const start = Date.UTC(2028, 5, 1, 1) + (parseInt(runId.slice(0, 6), 16) % 3000) * DAY_MS;
    const created = await requestBookingHttp(deadline, { method: 'POST', url: `${target.origin}/api/jobs`, headers: bearer(provider.token), body: { title: `Tin tuyển tổng hợp CL-12 ${runId}`, locality: 'Dữ liệu giả lập', capacity, startAt: iso(start), endAt: iso(start + 8 * 3600000) }, timeoutMs: SETUP_TIMEOUT_MS });
    const jobId = parseJson(created.text)?.job?.id;
    if (created.status !== 201 || !jobId) throw Object.assign(new Error('job failed'), { code: `JOB_${created.status}` });
    const call = measuredCall(deadline, started, rows, timeoutMs);
    try {
      stage = 'apply';
      const applicationIds = new Map();
      const applyTasks = [];
      for (let index = 0; index < operators; index += 1) applyTasks.push({ index, attempt: 1 }, { index, attempt: 2 });
      await pool(applyTasks, concurrency, deadline, async ({ index, attempt }) => {
        const { json } = await call({ phase: 'apply', pathLabel: '/api/jobs/:id/applications', index, attempt, url: `${target.origin}/api/jobs/${jobId}/applications`, token: workers[index].token });
        if (json?.application?.id) applicationIds.set(index, json.application.id);
      });
      stage = 'offer';
      const offerIds = new Map();
      await pool([...applicationIds.entries()], concurrency, deadline, async ([index, applicationId]) => {
        const { json } = await call({ phase: 'offer', pathLabel: '/api/applications/:id/offers', index, attempt: 1, url: `${target.origin}/api/applications/${applicationId}/offers`, token: provider.token });
        if (json?.offer?.id) offerIds.set(index, json.offer.id);
      });
      stage = 'accept';
      await pool([...offerIds.entries()], concurrency, deadline, async ([index, offerId]) => {
        await call({ phase: 'accept', pathLabel: '/api/offers/:id/accept', index, attempt: 1, url: `${target.origin}/api/offers/${offerId}/accept`, token: workers[index].token });
      });
      stage = 'probe';
      const probe = await requestBookingHttp(deadline, { method: 'POST', url: `${target.origin}/api/jobs/${jobId}/applications`, body: {}, timeoutMs });
      stage = 'readback';
      const job = parseJson((await requestBookingHttp(deadline, { method: 'GET', url: `${target.origin}/api/jobs/${jobId}`, timeoutMs: SETUP_TIMEOUT_MS })).text)?.job;
      const list = parseJson((await requestBookingHttp(deadline, { method: 'GET', url: `${target.origin}/api/jobs/${jobId}/applications?limit=100`, headers: bearer(provider.token), timeoutMs: SETUP_TIMEOUT_MS })).text)?.items;
      if (!job || !Array.isArray(list)) throw Object.assign(new Error('readback failed'), { code: 'READBACK' });
      const count = (phase, test) => rows.filter((row) => row.phase === phase && test(row)).length;
      observed = {
        applyCreated: count('apply', (row) => row.status === 201),
        applyDuplicateRefused: count('apply', (row) => row.status === 409 && row.businessError === 'DUPLICATE_APPLICATION'),
        offerCreated: count('offer', (row) => row.status === 201),
        acceptOk: count('accept', (row) => row.status === 200),
        acceptCapacityFull: count('accept', (row) => row.status === 409 && row.businessError === 'CAPACITY_FULL'),
        storedApplications: job.applicationCount,
        distinctApplicants: new Set(list.map((item) => item.operatorId)).size,
        liveOffers: list.filter((item) => item.activeOffer).length,
        acceptedOffers: job.acceptedCount,
        overCapacity: Math.max(0, job.acceptedCount - capacity),
        unauthorizedProbe: probe.status,
      };
    } finally {
      // Cleanup: close the synthetic job so it leaves the open job board. Recorded, not a pass criterion.
      const closed = await requestBookingHttp(new globalThis.AbortController(), { method: 'POST', url: `${target.origin}/api/jobs/${jobId}/close`, headers: bearer(provider.token), body: {}, timeoutMs: SETUP_TIMEOUT_MS });
      cleanup = { jobClosed: closed.status === 200 };
    }
  } catch (caught) {
    error = { code: ['apply', 'offer', 'accept', 'probe', 'readback'].includes(stage) ? 'RUN_FAILED' : 'SETUP_FAILED', step: stage, cause: caught.code ?? caught.name ?? 'ERROR' };
  } finally {
    globalThis.clearTimeout(timer);
  }
  return finish({ tool: 'benchmark-cloud-recruitment', startedAt, started, target, config, rows, expected, observed, error, deadline, extra: { cleanup } });
}

// ---- CLI --------------------------------------------------------------------------------------------------------

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      'allow-remote': { type: 'boolean', default: false },
      'allowed-host': { type: 'string', multiple: true, default: [] },
      credentials: { type: 'string' },
      operators: { type: 'string', default: '10' },
      output: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!['setup', 'status', 'booking', 'recruitment'].includes(command)) throw new OptionError('INVALID_COMMAND', 'lệnh là setup, status, booking hoặc recruitment');
  const { origin, scope } = validateOrigin({ baseUrl: values['base-url'], allowRemote: values['allow-remote'], allowedHosts: values['allowed-host'] });
  const file = credentialsPath(values.credentials);
  const target = { baseUrl: origin, allowRemote: values['allow-remote'], allowedHosts: values['allowed-host'] };

  if (command === 'setup') {
    let creds;
    try {
      creds = await loadCredentials(file, origin);
    } catch (error) {
      if (error.code !== 'CREDENTIALS_MISSING') throw error;
      const operators = Number(values.operators);
      if (!Number.isInteger(operators) || operators < 2 || operators > 40) throw new OptionError('INVALID_OPTION', 'operators phải trong [2, 40]');
      creds = createCredentials(origin, operators);
      await writeFile(file, `${JSON.stringify(creds, null, 2)}\n`, { flag: 'wx' });
    }
    const save = () => writeFile(file, `${JSON.stringify(creds, null, 2)}\n`);
    const result = await setupAccounts({ origin, creds, save, log: (line) => console.log(line) });
    if (!result.done) {
      console.log('Staging giới hạn số lần đăng ký mỗi IP. Đợi khoảng 15 phút rồi chạy lại đúng lệnh setup này.');
      process.exitCode = 3;
      return;
    }
    console.log('Đã đăng ký và gửi yêu cầu vai trò. Nhờ admin duyệt, sau đó chạy lệnh status.');
    return;
  }
  const creds = await loadCredentials(file, origin);
  if (command === 'status') {
    const rows = await accountStatus({ origin, creds });
    console.table(rows);
    if (rows.some((row) => !row.ready)) process.exitCode = 1;
    return;
  }
  if (!values.output) throw new OptionError('OUTPUT_REQUIRED', '--output là tiền tố file, nên đặt ngoài repo');
  const prefix = path.resolve(values.output);
  if (isInsideRepo(prefix)) throw new OptionError('OUTPUT_IN_REPO', 'không ghi kết quả vào trong repo');
  const run = command === 'booking' ? runCloudBookingBenchmark : runCloudRecruitmentBenchmark;
  const report = await run({ ...target, creds });
  report.target.scope = scope;
  await writeOutputs(prefix, report);
  const { rows, ...summary } = report;
  console.log(JSON.stringify({ ...summary, rowCount: rows.length }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
    process.exitCode = error instanceof OptionError ? 2 : 1;
  });
}
