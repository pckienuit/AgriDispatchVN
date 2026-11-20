// Browser check for edge flows on /v2/: C-02 coop role request and admin approval, F-03 area validation,
// F-06 quote disclaimer and booking submit, F-11 owner consent, F-12 uncertain payment report and retry.
// Disposable PostgreSQL (TEST_DATABASE_URL, loopback *_test) + two real services + headless Chromium at 390 and 1440 px.
// Accounts, requests and predecessor events go over real HTTP. Roles other than coop/farmer are granted by SQL like the other v2 tests.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const log = (...args) => console.log('[farmer-edge-roles]', ...args);
const SHOTS = process.env.FARMER_EDGE_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-farmer-edge-shots-')));
await mkdir(SHOTS, { recursive: true });

const PASSWORD = 'TestPass!12345';
const HOUR = 3600000;
const DAY = 86400000;
const AREA_M2 = 12960;
const ROLE_COOP_DESC = 'Nhận ủy quyền, gom đơn thành gói, theo dõi hiện trường.';
const UNCERTAIN_NOTE = 'Lần ghi báo trước chưa rõ kết quả';

// Test-only hook, installed before any page script. The first POST to /api/bookings/:id/payments reaches the real
// server and commits; the client then sees a network failure, the same shape as a response lost after commit.
const DROP_FIRST_PAYMENT_RESPONSE = `(() => {
  const realFetch = window.fetch.bind(window);
  let injected = false;
  window.fetch = async (input, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (!injected && method === 'POST' && /^\\/api\\/bookings\\/[0-9a-f-]{36}\\/payments$/.test(path)) {
      injected = true;
      await realFetch(input, init);
      throw new TypeError('test-only: response lost after server commit');
    }
    return realFetch(input, init);
  };
})();`;

const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const pageErrors = [];
const consoleErrors = [];
const checks = [];
let browser;
let origin;

