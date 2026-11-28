/* global AbortController */
// Sequential system test orchestrator. For each browser mode it starts the existing disposable fixture
// (server/tests/helpers/operations-browser-server.mjs), waits for readiness, runs the existing browser driver
// (server/tests/browser-smoke.mjs), stops both children and verifies cleanup. Local only: loopback PostgreSQL
// *_test database, 127.0.0.1 ports 33100/33101, in-memory evidence store inside the fixture. No cloud calls.
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseDisposableRoot } from '../tests/helpers/test-db.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_SCRIPT = join(REPO_ROOT, 'server/tests/helpers/operations-browser-server.mjs');
const BROWSER_SCRIPT = join(REPO_ROOT, 'server/tests/browser-smoke.mjs');
const ORIGIN = 'http://127.0.0.1:33100';
const FIXTURE_PORTS = [33100, 33101];
const READY_MARKER = 'OPERATIONS_SMOKE_READY';
// browser-smoke.mjs writes screenshots to $TMPDIR/cloud-start/ui-evidence; keep this path in sync with it.
const SHOT_SUBDIR = join('cloud-start', 'ui-evidence');
const DISPOSABLE_NAME = /^agridispatch_acct_[0-9a-f]{12}_test$/;
const MAX_OUTPUT = 1024 * 1024;
const CHROMIUM_TMPDIR_MAX = 60;

// Each mode maps to one browser-smoke branch. admin-role and postponement flows run inside operations and dispatch.
export const MODES = {
  default: { fixtureArgs: [], browserArgs: [], marker: 'BROWSER_SMOKE_PASS' },
  operations: { fixtureArgs: [], browserArgs: ['--operations'], marker: 'OPERATIONS_BROWSER_PASS' },
  dispatch: { fixtureArgs: ['--dispatch'], browserArgs: ['--dispatch'], marker: 'OPERATIONS_BROWSER_PASS' },
  recruitment: { fixtureArgs: [], browserArgs: ['--recruitment'], marker: 'RECRUITMENT_BROWSER_PASS' },
};

const SCOPE = {
  localOnly: true,
  cloudCalls: false,
  database: 'real PostgreSQL 17 disposable *_test database on loopback',
  mocks: ['evidence object store is an in-memory synthetic map inside the fixture process', 'mock case data labelled "mô phỏng"'],
  notExercised: ['Azure Blob Storage', 'Azure Function thumbnail trigger', 'remote deployments', 'load/capacity'],
  fullSystemClaim: false,
};

function inside(parent, child) {
  const target = resolve(child);
  return target === resolve(parent) || target.startsWith(resolve(parent) + sep);
}

export function parseSystemConfig({ env = process.env, argv = [] } = {}) {
  const rootUrl = parseDisposableRoot(env.TEST_DATABASE_URL ?? '').href;
  let modesArg = null;
  let outArg = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--modes') modesArg = argv[++i] ?? '';
    else if (flag === '--out') outArg = argv[++i] ?? '';
    else throw new Error(`unknown argument: ${flag}`);
  }
  const modes = modesArg === null ? Object.keys(MODES) : [...new Set(modesArg.split(',').map((m) => m.trim()))];
  for (const mode of modes) if (!Object.hasOwn(MODES, mode)) throw new Error(`unknown mode: ${mode}`);
  if (modes.length === 0) throw new Error('at least one mode is required');
  const tmpBase = env.TMPDIR ?? tmpdir();
  if (!isAbsolute(tmpBase) || inside(REPO_ROOT, tmpBase)) throw new Error('TMPDIR must be outside the repository');
  const outDir = outArg === null ? join(resolve(tmpBase), 'agridispatch-system-results') : resolve(outArg);
  if (inside(REPO_ROOT, outDir)) throw new Error('--out must be outside the repository');
  return {
    rootUrl,
    modes,
    outDir,
    tmpBase: resolve(tmpBase),
    chromiumBin: env.CHROMIUM_BIN || 'chromium',
    readyTimeoutMs: 90_000,
    caseTimeoutMs: 600_000,
    stopGraceMs: 15_000,
    // Chromium publishes DevToolsActivePort only when TMPDIR is short (measured: 57 ok, ~70+ hangs). Longer paths are refused in preflight.
    chromiumTmpMax: CHROMIUM_TMPDIR_MAX,
  };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function startChild(label, args, env, spawnImpl) {
  const child = spawnImpl(process.execPath, args, { cwd: REPO_ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const proc = { label, child, pid: child.pid, exited: false, code: null, signal: null, text: '', signalled: null };
  const onData = (chunk) => {
    proc.text += chunk.toString('utf8');
    if (proc.text.length > MAX_OUTPUT) proc.text = proc.text.slice(-MAX_OUTPUT / 2);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.once('exit', (code, signal) => {
    proc.exited = true;
    proc.code = code;
    proc.signal = signal;
  });
  child.once('error', (error) => {
    proc.spawnError = error.message;
    proc.exited = true;
  });
  return proc;
}

// Signal the whole process group (leader plus orphaned chromium children): SIGTERM, then SIGKILL after the grace
// window. The fixture SIGTERM handler drops its disposable DB before exiting.
async function stopGroup(proc, graceMs) {
  const result = { signal: null, forced: false };
  const busy = () => !proc.exited || groupAlive(proc.pid);
  if (busy()) {
    result.signal = 'SIGTERM';
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* group already gone */ }
    const deadline = Date.now() + graceMs;
    while (busy() && Date.now() < deadline) await sleep(50);
  }
  if (busy()) {
    result.signal = 'SIGKILL';
    result.forced = true;
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* group already gone */ }
    const deadline = Date.now() + graceMs;
    while (busy() && Date.now() < deadline) await sleep(50);
  }
  return result;
}

async function defaultPortFree(port) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once('error', () => resolvePort(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)));
  });
}

