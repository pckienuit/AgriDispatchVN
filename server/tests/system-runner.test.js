/* global AbortController */
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MODES, REPO_ROOT, parseSystemConfig, runSystemTests } from '../scripts/test-system.js';
import { FEATURES } from './system/feature-inventory.js';

// Fake fixture and browser are real child processes with the same stdout/exit contract as the real scripts.
// Unit tests never touch PostgreSQL, Chromium or ports 33100/33101 (portFree and listDisposable are injected).
const FAKE_DIR = resolve(REPO_ROOT, 'server/tests/system');
const ROOT_URL = 'postgresql://agridispatch:unit-test-only-password@127.0.0.1:55432/agridispatch_test';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'system-runner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function configFor(dir, modes = ['default'], overrides = {}) {
  const config = parseSystemConfig({
    env: { TEST_DATABASE_URL: ROOT_URL, TMPDIR: dir },
    argv: ['--modes', modes.join(','), '--out', join(dir, 'out')],
  });
  return Object.assign(config, { readyTimeoutMs: 3000, caseTimeoutMs: 8000, stopGraceMs: 800, chromiumTmpMax: 4096 }, overrides);
}

function depsFor(childEnv = {}, extra = {}) {
  return {
    portFree: async () => true,
    listDisposable: async () => new Set(),
    gitState: async () => ({ sha: 'abc1234', trackedClean: true }),
    checkBrowser: async () => 'Synthetic browser orchestration fixture',
    fixtureScript: join(FAKE_DIR, 'fake-fixture.mjs'),
    browserScript: join(FAKE_DIR, 'fake-browser.mjs'),
    childEnv,
    ...extra,
  };
}

test('config requires a loopback disposable *_test database without query parameters', () => {
  for (const bad of [
    undefined,
    '',
    'mysql://agridispatch:x@127.0.0.1:3306/agridispatch_test',
    'postgresql://agridispatch:x@db.example.com:5432/agridispatch_test',
    'postgresql://agridispatch:x@127.0.0.1:55432/agridispatch',
    'postgresql://agridispatch:x@127.0.0.1:55432/agridispatch_test?host=db.example.com',
  ]) {
    assert.throws(() => parseSystemConfig({ env: { TEST_DATABASE_URL: bad }, argv: [] }), /TEST_DATABASE_URL|PostgreSQL|loopback|_test|query/, String(bad));
  }
});

test('config runs all four browser modes in fixed order by default', () => {
  const config = parseSystemConfig({ env: { TEST_DATABASE_URL: ROOT_URL }, argv: [] });
  assert.deepEqual(config.modes, ['default', 'operations', 'dispatch', 'recruitment']);
  assert.deepEqual(Object.keys(MODES), config.modes);
});

test('config rejects unknown modes, unknown flags and output or temp paths inside the repository', () => {
  assert.throws(() => parseSystemConfig({ env: { TEST_DATABASE_URL: ROOT_URL }, argv: ['--modes', 'admin'] }), /unknown mode: admin/);
  assert.throws(() => parseSystemConfig({ env: { TEST_DATABASE_URL: ROOT_URL }, argv: ['--database-url', ROOT_URL] }), /unknown argument/);
  assert.throws(() => parseSystemConfig({ env: { TEST_DATABASE_URL: ROOT_URL }, argv: ['--out', join(REPO_ROOT, 'results')] }), /--out must be outside the repository/);
  assert.throws(() => parseSystemConfig({ env: { TEST_DATABASE_URL: ROOT_URL, TMPDIR: join(REPO_ROOT, 'tmp') }, argv: [] }), /TMPDIR must be outside the repository/);
});

