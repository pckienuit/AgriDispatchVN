// CL-12 suite: repeats each benchmark case until it has `runs` valid runs, after `warmupRuns` discarded runs.
// Writes every raw run (JSON + CSV), suite.json (conditions, config, errors, limits), summary.csv and summary.md.
// Write cases (booking, recruitment) are local disposable only. The read case can target an approved HTTPS host.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createAccountApp } from '../src/account-app.js';
import { createApp } from '../src/app.js';
import { readServicesCacheMs } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createDisposableDatabase } from '../tests/helpers/test-db.js';
import { OptionError, closeAll, isInsideRepo, listen, originOf, parseLocalRoot, runBookingBenchmark } from './benchmark-bookings.js';
import { runBenchmark, validateOrigin, writeOutputs } from './benchmark-http.js';
import { loadCredentials, runCloudBookingBenchmark, runCloudRecruitmentBenchmark } from './benchmark-cloud-writes.js';
import { runRecruitmentBenchmark } from './benchmark-recruitment.js';
import { migrate } from './migrate.js';
import { seedCatalog } from './seed-catalog.js';

export const CASES = Object.freeze(['read', 'booking', 'recruitment']);
const LIMITS = { runs: [30, 200], warmupRuns: [0, 10], maxInvalid: [0, 50] };
const LABEL = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const max = (values) => {
  const nums = values.filter((value) => typeof value === 'number');
  return nums.length ? Math.max(...nums) : null;
};

// Within this many ms of the window end, an aborted request is treated as cut by the window, not as a slow response.
const WINDOW_EDGE_MS = 5;

// benchmark-http gives each request min(timeoutMs, time left in the window) and records the abort as TIMEOUT (kept in raw
// rows). A request whose own deadline was shortened by the window and that ended at the window edge was cut by the window,
// not slow: the suite counts it separately. Any TIMEOUT that had its full timeoutMs available still fails the run.
export function countWindowCutoffs(report) {
  const config = report.config;
  if (!config || !Array.isArray(report.rows)) return 0;
  const windowEnd = config.warmupMs + config.durationMs;
  return report.rows.filter((row) => row.phase === 'measure' && row.error === 'TIMEOUT'
    && row.offsetMs + config.timeoutMs > windowEnd
    && row.offsetMs + row.durationMs >= windowEnd - WINDOW_EDGE_MS).length;
}

// One normalized line per run. Decides validity; never turns a failed run into a pass.
export function normalizeRun(caseName, report) {
  if (caseName === 'read') {
    const a = report.aggregates;
    const cutAtWindowEnd = countWindowCutoffs(report);
    const failures = a.http4xx + a.http5xx + a.redirectRefused + (a.timeouts - cutAtWindowEnd) + a.network + a.bodyLimit;
    return {
      valid: a.completed > 0 && failures === 0,
      errorCode: a.completed === 0 ? 'NO_COMPLETED' : failures ? 'REQUEST_ERRORS' : null,
      requests: a.attempted, p50Ms: a.p50Ms, p95Ms: a.p95Ms, throughputRps: a.throughputRps, violationCount: null, cutAtWindowEnd,
    };
  }
  if (caseName === 'booking' && !('measurementValid' in report)) {
    const a = report.aggregates;
    return {
      valid: report.ok === true,
      errorCode: report.error?.code ?? null,
      requests: a?.attempted ?? 0, p50Ms: a?.p50Ms ?? null, p95Ms: a?.p95Ms ?? null, throughputRps: null,
      // Booking invariants are part of ok, so a valid run has zero violations; a failing one shows its error code.
      violationCount: report.ok === true ? 0 : null,
    };
  }
  const a = report.aggregates;
  return {
    valid: report.measurementValid === true,
    errorCode: report.error?.code ?? null,
    requests: a?.attempted ?? 0, p50Ms: a?.p50Ms ?? null, p95Ms: a?.p95Ms ?? null, throughputRps: null,
    violationCount: report.measurementValid ? report.violationCount : null,
  };
}

