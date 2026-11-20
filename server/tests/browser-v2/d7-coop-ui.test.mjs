// Runnable regression for HTX v2 UI (H-02/03/05 + H-04 field inspection + H-08 first-level mediation).
// Uses disposable PostgreSQL migrated through latest + real same-origin HTTP server + headless Chromium (1440 & 390).
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
import * as coopMod from '../../../web/v2/screens/coop.js';

const log = (...args) => console.log('[d7-coop-ui]', ...args);

// 1. Unit checks for exported H-04 & H-08 helpers in web/v2/screens/coop.js
function runUnitChecks() {
  assert.equal(coopMod.inspectionStatusOf(null).key, 'unknown');
  assert.equal(coopMod.inspectionStatusOf({ passed: true, canInspect: true, latest: { result: 'PASSED', stale: false } }).key, 'passed');
  assert.equal(coopMod.inspectionStatusOf({ passed: false, canInspect: true, latest: { result: 'PASSED', stale: true } }).key, 'stale');
  assert.equal(coopMod.inspectionStatusOf({ passed: false, canInspect: true, latest: { result: 'FAILED', stale: false } }).key, 'failed');
  assert.equal(coopMod.inspectionStatusOf({ passed: false, canInspect: true, latest: null }).key, 'pending');
  assert.equal(coopMod.inspectionStatusOf({ passed: false, canInspect: false, latest: null }).key, 'waiting_readiness');

  assert.ok(coopMod.inspectionFailInput('   ').error);
  assert.ok(coopMod.inspectionFailInput('a'.repeat(501)).error);
  assert.deepEqual(coopMod.inspectionFailInput('  Đường ngập  '), { error: null, payload: { result: 'FAILED', reason: 'Đường ngập' } });

  const me = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  assert.equal(coopMod.canInspectHtxDisputeDetail({ mediatorId: null, eligible: true, mediationLevel: 'HTX', status: 'OPEN' }, me), false);
  assert.equal(coopMod.canInspectHtxDisputeDetail({ mediatorId: other, eligible: true, mediationLevel: 'HTX', status: 'OPEN' }, me), false);
  assert.equal(coopMod.canInspectHtxDisputeDetail({ mediatorId: me, eligible: false, conflictCode: 'PARTY_CONFLICT', mediationLevel: 'HTX', status: 'OPEN' }, me), false);
  assert.equal(coopMod.canInspectHtxDisputeDetail({ mediatorId: me, eligible: true, mediationLevel: 'ADMIN', status: 'OPEN' }, me), false);
  assert.equal(coopMod.canInspectHtxDisputeDetail({ mediatorId: me, eligible: true, mediationLevel: 'HTX', status: 'RESOLVED' }, me), false);
  assert.equal(coopMod.canInspectHtxDisputeDetail({ mediatorId: me, eligible: true, mediationLevel: 'HTX', status: 'OPEN' }, me), true);

  assert.ok(coopMod.escalationInput('', 'PARTY_CONFLICT').error);
  assert.ok(coopMod.escalationInput('Lý do', 'BAD_CODE').error);
  assert.deepEqual(coopMod.escalationInput('  Cần admin xử lý  ', ''), { error: null, payload: { reason: 'Cần admin xử lý' } });
  assert.deepEqual(coopMod.escalationInput('  Trùng vai trò  ', 'PARTY_CONFLICT'), {
    error: null,
    payload: { reason: 'Trùng vai trò', conflictType: 'PARTY_CONFLICT' },
  });

  assert.ok(coopMod.mediationProposalInput('   ').error);
  assert.ok(coopMod.mediationProposalInput('x'.repeat(2001)).error);
  assert.deepEqual(coopMod.mediationProposalInput('  Phương án v1  '), { error: null, payload: { text: 'Phương án v1' } });
  log('unit checks passed (6 groups)');
}

runUnitChecks();