test('pass path: readiness, pass marker, hashed shots, SIGTERM fixture stop and login file removal', async (t) => {
  const dir = await scratch(t);
  const mark = join(dir, 'fixture-mark.txt');
  const summary = await runSystemTests(configFor(dir), depsFor({ FAKE_FIXTURE: 'ok', FAKE_MARK: mark }));
  assert.equal(summary.status, 'pass');
  assert.equal(summary.scope.localOnly, true);
  assert.equal(summary.scope.cloudCalls, false);
  assert.equal(summary.sourceSHA, 'abc1234');
  const [c] = summary.cases;
  assert.equal(c.status, 'pass');
  assert.equal(c.markerSeen, true);
  assert.equal(c.exitCode, 0);
  assert.match(c.shots[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(c.shots[0].name, 'desktop-catalog.png');
  assert.equal(c.cleanup.fixtureSignal, 'SIGTERM');
  assert.equal(c.cleanup.fixtureForced, false);
  assert.equal(c.cleanup.loginFileRemoved, true);
  assert.equal(c.cleanup.childrenExited, true);
  assert.equal(c.cleanup.leakedDatabases, 0);
  assert.match(await readFile(mark, 'utf8'), /SIGTERM/);
  const written = JSON.parse(await readFile(join(dir, 'out', 'system-results.json'), 'utf8'));
  assert.equal(written.status, 'pass');
  assert.ok(!JSON.stringify(written).includes('fake-password-7f3a'));
  assert.ok(!JSON.stringify(written).includes('unit-test-only-password'));
});

test('browser output that echoes the synthetic password is redacted from results', async (t) => {
  const dir = await scratch(t);
  const summary = await runSystemTests(configFor(dir), depsFor({ FAKE_FIXTURE: 'ok', FAKE_BROWSER: 'echo-secret' }));
  assert.equal(summary.status, 'pass');
  const text = JSON.stringify(summary);
  assert.ok(!text.includes('fake-password-7f3a'), 'synthetic password leaked into results');
  assert.ok(!(await readFile(join(dir, 'out', 'system-results.json'), 'utf8')).includes('fake-password-7f3a'));
});

test('browser exit 0 without the mode pass marker is a failure', async (t) => {
  const dir = await scratch(t);
  const summary = await runSystemTests(configFor(dir), depsFor({ FAKE_FIXTURE: 'ok', FAKE_BROWSER: 'no-marker' }));
  assert.equal(summary.status, 'fail');
  assert.equal(summary.cases[0].markerSeen, false);
  assert.match(summary.cases[0].failure.reason, /pass marker missing/);
});

test('browser assertion failure is recorded per case and the run continues', async (t) => {
  const dir = await scratch(t);
  const summary = await runSystemTests(configFor(dir, ['default', 'operations']), depsFor({ FAKE_FIXTURE: 'ok', FAKE_BROWSER: 'fail' }));
  assert.equal(summary.status, 'fail');
  assert.equal(summary.abort, null);
  assert.deepEqual(summary.cases.map((c) => c.status), ['fail', 'fail']);
  assert.equal(summary.cases[0].exitCode, 1);
});

test('fixture that never prints readiness aborts the run, stops the child and spawns no browser', async (t) => {
  const dir = await scratch(t);
  const spawned = [];
  const deps = depsFor({ FAKE_FIXTURE: 'no-ready' }, {
    spawn: (cmd, args, opts) => { spawned.push(args[0]); return nodeSpawn(cmd, args, opts); },
  });
  const summary = await runSystemTests(configFor(dir, ['default', 'operations'], { readyTimeoutMs: 800 }), deps);
  assert.equal(summary.status, 'fail');
  assert.match(summary.abort, /readiness timed out/);
  assert.equal(summary.cases.length, 1);
  assert.equal(summary.cases[0].infraAbort, true);
  assert.equal(summary.cases[0].cleanup.fixtureStopped, true);
  assert.deepEqual(spawned, [deps.fixtureScript], 'browser must not start without readiness');
});

test('fixture that crashes before readiness aborts the run', async (t) => {
  const dir = await scratch(t);
  const summary = await runSystemTests(configFor(dir, ['default', 'operations']), depsFor({ FAKE_FIXTURE: 'crash' }));
  assert.equal(summary.status, 'fail');
  assert.match(summary.abort, /exited before readiness/);
  assert.equal(summary.cases.length, 1);
});

test('browser that hangs is killed at the case timeout and recorded as failure', async (t) => {
  const dir = await scratch(t);
  const started = Date.now();
  const summary = await runSystemTests(configFor(dir, ['default'], { caseTimeoutMs: 1000 }), depsFor({ FAKE_FIXTURE: 'ok', FAKE_BROWSER: 'hang' }));
  assert.equal(summary.status, 'fail');
  assert.match(summary.cases[0].failure.reason, /timed out/);
  assert.equal(summary.cases[0].cleanup.browserStopped, true);
  assert.equal(summary.cases[0].cleanup.fixtureSignal, 'SIGTERM');
  assert.equal(summary.cases[0].cleanup.childrenExited, true);
  assert.ok(Date.now() - started < 20000);
});

test('fixture that ignores SIGTERM is SIGKILLed and reported as forced', async (t) => {
  const dir = await scratch(t);
  const summary = await runSystemTests(configFor(dir), depsFor({ FAKE_FIXTURE: 'ignore-term' }));
  const c = summary.cases[0];
  assert.equal(c.cleanup.fixtureForced, true);
  assert.equal(c.cleanup.fixtureSignal, 'SIGKILL');
  assert.equal(c.cleanup.childrenExited, true);
  assert.equal(c.status, 'fail');
});

test('disposable database left behind after fixture stop fails the case', async (t) => {
  const dir = await scratch(t);
  let calls = 0;
  const leaked = 'agridispatch_acct_000000000000_test';
  let dropped = false;
  const summary = await runSystemTests(configFor(dir), depsFor({ FAKE_FIXTURE: 'ok' }, {
    listDisposable: async () => (calls++ === 0 ? new Set() : new Set([leaked])),
    dropDisposable: async () => { dropped = true; },
  }));
  assert.equal(summary.status, 'fail');
  assert.equal(dropped, false, 'snapshot differences cannot establish database ownership');
  assert.equal(summary.cases[0].cleanup.leakedDatabases, 1);
  assert.match(summary.cases[0].failure.reason, /disposable database left behind/);
  assert.ok(!JSON.stringify(summary).includes(leaked), 'database name must not be recorded');
});

test('occupied fixture port fails preflight without spawning or killing anything', async (t) => {
  const dir = await scratch(t);
  const spawned = [];
  const deps = depsFor({}, {
    portFree: async (port) => port !== 33101,
    spawn: (cmd, args, opts) => { spawned.push(args[0]); return nodeSpawn(cmd, args, opts); },
  });
  const summary = await runSystemTests(configFor(dir, ['default', 'operations']), deps);
  assert.equal(summary.status, 'fail');
  assert.match(summary.abort, /port 33101 already in use; not stopping it/);
  assert.equal(summary.cases[0].infraAbort, true);
  assert.deepEqual(spawned, []);
});

test('aborting the orchestrator stops the fixture, removes the login file and leaves no case directory', async (t) => {
  const dir = await scratch(t);
  const mark = join(dir, 'fixture-mark.txt');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  t.after(() => clearTimeout(timer));
  const summary = await runSystemTests(
    configFor(dir, ['default', 'operations'], { caseTimeoutMs: 20000 }),
    depsFor({ FAKE_FIXTURE: 'ok', FAKE_BROWSER: 'hang', FAKE_MARK: mark }, { signal: controller.signal }),
  );
  assert.equal(summary.abort, 'aborted by signal');
  assert.equal(summary.status, 'fail');
  assert.equal(summary.cases.length, 1);
  assert.match(await readFile(mark, 'utf8'), /SIGTERM/);
  assert.equal(summary.cases[0].cleanup.loginFileRemoved, true);
  assert.equal(summary.cases[0].cleanup.childrenExited, true);
  const leftovers = (await readdir(dir)).filter((name) => name.startsWith('system-default-'));
  assert.deepEqual(leftovers, []);
});

test('results and shots directory is private and outside the repository', async (t) => {
  const dir = await scratch(t);
  await runSystemTests(configFor(dir), depsFor({ FAKE_FIXTURE: 'ok' }));
  const outFile = join(dir, 'out', 'system-results.json');
  assert.ok(existsSync(outFile));
  assert.equal((await stat(outFile)).mode & 0o077, 0, 'results must not be group/world readable');
  assert.ok(!resolve(outFile).startsWith(REPO_ROOT + '/'));
});

test('browser gets the short shared TMPDIR, not the nested case directory', async (t) => {
  const dir = await scratch(t);
  const mark = join(dir, 'browser-mark.txt');
  const summary = await runSystemTests(configFor(dir), depsFor({ FAKE_FIXTURE: 'ok', FAKE_BROWSER_MARK: mark }));
  assert.equal(summary.status, 'pass');
  assert.equal(await readFile(mark, 'utf8'), `TMPDIR=${resolve(dir)}\n`);
});

test('TMPDIR longer than Chromium limit aborts preflight with no child started', async (t) => {
  const dir = await scratch(t);
  const spawned = [];
  const summary = await runSystemTests(configFor(dir, ['default'], { chromiumTmpMax: 10 }), depsFor({}, {
    spawn: () => { spawned.push(1); throw new Error('must not spawn'); },
  }));
  assert.equal(summary.status, 'fail');
  assert.match(summary.abort, /TMPDIR too long for Chromium/);
  assert.deepEqual(spawned, []);
});

test('existing ui-evidence directory is set aside for the run and restored afterwards', async (t) => {
  const dir = await scratch(t);
  const evidence = join(dir, 'cloud-start', 'ui-evidence');
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'keep.png'), 'previous evidence');
  const summary = await runSystemTests(configFor(dir), depsFor({ FAKE_FIXTURE: 'ok' }));
  assert.equal(summary.status, 'pass');
  assert.equal(await readFile(join(evidence, 'keep.png'), 'utf8'), 'previous evidence');
  assert.deepEqual((await readdir(join(dir, 'cloud-start'))).filter((n) => n.startsWith('ui-evidence')), ['ui-evidence'], 'set-aside copy must be gone after restore');
  assert.equal(await readFile(join(evidence, 'keep.png'), 'utf8'), 'previous evidence');
});