export function summarizeCase(caseName, target, lines) {
  const measured = lines.filter((line) => !line.warmup);
  const valid = measured.filter((line) => line.valid);
  const errorCodes = {};
  for (const line of measured.filter((item) => !item.valid)) errorCodes[line.errorCode ?? 'UNKNOWN'] = (errorCodes[line.errorCode ?? 'UNKNOWN'] ?? 0) + 1;
  const violations = valid.map((line) => line.violationCount).filter((value) => typeof value === 'number');
  return {
    case: caseName,
    status: valid.length >= target ? 'đủ' : 'thiếu',
    targetValidRuns: target,
    warmupRuns: lines.length - measured.length,
    attemptedRuns: measured.length,
    validRuns: valid.length,
    invalidRuns: measured.length - valid.length,
    invalidByCode: errorCodes,
    requestsInValidRuns: valid.reduce((sum, line) => sum + line.requests, 0),
    cutAtWindowEndInValidRuns: valid.reduce((sum, line) => sum + (line.cutAtWindowEnd ?? 0), 0),
    medianP50Ms: median(valid.map((line) => line.p50Ms)),
    medianP95Ms: median(valid.map((line) => line.p95Ms)),
    maxP95Ms: max(valid.map((line) => line.p95Ms)),
    medianThroughputRps: median(valid.map((line) => line.throughputRps)),
    violationsTotal: violations.length ? violations.reduce((sum, value) => sum + value, 0) : null,
    runsWithViolations: violations.filter((value) => value > 0).length,
  };
}

const CSV_COLUMNS = ['case', 'run', 'warmup', 'valid', 'errorCode', 'requests', 'cutAtWindowEnd', 'p50Ms', 'p95Ms', 'throughputRps', 'violationCount', 'startedAt', 'file'];
const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export const toSummaryCsv = (lines) => `${[CSV_COLUMNS.join(','), ...lines.map((line) => CSV_COLUMNS.map((key) => csvCell(line[key])).join(','))].join('\n')}\n`;