async function defaultListDisposable(rootUrl) {
  const client = new pg.Client({ connectionString: rootUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT datname FROM pg_database');
    return new Set(rows.map((row) => row.datname).filter((name) => DISPOSABLE_NAME.test(name)));
  } finally {
    await client.end();
  }
}

function defaultGitState() {
  return new Promise((resolveGit) => {
    execFile('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], (error, sha) => {
      if (error) return resolveGit({ sha: 'unknown', trackedClean: false });
      execFile('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=all'], (statusError, status) => {
        resolveGit({ sha: sha.trim(), trackedClean: !statusError && status.trim() === '' });
      });
    });
  });
}

function defaultCheckBrowser(bin) {
  return new Promise((resolveCheck, rejectCheck) => {
    execFile(bin, ['--version'], { timeout: 15_000 }, (error, stdout) => {
      if (error) rejectCheck(new Error(`browser binary not runnable (${bin}): ${error.code ?? error.message}`));
      else resolveCheck(stdout.trim().slice(0, 120));
    });
  });
}

function redact(text, secrets) {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[REDACTED]');
  return out;
}

// Returns 'ready' | 'exited' | 'timeout' | 'aborted'. Readiness is only the fixture's printed marker.
async function waitForReady(fixture, ms, signal) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fixture.text.includes(READY_MARKER)) return 'ready';
    if (fixture.exited) return 'exited';
    if (signal?.aborted) return 'aborted';
    if (Date.now() >= deadline) return 'timeout';
    await sleep(50);
  }
}

async function waitForExit(proc, ms, signal) {
  const deadline = Date.now() + ms;
  while (!proc.exited) {
    if (signal?.aborted) return 'aborted';
    if (Date.now() >= deadline) return 'timeout';
    await sleep(50);
  }
  return 'exited';
}

function newCaseRecord(mode) {
  return {
    mode,
    status: 'fail',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    infraAbort: false,
    markerSeen: false,
    exitCode: null,
    shots: [],
    cleanup: {
      fixtureSignal: null, fixtureForced: false, fixtureStopped: false,
      browserStopped: false, browserForced: false, childrenExited: false,
      portsFree: false, leakedDatabases: 0, leakedDropped: 0, loginFileRemoved: false,
    },
    failure: null,
    logTail: null,
  };
}

