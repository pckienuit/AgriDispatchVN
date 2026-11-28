/* global document */
// Browser test for provider P-04 fleet add/validation, P-08 extended job fields, and P-09 close-job on /v2/.
// Disposable PostgreSQL 17 Docker on loopback (unique container/db name) + real account & app HTTP + headless Chromium at 390 and 1440 px.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const log = (...args) => console.log('[provider-fleet-jobs]', ...args);
const SHOTS = process.env.PROVIDER_FLEET_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-fleet-jobs-shots-')));
await mkdir(SHOTS, { recursive: true });

const PASSWORD = 'TestPass!12345';
const secret = randomBytes(32).toString('base64url');
const pageErrors = [];
const consoleErrors = [];
const servers = [];
const expectedConsoleErrors = [];

let spawnedContainer = null;
let rootUrl = process.env.TEST_DATABASE_URL || null;
let db = null;
let pool = null;
let origin = null;
let browser = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageFn = (fn) => browser.ev(`(${fn.toString()})()`);

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function api(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function must(method, path, opts) {
  const res = await api(method, path, opts);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data;
}

async function makeActor(role, n) {
  const phone = `0917${String(n).padStart(6, '0')}`;
  const reg = await must('POST', '/api/auth/register', { body: { phone, password: PASSWORD, name: `Thử ${role} ${n}` } });
  if (role !== 'farmer') {
    await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1,$2) ON CONFLICT DO NOTHING', [reg.user.id, role]);
  }
  const login = await must('POST', '/api/auth/login', { body: { phone, password: PASSWORD } });
  return { role, phone, id: reg.user.id, token: login.token };
}

async function session(person, prefix, { width = 390, height = 844, mobile = true } = {}) {
  if (browser) {
    pageErrors.push(...browser.errors);
    consoleErrors.push(...browser.consoleErrors);
    await browser.close();
  }
  browser = await open({ width, height, mobile });
  await browser.go(`${origin}/v2/`);
  await browser.waitFor('location.hash.startsWith("#/chung/C-01")');
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', person.phone);
  await browser.fill('input[name=password]', PASSWORD);
  await browser.click('form button[type=submit]');
  await browser.waitFor(`location.hash.startsWith(${JSON.stringify(prefix)})`);
  return browser;
}

