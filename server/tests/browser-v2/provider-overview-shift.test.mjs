// Browser test for provider P-01 feed & filters and P-06 shift monitor on /v2/.
// Uses disposable PostgreSQL 17 Docker on loopback (unique container/db name) + real account & app HTTP + headless Chromium at 390 and 1440 px.
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

const log = (...args) => console.log('[provider-overview-shift]', ...args);
const SHOTS = process.env.PROVIDER_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-provider-shots-')));
await mkdir(SHOTS, { recursive: true });

const PASSWORD = 'TestPass!12345';
const secret = randomBytes(32).toString('base64url');
const pageErrors = [];
const consoleErrors = [];
const servers = [];

let spawnedContainer = null;
let rootUrl = process.env.TEST_DATABASE_URL;
let db = null;
let pool = null;
let origin = null;
let browser = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function api(method, path, { token, body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
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
  const phone = `0916${String(n).padStart(6, '0')}`;
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

const isoDay = (offsetDays, hour) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

const dateOnly = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

async function assertLayoutNoOverflow(label) {
  const layout = await browser.layout();
  assert.ok(layout && layout.sw <= layout.w && layout.wide.length === 0, `${label} horizontal overflow: ${JSON.stringify(layout)}`);
}

try {
  // Ensure loopback PostgreSQL 17 Docker instance
  if (!rootUrl) {
    const containerName = `agri-pg-p0106-${randomBytes(4).toString('hex')}`;
    log('Spawning PostgreSQL 17 Docker container:', containerName);
    execSync(`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=bootstrap_test -p 127.0.0.1::5432 postgres:17-alpine`);
    spawnedContainer = containerName;
    const portStr = execSync(`docker port ${containerName} 5432`, { encoding: 'utf8' }).trim();
    const port = portStr.split(':')[1];
    rootUrl = `postgresql://postgres:testpass@127.0.0.1:${port}/bootstrap_test`;
    for (let i = 0; i < 40; i++) {
      try {
        const client = new pg.Client({ connectionString: rootUrl });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        break;
      } catch {
        await sleep(150);
      }
    }
  }

  db = await createDisposableDatabase(rootUrl);
  pool = createPool(db.url);
  log('Database ready:', db.name);

  await migrate(pool);
  await seedCatalog(pool);

  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const evidenceStore = {
    async put() { return { etag: '"p0106-test"', versionId: null }; },
    async get() { return { bytes: pngBytes, contentType: 'image/png' }; },
    async remove() { return true; },
  };

  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret, evidenceStore }));
  log('App and Account services running on loopback HTTP');

  const farmer = await makeActor('farmer', 1);
  const coop = await makeActor('coop', 2);
  const provider = await makeActor('provider', 3);
  const operator = await makeActor('operator', 4);

  // =========================================================================
  // 1. P-01 EMPTY STATE
  // =========================================================================
  log('Step 1: P-01 empty state at 390px');
  await session(provider, '#/chu-may/', { width: 390, height: 844, mobile: true });
  await browser.hash('#/chu-may/P-01');
  await browser.waitText('Bảng tin gói việc');
  await browser.waitText('Chưa có gói việc đang mở');
  await browser.waitText('HTX chưa mở gói việc mới');
  await browser.waitText('Quản lý đội máy');

  // Summary counts match DB (all 0)
  const emptySummary = await browser.ev(`(()=>{
    return [...document.querySelectorAll('.summary-line__item')].map((el) => el.innerText.trim().replace(/\\s+/g, ' '));
  })()`);
  assert.ok(emptySummary.some((s) => s.includes('Gói đang mở') && s.includes('0')), 'open packages count is 0');
  assert.ok(emptySummary.some((s) => s.includes('Đơn trong gói mở') && s.includes('0')), 'open bookings count is 0');
  assert.ok(emptySummary.some((s) => s.includes('Gói bạn đã nhận') && s.includes('0')), 'claimed packages count is 0');

  // "Gói việc của bạn" card is absent when no claimed packages exist
  assert.equal(await browser.ev('!!document.querySelector(".table")'), false, 'no tables in empty P-01');
  await assertLayoutNoOverflow('P-01 empty mobile');
  await browser.shot(join(SHOTS, 'p01-empty-mobile.png'));

  // P-01 empty state at 1440px desktop
  log('Step 1b: P-01 empty state at 1440px');
  await browser.viewport(1440, 900, false);
  await assertLayoutNoOverflow('P-01 empty desktop');
  await browser.shot(join(SHOTS, 'p01-empty-desktop.png'));

  // =========================================================================
  // 2. P-06 EMPTY STATE
  // =========================================================================
  log('Step 2: P-06 empty state at 390px');
  await browser.viewport(390, 844, true);
  await browser.hash('#/chu-may/P-06');
  await browser.waitText('Ca máy');
  await browser.waitText('Chưa có ca máy nào chạy');
  await browser.waitText('Sau khi bạn nhận gói việc');
  await browser.waitText('Xem bảng tin gói việc');

  // Read-only check: provider has no start/pause/complete buttons
  const p06Buttons = await browser.ev(`[...document.querySelectorAll('button')].map(b => b.textContent.trim())`);
  assert.ok(!p06Buttons.includes('Bắt đầu ca'), 'no start shift button for provider');
  assert.ok(!p06Buttons.includes('Tạm dừng'), 'no pause shift button for provider');
  assert.ok(!p06Buttons.includes('Kết thúc ca'), 'no complete shift button for provider');

  await assertLayoutNoOverflow('P-06 empty mobile');
  await browser.shot(join(SHOTS, 'p06-empty-mobile.png'));

  // P-06 empty state at 1440px desktop
  log('Step 2b: P-06 empty state at 1440px');
  await browser.viewport(1440, 900, false);
  await assertLayoutNoOverflow('P-06 empty desktop');
  await browser.shot(join(SHOTS, 'p06-empty-desktop.png'));

  // =========================================================================
  // 3. SEED REAL PACKAGES (OPEN AND CLAIMED) & RECRUITMENT COMMITMENT
  // =========================================================================
  log('Step 3: Creating real OPEN and CLAIMED packages');
  const services = (await must('GET', '/api/services')).items;
  const harvestSvc = services.find((s) => s.code === 'harvest-combine');
  const tillageSvc = services.find((s) => s.code === 'tillage-tractor');
  assert.ok(harvestSvc && tillageSvc, 'services present in catalog');

  // Machine and Recruitment prerequisite for provider + operator
  await must('POST', '/api/machines', {
    token: provider.token,
    body: { name: 'Máy gặt Kubota DC70', type: 'harvester' },
  });
  const machines = (await must('GET', '/api/machines', { token: provider.token })).items;
  const machine = machines[0];
  assert.ok(machine, 'harvester machine created');

  const job = (await must('POST', '/api/jobs', {
    token: provider.token,
    body: {
      title: 'Tuyển thợ gặt lúa An Giang',
      locality: 'Thoại Sơn, An Giang',
      capacity: 1,
      startAt: isoDay(1, 6),
      endAt: isoDay(20, 18),
      wageType: 'PER_SHIFT',
      wageAmountVnd: 1200000,
      machineType: 'harvester',
      requiredSkills: ['gặt lúa', 'lái máy'],
    },
  })).job;

  const appRes = await must('POST', `/api/jobs/${job.id}/applications`, { token: operator.token, body: {} });
  const offerRes = await must('POST', `/api/applications/${appRes.application.id}/offers`, { token: provider.token, body: {} });
  await must('POST', `/api/offers/${offerRes.offer.id}/accept`, { token: operator.token, body: {} });
  log('Workforce commitment accepted for operator');

  // Package 1: OPEN with 2 bookings (Thoại Sơn, An Giang, harvest-combine)
  const f1 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng Đông 1', locality: 'Thoại Sơn, An Giang', areaM2: 12000 } })).field;
  const f2 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng Đông 2', locality: 'Thoại Sơn, An Giang', areaM2: 15000 } })).field;
  const b1 = (await must('POST', '/api/bookings', {
    token: farmer.token,
    key: 'test-idemp-key-b1-0000001',
    body: { fieldId: f1.id, serviceId: harvestSvc.id, startAt: isoDay(5, 8), endAt: isoDay(5, 12) },
  })).booking;
  await must('POST', `/api/bookings/${b1.id}/coordinator`, { token: farmer.token, body: { coordinatorId: coop.id } });
  const b2 = (await must('POST', '/api/bookings', {
    token: farmer.token,
    key: 'test-idemp-key-b2-0000001',
    body: { fieldId: f2.id, serviceId: harvestSvc.id, startAt: isoDay(5, 8), endAt: isoDay(5, 12) },
  })).booking;
  await must('POST', `/api/bookings/${b2.id}/coordinator`, { token: farmer.token, body: { coordinatorId: coop.id } });
  const pkg1 = (await must('POST', '/api/packages', { token: coop.token, body: { bookingIds: [b1.id, b2.id] } })).package;
  assert.equal(pkg1.status, 'OPEN');
  assert.equal(pkg1.bookingCount, 2);

  // Package 2: OPEN with 1 booking (Châu Thành, Đồng Tháp, tillage-tractor)
  const f3 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng Tây', locality: 'Châu Thành, Đồng Tháp', areaM2: 20000 } })).field;
  const b3 = (await must('POST', '/api/bookings', {
    token: farmer.token,
    key: 'test-idemp-key-b3-0000001',
    body: { fieldId: f3.id, serviceId: tillageSvc.id, startAt: isoDay(8, 7), endAt: isoDay(8, 13) },
  })).booking;
  await must('POST', `/api/bookings/${b3.id}/coordinator`, { token: farmer.token, body: { coordinatorId: coop.id } });
  const pkg2 = (await must('POST', '/api/packages', { token: coop.token, body: { bookingIds: [b3.id] } })).package;
  assert.equal(pkg2.status, 'OPEN');
  assert.equal(pkg2.bookingCount, 1);

  // Package 3: CLAIMED with 1 booking (Vĩnh Thạnh, Cần Thơ, harvest-combine)
  const f4 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng Nam', locality: 'Vĩnh Thạnh, Cần Thơ', areaM2: 14000 } })).field;
  const b4 = (await must('POST', '/api/bookings', {
    token: farmer.token,
    key: 'test-idemp-key-b4-0000001',
    body: { fieldId: f4.id, serviceId: harvestSvc.id, startAt: isoDay(3, 8), endAt: isoDay(3, 14) },
  })).booking;
  await must('POST', `/api/bookings/${b4.id}/coordinator`, { token: farmer.token, body: { coordinatorId: coop.id } });
  const pkg3 = (await must('POST', '/api/packages', { token: coop.token, body: { bookingIds: [b4.id] } })).package;
  assert.equal(pkg3.status, 'OPEN');

  // Provider claims Package 3
  const claimRes = await must('POST', `/api/packages/${pkg3.id}/claim`, {
    token: provider.token,
    body: { machineId: machine.id, operatorId: operator.id },
  });
  assert.equal(claimRes.package.status, 'CLAIMED');
  log('Package 3 claimed by provider');

  // Verify counts directly from PostgreSQL
  const dbOpenCount = (await pool.query("SELECT count(*)::int AS n FROM dispatch.packages WHERE status = 'OPEN'")).rows[0].n;
  const dbOpenBookings = (await pool.query(`
    SELECT COALESCE(SUM(c.cnt), 0)::int AS n
      FROM dispatch.packages p
      JOIN LATERAL (SELECT count(*)::int AS cnt FROM dispatch.package_bookings pb WHERE pb.package_id = p.id) c ON true
     WHERE p.status = 'OPEN'
  `)).rows[0].n;
  const dbClaimedCount = (await pool.query("SELECT count(*)::int AS n FROM dispatch.packages WHERE status = 'CLAIMED' AND provider_id = $1", [provider.id])).rows[0].n;
  assert.equal(dbOpenCount, 2);
  assert.equal(dbOpenBookings, 3);
  assert.equal(dbClaimedCount, 1);

  // =========================================================================
  // 4. P-01 FEED WITH REAL PACKAGES, FILTERS & SORTING
  // =========================================================================
  log('Step 4: P-01 feed with populated packages and filters');
  await browser.hash('#/chu-may/P-01');
  await browser.waitText('Thoại Sơn, An Giang');
  await browser.waitText('Châu Thành, Đồng Tháp');
  await browser.waitText('Vĩnh Thạnh, Cần Thơ');

  // Verify Summary counts match PostgreSQL exactly
  const feedSummary = await browser.ev(`(()=>{
    return [...document.querySelectorAll('.summary-line__item')].map((el) => el.innerText.trim().replace(/\\s+/g, ' '));
  })()`);
  assert.ok(feedSummary.some((s) => s.includes('Gói đang mở') && s.includes(String(dbOpenCount))), 'open package count matches DB (2)');
  assert.ok(feedSummary.some((s) => s.includes('Đơn trong gói mở') && s.includes(String(dbOpenBookings))), 'open booking count matches DB (3)');
  assert.ok(feedSummary.some((s) => s.includes('Gói bạn đã nhận') && s.includes(String(dbClaimedCount))), 'claimed count matches DB (1)');

  // Verify claimed package card
  await browser.waitText('Gói việc của bạn');
  await browser.waitText('Đã nhận');

  // Open details for filters
  await browser.click('summary');
  await browser.waitFor('!!document.querySelector("select[name=serviceId]")');

  // 4a. Service filter: filter by tillage-tractor
  log('Step 4a: Service filter');
  await browser.fill('select[name=serviceId]', tillageSvc.id);
  await browser.waitFor('!document.body.innerText.includes("Thoại Sơn, An Giang")');
  await browser.waitText('Châu Thành, Đồng Tháp');

  // 4b. Search query filter + zero matches empty state
  log('Step 4b: Search filter and resetFilters via "Xóa bộ lọc"');
  await browser.fill('input[name=q]', 'Không Khớp Nào');
  await browser.waitText('Không có gói việc khớp bộ lọc');
  await browser.waitText('Xóa bộ lọc');

  // Click "Xóa bộ lọc" button
  await browser.clickText('Xóa bộ lọc', 'button');
  await browser.waitText('Thoại Sơn, An Giang');
  await browser.waitText('Châu Thành, Đồng Tháp');
  assert.equal(await browser.ev('document.querySelector("select[name=serviceId]").value'), 'all', 'service filter reset to all');
  assert.equal(await browser.ev('document.querySelector("input[name=q]").value'), '', 'search filter reset to empty');

  // 4c. Search filter alone
  log('Step 4c: Search filter matching Thoại Sơn');
  await browser.fill('input[name=q]', 'Thoại Sơn');
  await browser.waitText('Thoại Sơn, An Giang');
  assert.equal(await browser.ev('document.body.innerText.includes("Châu Thành, Đồng Tháp")'), false, 'Chau Thanh hidden by search');

  // 4d. Date filter
  log('Step 4d: Date filter');
  // Day +6 to Day +9 isolates Package 2 (starts day 8), excludes Package 1 (day 5)
  await browser.fill('input[name=q]', '');
  await browser.fill('input[name=from]', dateOnly(6));
  await browser.fill('input[name=to]', dateOnly(9));
  await browser.waitText('Châu Thành, Đồng Tháp');
  assert.equal(await browser.ev('document.body.innerText.includes("Thoại Sơn, An Giang")'), false, 'Thoai Son excluded by date filter');

  // 4e. Sort filter
  log('Step 4e: Sort filter');
  // Reset date filters first
  await browser.clickText('Đặt lại', 'button');
  await browser.waitText('Thoại Sơn, An Giang');
  await browser.waitText('Châu Thành, Đồng Tháp');

  // Sort by bookings-desc: Package 1 (2 bookings) should precede Package 2 (1 booking)
  await browser.fill('select[name=sort]', 'bookings-desc');
  const tableRowsOrder = await browser.ev(`(()=>{
    const trs = [...document.querySelectorAll('table tbody tr')];
    return trs.map((tr) => tr.innerText.replace(/\\s+/g, ' '));
  })()`);
  assert.ok(tableRowsOrder[0].includes('Thoại Sơn, An Giang') && tableRowsOrder[0].includes('2 đơn'), 'Package 1 with 2 bookings is first');

  // 4f. Clicking package opens P-02 detail
  log('Step 4f: Clicking package "Chi tiết" opens P-02');
  await browser.ev(`(()=>{
    const tr = [...document.querySelectorAll('table tbody tr')].find((r) => r.textContent.includes('Thoại Sơn, An Giang'));
    if (!tr) throw new Error('Package 1 row missing');
    const btn = [...tr.querySelectorAll('a,button')].find((el) => el.textContent.trim() === 'Chi tiết');
    if (!btn) throw new Error('Chi tiet button missing');
    btn.click();
  })()`);
  await browser.waitFor(`location.hash.startsWith('#/chu-may/P-02')`);
  await browser.waitText(`Gói việc ${pkg1.id.slice(0, 8)}`);
  await browser.waitText('Thoại Sơn, An Giang');
  await browser.waitText('2 đơn');
  const p02Id = await browser.ev('new URLSearchParams(location.hash.split("?")[1]).get("id")');
  assert.equal(p02Id, pkg1.id, 'navigated to correct package ID');

  // Check layout on P-01 and P-02 at 1440px and 390px
  await assertLayoutNoOverflow('P-02 desktop');
  await browser.shot(join(SHOTS, 'p02-detail-desktop.png'));

  await browser.viewport(390, 844, true);
  await assertLayoutNoOverflow('P-02 mobile');
  await browser.shot(join(SHOTS, 'p02-detail-mobile.png'));

  await browser.hash('#/chu-may/P-01');
  await browser.waitText('Bảng tin gói việc');
  await assertLayoutNoOverflow('P-01 populated mobile');
  await browser.shot(join(SHOTS, 'p01-populated-mobile.png'));

  // =========================================================================
  // 5. P-06 SHIFT LIFECYCLE (RUNNING -> PAUSED -> COMPLETED)
  // =========================================================================
  log('Step 5: Starting shift on Package 3 by operator');
  // Prerequisites: Farmer readiness and HTX inspection on Booking 4
  await must('POST', `/api/bookings/${b4.id}/readiness`, {
    token: farmer.token,
    body: { drained: true, mature: true, intakeReady: true },
  });
  await must('POST', `/api/bookings/${b4.id}/inspections`, {
    token: coop.token,
    body: { result: 'PASSED' },
  });

  // Operator starts shift
  const startRes = await must('POST', `/api/packages/${pkg3.id}/shifts/start`, { token: operator.token, body: {} });
  const shiftId = startRes.shift.id;
  assert.equal(startRes.shift.status, 'RUNNING');
  log('Shift started with ID:', shiftId);

  // Provider visits P-06: RUNNING status
  log('Step 5a: Provider views RUNNING shift on P-06');
  await browser.hash('#/chu-may/P-06');
  await browser.waitText('Ca máy');
  await browser.waitText('Vĩnh Thạnh, Cần Thơ');
  await browser.waitText('Đang làm');
  await browser.waitText('Chưa chốt');
  await browser.waitText('Bắt đầu ca');

  // Verify status summary counts: 1 RUNNING, 0 PAUSED, 0 COMPLETED
  const runningSummary = await browser.ev(`(()=>{
    return [...document.querySelectorAll('.summary-line__item')].map((el) => el.innerText.trim().replace(/\\s+/g, ' '));
  })()`);
  assert.ok(runningSummary.some((s) => s.includes('Đang chạy') && s.includes('1')), 'RUNNING shift count is 1');
  assert.ok(runningSummary.some((s) => s.includes('Tạm dừng') && s.includes('0')), 'PAUSED shift count is 0');
  assert.ok(runningSummary.some((s) => s.includes('Đã xong') && s.includes('0')), 'COMPLETED shift count is 0');

  // READ-ONLY check: provider has no start/pause/complete action controls
  const providerButtonsRunning = await browser.ev(`[...document.querySelectorAll('button')].map(b => b.textContent.trim())`);
  assert.ok(!providerButtonsRunning.includes('Tạm dừng'), 'provider cannot pause shift');
  assert.ok(!providerButtonsRunning.includes('Tiếp tục ca'), 'provider cannot resume shift');
  assert.ok(!providerButtonsRunning.includes('Kết thúc ca'), 'provider cannot complete shift');
  assert.ok(!providerButtonsRunning.includes('Bắt đầu ca'), 'provider cannot start shift');

  await assertLayoutNoOverflow('P-06 RUNNING mobile');
  await browser.shot(join(SHOTS, 'p06-running-mobile.png'));

  // Operator pauses shift with real reason
  log('Step 5b: Operator pauses shift');
  await must('POST', `/api/shifts/${shiftId}/pause`, {
    token: operator.token,
    body: { reason: 'Mưa to bất chợt' },
  });

  // Provider views P-06: PAUSED status
  log('Step 5c: Provider views PAUSED shift on P-06');
  await browser.hash('#/chu-may/P-01');
  await browser.hash('#/chu-may/P-06');
  await browser.waitText('Tạm dừng');
  await browser.waitText('Mưa to bất chợt');

  const pausedSummary = await browser.ev(`(()=>{
    return [...document.querySelectorAll('.summary-line__item')].map((el) => el.innerText.trim().replace(/\\s+/g, ' '));
  })()`);
  assert.ok(pausedSummary.some((s) => s.includes('Đang chạy') && s.includes('0')), 'RUNNING shift count is 0');
  assert.ok(pausedSummary.some((s) => s.includes('Tạm dừng') && s.includes('1')), 'PAUSED shift count is 1');
  assert.ok(pausedSummary.some((s) => s.includes('Đã xong') && s.includes('0')), 'COMPLETED shift count is 0');

  await assertLayoutNoOverflow('P-06 PAUSED mobile');
  await browser.shot(join(SHOTS, 'p06-paused-mobile.png'));

  // Operator resumes and completes shift with area and note
  log('Step 5d: Operator resumes and completes shift');
  await must('POST', `/api/shifts/${shiftId}/resume`, { token: operator.token, body: {} });
  await must('POST', `/api/shifts/${shiftId}/complete`, {
    token: operator.token,
    body: { areaM2: 14000, note: 'Gặt xong toàn bộ diện tích lúa tốt' },
  });

  // Verify DB state
  const [shiftDbRow] = (await pool.query('SELECT status, area_m2, note, completed_at FROM dispatch.shifts WHERE id = $1', [shiftId])).rows;
  assert.equal(shiftDbRow.status, 'COMPLETED');
  assert.equal(Number(shiftDbRow.area_m2), 14000);
  assert.equal(shiftDbRow.note, 'Gặt xong toàn bộ diện tích lúa tốt');
  assert.ok(shiftDbRow.completed_at);

  // Provider views P-06: COMPLETED status
  log('Step 5e: Provider views COMPLETED shift on P-06 at 1440px desktop');
  await browser.viewport(1440, 900, false);
  await browser.hash('#/chu-may/P-01');
  await browser.hash(`#/chu-may/P-06?id=${shiftId}`);
  await browser.waitText('Đã xong');
  await browser.waitText('14.000 m² (1,40 ha)');
  await browser.waitText('Gặt xong toàn bộ diện tích lúa tốt');
  await browser.waitText('Kết thúc lúc');
  await browser.waitText('Diện tích đã làm');
  await browser.waitText('Tới Nghiệm thu và tiền');

  // Verify status summary counts: 0 RUNNING, 0 PAUSED, 1 COMPLETED
  const completedSummary = await browser.ev(`(()=>{
    return [...document.querySelectorAll('.summary-line__item')].map((el) => el.innerText.trim().replace(/\\s+/g, ' '));
  })()`);
  assert.ok(completedSummary.some((s) => s.includes('Đang chạy') && s.includes('0')), 'RUNNING shift count is 0');
  assert.ok(completedSummary.some((s) => s.includes('Tạm dừng') && s.includes('0')), 'PAUSED shift count is 0');
  assert.ok(completedSummary.some((s) => s.includes('Đã xong') && s.includes('1')), 'COMPLETED shift count is 1');

  // Verify shift API match for provider
  const apiShiftRes = await must('GET', `/api/shifts/${shiftId}`, { token: provider.token });
  assert.equal(apiShiftRes.shift.status, 'COMPLETED');
  assert.equal(Number(apiShiftRes.shift.areaM2), 14000);
  assert.equal(apiShiftRes.shift.note, 'Gặt xong toàn bộ diện tích lúa tốt');

  // Check read-only: still no operator write buttons
  const providerButtonsCompleted = await browser.ev(`[...document.querySelectorAll('button')].map(b => b.textContent.trim())`);
  assert.ok(!providerButtonsCompleted.includes('Tạm dừng'), 'provider cannot pause');
  assert.ok(!providerButtonsCompleted.includes('Tiếp tục ca'), 'provider cannot resume');
  assert.ok(!providerButtonsCompleted.includes('Kết thúc ca'), 'provider cannot complete');

  await assertLayoutNoOverflow('P-06 COMPLETED desktop');
  await browser.shot(join(SHOTS, 'p06-completed-desktop.png'));

  // P-06 COMPLETED at 390px mobile
  log('Step 5f: P-06 COMPLETED at 390px mobile');
  await browser.viewport(390, 844, true);
  await assertLayoutNoOverflow('P-06 COMPLETED mobile');
  await browser.shot(join(SHOTS, 'p06-completed-mobile.png'));

  // =========================================================================
  // 6. P-06 INVALID UUID PARAMETER
  // =========================================================================
  log('Step 6: P-06 invalid UUID param');
  await browser.hash('#/chu-may/P-06?id=not-a-valid-uuid');
  await browser.waitText('Không tìm thấy ca máy');
  await browser.waitText('Mã ca máy không hợp lệ.');
  await browser.clickText('Về danh sách ca máy', 'a');
  await browser.waitText('Danh sách ca máy');

  // Verify captured screenshots exist
  const shotFiles = [
    'p01-empty-mobile.png', 'p01-empty-desktop.png',
    'p06-empty-mobile.png', 'p06-empty-desktop.png',
    'p01-populated-mobile.png', 'p02-detail-desktop.png', 'p02-detail-mobile.png',
    'p06-running-mobile.png', 'p06-paused-mobile.png',
    'p06-completed-desktop.png', 'p06-completed-mobile.png',
  ];
  for (const f of shotFiles) {
    const s = await stat(join(SHOTS, f));
    assert.ok(s.size > 1000, `screenshot ${f} is too small or missing (${s.size} bytes)`);
  }
  log(`All ${shotFiles.length} screenshots inspected and non-empty in ${SHOTS}`);

  // Collect page and console errors
  pageErrors.push(...browser.errors);
  consoleErrors.push(...browser.consoleErrors);
  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(' | ')}`);

  log('ALL P-01 AND P-06 ASSERTIONS PASSED CLEANLY');
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