async function runCase(mode, cfg, deps, run) {
  const spec = MODES[mode];
  const rec = newCaseRecord(mode);
  const started = Date.now();
  const caseDir = join(run.tmpDir, `system-${mode}`);
  const loginFile = join(caseDir, 'login.json');
  const shotSource = join(cfg.tmpBase, SHOT_SUBDIR);
  const setAside = join(cfg.tmpBase, `ui-evidence-set-aside-${run.runId}-${mode}`);
  let movedAside = false;
  let fixture = null;
  let browser = null;
  let before = new Set();
  let secrets = [decodeURIComponent(new URL(cfg.rootUrl).password)];
  const spawnImpl = deps.spawn ?? nodeSpawn;
  try {
    await mkdir(caseDir, { recursive: true, mode: 0o700 });
    // Pre-create the synthetic login file with mode 0600; the fixture rewrites it in place, keeping the mode.
    await writeFile(loginFile, '', { mode: 0o600, flag: 'wx' });
    before = await deps.listDisposable(cfg.rootUrl);
    const fixtureEnv = { ...deps.baseEnv, TEST_DATABASE_URL: cfg.rootUrl, SYNTHETIC_LOGIN_FILE: loginFile, TMPDIR: caseDir, ...deps.childEnv };
    fixture = startChild('fixture', [deps.fixtureScript, ...spec.fixtureArgs], fixtureEnv, spawnImpl);
    const ready = await waitForReady(fixture, cfg.readyTimeoutMs, run.signal);
    if (ready !== 'ready') {
      rec.infraAbort = true;
      rec.failure = {
        reason: {
          timeout: `fixture readiness timed out after ${cfg.readyTimeoutMs}ms`,
          exited: `fixture exited before readiness (code ${fixture.code}, signal ${fixture.signal})`,
          aborted: 'aborted by signal',
        }[ready],
      };
      return rec;
    }
    const login = JSON.parse(await readFile(loginFile, 'utf8').catch(() => '{}'));
    if (typeof login.password === 'string') secrets = [...secrets, login.password];
    const browserEnv = { ...deps.baseEnv, SYNTHETIC_LOGIN_FILE: loginFile, TMPDIR: cfg.tmpBase, CHROMIUM_BIN: cfg.chromiumBin, ...deps.childEnv };
    // The driver always writes to $TMPDIR/cloud-start/ui-evidence. Move any prior evidence aside; restore in finally.
    if (existsSync(shotSource)) {
      await rename(shotSource, setAside);
      movedAside = true;
    }
    browser = startChild('browser', [deps.browserScript, ORIGIN, ...spec.browserArgs], browserEnv, spawnImpl);
    const outcome = await waitForExit(browser, cfg.caseTimeoutMs, run.signal);
    if (outcome === 'timeout') rec.failure = { reason: `browser case timed out after ${cfg.caseTimeoutMs}ms` };
    if (outcome === 'aborted') rec.failure = { reason: 'aborted by signal' };
    if (fixture.exited && outcome !== 'aborted') {
      rec.failure ??= { reason: `fixture exited during browser case (code ${fixture.code}, signal ${fixture.signal})` };
    }
    rec.exitCode = browser.exited ? browser.code : null;
    rec.markerSeen = browser.text.includes(spec.marker);
    if (!rec.failure) {
      if (browser.code !== 0) rec.failure = { reason: `browser exited ${browser.code ?? `by signal ${browser.signal}`}` };
      else if (!rec.markerSeen) rec.failure = { reason: `pass marker missing: ${spec.marker}` };
    }
    if (existsSync(shotSource)) {
      const shotDir = join(cfg.outDir, 'shots', run.runId, mode);
      await mkdir(shotDir, { recursive: true, mode: 0o700 });
      for (const name of (await readdir(shotSource)).filter((n) => n.endsWith('.png')).sort()) {
        const bytes = await readFile(join(shotSource, name));
        await writeFile(join(shotDir, name), bytes, { mode: 0o600 });
        rec.shots.push({ name, sha256: sha256(bytes), bytes: bytes.length });
      }
    }
    if (!rec.failure && rec.shots.length === 0) rec.failure = { reason: 'no screenshots captured' };
  } catch (error) {
    rec.failure ??= { reason: `orchestrator error: ${error.message}` };
  } finally {
    if (browser) {
      const stopped = await stopGroup(browser, cfg.stopGraceMs);
      rec.cleanup.browserStopped = !groupAlive(browser.pid);
      rec.cleanup.browserForced = stopped.forced;
      if (stopped.forced) rec.failure ??= { reason: 'browser ignored SIGTERM; killed' };
    }
    if (fixture) {
      const stopped = await stopGroup(fixture, cfg.stopGraceMs);
      rec.cleanup.fixtureSignal = stopped.signal;
      rec.cleanup.fixtureForced = stopped.forced;
      rec.cleanup.fixtureStopped = !groupAlive(fixture.pid);
      if (stopped.forced) rec.failure ??= { reason: 'fixture ignored SIGTERM; killed without DB drop' };
    }
    rec.cleanup.childrenExited = [fixture, browser].every((p) => !p || !groupAlive(p.pid));
    let portsOk = false;
    for (let i = 0; i < 40 && !portsOk; i++) {
      portsOk = (await Promise.all(FIXTURE_PORTS.map((p) => deps.portFree(p)))).every(Boolean);
      if (!portsOk) await sleep(100);
    }
    rec.cleanup.portsFree = portsOk;
    const leaked = [...(await deps.listDisposable(cfg.rootUrl))].filter((name) => !before.has(name));
    rec.cleanup.leakedDatabases = leaked.length;
    // A concurrent test can create a matching DB. Difference in snapshots is not ownership.
    // Report unexplained databases; only the fixture may drop its own recorded database.
    await rm(loginFile, { force: true });
    rec.cleanup.loginFileRemoved = !existsSync(loginFile);
    if (leaked.length > 0) rec.failure ??= { reason: 'disposable database left behind after fixture stop' };
    if (!rec.cleanup.childrenExited) rec.failure ??= { reason: 'child process group leaked' };
    if (!portsOk) rec.failure ??= { reason: 'fixture port still bound after stop' };
    if (!rec.cleanup.loginFileRemoved) rec.failure ??= { reason: 'synthetic login file not removed' };
    rec.logTail = redact([fixture?.text ?? '', browser?.text ?? ''].join('\n'), secrets).slice(-4000);
    await rm(caseDir, { recursive: true, force: true });
    // Only touch ui-evidence if this case moved the operator's prior evidence aside: discard this case's shots, then restore.
    if (movedAside) {
      await rm(shotSource, { recursive: true, force: true });
      await rename(setAside, shotSource);
    }
    rec.finishedAt = new Date().toISOString();
    rec.durationMs = Date.now() - started;
    rec.status = rec.failure ? 'fail' : 'pass';
  }
  return rec;
}