test('feature inventory names real test files, real routes and an explicit gap for every empty layer', async () => {
  assert.ok(FEATURES.length >= 15, 'inventory must cover every feature area');
  const src = (await Promise.all((await readdir(join(REPO_ROOT, 'server/src'), { recursive: true }))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFile(join(REPO_ROOT, 'server/src', f), 'utf8')))).join('\n');
  for (const feature of FEATURES) {
    for (const layer of ['unit', 'integration']) {
      const files = feature[layer];
      if (files.length === 0) {
        assert.ok(feature.gaps?.[layer], `${feature.id}: ${layer} empty without gap reason`);
      }
      for (const file of files) assert.ok(existsSync(join(REPO_ROOT, file)), `${feature.id}: missing ${file}`);
    }
    assert.ok(Array.isArray(feature.browser), `${feature.id}: browser must be an array`);
    if (feature.browser.length === 0) assert.ok(feature.gaps?.browser, `${feature.id}: browser empty without gap reason`);
    for (const flow of feature.browser) {
      assert.ok(Object.hasOwn(MODES, flow.mode), `${feature.id}: unknown browser mode ${flow.mode}`);
      assert.ok(flow.flow.length > 0);
    }
    for (const route of feature.routes ?? []) {
      const [, path] = route.split(' ');
      assert.ok(src.includes(`'${path}'`), `${feature.id}: route not in server/src: ${route}`);
    }
  }
});