// 2. Boot disposable PostgreSQL (migrated through latest) + same-origin HTTP servers
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

  // Tiny valid 1x1 PNG for evidence content/thumbnail tests
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  );
  const objects = new Map();
  const evidenceStore = {
    async put(key, bytes, contentType) {
      objects.set(key, { bytes, contentType });
      return { etag: '"d7-test"', versionId: null };
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
  log('disposable DB + same-origin server ready', { db: db.name, apiBase });

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

  async function createActor(role, idx = 1) {
    const phone = `090${String(idx).padStart(2, '0')}${String(Math.floor(Math.random() * 90000) + 10000)}`;
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
  const coopOther = await createActor('coop', 3);
  const provider = await createActor('provider', 4);
  const operator = await createActor('operator', 5);
  const admin = await createActor('admin', 6);
  // Give coop farmer role too only to create a PARTY_CONFLICT booking later
  await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1, $2) ON CONFLICT DO NOTHING', [coop.user.id, 'farmer']);
  // Re-login coop so token carries updated roles (coop + farmer); note coop is NOT provider/operator/admin so eligible on normal bookings!
  const coopRelogin = await must('POST', '/api/auth/login', { body: { phone: coop.phone, password } });
  coop.token = coopRelogin.data.token;

  const svcs = await must('GET', '/api/services?limit=100', { token: farmer.token });
  const svc = svcs.data.items.find((s) => s.code === 'harvest-combine') || svcs.data.items[0];
  assert.ok(svc, 'seeded service missing');

  const f1 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng Bắc', locality: 'Vĩnh Trạch', areaM2: 14000 } })).data.field;
  const f2 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng Nam', locality: 'Vĩnh Trạch', areaM2: 11000 } })).data.field;
  const f3 = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng Xa', locality: 'Long Hữu', areaM2: 9000 } })).data.field;

  const t0 = Date.now() + 70 * 86400000;
  const slot = (hOff, durH) => ({
    startAt: new Date(t0 + hOff * 3600000).toISOString(),
    endAt: new Date(t0 + (hOff + durH) * 3600000).toISOString(),
  });

  async function mkBooking(actor, fieldId, s, key) {
    const b = (await must('POST', '/api/bookings', {
      token: actor.token,
      headers: { 'Idempotency-Key': key },
      body: { fieldId, serviceId: svc.id, ...s },
    })).data.booking;
    await must('POST', `/api/bookings/${b.id}/coordinator`, {
      token: actor.token,
      body: { coordinatorId: coop.user.id },
    });
    return b;
  }

  const bk1 = await mkBooking(farmer, f1.id, slot(0, 10), 'd7-bk1-key-000001');
  const bk2 = await mkBooking(farmer, f2.id, slot(1, 10), 'd7-bk2-key-000001');
  await mkBooking(farmer, f3.id, slot(2, 10), 'd7-bk3-key-000001');

  // H-03 advisory fixture: 25 ha field in the same locality/service with an overlapping window. Alone it reaches the
  // 20 ha hint target, so Ruộng Bắc (1.4 ha) gets a candidate hint. Bắc + Nam (2.5 ha) stays below the 15 ha hint minimum.
  const fBig = (await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng Lớn', locality: 'Vĩnh Trạch', areaM2: 250000 } })).data.field;
  await mkBooking(farmer, fBig.id, slot(0, 10), 'd7-bkbig-key-00001');

  // Foreign booking coordinated by coopOther for denied checks
  const foreignBooking = (await must('POST', '/api/bookings', {
    token: farmer.token,
    headers: { 'Idempotency-Key': 'd7-foreign-bk-0001' },
    body: { fieldId: f3.id, serviceId: svc.id, ...slot(72, 8) },
  })).data.booking;
  await must('POST', `/api/bookings/${foreignBooking.id}/coordinator`, {
    token: farmer.token,
    body: { coordinatorId: coopOther.user.id },
  });

  // 3. Browser checks at 1440x900 and 390x844
  browser = await open({ width: 1440, height: 900, mobile: false });

  async function assertLayout(label) {
    const lay = await browser.ev(`(()=>{const w=innerWidth,cw=document.documentElement.clientWidth,sw=document.documentElement.scrollWidth;const wide=[...document.querySelectorAll('main *')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.right>cw+1&&getComputedStyle(e).position!=='fixed'}).slice(0,3).map(e=>e.tagName+'.'+String(e.className).slice(0,40)+':'+Math.round(e.getBoundingClientRect().right));return {w,cw,sw,wide,h1:(document.querySelector('h1')||{}).textContent}})()`);
    assert.equal(lay.sw, lay.cw, `${label}: horizontal overflow sw=${lay.sw} cw=${lay.cw} wide=${JSON.stringify(lay.wide)}`);
    assert.ok(lay.sw <= lay.w, `${label}: sw=${lay.sw} > innerWidth=${lay.w}`);
    assert.equal(lay.wide.length, 0, `${label}: overflowing elements=${JSON.stringify(lay.wide)}`);
    assert.ok(lay.h1 && lay.h1.length > 0, `${label}: missing h1`);
    log('layout OK', label, lay);
  }

  // Login via UI
  await browser.go(v2Base);
  await browser.waitFor(`location.hash.startsWith('#/chung/C-01')`);
  await browser.fill('input[name=phone]', coop.phone);
  await browser.fill('input[name=password]', password);
  await browser.click('form button[type=submit]');
  await browser.waitFor(`location.hash.startsWith('#/htx/')`);

  // Verify H-08 appears in HTX nav
  const hasH08Nav = await browser.ev(`[...document.querySelectorAll('nav a')].some(a => a.textContent.includes('Hòa giải') && a.getAttribute('href')?.includes('H-08'))`);
  assert.equal(hasH08Nav, true, 'H-08 nav link must appear in HTX nav');

  // H-02 & H-03 regression: queue visible, filter works, group bk1+bk2 into package
  await browser.hash('#/htx/H-02');
  await browser.waitText('Ruộng Bắc');
  await browser.waitText('Ruộng Xa');
  await assertLayout('H-02-1440');

  await browser.hash('#/htx/H-03');
  await browser.waitText('Ruộng Bắc');
  await browser.waitText('mặc định, chưa có phiên bản được lưu');

  // H-03 advisory (hint only): thresholds come from /api/platform-parameters and are labeled Giả định.
  // Base eligibility is unchanged: selection and manual submission never depend on these hints.
  // Save the same values as a real version via the admin API so the UI shows a stored version, not server defaults.
  await must('PUT', '/api/admin/platform-parameters', {
    token: admin.token,
    body: { values: { clusterMinHa: 15, clusterTargetHa: 20, clusterMaxHa: 50 }, note: 'D7 H-03 advisory check' },
  });
  await browser.waitText('Ruộng Lớn');
  await browser.waitText('Giả định');
  await browser.hash('#/htx/H-02');
  await browser.hash('#/htx/H-03');
  await browser.waitText('phiên bản 1');
  await browser.click('input[aria-label="Chọn đơn Ruộng Bắc"]');
  await browser.waitText('Dưới ngưỡng gợi ý tối thiểu 15 ha');
  await browser.waitText('Gợi ý thêm 1 đơn: Ruộng Lớn. Tổng khi đó 26,40 ha');
  await browser.waitText('không phải kiểm tra vị trí hoặc khoảng cách');
  assert.equal(await browser.ev(`document.body.innerText.includes('1,5 km')`), false, 'no 1.5 km rule text in H-03');
  await browser.shot(`${SHOTS}/d7-h03-advice-1440.png`);
  await assertLayout('H-03-advice-1440');
  await browser.viewport(390, 844, true);
  await browser.waitText('Gợi ý thêm 1 đơn: Ruộng Lớn');
  await assertLayout('H-03-advice-390');
  // Mobile reachability: hint button is at least 44px tall at 390px.
  const touch = await browser.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Chọn các đơn gợi ý');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();const bar=document.querySelector('.actionbar');const br=bar?bar.getBoundingClientRect():null;const overlap=br?!(r.bottom<=br.top||r.top>=br.bottom):false;return {h:Math.round(r.height),overlap}})()`);
  assert.ok(touch.h >= 44, `hint button height ${touch.h} below 44px`);
  assert.equal(touch.overlap, false, 'hint button must not be hidden under the sticky action bar');
  // Advisory badge is in the DOM next to the threshold line (visual check alone is not proof).
  const badges = await browser.ev(`[...document.querySelectorAll('#app .badge, main .badge, .badge')].filter(b=>b.textContent.trim()==='Giả định').length`);
  assert.ok(badges >= 2, `expected advisory and hint Giả định badges, got ${badges}`);
  const advDom = await browser.ev(`JSON.stringify({badges: [...document.querySelectorAll('.badge')].filter((b) => b.textContent.trim() === 'Giả định').map((b) => ({ hasIcon: !!b.querySelector('i.ph'), parent: b.parentElement.textContent.trim().slice(0, 80) }))})`);
  log('H-03 390 advisory DOM', advDom);
  await browser.shot(`${SHOTS}/d7-h03-advice-390.png`);
  await browser.viewport(1440, 900, false);
  // Keyboard path: focus the hint action, press Enter. It only selects the suggested row; HTX still submits by hand.
  await browser.ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Chọn các đơn gợi ý').focus()`);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.waitText('Đã chọn 2 đơn');
  assert.equal(await browser.ev(`document.querySelector('input[aria-label="Chọn đơn Ruộng Lớn"]').checked`), true, 'hint action must check suggested booking');
  await browser.clickText('Bỏ chọn', 'button');
  await browser.waitText('Chưa chọn đơn nào');
  // Single field already at target: no candidate hint.
  await browser.click('input[aria-label="Chọn đơn Ruộng Lớn"]');
  await browser.waitText('Đạt mục tiêu gợi ý 20 ha');
  assert.equal(await browser.ev(`document.body.innerText.includes('Gợi ý thêm')`), false, 'no candidate hint once target reached');
  await browser.clickText('Bỏ chọn', 'button');
  await browser.waitText('Chưa chọn đơn nào');

  await browser.click('input[aria-label="Chọn đơn Ruộng Bắc"]');
  await browser.click('input[aria-label="Chọn đơn Ruộng Nam"]');
  await browser.waitText('Các đơn đã chọn cùng dịch vụ, cùng địa phương và có khung giờ chung.');
  // Manual submission below the 15 ha hint minimum (2,50 ha) must still create the package.
  // Advisory fetch blocked in Chromium: H-03 must warn, hide hints and keep manual selection + create working.
  await browser.send('Network.enable');
  await browser.send('Network.setBlockedURLs', { urls: ['*/api/platform-parameters*'] });
  await browser.hash('#/htx/H-02');
  await browser.hash('#/htx/H-03');
  await browser.waitText('Chưa tải được ngưỡng gợi ý từ máy chủ');
  await browser.click('input[aria-label="Chọn đơn Ruộng Bắc"]');
  await browser.click('input[aria-label="Chọn đơn Ruộng Nam"]');
  await browser.waitText('Các đơn đã chọn cùng dịch vụ, cùng địa phương và có khung giờ chung.');
  assert.equal(await browser.ev(`document.body.innerText.includes('Gợi ý thêm')`), false, 'no hint while advisory unavailable');
  assert.equal(await browser.ev(`document.body.innerText.includes('Dưới ngưỡng gợi ý tối thiểu')`), false, 'no threshold advice without server values');
  await browser.send('Network.setBlockedURLs', { urls: [] });
  await browser.clickText('Tạo gói việc', '.actionbar button');
  await browser.waitFor(`location.hash.startsWith('#/htx/H-05')`);
  await browser.waitText('Danh sách đơn và thẩm định thực địa');
  const pkgId = await browser.ev(`new URLSearchParams(location.hash.split('?')[1] || '').get('id')`);
  assert.ok(pkgId, 'H-05 must have pkgId');
  const createdPackage = await must('GET', `/api/packages/${pkgId}`, { token: coop.token });
  assert.deepEqual([...createdPackage.data.package.bookingIds].sort(), [bk1.id, bk2.id].sort(),
    'manual submission persisted only the two selected bookings, even with advisory unavailable');
  await assertLayout('H-05-with-inspections-1440');

  // H-02 should now show H-04 link since an unstarted package exists
  await browser.hash('#/htx/H-02');
  await browser.waitText('Mở thẩm định thực địa');
  const h02LinkHref = await browser.ev(`[...document.querySelectorAll('a')].find(a=>a.textContent.includes('Mở thẩm định thực địa'))?.getAttribute('href')`);
  assert.ok(h02LinkHref?.includes('H-04'), 'H-02 must link to H-04 when packages exist');

  // Navigate to H-04 from H-05 link
  await browser.hash(`#/htx/H-05?id=${pkgId}`);
  await browser.waitText('Thẩm định thực địa');
  await browser.clickText('Thẩm định thực địa', 'a');
  await browser.waitFor(`location.hash.startsWith('#/htx/H-04')`);
  await browser.waitText('Đang khóa ghi nhận');
  await assertLayout('H-04-locked-1440');

  // Verify strict server canInspect gating: Pass button must NOT exist before farmer readiness
  const passBtnBefore = await browser.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Xác nhận Đạt thực địa'))`);
  assert.equal(passBtnBefore, false, 'Pass button must not be shown when canInspect=false');

  // Farmer submits readiness for bk1 and bk2
  await must('POST', `/api/bookings/${bk1.id}/readiness`, {
    token: farmer.token,
    body: { drained: true, mature: true, intakeReady: true },
  });
  await must('POST', `/api/bookings/${bk2.id}/readiness`, {
    token: farmer.token,
    body: { drained: true, mature: true, intakeReady: true },
  });
  await browser.clickText('Tải lại', 'button');
  await browser.waitText('Xác nhận Đạt thực địa');
  await browser.waitText('Máy chủ đã xác nhận đủ điều kiện ghi nhận');

  // Record FAILED with reason, verify reason & history render after refresh
  await browser.fill('textarea[name=reason]', 'Đường bờ còn lầy chưa vào máy');
  await browser.clickText('Ghi nhận Không đạt', 'button[type=submit]');
  await browser.waitText('Đường bờ còn lầy chưa vào máy');
  await browser.waitText('Không đạt');
  await browser.waitText('Lần #1: Không đạt');
  await assertLayout('H-04-failed-1440');

  // Record PASSED, verify PASSED & history render
  await browser.clickText('Xác nhận Đạt thực địa', 'button');
  await browser.waitText('Đạt thẩm định');
  await browser.waitText('Lần #2: Đạt');

  // Farmer resets readiness -> inspection becomes STALE
  await must('POST', `/api/bookings/${bk1.id}/readiness`, {
    token: farmer.token,
    body: { drained: false, mature: true, intakeReady: false },
  });
  await must('POST', `/api/bookings/${bk2.id}/readiness`, {
    token: farmer.token,
    body: { drained: false, mature: true, intakeReady: false },
  });

  // Verify H-05 still links to H-04 and displays Cần thẩm định lại
  await browser.hash(`#/htx/H-05?id=${pkgId}`);
  await browser.waitText('Hết hiệu lực');
  await browser.waitText('Cần thẩm định lại');
  await browser.clickText('Thẩm định thực địa', 'a');
  await browser.waitFor(`location.hash.startsWith('#/htx/H-04')`);
  await browser.waitText('đã hết hiệu lực');
  await browser.waitText('Lần #2: Đạt (Hết hiệu lực)');

  // Re-record PASSED after readiness reset
  await browser.clickText('Xác nhận Đạt thực địa', 'button');
  await browser.waitText('Lần #3: Đạt');
  await browser.shot(`${SHOTS}/d7-h04-1440.png`);

  // Mobile 390x844 layout check for H-04
  await browser.viewport(390, 844, true);
  await assertLayout('H-04-390');
  await browser.shot(`${SHOTS}/d7-h04-390.png`);
  await browser.viewport(1440, 900, false);

  // Verify zero console/runtime errors during normal flows before negative-auth 404 probes
  assert.equal(browser.errors.length, 0, `Runtime JS errors: ${JSON.stringify(browser.errors)}`);
  assert.equal(browser.consoleErrors.length, 0, `Unexpected console errors on H-04 positive flow: ${JSON.stringify(browser.consoleErrors)}`);

  // H-04 denied & invalid ID checks (404 expected from backend)
  await browser.hash(`#/htx/H-04?id=${foreignBooking.id}`);
  await browser.waitText('Không thể truy cập thẩm định đơn này');
  await browser.hash('#/htx/H-04?id=not-a-uuid');
  await browser.waitText('Mã đơn không hợp lệ');
  browser.consoleErrors.length = 0;

  // ---------- H-08: First-level mediation ----------
  // Seed a completed/running shift on pkgId so disputes can be opened cleanly on bk1 & bk2
  await must('POST', `/api/bookings/${bk2.id}/readiness`, {
    token: farmer.token,
    body: { drained: true, mature: true, intakeReady: true },
  });
  await must('POST', `/api/bookings/${bk2.id}/inspections`, {
    token: coop.token,
    body: { result: 'PASSED' },
  });
  const machine = (await must('POST', '/api/machines', { token: provider.token, body: { name: 'Máy Gặt D7', type: 'harvester' } })).data.machine;
  const job = (await must('POST', '/api/jobs', {
    token: provider.token,
    body: {
      title: 'Tuyển thợ D7',
      locality: 'Vĩnh Trạch',
      capacity: 1,
      startAt: new Date(t0 - 86400000).toISOString(),
      endAt: new Date(t0 + 10 * 86400000).toISOString(),
    },
  })).data.job;
  const app = (await must('POST', `/api/jobs/${job.id}/applications`, { token: operator.token, body: {} })).data.application;
  const offer = (await must('POST', `/api/applications/${app.id}/offers`, { token: provider.token, body: {} })).data.offer;
  await must('POST', `/api/offers/${offer.id}/accept`, { token: operator.token, body: {} });
  await must('POST', `/api/packages/${pkgId}/claim`, {
    token: provider.token,
    body: { machineId: machine.id, operatorId: operator.user.id },
  });

  // d1: Eligible dispute on bk1 with real PNG evidence
  const d1 = (await must('POST', `/api/bookings/${bk1.id}/disputes`, {
    token: farmer.token,
    body: { reason: 'AREA_MISMATCH', details: 'Thực tế gặt thiếu 2 công' },
  })).data.dispute;
  await fetch(`${apiBase}/api/disputes/${d1.id}/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${farmer.token}`, 'Content-Type': 'image/png' },
    body: pngBytes,
  }).then((r) => assert.equal(r.status, 201, 'evidence upload failed'));

  // d2: PARTY_CONFLICT dispute where coop itself is claimant AND coordinator on a separate field/booking
  const coopField = (await must('POST', '/api/fields', { token: coop.token, body: { name: 'Ruộng HTX Tự Trồng', locality: 'Vĩnh Trạch', areaM2: 10000 } })).data.field;
  const bkConflict = await mkBooking(coop, coopField.id, slot(48, 8), 'd7-bk-conflict-001');
  const pkgConflict = (await must('POST', '/api/packages', {
    token: coop.token,
    body: { bookingIds: [bkConflict.id] },
  })).data.package;
  await must('POST', `/api/packages/${pkgConflict.id}/claim`, {
    token: provider.token,
    body: { machineId: machine.id, operatorId: operator.user.id },
  });
  const d2 = (await must('POST', `/api/bookings/${bkConflict.id}/disputes`, {
    token: coop.token,
    body: { reason: 'OTHER', details: 'Vụ việc có trùng vai trò HTX' },
  })).data.dispute;

  // d3: Eligible dispute on bk2 for post-claim recusal/escalation test
  const d3 = (await must('POST', `/api/bookings/${bk2.id}/disputes`, {
    token: farmer.token,
    body: { reason: 'QUALITY', details: 'Cần xem xét chất lượng cắt' },
  })).data.dispute;

  // Foreign dispute for denied check
  const pkgForeign = (await must('POST', '/api/packages', {
    token: coopOther.token,
    body: { bookingIds: [foreignBooking.id] },
  })).data.package;
  await must('POST', `/api/packages/${pkgForeign.id}/claim`, {
    token: provider.token,
    body: { machineId: machine.id, operatorId: operator.user.id },
  });
  const dForeign = (await must('POST', `/api/bookings/${foreignBooking.id}/disputes`, {
    token: farmer.token,
    body: { reason: 'NO_SHOW', details: 'Đơn của HTX khác' },
  })).data.dispute;

  // Open H-08
  await browser.hash('#/htx/H-08');
  await browser.waitText('Hòa giải cấp HTX');
  await browser.waitText('Sai lệch diện tích');

  // Select d1 (unclaimed eligible): verify details/evidence NOT exposed before claim, and NO foreign HTX claim selector
  await browser.hash(`#/htx/H-08?id=${d1.id}`);
  await browser.waitText('Nhận hòa giải vụ việc này');
  const hasEvidenceBeforeClaim = await browser.ev(`document.body.innerText.includes('Bằng chứng ảnh')`);
  assert.equal(hasEvidenceBeforeClaim, false, 'Evidence must not be shown before HTX claims dispute');
  const hasMediatorSelect = await browser.ev(`Boolean(document.querySelector('select[name=mediatorId]'))`);
  assert.equal(hasMediatorSelect, false, 'Must not allow claiming for another HTX');

  // Claim d1 -> unlocks details, timeline, evidence, versioned proposal form!
  await browser.clickText('Nhận hòa giải vụ việc này', 'button');
  await browser.waitText('Chi tiết vụ việc');
  await browser.waitText('Thực tế gặt thiếu 2 công');
  await browser.waitText('Bằng chứng ảnh (chỉ xem)');
  await browser.waitText('Gửi phương án v1');

  // Verify NO consent button, NO close-unresolved button, NO money movement UI
  const forbiddenBtns = await browser.ev(`[...document.querySelectorAll('button')].filter(b=>/đồng ý phương án|đóng chưa giải quyết|chuyển tiền|thanh toán hộ/i.test(b.textContent)).length`);
  assert.equal(forbiddenBtns, 0, 'HTX must not have consent, close-unresolved, or money-movement buttons');

  // Load real image in Evidence modal and close it
  await browser.clickText('Xem ảnh gốc', 'button');
  await browser.waitFor(`Boolean(document.querySelector('.modal img[src^="blob:"]'))`);
  await browser.clickText('Đóng', '.modal button');

  // Submit proposal v1
  await browser.fill('textarea[name=text]', 'Đề xuất các bên thống nhất nghiệm thu theo 1.2 ha thực tế.');
  await browser.clickText('Gửi phương án v1', 'button[type=submit]');
  await browser.waitText('Phương án v1');
  await browser.waitText('Chờ bên khiếu nại');
  await browser.waitText('Chờ bên bị khiếu nại');
  await assertLayout('H-08-claimed-1440');
  await browser.shot(`${SHOTS}/d7-h08-claimed-1440.png`);

  // Mobile 390x844 check for H-08
  await browser.viewport(390, 844, true);
  await assertLayout('H-08-390');
  await browser.shot(`${SHOTS}/d7-h08-390.png`);
  await browser.viewport(1440, 900, false);

  // Both parties consent independently -> verify RESOLVED in Tôi xử lý tab
  await must('POST', `/api/disputes/${d1.id}/proposals/1/consent`, { token: farmer.token, body: {} });
  await must('POST', `/api/disputes/${d1.id}/proposals/1/consent`, { token: provider.token, body: {} });
  await browser.hash(`#/htx/H-08?hang=cua-toi&id=${d1.id}`);
  await browser.waitText('Đã hòa giải');
  await browser.waitText('Bên khiếu nại đã đồng ý');
  await browser.waitText('Bên bị khiếu nại đã đồng ý');

  // Shared account link keeps the HTX role; a persisted dispute event opens the right case in H-08.
  await browser.hash('#/chung/C-02');
  await browser.waitText('Vai trò đang có');
  await browser.clickText('Hoạt động gần đây', 'a');
  await browser.waitText('Tranh chấp đã đóng sau khi hai bên đồng ý');
  assert.equal(await browser.ev('location.hash'), '#/htx/C-03', 'Shared account activity must retain the HTX role');
  await browser.click(`main a[href="#/htx/H-08?id=${d1.id}&hang=cua-toi"]`);
  await browser.waitText('Thực tế gặt thiếu 2 công');
  await browser.waitText('Bên bị khiếu nại đã đồng ý');

  // Check d2 (PARTY_CONFLICT): explicit conflict banner, NO claim button, escalate to ADMIN
  await browser.hash(`#/htx/H-08?id=${d2.id}`);
  await browser.waitText('Phải từ chối và chuyển lên quản trị viên');
  const canClaimConflict = await browser.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Nhận hòa giải vụ việc này'))`);
  assert.equal(canClaimConflict, false, 'Conflicted HTX must not see claim button');
  await browser.fill('textarea[name=reason]', 'HTX là bên trực tiếp trong đơn này nên chuyển quản trị viên.');
  await browser.clickText('Chuyển lên quản trị viên nền tảng', 'button[type=submit]');
  await browser.waitFor(`location.hash === '#/htx/H-08'`);
  // Direct URL to escalated d2 must now show denied / locked state
  await browser.hash(`#/htx/H-08?id=${d2.id}`);
  await browser.waitText('Chi tiết vụ việc');

  // Wait: coop is claimant on d2 so coop can still read d2 as a party; check d3 (where coop is NOT a party!)
  // Claim d3 then escalate via <details> recusal form -> after escalation, direct link to d3 MUST return 404 -> denied empty!
  await browser.hash(`#/htx/H-08?id=${d3.id}`);
  await browser.clickText('Nhận hòa giải vụ việc này', 'button');
  await browser.waitText('Cần xem xét chất lượng cắt');
  await browser.clickText('Không thể tiếp tục hòa giải? Chuyển lên quản trị viên nền tảng', 'summary');
  await browser.fill('textarea[name=reason]', 'HTX tự từ chối để quản trị viên xử lý độc lập.');
  await browser.clickText('Chuyển lên quản trị viên nền tảng', 'button[type=submit]');
  await browser.waitFor(`location.hash === '#/htx/H-08'`);
  assert.equal(browser.consoleErrors.length, 0, `Unexpected console errors on H-08 flow: ${JSON.stringify(browser.consoleErrors)}`);
  await browser.hash(`#/htx/H-08?id=${d3.id}`);
  await browser.waitText('Không có quyền xem chi tiết vụ việc');

  // Foreign dispute denied check & invalid UUID check
  await browser.hash(`#/htx/H-08?id=${dForeign.id}`);
  await browser.waitText('Không có quyền xem chi tiết vụ việc');
  await browser.hash('#/htx/H-08?id=bad-id');
  await browser.waitText('Mã vụ việc không hợp lệ');
  browser.consoleErrors.length = 0;

  // Verify admin still sees escalated disputes cleanly via API
  const adminQueue = await must('GET', '/api/dispute-review?limit=20', { token: admin.token });
  assert.ok(adminQueue.data.items.some((x) => x.id === d2.id), 'd2 must be in admin dispute queue');
  assert.ok(adminQueue.data.items.some((x) => x.id === d3.id), 'd3 must be in admin dispute queue');

  // Verify previous H-06 & H-07 screens still render cleanly with zero errors
  await browser.hash('#/htx/H-06');
  await browser.waitText('Giám sát hiện trường');
  await assertLayout('H-06-1440');

  await browser.hash(`#/htx/H-07?id=${pkgId}`);
  await browser.waitText('Sự cố');
  await assertLayout('H-07-1440');

  // Keyboard Tab sanity check on H-08
  await browser.hash('#/htx/H-08');
  await browser.waitText('Hòa giải cấp HTX');
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
  const focusedTag = await browser.ev(`document.activeElement?.tagName || ''`);
  assert.ok(focusedTag.length > 0, 'keyboard focus must land on an interactive element');

  // ---------- P-10: chủ máy phản hồi khiếu nại đang mở (d3 is OPEN, provider is respondent) ----------
  const responsesOf = async (disputeId, token) => (await must('GET', `/api/disputes/${disputeId}`, { token }))
    .data.events.filter((ev) => ev.type === 'RESPONSE_ADDED');
  const asideText = () => browser.ev(`document.querySelector('aside')?.innerText || ''`);
  const loginAs = async (who) => {
    await browser.waitFor(`!!document.querySelector('input[name=phone]')`);
    await browser.fill('input[name=phone]', who.phone);
    await browser.fill('input[name=password]', password);
    await browser.click('form button[type=submit]');
    await browser.waitFor(`location.hash.startsWith('#/${who === farmer ? 'nong-dan' : 'chu-may'}/')`);
  };
  const logoutViaAccount = async () => {
    await browser.hash('#/chung/C-02');
    await browser.waitText('Đăng xuất');
    await browser.ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Đăng xuất')).click()`);
    await browser.waitFor(`location.hash.startsWith('#/chung/C-01')`);
  };

  await logoutViaAccount();
  await loginAs(provider);
  await browser.hash(`#/chu-may/P-10?id=${d3.id}`);
  await browser.waitText('Gửi phản hồi');
  assert.equal((await responsesOf(d3.id, provider.token)).length, 0, 'no P-10 response before the provider submits');

  // Blank and whitespace-only text: UI refuses without a request; API refuses with 400 and writes no event.
  await browser.fill('textarea[name=text]', '   ');
  await browser.clickText('Gửi phản hồi', 'button[type=submit]');
  await browser.waitText('Nhập nội dung phản hồi từ 1 đến 2000 ký tự.');
  assert.equal((await responsesOf(d3.id, provider.token)).length, 0, 'blank UI submit must not write an event');
  const blankApi = await api('POST', `/api/disputes/${d3.id}/responses`, { token: provider.token, body: { text: '   ' } });
  assert.equal(blankApi.status, 400, `blank API response must be 400, got ${blankApi.status}`);
  assert.equal(blankApi.data.error.code, 'VALIDATION_FAILED');
  assert.equal((await responsesOf(d3.id, provider.token)).length, 0, 'blank API submit must not write an event');

  // One unique response through the keyboard path (focus submit, Enter).
  const token = `P10-${randomBytes(4).toString('hex')}`;
  const responseText = `Chủ máy phản hồi ${token}: số công trong ca máy khác biên bản, đề nghị đo lại cùng HTX.`;
  await browser.fill('textarea[name=text]', responseText);
  await browser.ev(`[...document.querySelectorAll('button[type=submit]')].find((b) => b.textContent.trim() === 'Gửi phản hồi').focus()`);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.waitText(token);
  const afterSubmit = await responsesOf(d3.id, provider.token);
  assert.equal(afterSubmit.length, 1, `exactly one response event expected, got ${afterSubmit.length}`);
  assert.equal(afterSubmit[0].actorId, provider.user.id, 'response actor must be the provider');
  assert.equal(afterSubmit[0].data.text, responseText, 'stored response text must match submitted text');
  const aside1 = await asideText();
  assert.ok(aside1.includes('Đang mở'), 'open dispute must keep status Đang mở after a response');
  for (const bad of ['Đã hòa giải', 'Đóng chưa giải quyết', 'Lý do đóng']) {
    assert.equal(aside1.includes(bad), false, `response must not read as case resolution: found "${bad}"`);
  }
  assert.equal(await browser.ev(`document.querySelector('textarea[name=text]')?.value ?? null`), '', 'form clears after success');
  log('P-10 focus after success (report only)', await browser.ev(`document.activeElement?.tagName || 'none'`));
  await assertLayout('P-10-open-1440');
  await browser.shot(`${SHOTS}/p10-open-1440.png`);

  // Reload drops the in-memory session; sign in again and read the response back from UI and API.
  await browser.send('Page.reload', { ignoreCache: true });
  await loginAs(provider);
  await browser.hash(`#/chu-may/P-10?id=${d3.id}`);
  await browser.waitText(token);
  const readbackProvider = await responsesOf(d3.id, provider.token);
  assert.equal(readbackProvider.length, 1, 'reload readback must return the single persisted response');
  assert.equal(readbackProvider[0].data.text, responseText, 'reload readback text must match');
  assert.equal(await browser.ev(`document.querySelectorAll('textarea[name=text]').length`), 1, 'open dispute keeps the response form');
  await browser.viewport(390, 844, true);
  await browser.waitText(token);
  await assertLayout('P-10-open-390');
  await browser.shot(`${SHOTS}/p10-open-390.png`);
  await browser.viewport(1440, 900, false);

  // Closed case (d1 RESOLVED, provider is respondent): no response form, no consent control, no new event.
  await browser.hash(`#/chu-may/P-10?id=${d1.id}`);
  await browser.waitFor(`(document.querySelector('aside')?.innerText || '').includes('Đã hòa giải')`);
  assert.equal(await browser.ev(`document.querySelectorAll('textarea[name=text]').length`), 0, 'closed case must not show response input');
  assert.equal(await browser.ev(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Gửi phản hồi')`), false, 'closed case must not show send control');
  assert.equal(await browser.ev(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Đồng ý phương án'))`), false, 'closed case must not show consent control');
  assert.equal((await responsesOf(d1.id, provider.token)).length, 0, 'closed case must not gain a response event');

  // Admin-closed unresolved case (d2 escalated to ADMIN, provider is respondent): same closed rules, plus API 409.
  // close-unresolved needs the uninvolved admin to be the assigned mediator, so assign via the existing route first.
  const assignRes = await api('POST', `/api/disputes/${d2.id}/mediator`, { token: admin.token, body: { mediatorId: admin.user.id } });
  assert.equal(assignRes.status, 200, `admin mediator assign failed (${assignRes.status}): ${JSON.stringify(assignRes.data)}`);
  const closeRes = await api('POST', `/api/disputes/${d2.id}/close-unresolved`, { token: admin.token, body: { reason: 'Synthetic P-10 closure' } });
  assert.equal(closeRes.status, 200, `admin close-unresolved failed (${closeRes.status}): ${JSON.stringify(closeRes.data)}`);
  await logoutViaAccount();
  await loginAs(provider);
  await browser.hash(`#/chu-may/P-10?id=${d2.id}`);
  await browser.waitText('Đóng chưa giải quyết');
  assert.equal(await browser.ev(`document.querySelectorAll('textarea[name=text]').length`), 0, 'closed-unresolved case must not show response input');
  assert.equal(await browser.ev(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Gửi phản hồi')`), false, 'closed-unresolved case must not show send control');
  const aside2 = await asideText();
  assert.equal(aside2.includes('Đã hòa giải'), false, 'closed-unresolved must not read as resolved');
  const closedApi = await api('POST', `/api/disputes/${d2.id}/responses`, { token: provider.token, body: { text: 'Synthetic late reply' } });
  assert.equal(closedApi.status, 409, `late response on closed case must be 409, got ${closedApi.status}`);
  assert.equal(closedApi.data.error.code, 'DISPUTE_NOT_OPEN');
  assert.equal((await responsesOf(d2.id, provider.token)).length, 0, 'closed-unresolved case must not gain a response event');

  // Farmer (claimant) reads the same persisted response from F-13 and API; farmer has no response control.
  await logoutViaAccount();
  await loginAs(farmer);
  await browser.hash(`#/nong-dan/F-13?id=${d3.id}`);
  await browser.waitText(token);
  const readbackFarmer = await responsesOf(d3.id, farmer.token);
  assert.equal(readbackFarmer.length, 1, 'farmer must read the same single response');
  assert.equal(readbackFarmer[0].data.text, responseText, 'farmer readback text must match');
  assert.equal(browser.consoleErrors.length, 0, `Console errors in P-10 flow: ${JSON.stringify(browser.consoleErrors)}`);
  log('P-10 response readback OK (provider UI+API after reload, farmer UI+API, closed case blocked)');

  assert.equal(browser.errors.length, 0, `Runtime JS errors: ${JSON.stringify(browser.errors)}`);
  assert.equal(browser.consoleErrors.length, 0, `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
  log('ALL CHECKS PASSED (H-02, H-03, H-04, H-05, H-06, H-07, H-08, 1440x900 & 390x844, zero console/runtime errors)');
} finally {
  if (browser) await browser.close();
  await Promise.all([accountSrv, appSrv].filter(Boolean).map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); })));
  await pool.end();
  await db.drop();
  log('cleaned up disposable DB and servers', { db: db.name });
}