export async function runSystemTests(cfg, deps = {}) {
  const runId = randomBytes(6).toString('hex');
  const startedAt = Date.now();
  const full = {
    childEnv: {},
    spawn: undefined,
    signal: undefined,
    portFree: defaultPortFree,
    listDisposable: defaultListDisposable,

    gitState: defaultGitState,
    checkBrowser: () => defaultCheckBrowser(cfg.chromiumBin),
    fixtureScript: FIXTURE_SCRIPT,
    browserScript: BROWSER_SCRIPT,
    baseEnv: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'C.UTF-8' },
    ...deps,
  };
  const git = await full.gitState();
  const summary = {
    runId,
    status: 'fail',
    sourceSHA: git.sha,
    trackedClean: git.trackedClean,
    browserVersion: null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: 0,
    scope: SCOPE,
    modes: cfg.modes,
    cases: [],
    skipped: [],
    abort: null,
  };
  const tmpDir = join(cfg.tmpBase, `system-run-${runId}`);
  const run = { runId, tmpDir, signal: full.signal };
  // Preflight failures are recorded against the first mode; every later mode is listed as skipped.
  const infra = (reason) => {
    const rec = newCaseRecord(cfg.modes[0]);
    rec.infraAbort = true;
    rec.failure = { reason };
    summary.cases.push(rec);
    summary.abort = reason;
    summary.skipped = cfg.modes.slice(1);
  };
  try {
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await mkdir(cfg.outDir, { recursive: true, mode: 0o700 });
    summary.shotsDir = join(cfg.outDir, 'shots', runId);
    if (cfg.tmpBase.length > cfg.chromiumTmpMax) {
      infra(`TMPDIR too long for Chromium (${cfg.tmpBase.length} > ${cfg.chromiumTmpMax} characters)`);
    }
    if (summary.abort === null) {
      try {
        summary.browserVersion = await full.checkBrowser();
      } catch (error) {
        infra(error.message);
      }
    }
    if (summary.abort === null) {
      for (const port of FIXTURE_PORTS) {
        if (!(await full.portFree(port))) {
          infra(`port ${port} already in use; not stopping it`);
          break;
        }
      }
    }
    if (summary.abort === null) {
      for (let i = 0; i < cfg.modes.length; i++) {
        if (full.signal?.aborted) {
          summary.abort = 'aborted by signal';
          summary.skipped = cfg.modes.slice(i);
          break;
        }
        const rec = await runCase(cfg.modes[i], cfg, full, run);
        // Only the infra abort and signal abort stop the loop; ordinary browser failures let later modes run.
        summary.cases.push(rec);
        if (rec.infraAbort || rec.failure?.reason === 'aborted by signal') {
          summary.abort = rec.failure.reason;
          summary.skipped = cfg.modes.slice(i + 1);
          break;
        }
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedAt;
    summary.status = summary.abort === null && summary.skipped.length === 0 && summary.cases.every((c) => c.status === 'pass') ? 'pass' : 'fail';
    const file = join(cfg.outDir, 'system-results.json');
    await writeFile(file, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    await chmod(file, 0o600);
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  try {
    const config = parseSystemConfig({ env: process.env, argv: process.argv.slice(2) });
    const summary = await runSystemTests(config, { signal: controller.signal });
    const line = summary.cases.map((c) => `${c.mode}=${c.status}`).join(' ');
    console.log(`SYSTEM_TESTS_${summary.status.toUpperCase()} ${line}${summary.abort ? ' abort=' + summary.abort : ''}`);
    process.exitCode = summary.status === 'pass' ? 0 : 1;
  } catch (error) {
    console.error(`system tests: ${error.message}`);
    process.exitCode = 2;
  }
}