async function pollDb(fn, ok, label, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}; last=${JSON.stringify(last)}`);
}

async function assertLayoutNoOverflow(label) {
  const layout = await browser.layout();
  assert.ok(layout && layout.sw <= layout.w && layout.wide.length === 0, `${label} horizontal overflow: ${JSON.stringify(layout)}`);
}

// Pure DOM readers, serialised into the page by pageFn.
function summaryPairs() {
  return [...document.querySelectorAll('.summary-line__item')].map((el) => [
    el.querySelector('span.muted:not(.summary-line__sep)')?.textContent.replace(/\u00a0/g, ' ').trim() ?? '',
    el.querySelector('strong')?.textContent.trim() ?? '',
  ]).filter(([label]) => label !== '');
}
function fleetRows() {
  return [...document.querySelectorAll('.table tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim());
}
function bodyText() {
  return document.body.innerText.replace(/\s+/g, ' ');
}
function visibleAlerts() {
  return [...document.querySelectorAll('.msg--error')].filter((m) => !m.hidden).map((m) => m.textContent.trim());
}
function jobButtonLabels() {
  return [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => t === 'Đóng tin');
}

const pairsWithLabel = (pairs, label) => pairs.find(([l]) => l === label)?.[1];

try {
  if (!rootUrl) {
    const dbPass = randomBytes(12).toString('hex');
    const containerName = `agri-pg-fleetjobs-${randomBytes(4).toString('hex')}`;
    log('Spawning PostgreSQL 17 Docker container:', containerName);
    execSync(`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=${dbPass} -e POSTGRES_DB=bootstrap_test -p 127.0.0.1::5432 postgres:17-alpine`);
    spawnedContainer = containerName;
    const port = execSync(`docker port ${containerName} 5432`, { encoding: 'utf8' }).trim().split(':')[1];
    rootUrl = `postgresql://postgres:${dbPass}@127.0.0.1:${port}/bootstrap_test`;
    let ready = 0;
    for (let i = 0; i < 120 && ready < 2; i++) {
      try {
        const client = new pg.Client({ connectionString: rootUrl });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        ready += 1;
      } catch {
        ready = 0;
      }
      await sleep(250);
    }
    assert.equal(ready, 2, 'PostgreSQL 17 container did not become ready');
  }

  db = await createDisposableDatabase(rootUrl);
  pool = createPool(db.url);
  log('Database ready:', db.name);

  await migrate(pool);
  await seedCatalog(pool);

  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const evidenceStore = {
    async put() { return { etag: '"fleet-jobs-test"', versionId: null }; },
    async get() { return { bytes: pngBytes, contentType: 'image/png' }; },
    async remove() { return true; },
  };

  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret, evidenceStore }));
  log('App and Account services running on loopback HTTP');

  const provider = await makeActor('provider', 1);
  const ownerRows = async () => (await pool.query(
    'SELECT id, name, machine_type, status FROM dispatch.machines WHERE owner_id=$1 ORDER BY created_at, id',
    [provider.id],
  )).rows;

  // =========================================================================
  // 1. P-04 fleet: empty state -> invalid names rejected -> add harvester + drone -> reload -> PG readback
  // =========================================================================
  log('Step 1: P-04 empty state at 390px');
  await session(provider, '#/chu-may/', { width: 390, height: 844, mobile: true });
  await browser.hash('#/chu-may/P-04');
  await browser.waitText('Khai báo máy mới');
  await browser.waitText('Chưa có máy nào');
  let pairs = await pageFn(summaryPairs);
  assert.equal(pairsWithLabel(pairs, 'Tổng số máy'), '0', `empty total: ${JSON.stringify(pairs)}`);
  assert.equal(pairsWithLabel(pairs, 'Đang sẵn sàng'), '0', `empty ready: ${JSON.stringify(pairs)}`);
  assert.equal(pairsWithLabel(pairs, 'Máy gặt'), '0', `empty harvester: ${JSON.stringify(pairs)}`);
  assert.deepEqual(await pageFn(fleetRows), [], 'no machine rows in empty state');
  await assertLayoutNoOverflow('P-04 empty mobile');
  await browser.shot(join(SHOTS, 'p04-empty-390.png'));
  log('P-04 empty summary and empty table verified');

  log('Step 1b: P-04 reject blank, whitespace-only and 121-char machine names');
  const nameMsg = 'Nhập tên máy từ 1 đến 120 ký tự.';
  for (const bad of ['', '    ', 'x'.repeat(121)]) {
    await browser.fill('form input[name=name]', bad);
    await browser.ev('document.querySelector("form input[name=name]").form.requestSubmit()');
    await browser.waitText(nameMsg);
    assert.deepEqual(await pageFn(visibleAlerts), [nameMsg], `alert for input length ${bad.length}`);
  }
  assert.equal((await ownerRows()).length, 0, 'rejected names created no machine rows');
  await browser.shot(join(SHOTS, 'p04-invalid-390.png'));
  log('Blank, whitespace and 121-char names rejected with no DB row');

  log('Step 1c: P-04 add harvester and drone');
  const harvesterName = 'Kubota DC-70 Plus #1';
  const droneName = 'DJI Agras T40 #1';
  await browser.fill('form input[name=name]', harvesterName);
  await browser.ev('document.querySelector("form input[name=name]").form.requestSubmit()');
  await browser.waitText('Đã thêm máy mới');
  await pollDb(ownerRows, (r) => r.length === 1, 'harvester persisted');
  await browser.waitText(harvesterName);

  await browser.ev('(()=>{const r=document.querySelector("input[name=type][value=drone]");if(!r)throw new Error("no drone radio");r.click();})()');
  await browser.fill('form input[name=name]', droneName);
  await browser.ev('document.querySelector("form input[name=name]").form.requestSubmit()');
  await browser.waitText('Đã thêm máy mới');
  await pollDb(ownerRows, (r) => r.length === 2, 'drone persisted');
  await browser.waitText(droneName);

  const dbMachines = await ownerRows();
  const harvester = dbMachines.find((m) => m.name === harvesterName);
  const drone = dbMachines.find((m) => m.name === droneName);
  assert.equal(harvester?.machine_type, 'harvester');
  assert.equal(drone?.machine_type, 'drone');
  assert.equal(harvester.status, 'available');
  assert.equal(drone.status, 'available');

  pairs = await pageFn(summaryPairs);
  assert.equal(pairsWithLabel(pairs, 'Tổng số máy'), '2', `total after add: ${JSON.stringify(pairs)}`);
  assert.equal(pairsWithLabel(pairs, 'Đang sẵn sàng'), '2', `ready after add: ${JSON.stringify(pairs)}`);
  assert.equal(pairsWithLabel(pairs, 'Máy gặt'), '1', `harvester count after add: ${JSON.stringify(pairs)}`);

  const rowsBefore = await pageFn(fleetRows);
  assert.equal(rowsBefore.length, 2, `two table rows: ${JSON.stringify(rowsBefore)}`);
  // created_at DESC: drone first, harvester second. Short ID = first 8 chars of machine UUID.
  assert.ok(rowsBefore[0].includes(droneName) && rowsBefore[0].includes(drone.id.slice(0, 8)), `drone row: ${rowsBefore[0]}`);
  assert.ok(rowsBefore[0].includes('Drone phun thuốc'), `drone type label: ${rowsBefore[0]}`);
  assert.ok(rowsBefore[1].includes(harvesterName) && rowsBefore[1].includes(harvester.id.slice(0, 8)), `harvester row: ${rowsBefore[1]}`);
  assert.ok(rowsBefore[1].includes('Máy gặt đập liên hợp'), `harvester type label: ${rowsBefore[1]}`);
  log('P-04 summary 2/2/1 and table rows with short IDs verified');

  log('Step 1d: P-04 readback at 390px in a fresh browser profile');
  await session(provider, '#/chu-may/', { width: 390, height: 844, mobile: true });
  await browser.hash('#/chu-may/P-04');
  await browser.waitText(droneName);
  await browser.waitText(harvesterName);
  pairs = await pageFn(summaryPairs);
  assert.equal(pairsWithLabel(pairs, 'Tổng số máy'), '2', `total after reload: ${JSON.stringify(pairs)}`);
  assert.deepEqual(await pageFn(fleetRows), rowsBefore, 'rows identical after reload');
  await assertLayoutNoOverflow('P-04 populated mobile');
  await browser.shot(join(SHOTS, 'p04-populated-390.png'));

  // =========================================================================
  // 2. P-08 extended fields: client and server validation, then creation -> P-08 list -> PG readback
  // =========================================================================
  log('Step 2: P-08 extended-field validation');
  await browser.hash('#/chu-may/P-08');
  await browser.waitText('Đăng tin tuyển mới');
  const jobTitle = `Tuyển thợ máy gặt vụ Đông Xuân ${randomBytes(2).toString('hex')}`;
  const fillBase = async () => {
    await browser.fill('input[name=title]', jobTitle);
    await browser.fill('input[name=locality]', 'Thoại Sơn, An Giang');
    await browser.fill('input[name=capacity]', '2');
    await browser.fill('input[name=startLocal]', localInput(10, 7));
    await browser.fill('input[name=endLocal]', localInput(10, 13));
  };
  const submitP08 = () => browser.ev('document.querySelector("input[name=title]").form.requestSubmit()');
  const jobCount = async () => (await pool.query('SELECT count(*)::int AS n FROM dispatch.jobs WHERE provider_id=$1', [provider.id])).rows[0].n;

  await fillBase();
  const wageCases = [
    ['', '1500000', 'Chọn hình thức tiền công theo ha hoặc theo ca.'],
    ['NEGOTIABLE', '1500000', 'Chọn hình thức tiền công theo ha hoặc theo ca.'],
    ['PER_SHIFT', '0', 'Tiền công phải là số nguyên dương.'],
    ['PER_SHIFT', '12.5', 'Tiền công phải là số nguyên dương.'],
  ];
  for (const [wageType, amount, expected] of wageCases) {
    await browser.fill('select[name=wageType]', wageType);
    await browser.fill('input[name=wageAmountVnd]', amount);
    await submitP08();
    await browser.waitText(expected);
    assert.deepEqual(await pageFn(visibleAlerts), [expected], `P-08 wage case ${wageType}/${amount}`);
  }
  assert.equal(await jobCount(), 0, 'rejected wage cases created no job');
  log('P-08 wage validation rejected 4 invalid combinations with no job row');

  // Server boundary: more than 30 skills is refused by the API. Expect exactly one 400 console entry for POST /api/jobs.
  await browser.fill('select[name=wageType]', 'PER_SHIFT');
  await browser.fill('input[name=wageAmountVnd]', '500000');
  await browser.fill('input[name=requiredSkills]', Array.from({ length: 31 }, (_, i) => `kỹ năng ${i + 1}`).join(', '));
  await submitP08();
  await browser.waitFor(`document.querySelectorAll('.msg--error:not([hidden])').length > 0`);
  const serverAlerts = await pageFn(visibleAlerts);
  assert.equal(serverAlerts.length, 1, `server refusal shown: ${JSON.stringify(serverAlerts)}`);
  assert.equal(await jobCount(), 0, 'server-refused skills created no job');
  expectedConsoleErrors.push('/api/jobs');
  log('P-08 server refusal for 31 skills shown inline, no job row. Message:', serverAlerts[0]);

  log('Step 2b: P-08 valid extended fields create job');
  await browser.fill('input[name=requiredSkills]', 'bảo dưỡng, cắt lúa sập');
  await browser.fill('select[name=wageType]', 'PER_SHIFT');
  await browser.fill('input[name=wageAmountVnd]', '500000');
  await browser.fill('select[name=machineType]', 'harvester');
  await submitP08();
  await browser.waitText('Đã đăng tin tuyển thợ');
  const [job] = (await pollDb(
    () => pool.query('SELECT id, title, status, capacity, wage_type, wage_amount_vnd, machine_type, required_skills FROM dispatch.jobs WHERE provider_id=$1 AND title=$2', [provider.id, jobTitle]),
    (r) => r.rowCount === 1,
    'job persisted',
  )).rows;
  assert.equal(job.status, 'OPEN');
  assert.equal(job.capacity, 2);
  assert.equal(job.wage_type, 'PER_SHIFT');
  assert.equal(String(job.wage_amount_vnd), '500000');
  assert.equal(job.machine_type, 'harvester');
  assert.deepEqual(job.required_skills, ['bảo dưỡng', 'cắt lúa sập']);
  await browser.waitText(jobTitle);
  const p08Text = await pageFn(bodyText);
  assert.ok(p08Text.includes('Theo ca · 500.000 đ · Máy gặt đập liên hợp'), `P-08 wage/machine line: ${p08Text.slice(0, 400)}`);
  assert.ok(p08Text.includes('Kỹ năng: bảo dưỡng, cắt lúa sập'), 'P-08 skills line');
  log('P-08 job persisted with wage, machine and skills; P-08 list shows them');
  await assertLayoutNoOverflow('P-08 mobile');
  await browser.shot(join(SHOTS, 'p08-created-390.png'));

  // =========================================================================
  // 3. P-09: extended fields visible -> close via confirm modal -> status Đã đóng, DB CLOSED, button gone
  // =========================================================================
  log('Step 3: P-09 readback of extended fields and close-job flow at 390px');
  await browser.hash(`#/chu-may/P-09?id=${job.id}`);
  await browser.waitText('Ứng viên và đề nghị');
  await browser.waitText(jobTitle);
  const p09Text = await pageFn(bodyText);
  assert.ok(p09Text.includes('Theo ca') && p09Text.includes('500.000 đ'), `P-09 wage readback: ${p09Text.slice(0, 500)}`);
  assert.ok(p09Text.includes('Máy gặt đập liên hợp'), 'P-09 machine readback');
  assert.ok(p09Text.includes('bảo dưỡng') && p09Text.includes('cắt lúa sập'), 'P-09 skills readback');
  assert.deepEqual(await pageFn(jobButtonLabels), ['Đóng tin'], 'close button visible while OPEN');
  await assertLayoutNoOverflow('P-09 open mobile');
  await browser.shot(join(SHOTS, 'p09-open-390.png'));

  // Cancel path first: confirm modal must not close the job.
  await browser.clickText('Đóng tin', 'button');
  await browser.waitText('Đóng tin tuyển này?');
  await browser.clickText('Bỏ qua', '.modal button');
  await browser.waitFor('!document.querySelector(".modal")');
  assert.equal((await pool.query('SELECT status FROM dispatch.jobs WHERE id=$1', [job.id])).rows[0].status, 'OPEN', 'cancel keeps job OPEN');

  await browser.clickText('Đóng tin', 'button');
  await browser.waitText('Đóng tin tuyển này?');
  await browser.shot(join(SHOTS, 'p09-confirm-390.png'));
  await browser.clickText('Đóng tin', '.modal button');
  await browser.waitText('Đã đóng tin tuyển');
  const closed = await pollDb(
    () => pool.query('SELECT status, closed_at FROM dispatch.jobs WHERE id=$1', [job.id]),
    (r) => r.rows[0]?.status === 'CLOSED',
    'job CLOSED in DB',
  );
  assert.ok(closed.rows[0].closed_at, 'closed_at set');
  await browser.waitText('Đã đóng');
  assert.deepEqual(await pageFn(jobButtonLabels), [], 'close button gone after close');
  assert.equal((await pageFn(bodyText)).includes('Đang tuyển'), false, 'no Đang tuyển badge after close');
  await assertLayoutNoOverflow('P-09 closed mobile');
  await browser.shot(join(SHOTS, 'p09-closed-390.png'));
  log('P-09 close confirmed: UI Đã đóng, DB CLOSED, button gone');

  // Sibling screen for the same record: P-08 must not offer the close action again.
  await browser.hash('#/chu-may/P-08');
  await browser.waitText(jobTitle);
  assert.deepEqual(await pageFn(jobButtonLabels), [], 'P-08 offers no close action for CLOSED job');
  assert.ok((await pageFn(bodyText)).includes('Đã đóng'), 'P-08 shows Đã đóng for the job');

  // Reload P-09 at 1440 for desktop evidence.
  await browser.viewport(1440, 900, false);
  await browser.hash(`#/chu-may/P-09?id=${job.id}`);
  await browser.waitText('Đã đóng');
  assert.deepEqual(await pageFn(jobButtonLabels), [], 'desktop: close button absent');
  await assertLayoutNoOverflow('P-09 closed desktop');
  await browser.shot(join(SHOTS, 'p09-closed-1440.png'));

  // 1440 desktop checks for P-04 and P-08.
  await browser.hash('#/chu-may/P-04');
  await browser.waitText(harvesterName);
  await assertLayoutNoOverflow('P-04 populated desktop');
  await browser.shot(join(SHOTS, 'p04-populated-1440.png'));
  await browser.hash('#/chu-may/P-08');
  await browser.waitText(jobTitle);
  await assertLayoutNoOverflow('P-08 desktop');
  await browser.shot(join(SHOTS, 'p08-created-1440.png'));

  // DB final state.
  const finalJob = (await pool.query('SELECT status, closed_at FROM dispatch.jobs WHERE provider_id=$1', [provider.id])).rows;
  assert.equal(finalJob.length, 1);
  assert.equal(finalJob[0].status, 'CLOSED');

  for (const f of ['p04-empty-390.png', 'p04-invalid-390.png', 'p04-populated-390.png', 'p08-created-390.png', 'p09-open-390.png', 'p09-confirm-390.png', 'p09-closed-390.png', 'p09-closed-1440.png', 'p04-populated-1440.png', 'p08-created-1440.png']) {
    const s = await stat(join(SHOTS, f));
    assert.ok(s.size > 1000, `screenshot ${f} too small (${s.size} bytes)`);
  }
  log(`Screenshots written and non-empty in ${SHOTS}`);

  pageErrors.push(...browser.errors);
  consoleErrors.push(...browser.consoleErrors);
  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
  const unexpectedConsole = consoleErrors.filter((e) => !expectedConsoleErrors.some((x) => e.includes(x)));
  assert.deepEqual(unexpectedConsole, [], `browser console errors: ${unexpectedConsole.join(' | ')}`);
  assert.equal(consoleErrors.length - unexpectedConsole.length, 1, 'exactly one expected 400 console entry');
  log('ALL P-04, P-08 AND P-09 ASSERTIONS PASSED CLEANLY');
} finally {
  try {
    if (browser) await browser.close();
  } catch (err) {
    void err;
  }
  try {
    await Promise.all(servers.map((s) => new Promise((resolve) => {
      s.close(resolve);
      s.closeAllConnections?.();
    })));
  } catch (err) {
    void err;
  }
  try {
    if (pool) await pool.end();
  } catch (err) {
    void err;
  }
  try {
    if (db) await db.drop();
  } catch (err) {
    void err;
  }
  if (spawnedContainer) {
    try {
      execSync(`docker rm -f ${spawnedContainer}`, { stdio: 'ignore' });
      log('Cleaned up Docker container:', spawnedContainer);
    } catch (err) {
      void err;
    }
  }
}

function localInput(days, hour) {
  const d = new Date(Date.now() + days * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}
