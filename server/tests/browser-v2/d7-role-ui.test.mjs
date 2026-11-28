// Runnable E2E regression for D7 role UIs: Farmer (F-07/08/13/14), Operator (O-01), Admin (A-03).
// Uses disposable PostgreSQL migrated through latest + two-service real API + headless Chromium (1440 & 390).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from './cdp.mjs';

const SHOTS = await mkdtemp(join(tmpdir(), 'agri-d7-shots-'));
console.log(`Screenshots: ${SHOTS}`);

import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';

const log = (...args) => console.log('[d7-role-ui]', ...args);

const rootUrl = process.env.TEST_DATABASE_URL;
const db = await createDisposableDatabase(rootUrl);
const pool = createPool(db.url);

let accountSrv;
let appSrv;
let browser;

try {
  await migrate(pool);
  await seedCatalog(pool);

  const secret = randomBytes(32).toString('base64url');
  const password = 'TestPass!12345';

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  );
  const objects = new Map();
  const evidenceStore = {
    async put(key, bytes, contentType) {
      objects.set(key, { bytes, contentType });
      return { etag: '"d7-role-test"', versionId: null };
    },
    async get(key, { thumbnail = false } = {}) {
      const obj = objects.get(key);
      if (!obj) return null;
      return thumbnail ? { ...obj, bytes: pngBytes } : obj;
    },
    async remove(key) {
      return objects.delete(key);
    },
  };

  accountSrv = createAccountApp({
    pool,
    internalServiceToken: secret,
    throttle: { loginIpMax: 1000 },
  }).listen(0, '127.0.0.1');
  await new Promise((r) => (accountSrv.listening ? r() : accountSrv.once('listening', r)));
  const accountUrl = `http://127.0.0.1:${accountSrv.address().port}`;

  appSrv = createApp({
    pool,
    accountServiceUrl: accountUrl,
    internalServiceToken: secret,
    evidenceStore,
  }).listen(0, '127.0.0.1');
  await new Promise((r) => (appSrv.listening ? r() : appSrv.once('listening', r)));
  const apiBase = `http://127.0.0.1:${appSrv.address().port}`;
  const v2Base = `${apiBase}/v2/`;
  log('disposable DB + two-service real API ready', { db: db.name, apiBase });

  async function api(method, path, { token, body, headers = {} } = {}) {
    const reqHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: reqHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }

  async function must(method, path, opts) {
    const res = await api(method, path, opts);
    assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} failed (${res.status}): ${JSON.stringify(res.data)}`);
    return res;
  }

  async function createActor(role, idx) {
    const phone = `091${String(idx).padStart(2, '0')}${String(Math.floor(Math.random() * 90000) + 10000)}`;
    const reg = await must('POST', '/api/auth/register', {
      body: { phone, password, name: `${role.toUpperCase()} ${idx}` },
    });
    if (role !== 'farmer') {
      await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1, $2) ON CONFLICT DO NOTHING', [reg.data.user.id, role]);
    }
    const login = await must('POST', '/api/auth/login', { body: { phone, password } });
    return { phone, password, token: login.data.token, user: login.data.user };
  }

  const farmer = await createActor('farmer', 1);
  const coop = await createActor('coop', 2);
  const provider = await createActor('provider', 3);
  const operator = await createActor('operator', 4);
  const admin1 = await createActor('admin', 5);
  const admin2 = await createActor('admin', 6);

  const svcs = await must('GET', '/api/services?limit=100', { token: farmer.token });
  const svc = svcs.data.items.find((s) => s.code === 'harvest-combine') || svcs.data.items[0];
  assert.ok(svc, 'seeded service missing');

  const f1 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng D7 Một', locality: 'Thới Bình', areaM2: 15000 } })).data.field;
  const f2 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng D7 Hai', locality: 'Thới Bình', areaM2: 12000 } })).data.field;

  const t0 = Date.now() + 80 * 86400000;
  const slot = (hOff, durH) => ({
    startAt: new Date(t0 + hOff * 3600000).toISOString(),
    endAt: new Date(t0 + (hOff + durH) * 3600000).toISOString(),
  });

  // Booking 1: for F-07/F-08, O-01 gating/start, and F-13/F-14/F-16 farmer-escalated dispute
  const bk1 = (await must('POST', '/api/bookings', {
    token: farmer.token,
    headers: { 'Idempotency-Key': 'd7-role-bk1-00001' },
    body: { fieldId: f1.id, serviceId: svc.id, ...slot(0, 12) },
  })).data.booking;
  await must('POST', `/api/bookings/${bk1.id}/coordinator`, {
    token: farmer.token,
    body: { coordinatorId: coop.user.id },
  });

  // Booking 2: for HTX-level dispute in A-03 admin escalation + mediator assignment + private evidence
  const bk2 = (await must('POST', '/api/bookings', {
    token: farmer.token,
    headers: { 'Idempotency-Key': 'd7-role-bk2-00001' },
    body: { fieldId: f2.id, serviceId: svc.id, ...slot(24, 12) },
  })).data.booking;
  await must('POST', `/api/bookings/${bk2.id}/coordinator`, {
    token: farmer.token,
    body: { coordinatorId: coop.user.id },
  });

  // Package & Operator job/offer/claim for bk1
  const pkg1 = (await must('POST', '/api/packages', { token: coop.token, body: { bookingIds: [bk1.id] } })).data.package;
  const job = (await must('POST', '/api/jobs', {
    token: provider.token,
    body: { title: 'Tuyển thợ lái gặt D7', locality: 'Thới Bình', capacity: 1, ...slot(0, 48) },
  })).data.job;
  const app = (await must('POST', `/api/jobs/${job.id}/applications`, { token: operator.token, body: {} })).data.application;
  const off = (await must('POST', `/api/applications/${app.id}/offers`, { token: provider.token, body: {} })).data.offer;
  await must('POST', `/api/offers/${off.id}/accept`, { token: operator.token, body: {} });
  const machine = (await must('POST', '/api/machines', { token: provider.token, body: { name: 'Máy gặt D7', type: 'harvester' } })).data.machine;
  await must('POST', `/api/packages/${pkg1.id}/claim`, { token: provider.token, body: { machineId: machine.id, operatorId: operator.user.id } });

  // Package & claim bk2 as well so it is ASSIGNED with provider_id and eligible for disputes
  const pkg2 = (await must('POST', '/api/packages', { token: coop.token, body: { bookingIds: [bk2.id] } })).data.package;
  const machine2 = (await must('POST', '/api/machines', { token: provider.token, body: { name: 'Máy gặt D7 Hai', type: 'harvester' } })).data.machine;
  await must('POST', `/api/packages/${pkg2.id}/claim`, { token: provider.token, body: { machineId: machine2.id, operatorId: operator.user.id } });

  // Open an HTX-level dispute on bk2 and upload private PNG evidence
  const dispHtx = (await must('POST', `/api/bookings/${bk2.id}/disputes`, {
    token: farmer.token,
    body: { reason: 'QUALITY', details: 'Cần kiểm tra lại chất lượng thu hoạch trên thửa Ruộng D7 Hai.' },
  })).data.dispute;
  assert.equal(dispHtx.mediationLevel, 'HTX');

  // Upload raw PNG evidence to dispHtx as farmer
  const evUploadRes = await fetch(`${apiBase}/api/disputes/${dispHtx.id}/evidence`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${farmer.token}`,
      'Content-Type': 'image/png',
    },
    body: pngBytes,
  });
  assert.equal(evUploadRes.status, 201, `evidence upload failed: ${evUploadRes.status}`);

  // Verify H-08 defensive fix at API boundary: unassigned HTX dispute cannot assign admin mediator directly
  const h08Refusal = await api('POST', `/api/disputes/${dispHtx.id}/mediator`, {
    token: admin1.token,
    body: { mediatorId: admin2.user.id },
  });
  assert.equal(h08Refusal.status, 409);
  assert.equal(h08Refusal.data?.error?.code || h08Refusal.data?.code, 'ESCALATION_REQUIRED');
  log('verified H-08 defensive 409 ESCALATION_REQUIRED on HTX dispute');

  browser = await open({ width: 1440, height: 900, mobile: false });

  async function assertLayout(label) {
    const lay = await browser.ev(`(()=>{const w=innerWidth,cw=document.documentElement.clientWidth,sw=document.documentElement.scrollWidth;const wide=[...document.querySelectorAll('main *')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.right>cw+1&&getComputedStyle(e).position!=='fixed'}).slice(0,3).map(e=>e.tagName+'.'+String(e.className).slice(0,40)+':'+Math.round(e.getBoundingClientRect().right));return {w,cw,sw,wide,h1:(document.querySelector('h1')||{}).textContent}})()`);
    assert.equal(lay.sw, lay.cw, `${label}: horizontal overflow sw=${lay.sw} cw=${lay.cw} wide=${JSON.stringify(lay.wide)}`);
    assert.ok(lay.sw <= lay.w, `${label}: sw=${lay.sw} > innerWidth=${lay.w}`);
    assert.equal(lay.wide.length, 0, `${label}: overflowing elements=${JSON.stringify(lay.wide)}`);
    assert.ok(lay.h1 && lay.h1.length > 0, `${label}: missing h1`);
    log('layout OK', label);
  }

  async function loginAs(phone, roleHashPrefix) {
    await browser.send('Network.clearBrowserCookies');
    await browser.go(`${v2Base}?signin=${Date.now()}#/chung/C-01`);
    await browser.waitFor(`location.hash.startsWith('#/chung/C-01') && !!document.querySelector('input[name=phone]')`);
    await browser.fill('input[name=phone]', phone);
    await browser.fill('input[name=password]', password);
    await browser.click('form button[type=submit]');
    await browser.waitFor(`location.hash.startsWith(${JSON.stringify(roleHashPrefix)})`);
  }

  async function logout() {
    await browser.hash('#/chung/C-02');
    await browser.waitFor(`document.body.innerText.includes('Đăng xuất')`);
    await browser.clickText('Đăng xuất', 'button');
    await browser.waitFor(`!!document.querySelector('input[name=phone]')`);
  }

  // =========================================================================
  // PART 1: FARMER F-07 / F-08 (Owner declaration vs HTX field inspection)
  // =========================================================================
  await browser.go(`${v2Base}#/nong-dan/f-07?id=${bk1.id}`);
  await browser.waitFor(`location.hash.startsWith('#/chung/C-01') && !!document.querySelector('input[name=phone]')`);
  await browser.fill('input[name=phone]', farmer.phone);
  await browser.fill('input[name=password]', password);
  await browser.click('form button[type=submit]');
  await browser.waitFor("location.hash.startsWith('#/nong-dan/')");
  const resumed = await browser.ev('location.hash');
  assert.equal(resumed, `#/nong-dan/F-07?id=${bk1.id}`, 'login resumes the requested booking deep link');
  await browser.waitText('Ruộng D7 Một');
  await browser.waitText('Kiểm tra thực địa của HTX');
  await browser.waitText('Chưa kiểm tra');
  await assertLayout('F-07-1440');

  // Go to F-08 readiness & inspection screen
  await browser.hash(`#/nong-dan/F-08?id=${bk1.id}`);
  await browser.waitText('Khai báo sẵn sàng của chủ ruộng');
  await browser.waitText('Kiểm tra thực địa của HTX');
  await browser.waitText('Chưa có lượt kiểm tra nào');

  // Check all 3 declaration boxes and save
  const checkCount = await browser.ev(`(()=>{const boxes=[...document.querySelectorAll('input[type=checkbox]')]; boxes.forEach(b=>{if(!b.checked)b.click();}); return boxes.length;})()`);
  assert.equal(checkCount, 3, 'F-08 should have 3 readiness checkboxes');
  await browser.clickText('Lưu khai báo ruộng sẵn sàng', 'button');
  await browser.waitText('Đã khai báo đủ 3 mục');
  // Inspection is still separate!
  await browser.waitText('Chưa kiểm tra thực địa');
  await assertLayout('F-08-ready-not-inspected-1440');

  // HTX passes inspection via real API
  await must('POST', `/api/bookings/${bk1.id}/inspections`, {
    token: coop.token,
    body: { result: 'PASSED' },
  });

  // Farmer refreshes F-07 and F-08 and sees PASSED inspection
  await browser.hash(`#/nong-dan/F-07?id=${bk1.id}`);
  await browser.waitText('HTX đã kiểm tra đạt');
  await browser.hash(`#/nong-dan/F-08?id=${bk1.id}`);
  await browser.waitText('Đạt kiểm tra');

  // Farmer unchecks one box -> inspection becomes STALE on backend -> UI shows stale!
  await browser.ev(`(()=>{const b=document.querySelector('input[name=drained]'); if(b&&b.checked)b.click();})()`);
  await browser.clickText('Lưu khai báo ruộng sẵn sàng', 'button');
  await browser.waitText('Cần HTX kiểm tra lại');
  log('verified F-08 separates owner declaration vs HTX passed/stale inspection');

  // Re-confirm readiness so ready=true, while inspection remains stale
  await browser.ev(`(()=>{const b=document.querySelector('input[name=drained]'); if(b&&!b.checked)b.click();})()`);
  await browser.clickText('Lưu khai báo ruộng sẵn sàng', 'button');
  await browser.waitText('Cần HTX kiểm tra lại');
  await browser.viewport(390, 844, true);
  await assertLayout('F-08-390');
  await browser.viewport(1440, 900, false);

  await logout();

  // =========================================================================
  // PART 2: OPERATOR O-01 (Gated by both ready & inspected, explains stale, refreshes)
  // =========================================================================
  await loginAs(operator.phone, '#/tho-lai/');
  await browser.hash('#/tho-lai/O-01');
  await browser.waitText('Gói việc chờ bắt đầu ca');
  await browser.waitText('Chờ HTX kiểm tra');
  await browser.waitText('kết quả cũ đã hết hạn');
  // Ensure Bắt đầu ca is NOT clickable/present while inspected=false
  const hasStartWhenStale = await browser.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Bắt đầu ca'))`);
  assert.equal(hasStartWhenStale, false, 'O-01 must gate Bắt đầu ca when inspected is false/stale');
  await assertLayout('O-01-blocked-1440');

  // HTX re-inspects PASSED -> Operator clicks Tải lại trạng thái -> Bắt đầu ca appears!
  await must('POST', `/api/bookings/${bk1.id}/inspections`, {
    token: coop.token,
    body: { result: 'PASSED' },
  });
  await browser.clickText('Tải lại trạng thái', 'button');
  await browser.waitText('Sẵn sàng mở ca');
  await browser.waitText('Bắt đầu ca');

  // Race test: farmer unchecks readiness behind operator's back, operator clicks Bắt đầu ca -> gets refusal + auto-refresh!
  await must('POST', `/api/bookings/${bk1.id}/readiness`, {
    token: farmer.token,
    body: { drained: false, mature: true, intakeReady: true },
  });
  await browser.clickText('Bắt đầu ca', 'button');
  await browser.waitText('Chưa đủ điều kiện', 8000);
  const hasStartAfterRace = await browser.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Bắt đầu ca'))`);
  assert.equal(hasStartAfterRace, false, 'O-01 must refresh to blocked state after 409 refusal');
  log('verified O-01 auto-refreshes after 409 refusal on stale state');

  // Restore readiness + inspection and start shift successfully!
  await must('POST', `/api/bookings/${bk1.id}/readiness`, {
    token: farmer.token,
    body: { drained: true, mature: true, intakeReady: true },
  });
  await must('POST', `/api/bookings/${bk1.id}/inspections`, {
    token: coop.token,
    body: { result: 'PASSED' },
  });
  await browser.clickText('Tải lại trạng thái', 'button');
  await browser.waitText('Bắt đầu ca');
  await browser.clickText('Bắt đầu ca', 'button');
  await browser.waitText('Ca đang làm');
  await browser.viewport(390, 844, true);
  await assertLayout('O-01-active-shift-390');
  await browser.viewport(1440, 900, false);

  // Complete shift via API so we can test farmer dispute on bk1
  const shiftsList = (await must('GET', '/api/shifts', { token: operator.token })).data.shifts;
  const activeShift = shiftsList.find((s) => s.packageId === pkg1.id);
  assert.ok(activeShift, 'shift must exist');
  await must('POST', `/api/shifts/${activeShift.id}/complete`, {
    token: operator.token,
    body: { areaM2: 15000, note: 'Gặt xong thửa Ruộng D7 Một.' },
  });

  await logout();

  // =========================================================================
  // PART 3: FARMER F-13 / F-14 (Mediation level, Escalation, Party Consent)
  // =========================================================================
  const disp1 = (await must('POST', `/api/bookings/${bk1.id}/disputes`, {
    token: farmer.token,
    body: { reason: 'AREA_MISMATCH', details: 'Diện tích thực tế có sai lệch cần kiểm tra lại.' },
  })).data.dispute;

  await loginAs(farmer.phone, '#/nong-dan/');

  // Open F-13 on disp1 (initially HTX level)
  await browser.hash(`#/nong-dan/F-13?id=${disp1.id}`);
  await browser.waitText('Cấp HTX');
  await browser.waitText('Yêu cầu chuyển lên Quản trị độc lập');
  await assertLayout('F-13-htx-1440');

  // Escalate disp1 via Farmer UI form!
  await browser.fill('select[name=conflictType]', 'PARTY_REQUEST');
  await browser.fill('textarea[name=reason]', 'Tôi đề nghị quản trị viên độc lập xem xét khách quan.');
  await browser.clickText('Yêu cầu chuyển lên Quản trị độc lập', 'button');
  await browser.waitText('Cấp Quản trị độc lập');
  // Escalation button should disappear once escalated to ADMIN
  const hasEscBtnAfter = await browser.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Yêu cầu chuyển lên Quản trị độc lập'))`);
  assert.equal(hasEscBtnAfter, false, 'Escalation button must disappear once at ADMIN level');
  log('verified F-13 farmer escalation to ADMIN');

  // Assign admin1 as independent mediator on disp1 and propose remedy v1
  await must('POST', `/api/disputes/${disp1.id}/mediator`, {
    token: admin2.token,
    body: { mediatorId: admin1.user.id },
  });
  await must('POST', `/api/disputes/${disp1.id}/proposals`, {
    token: admin1.token,
    body: { text: 'Phương án v1: Thống nhất diện tích nghiệm thu 14.800 m2.' },
  });

  // Farmer opens F-14, sees proposal v1 + separate party consent rows, and consents!
  await browser.hash(`#/nong-dan/F-14?id=${disp1.id}`);
  await browser.waitText('Phương án v1: Thống nhất diện tích nghiệm thu 14.800 m2.');
  await browser.waitText('Đồng ý phương án phiên bản 1');
  await browser.clickText('Đồng ý phương án phiên bản 1', 'button');
  await browser.waitText('Xác nhận đồng ý phương án phiên bản 1');
  await browser.clickText('Đồng ý phương án', '.modal button');
  await browser.waitText('Đã đồng ý lúc');
  await browser.viewport(390, 844, true);
  await assertLayout('F-14-consent-390');
  await browser.viewport(1440, 900, false);
  log('verified F-14 separate party consent on exact version');

  await logout();

  // =========================================================================
  // PART 4: ADMIN A-03 (HTX vs ADMIN queue, trace, documented escalation, private evidence)
  // =========================================================================
  await loginAs(admin1.phone, '#/quan-tri/');
  await browser.hash('#/quan-tri/A-03');
  await browser.waitText('Trọng tài tranh chấp');
  await browser.waitText('Cấp HTX (chờ chuyển cấp)');
  await browser.waitText('Cấp Quản trị (sẵn sàng gán)');
  await assertLayout('A-03-queue-1440');

  // Filter queue to Cấp HTX -> select dispHtx
  await browser.clickText('Cấp HTX (1)', 'button');
  await browser.waitText('Chất lượng công việc');
  await browser.waitText('Cấp HTX');

  // Select dispHtx explicitly via hash
  await browser.hash(`#/quan-tri/A-03?cap=htx&id=${dispHtx.id}`);
  await browser.waitText('Hồ sơ cấp hòa giải và chuyển cấp');
  // Private evidence lock notice MUST be shown to unassigned admin1
  await browser.waitText('Ảnh bằng chứng chỉ mở cho hai bên của đơn và quản trị viên được gán làm người hòa giải.');
  // Documented escalation card MUST appear instead of direct mediator assignment
  await browser.waitText('Lập biên bản chuyển cấp lên Quản trị');
  const hasDirectAssignOnHtx = await browser.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Gán người hòa giải'))`);
  assert.equal(hasDirectAssignOnHtx, false, 'A-03 must require documented escalation before mediator assignment on HTX dispute');

  // Submit documented escalation in UI
  await browser.fill('select[name=conflictType]', 'ROLE_OVERLAP');
  await browser.fill('textarea[name=reason]', 'Phát hiện HTX có thành viên kiêm nhiệm vai trò chủ máy trong đơn này.');
  await browser.clickText('Lập biên bản chuyển cấp lên Quản trị', 'button');

  // After escalation, dispute moves to Cấp Quản trị, trace shows reason/conflictType, and assignMediatorCard appears!
  await browser.waitText('Cấp Quản trị độc lập');
  await browser.waitText('HTX kiêm nhiệm chủ máy hoặc thợ lái');
  await browser.waitText('Phát hiện HTX có thành viên kiêm nhiệm vai trò chủ máy trong đơn này.');
  await browser.waitText('Gán người hòa giải độc lập');
  await assertLayout('A-03-escalated-detail-1440');
  log('verified A-03 documented escalation and trace');

  // Assign admin2 as independent mediator via UI
  await browser.fill('select[name=mediatorId]', admin2.user.id);
  await browser.clickText('Gán người hòa giải', 'button');
  await browser.waitText('Người hòa giải');
  await logout();

  // Login as assigned mediator admin2 -> verify private evidence is accessible & mediation works
  await loginAs(admin2.phone, '#/quan-tri/');
  await browser.hash(`#/quan-tri/A-03?hang=hoa-giai&id=${dispHtx.id}`);
  await browser.waitText('Bạn (đã gán)');
  await browser.waitText('Ảnh 1');
  await browser.clickText('Xem ảnh gốc', 'button');
  await browser.waitFor(`!!document.querySelector('img[alt*="Ảnh bằng chứng"]')`);
  await browser.ev(`document.querySelector('.modal button[aria-label="Đóng"]')?.click()`);
  await browser.viewport(390, 844, true);
  await assertLayout('A-03-mediator-390');
  log('verified A-03 assigned independent mediator sees private evidence');

  await browser.shot(`${SHOTS}/d7-role-ui-a03-mediator-390.png`);

  assert.deepEqual(browser.errors, [], `Uncaught runtime errors: ${JSON.stringify(browser.errors)}`);
  const unexpectedConsole = browser.consoleErrors.filter(
    (msg) => !(msg.includes('409 (Conflict)') && msg.includes(`/api/packages/${pkg1.id}/shifts/start`)),
  );
  assert.deepEqual(unexpectedConsole, [], `Console errors: ${JSON.stringify(unexpectedConsole)}`);
  log('ALL D7 ROLE UI E2E CHECKS PASSED CLEANLY');
} finally {
  if (browser) await browser.close();
  if (appSrv) await new Promise((r) => { appSrv.close(r); appSrv.closeAllConnections(); });
  if (accountSrv) await new Promise((r) => { accountSrv.close(r); accountSrv.closeAllConnections(); });
  await pool.end();
  await db.drop();
}