const fmtNum = (n, d = 0) => new Intl.NumberFormat('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const newPhone = () => `09${randomInt(10000000, 100000000)}`;
const tagOf = () => randomBytes(4).toString('hex');

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const reqHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';
  if (token) reqHeaders.Authorization = `Bearer ${token}`;
  const res = await fetch(`${origin}${path}`, { method, headers: reqHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function ok(method, path, opts) {
  const res = await api(method, path, opts);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    log('PASS', name);
  } catch (error) {
    const detail = 'actual' in error ? `${JSON.stringify(error.actual)} !== ${JSON.stringify(error.expected)}` : String(error.message).split('\n')[0];
    checks.push({ name, ok: false, error: detail.slice(0, 300) });
    log('FAIL', name, '::', detail.slice(0, 300));
  }
}

async function makeActor(name, role) {
  const phone = newPhone();
  const reg = await ok('POST', '/api/auth/register', { body: { phone, password: PASSWORD, name } });
  const id = reg.user.id;
  if (role) await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  const login = await ok('POST', '/api/auth/login', { body: { phone, password: PASSWORD } });
  return { id, phone, token: login.token };
}

async function signInUi(phone) {
  await browser.go(`${origin}/v2/`);
  await browser.waitFor(`location.hash.startsWith('#/chung/C-01')`);
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', phone);
  await browser.fill('input[name=password]', PASSWORD);
  await browser.click('form button[type=submit]');
  await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-01')`);
}

const mainText = () => browser.ev(`document.querySelector('#main')?.innerText || ''`);
const badgeTexts = () => browser.ev(`[...document.querySelectorAll('#main .badge')].map((b) => b.textContent.trim())`);
const roleRadioValues = () => browser.ev(`[...document.querySelectorAll('input[name=role]')].map((i) => i.value)`);
const formMsg = () => browser.ev(`(() => { const m = document.querySelector('#main form .msg--error'); return m && !m.hidden ? m.textContent.trim() : null; })()`);
const submitFormOf = (selector) => browser.ev(`document.querySelector(${JSON.stringify(selector)}).form.requestSubmit()`);
const assertLayout = async (label) => {
  const layout = await browser.layout();
  assert.ok(layout.sw <= layout.w && layout.wide.length === 0, `${label}: ${JSON.stringify(layout)}`);
};
const dbCount = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

// Predecessor chain over real HTTP: booking -> HTX grouping -> provider claim -> readiness -> PASSED inspection
// -> shift complete -> provider acceptance proposal. Owner and provider consents are not made here.
async function buildChain({ farmer, coop, provider, operator, fieldId, tag }) {
  const T0 = Date.now() + 80 * DAY;
  const slot = (h, d) => ({ startAt: new Date(T0 + h * HOUR).toISOString(), endAt: new Date(T0 + (h + d) * HOUR).toISOString() });
  const { items: services } = await ok('GET', '/api/services?limit=100', { token: farmer.token });
  const svc = services.find((s) => s.code === 'harvest-combine');
  assert.ok(svc, 'seeded harvest-combine service missing');
  const { booking } = await ok('POST', '/api/bookings', { token: farmer.token, headers: { 'Idempotency-Key': `edge-chain-${randomBytes(12).toString('hex')}` }, body: { fieldId, serviceId: svc.id, ...slot(0, 12) } });
  await ok('POST', `/api/bookings/${booking.id}/coordinator`, { token: farmer.token, body: { coordinatorId: coop.id } });
  const { package: pkg } = await ok('POST', '/api/packages', { token: coop.token, body: { bookingIds: [booking.id] } });
  const { job } = await ok('POST', '/api/jobs', { token: provider.token, body: { title: `Tuyển thợ lái ${tag}`, locality: 'Thới Bình', capacity: 1, ...slot(0, 48) } });
  const { application } = await ok('POST', `/api/jobs/${job.id}/applications`, { token: operator.token, body: {} });
  const { offer } = await ok('POST', `/api/applications/${application.id}/offers`, { token: provider.token, body: {} });
  await ok('POST', `/api/offers/${offer.id}/accept`, { token: operator.token, body: {} });
  const { machine } = await ok('POST', '/api/machines', { token: provider.token, body: { name: `Máy gặt ${tag}`, type: 'harvester' } });
  await ok('POST', `/api/packages/${pkg.id}/claim`, { token: provider.token, body: { machineId: machine.id, operatorId: operator.id } });
  await ok('POST', `/api/bookings/${booking.id}/readiness`, { token: farmer.token, body: { drained: true, mature: true, intakeReady: true } });
  await ok('POST', `/api/bookings/${booking.id}/inspections`, { token: coop.token, body: { result: 'PASSED' } });
  const { shift } = await ok('POST', `/api/packages/${pkg.id}/shifts/start`, { token: operator.token, body: {} });
  await ok('POST', `/api/shifts/${shift.id}/complete`, { token: operator.token, body: { areaM2: AREA_M2 } });
  await ok('POST', `/api/bookings/${booking.id}/acceptance`, { token: provider.token, body: { areaM2: AREA_M2, totalVnd: booking.totalVnd } });
  return { booking, pkg, shift };
}

async function runAt(width) {
  const w = `[${width}px]`;
  const tag = tagOf();
  const coop = await makeActor(`HTX ${tag}`, null);
  const admin = await makeActor(`Quản trị ${tag}`, 'admin');
  const farmer = await makeActor(`Nông dân ${tag}`, null);
  const provider = await makeActor(`Chủ máy ${tag}`, 'provider');
  const operator = await makeActor(`Thợ lái ${tag}`, 'operator');
  browser = await open({ width, height: width < 760 ? 844 : 900, mobile: width < 760 });

  // ---- C-02: coop role request -> PENDING -> admin approves over API -> refresh -> role active.
  await signInUi(coop.phone);
  await browser.hash('#/chung/C-02');
  await browser.waitText('Xin thêm vai trò');
  await check(`${w} C-02 before request: coop offered, no pending badge`, async () => {
    assert.ok((await roleRadioValues()).includes('coop'), 'coop radio missing');
    assert.ok(!(await badgeTexts()).includes('Chờ duyệt'));
  });
  await browser.click('input[name=role][value=coop]');
  await browser.clickText('Gửi yêu cầu', 'button');
  await browser.waitText('Chờ duyệt');
  await check(`${w} C-02 submit coop request -> PENDING badge, one PENDING row, coop not offered again`, async () => {
    const { rows } = await pool.query("SELECT status FROM account.role_requests WHERE user_id=$1 AND requested_role='coop'", [coop.id]);
    assert.deepEqual(rows.map((r) => r.status), ['PENDING']);
    assert.ok((await badgeTexts()).includes('Chờ duyệt'), 'PENDING badge missing');
    assert.ok(!(await roleRadioValues()).includes('coop'), 'pending role still offered');
  });
  await browser.shot(join(SHOTS, `${width}-c02-pending.png`));
  await assertLayout(`${w} C-02 pending`);

  let roleRequest;
  await check(`${w} admin approves coop request via API`, async () => {
    const { items } = await ok('GET', '/api/role-requests?limit=20&offset=0', { token: coop.token });
    roleRequest = items.find((r) => r.role === 'coop' && r.status === 'PENDING');
    assert.ok(roleRequest, 'pending coop request not listed for requester');
    const decided = await ok('POST', `/api/admin/role-requests/${roleRequest.id}/approve`, { token: admin.token, body: {} });
    assert.equal(decided.request.status, 'APPROVED');
  });

  // Hash must change to re-render C-02; C-03 is a distinct route the coop can open.
  await browser.hash('#/chung/C-03');
  await browser.waitText('Hoạt động gần đây');
  await browser.hash('#/chung/C-02');
  await browser.waitText('Lịch sử yêu cầu vai trò');
  await check(`${w} C-02 refresh after approval: coop role listed, Đã duyệt, no PENDING badge`, async () => {
    const text = await mainText();
    assert.ok(text.includes(ROLE_COOP_DESC), 'coop role not in Vai trò đang có');
    assert.ok((await badgeTexts()).includes('Đã duyệt'), 'Đã duyệt badge missing');
    assert.ok(!(await badgeTexts()).includes('Chờ duyệt'), 'stale PENDING badge');
    assert.ok(!(await roleRadioValues()).includes('coop'), 'approved role still offered');
    const me = await ok('GET', '/api/me', { token: coop.token });
    assert.ok(me.user.roles.includes('coop'), `roles ${JSON.stringify(me.user.roles)}`);
  });
  await browser.shot(join(SHOTS, `${width}-c02-approved.png`));
  await assertLayout(`${w} C-02 approved`);

  await check(`${w} coop role active: #/htx/H-01 opens without access denial`, async () => {
    await browser.hash('#/htx/H-01');
    await browser.waitFor(`location.hash.startsWith('#/htx/H-01')`);
    await browser.sleep(800);
    const text = await mainText();
    assert.ok(!text.includes('Tài khoản chưa có quyền'), 'coop screen still denied');
    assert.ok(!text.includes('Không tìm thấy'), 'coop screen not found');
  });

  // ---- F-03: invalid area is blocked inline; valid m2 shows ha/công preview and saves.
  await signInUi(farmer.phone);
  await browser.hash('#/nong-dan/F-03');
  await browser.waitText('Lưu thửa ruộng');
  const fieldName = `Thửa Edge ${tag}`;
  await browser.fill('input[name=name]', fieldName);
  await browser.fill('input[name=locality]', `Xã Edge ${tag}`);
  for (const bad of ['0', '12a']) {
    await check(`${w} F-03 area "${bad}": preview prompt, inline error, no field row`, async () => {
      await browser.fill('input[name=areaM2]', bad);
      assert.ok((await mainText()).includes('Nhập số nguyên dương từ 1 đến 10.000.000 m².'), 'invalid-area preview missing');
      await submitFormOf('input[name=areaM2]');
      await browser.waitFor(`(() => { const m = document.querySelector('#main form .msg--error'); return !!m && !m.hidden; })()`);
      assert.equal(await formMsg(), 'Nhập diện tích bằng số nguyên m², từ 1 đến 10.000.000.');
      assert.equal(await browser.ev(`location.hash.startsWith('#/nong-dan/F-03')`), true, 'left F-03 on invalid input');
      assert.equal(await dbCount('SELECT count(*)::int AS n FROM dispatch.fields WHERE owner_id=$1', [farmer.id]), 0, 'field row created for invalid area');
    });
  }
  await browser.shot(join(SHOTS, `${width}-f03-invalid.png`));
  await assertLayout(`${w} F-03 invalid`);

  await check(`${w} F-03 valid 12960 m2 -> ha/công preview with 1.296 m² and 1.000 m² bases`, async () => {
    await browser.fill('input[name=areaM2]', String(AREA_M2));
    const expected = `Quy đổi: ${fmtNum(1.296, 2)} ha · ${fmtNum(10, 1)} công (tầm cắt 1.296 m²) · ${fmtNum(12.96, 1)} công (tầm cấy 1.000 m²).`;
    assert.ok((await mainText()).includes(expected), `preview text missing: ${expected}`);
  });
  await browser.shot(join(SHOTS, `${width}-f03-valid.png`));
  await assertLayout(`${w} F-03 valid preview`);
  await submitFormOf('input[name=areaM2]');
  await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-02')`);
  await browser.waitText(fieldName);
  const fieldRows = (await pool.query('SELECT id, area_m2 FROM dispatch.fields WHERE owner_id=$1', [farmer.id])).rows;
  assert.equal(fieldRows.length, 1, 'expected one field after valid save');
  assert.equal(Number(fieldRows[0].area_m2), AREA_M2);
  const field = fieldRows[0];

  // ---- F-05 -> F-06: disclaimer shown, quote submit creates one booking.
  const { items: services } = await ok('GET', '/api/services?limit=100', { token: farmer.token });
  const harvest = services.find((s) => s.code === 'harvest-combine');
  assert.ok(harvest, 'harvest-combine missing');
  await browser.hash(`#/nong-dan/F-05?field=${field.id}&service=${harvest.id}`);
  await browser.waitFor('!!document.querySelector("input[name=startLocal]")');
  await browser.clickText('Xem bảng giá và xác nhận', 'button');
  await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-06')`);
  await browser.waitText('Tổng tạm tính');
  await check(`${w} F-06 shows 'Chưa gồm phụ phí hoặc đặt cọc' under total`, async () => {
    assert.ok((await mainText()).includes('Chưa gồm phụ phí hoặc đặt cọc'), 'disclaimer missing');
  });
  await browser.shot(join(SHOTS, `${width}-f06.png`));
  await assertLayout(`${w} F-06`);
  await browser.clickText('Xác nhận gửi yêu cầu', 'button');
  await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-07?id=')`);
  await check(`${w} F-06 submit -> one booking row for the field, F-07 opens it`, async () => {
    assert.equal(await dbCount('SELECT count(*)::int AS n FROM dispatch.bookings WHERE owner_id=$1 AND field_id=$2', [farmer.id, field.id]), 1);
    const id = await browser.ev('new URLSearchParams(location.hash.split("?")[1]).get("id")');
    assert.equal(await dbCount('SELECT count(*)::int AS n FROM dispatch.bookings WHERE id=$1 AND owner_id=$2', [id, farmer.id]), 1);
  });

  // ---- F-11 and F-12 need an agreed-ready chain. The chain is built over HTTP; the screens under test are UI.
  const fieldChain = await ok('POST', '/api/fields', { token: farmer.token, body: { name: `Ruộng chuỗi ${tag}`, locality: 'Thoại Sơn', areaM2: AREA_M2 } });
  const chain = await buildChain({ farmer, coop, provider, operator, fieldId: fieldChain.field.id, tag });
  const bid = chain.booking.id;
  const total = chain.booking.totalVnd;
  const refCode = `EDGE-${tag}`;

  // Test-only injection installed before the page loads: first payment POST is committed, then the response is lost.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: DROP_FIRST_PAYMENT_RESPONSE });
  await signInUi(farmer.phone);

  await browser.hash(`#/nong-dan/F-11?id=${bid}`);
  await browser.waitText('Đồng ý nghiệm thu phiên bản 1');
  await check(`${w} F-11 before consent: owner button shown, no dispute block, no dispute row`, async () => {
    const text = await mainText();
    assert.match(text, /Chủ ruộng\s+Chưa đồng ý/, 'owner pending label missing');
    assert.ok(!text.includes('Đơn đang có khiếu nại'), 'dispute banner shown without dispute');
    assert.equal(await dbCount('SELECT count(*)::int AS n FROM dispatch.disputes WHERE booking_id=$1', [bid]), 0);
  });
  await browser.shot(join(SHOTS, `${width}-f11-before.png`));
  await assertLayout(`${w} F-11 before`);

  await browser.clickText('Đồng ý nghiệm thu phiên bản 1', 'button');
  await browser.waitFor(`!document.body.innerText.includes('Đồng ý nghiệm thu phiên bản 1')`);
  await check(`${w} F-11 owner consent: DB row for owner v1 and page shows Đã đồng ý`, async () => {
    assert.equal(await dbCount("SELECT count(*)::int AS n FROM dispatch.acceptance_consents WHERE booking_id=$1 AND version=1 AND party='owner'", [bid]), 1);
    assert.match(await mainText(), /Chủ ruộng\s+Đã đồng ý/, 'owner consent not shown');
    assert.ok(!(await mainText()).includes('Hai bên đã đồng ý'), 'agreed before provider consent');
  });

  await ok('POST', `/api/bookings/${bid}/acceptance/1/consent`, { token: provider.token, body: {} });
  await browser.hash('#/nong-dan/F-07?id=' + bid);
  await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-07')`);
  await browser.hash(`#/nong-dan/F-11?id=${bid}`);
  await browser.waitText('Hai bên đã đồng ý');
  await check(`${w} F-11 after provider consent: agreed state, F-12 link`, async () => {
    assert.ok((await mainText()).includes('Đi tới quyết toán (F-12)'), 'F-12 link missing');
  });

  // ---- F-12: real POST commits, client sees a lost response -> read-only pending inputs and retry.
  await browser.hash(`#/nong-dan/F-12?id=${bid}`);
  await browser.waitText('Ghi báo đã chuyển tiền ngoài hệ thống');
  await browser.waitFor(`document.querySelector('input[name=amountVnd]')?.value === ${JSON.stringify(total)}`);
  await check(`${w} F-12 before report: amount prefilled to total, inputs editable`, async () => {
    const st = await browser.ev(`(() => { const a = document.querySelector('input[name=amountVnd]'); const r = document.querySelector('input[name=reference]'); return { a: a.readOnly, r: r.readOnly, rv: r.value }; })()`);
    assert.deepEqual(st, { a: false, r: false, rv: '' });
  });
  await browser.fill('input[name=reference]', refCode);
  await browser.shot(join(SHOTS, `${width}-f12-filled.png`));
  await submitFormOf('input[name=reference]');
  await browser.waitFor(`document.querySelector('input[name=amountVnd]')?.readOnly === true`);
  await browser.waitText(UNCERTAIN_NOTE);
  await check(`${w} F-12 lost response: server stored 1 payment, client keeps pending inputs read-only`, async () => {
    const rows = (await pool.query('SELECT id, amount_vnd, reference FROM dispatch.payments WHERE booking_id=$1', [bid])).rows;
    assert.equal(rows.length, 1, `stored payments ${rows.length}`);
    assert.equal(String(rows[0].amount_vnd), total);
    assert.equal(rows[0].reference, refCode);
    const st = await browser.ev(`(() => ({ a: document.querySelector('input[name=amountVnd]').readOnly, r: document.querySelector('input[name=reference]').readOnly }))()`);
    assert.deepEqual(st, { a: true, r: true });
  });
  await check(`${w} F-12 lost response: uncertain note and retry label shown`, async () => {
    const text = await mainText();
    assert.ok(text.includes(UNCERTAIN_NOTE), 'uncertain note missing');
    assert.ok(await browser.ev(`[...document.querySelectorAll('#main form button[type=submit]')].some((b) => b.textContent.trim() === 'Gửi lại đúng ghi báo trước')`), 'retry label missing');
  });
  await browser.shot(join(SHOTS, `${width}-f12-uncertain.png`));
  await assertLayout(`${w} F-12 uncertain`);

  await browser.ev(`document.querySelector('input[name=reference]').form.querySelector('button[type=submit]').click()`);
  // Wait for the post-success re-render to drop the uncertain note. A "Chờ xác nhận" row alone is already on screen from the lost-response render.
  await browser.waitFor(`!(document.querySelector('#main')?.innerText || '').includes(${JSON.stringify(UNCERTAIN_NOTE)})`);
  await check(`${w} F-12 retry: same payment reused, still 1 stored row, outstanding unchanged`, async () => {
    const rows = (await pool.query('SELECT id, amount_vnd, reference FROM dispatch.payments WHERE booking_id=$1', [bid])).rows;
    assert.equal(rows.length, 1, `stored payments after retry ${rows.length}`);
    assert.equal(rows[0].reference, refCode);
    const { summary } = await ok('GET', `/api/bookings/${bid}/payments`, { token: farmer.token });
    assert.equal(summary.reportedVnd, total);
    assert.equal(summary.availableToReportVnd, '0');
  });
  await check(`${w} F-12 retry: uncertain note cleared, one history row`, async () => {
    if ((await mainText()).includes(UNCERTAIN_NOTE)) { const t = await mainText(); const i = t.indexOf(UNCERTAIN_NOTE); throw new Error(`uncertain note still shown at ${i}/${t.length}: ${t.slice(Math.max(0, i - 200), i + 200).replace(/\n/g, ' | ')} ## LIST=${JSON.stringify(await browser.ev(`[...document.querySelectorAll('#main ul.list > li')].map((li) => li.textContent.trim().slice(0, 120))`))}`); }
    const items = await browser.ev(`[...document.querySelectorAll('#main ul.list > li')].length`);
    assert.equal(items, 1);
  });
  await browser.shot(join(SHOTS, `${width}-f12-after-retry.png`));
  await assertLayout(`${w} F-12 after retry`);

  pageErrors.push(...browser.errors);
  consoleErrors.push(...browser.consoleErrors);
  await browser.close();
  browser = null;
}

try {
  await migrate(pool);
  await seedCatalog(pool);
  const secret = randomBytes(32).toString('base64url');
  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret }));
  log('disposable DB + two-service API ready', { db: db.name });

  await runAt(1440);
  await runAt(390);

  await check('no uncaught page errors and no console errors at 1440 or 390', async () => {
    assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
  });
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      await Promise.all(servers.map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
      await pool.end();
    } finally {
      await db.drop();
    }
  }
}

const failed = checks.filter((c) => !c.ok);
log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const f of failed) log('FAILED', f.name, '::', f.error);
  process.exitCode = 1;
} else {
  log('PASS farmer edge roles: C-02, F-03, F-06, F-11, F-12', { shots: SHOTS });
}