const cell = (value) => (value === null || value === undefined ? 'thiếu' : String(value));
export function toSummaryMarkdown(suite) {
  const head = [
    `# Kết quả đo CL-12: ${suite.label}`,
    '',
    `- Nơi phát tải: ${suite.conditions.location}`,
    `- Đích đọc: ${suite.conditions.readTarget}; đích ghi: ${suite.conditions.writeTarget}`,
    `- Build SHA khai báo: ${suite.conditions.buildSha ?? 'không có'}`,
    `- Bắt đầu: ${suite.startedAt}; kết thúc: ${suite.finishedAt} (UTC)`,
    `- Máy: ${suite.conditions.host.platform} ${suite.conditions.host.release}, ${suite.conditions.host.cpus} x ${suite.conditions.host.cpuModel}, Node ${suite.conditions.host.node}`,
    '',
    '| Ca | Trạng thái | Lượt hợp lệ/mục tiêu | Lượt lỗi | p50 trung vị (ms) | p95 trung vị (ms) | p95 lớn nhất (ms) | RPS trung vị | Vi phạm bất biến |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const rows = suite.cases.map((c) => `| ${c.case} | ${c.status} | ${c.validRuns}/${c.targetValidRuns} | ${c.invalidRuns} | ${cell(c.medianP50Ms)} | ${cell(c.medianP95Ms)} | ${cell(c.maxP95Ms)} | ${c.case === 'read' ? cell(c.medianThroughputRps) : 'không áp dụng'} | ${c.case === 'read' ? 'không áp dụng' : cell(c.violationsTotal)} |`);
  return `${[...head, ...rows, '', 'Số liệu từng lượt ở summary.csv và runs/. Ca có trạng thái "thiếu" chưa đủ lượt hợp lệ, không được ghi là đạt.', ''].join('\n')}`;
}

async function startLocalReadTarget(rootDatabaseUrl, servicesCacheMs) {
  const state = { child: null, pool: null, servers: [] };
  try {
    state.child = await createDisposableDatabase(parseLocalRoot(rootDatabaseUrl).href);
    state.pool = createPool(state.child.url, { statementTimeout: 10000 });
    await migrate(state.pool);
    await seedCatalog(state.pool);
    const token = randomBytes(32).toString('base64url');
    const account = await listen(createAccountApp({ pool: state.pool, internalServiceToken: token }));
    state.servers.push(account);
    const app = await listen(createApp({ pool: state.pool, accountServiceUrl: originOf(account), internalServiceToken: token, servicesCacheMs }));
    state.servers.push(app);
    return { baseUrl: originOf(app), close: () => closeAll(state) };
  } catch (error) {
    await closeAll(state);
    throw error;
  }
}

export function validateSuiteOptions(options) {
  const out = {};
  for (const [key, [min, maxValue]] of Object.entries(LIMITS)) {
    const value = options[key];
    if (!Number.isInteger(value) || value < min || value > maxValue) throw new OptionError('INVALID_OPTION', `${key} phải là số nguyên trong [${min}, ${maxValue}]`);
    out[key] = value;
  }
  if (!Array.isArray(options.cases) || options.cases.length === 0 || options.cases.some((name) => !CASES.includes(name))) {
    throw new OptionError('INVALID_OPTION', `cases chỉ gồm ${CASES.join(', ')}`);
  }
  out.cases = [...new Set(options.cases)];
  if (typeof options.label !== 'string' || !LABEL.test(options.label)) throw new OptionError('INVALID_OPTION', 'label chỉ gồm chữ thường, số, dấu chấm, gạch nối, gạch dưới (tối đa 48)');
  out.label = options.label;
  if (typeof options.location !== 'string' || options.location.trim() === '' || options.location.length > 120) throw new OptionError('INVALID_OPTION', 'location bắt buộc, tối đa 120 ký tự');
  out.location = options.location.trim();
  return out;
}

export async function runSuite(input) {
  const opts = validateSuiteOptions(input);
  const { outputDir, read = {}, booking = {}, recruitment = {}, rootDatabaseUrl, buildSha = null, creds = null, allowRemoteWrites = false, log = () => {} } = input;
  const remoteRead = Boolean(read.baseUrl);
  // With a base URL, write cases go through the public API (benchmark-cloud-writes.js) instead of a local database.
  const apiWrites = remoteRead && opts.cases.some((name) => name !== 'read');
  if (apiWrites) {
    const { scope } = validateOrigin(read);
    if (!creds) throw new OptionError('CREDENTIALS_REQUIRED', 'ca ghi qua API cần --credentials (tạo bằng benchmark-cloud-writes.js setup)');
    if (scope === 'remote' && allowRemoteWrites !== true) throw new OptionError('REMOTE_WRITE_REFUSED', 'ghi lên host từ xa cần thêm --allow-remote-writes');
  }
  if (!remoteRead) parseLocalRoot(rootDatabaseUrl);
  const runsDir = path.join(outputDir, 'runs');
  await mkdir(runsDir);
  const startedAt = new Date().toISOString();
  const lines = [];
  const caseSummaries = [];
  const readConfig = { concurrency: 4, durationMs: 5000, warmupMs: 1000, timeoutMs: 2000, maxRequests: 2000, ...read };
  const bookingConfig = apiWrites ? { count: 10, concurrency: 4, timeoutMs: 5000, ...booking } : { count: 30, concurrency: 4, timeoutMs: 3000, ...booking };
  const recruitmentConfig = apiWrites
    ? { capacity: 3, concurrency: creds.operators.length, timeoutMs: 5000, ...recruitment, operators: creds.operators.length }
    : { operators: 10, capacity: 3, concurrency: 10, timeoutMs: 3000, ...recruitment };
  const apiTarget = apiWrites ? { baseUrl: read.baseUrl, allowRemote: read.allowRemote, allowedHosts: read.allowedHosts, creds } : null;
  let readTarget = remoteRead ? readConfig.baseUrl : 'local in-process, disposable PostgreSQL';
  // Local read target only: same env switch as server.js, so before/after optimisation runs differ in this value alone.
  const localServicesCacheMs = remoteRead ? null : readServicesCacheMs(process.env);

  for (const caseName of opts.cases) {
    let localRead = null;
    if (caseName === 'read' && !remoteRead) {
      localRead = await startLocalReadTarget(rootDatabaseUrl, localServicesCacheMs);
      readTarget = 'local in-process, disposable PostgreSQL';
    }
    const runOnce = async () => {
      try {
        if (caseName === 'read') return await runBenchmark({ ...readConfig, baseUrl: localRead?.baseUrl ?? readConfig.baseUrl });
        if (caseName === 'booking') return apiWrites ? await runCloudBookingBenchmark({ ...apiTarget, ...bookingConfig }) : await runBookingBenchmark({ ...bookingConfig, rootDatabaseUrl });
        // operators comes from the credentials file; the runner ignores the copy in recruitmentConfig.
        if (apiWrites) return await runCloudRecruitmentBenchmark({ ...apiTarget, ...recruitmentConfig });
        return await runRecruitmentBenchmark({ ...recruitmentConfig, rootDatabaseUrl });
      } catch (error) {
        if (error instanceof OptionError) throw error;
        return { tool: caseName, ok: false, measurementValid: false, error: { code: 'RUNNER_THREW', cause: error.code ?? error.name }, aggregates: null, rows: [] };
      }
    };
    const caseLines = [];
    try {
      let warm = 0;
      let measuredInvalid = 0;
      let run = 0;
      while (caseLines.filter((line) => !line.warmup && line.valid).length < opts.runs && measuredInvalid <= opts.maxInvalid) {
        const warmup = warm < opts.warmupRuns;
        const report = await runOnce();
        const name = warmup ? `${caseName}-warmup-${String(warm + 1).padStart(2, '0')}` : `${caseName}-${String(run + 1).padStart(3, '0')}`;
        report.suite = { label: opts.label, case: caseName, warmup, buildSha };
        if (!report.aggregates && caseName === 'read') report.aggregates = { attempted: 0, completed: 0, http4xx: 0, http5xx: 0, redirectRefused: 0, timeouts: 0, network: 0, bodyLimit: 0, p50Ms: null, p95Ms: null, throughputRps: null };
        await writeOutputs(path.join(runsDir, name), report);
        const line = { case: caseName, run: warmup ? `warmup-${warm + 1}` : run + 1, warmup, ...normalizeRun(caseName, report), startedAt: report.startedAt ?? null, file: `runs/${name}.json` };
        caseLines.push(line);
        if (warmup) warm += 1;
        else {
          run += 1;
          if (!line.valid) measuredInvalid += 1;
        }
        log(`${caseName} ${line.run}: ${line.valid ? 'hợp lệ' : `lỗi ${line.errorCode}`}`);
      }
    } finally {
      if (localRead) await localRead.close();
    }
    lines.push(...caseLines);
    caseSummaries.push(summarizeCase(caseName, opts.runs, caseLines));
  }

  const suite = {
    tool: 'benchmark-suite',
    schemaVersion: 1,
    label: opts.label,
    startedAt,
    finishedAt: new Date().toISOString(),
    conditions: {
      location: opts.location,
      readTarget,
      writeTarget: apiWrites ? `${read.baseUrl} qua API công khai, tài khoản tổng hợp dùng lại` : 'local in-process, disposable PostgreSQL per run',
      buildSha,
      host: { platform: os.platform(), release: os.release(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model?.trim() ?? null, totalMemMiB: Math.round(os.totalmem() / 1048576), node: process.version },
    },
    config: { runs: opts.runs, warmupRuns: opts.warmupRuns, maxInvalid: opts.maxInvalid, cases: opts.cases, read: { ...readConfig, baseUrl: remoteRead ? readConfig.baseUrl : null, localServicesCacheMs }, booking: bookingConfig, recruitment: recruitmentConfig },
    limits: [
      'Tải closed-loop trên một máy phát tải; không phải SLA hay công suất tối đa.',
      ...(apiWrites
        ? ['Ca ghi qua API: bất biến đọc lại bằng API, không bằng SQL; ca tuyển thợ không kiểm được số sự kiện.', 'Ca ghi qua API để lại dữ liệu tổng hợp trên đích; tin tuyển được đóng sau mỗi lượt.']
        : ['Ca ghi chạy trên PostgreSQL loopback dùng một lần, không phản ánh DB cloud.', 'Mỗi lượt ghi tạo DB con mới nên p50/p95 gồm cả DB còn lạnh sau migrate.']),
      'Ca đọc trộn /health và hai truy vấn danh sách; đọc perPath trong file gốc.',
      'Ca đọc: request bị cắt khi đóng cửa sổ đo vẫn là TIMEOUT trong file gốc, được đếm riêng ở cutAtWindowEnd và không làm lượt hỏng.',
    ],
    cases: caseSummaries,
  };
  const files = [
    ['suite.json', `${JSON.stringify(suite, null, 2)}\n`],
    ['summary.csv', toSummaryCsv(lines)],
    ['summary.md', toSummaryMarkdown(suite)],
  ];
  for (const [name, data] of files) await writeFile(path.join(outputDir, name), data, { flag: 'wx' });
  return suite;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'output-dir': { type: 'string' },
      label: { type: 'string' },
      location: { type: 'string' },
      cases: { type: 'string', default: CASES.join(',') },
      runs: { type: 'string', default: '30' },
      'warmup-runs': { type: 'string', default: '2' },
      'max-invalid': { type: 'string', default: '10' },
      'base-url': { type: 'string' },
      'allow-remote': { type: 'boolean', default: false },
      'allowed-host': { type: 'string', multiple: true, default: [] },
      'read-concurrency': { type: 'string', default: '4' },
      'read-duration-ms': { type: 'string', default: '5000' },
      'read-warmup-ms': { type: 'string', default: '1000' },
      'booking-count': { type: 'string' },
      credentials: { type: 'string' },
      'allow-remote-writes': { type: 'boolean', default: false },
      'recruitment-operators': { type: 'string', default: '10' },
      'recruitment-capacity': { type: 'string', default: '3' },
    },
  });
  if (!values['output-dir']) throw new OptionError('OUTPUT_REQUIRED', '--output-dir là thư mục rỗng có sẵn, nằm ngoài repo');
  const outputDir = path.resolve(values['output-dir']);
  if (isInsideRepo(outputDir)) throw new OptionError('OUTPUT_IN_REPO', 'không ghi kết quả vào trong repo');
  let entries;
  try {
    entries = await readdir(outputDir);
  } catch {
    throw new OptionError('OUTPUT_DIR_MISSING', 'thư mục output phải tồn tại sẵn');
  }
  if (entries.length) throw new OptionError('OUTPUT_DIR_NOT_EMPTY', 'thư mục output phải rỗng để không trộn lượt cũ');
  const sha = process.env.BUILD_SHA ?? '';
  const cases = values.cases.split(',').map((name) => name.trim()).filter(Boolean);
  const writesViaApi = Boolean(values['base-url']) && cases.some((name) => name !== 'read');
  if (writesViaApi && !values.credentials) throw new OptionError('CREDENTIALS_REQUIRED', 'ca ghi với --base-url cần --credentials');
  const creds = writesViaApi ? await loadCredentials(values.credentials, validateOrigin({ baseUrl: values['base-url'], allowRemote: values['allow-remote'], allowedHosts: values['allowed-host'] }).origin) : null;
  const suite = await runSuite({
    outputDir,
    label: values.label,
    location: values.location,
    cases,
    runs: Number(values.runs),
    warmupRuns: Number(values['warmup-runs']),
    maxInvalid: Number(values['max-invalid']),
    rootDatabaseUrl: process.env.TEST_DATABASE_URL,
    buildSha: SHA_PATTERN.test(sha) ? sha : null,
    read: {
      ...(values['base-url'] ? { baseUrl: values['base-url'], allowRemote: values['allow-remote'], allowedHosts: values['allowed-host'] } : {}),
      concurrency: Number(values['read-concurrency']),
      durationMs: Number(values['read-duration-ms']),
      warmupMs: Number(values['read-warmup-ms']),
    },
    creds,
    allowRemoteWrites: values['allow-remote-writes'],
    booking: values['booking-count'] === undefined ? {} : { count: Number(values['booking-count']) },
    recruitment: { operators: Number(values['recruitment-operators']), capacity: Number(values['recruitment-capacity']) },
    log: (message) => console.error(message),
  });
  console.log(JSON.stringify(suite.cases, null, 2));
  if (suite.cases.some((item) => item.status !== 'đủ' || item.violationsTotal > 0)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
    process.exitCode = error instanceof OptionError ? 2 : 1;
  });
}
