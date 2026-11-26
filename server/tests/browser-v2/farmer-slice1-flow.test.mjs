// Browser check for the farmer slice 1 flow (DEV-13): create a field, see the quote, place one order, read both back
// after a full page reload, and keep what the farmer typed when the network, permission or data check fails.
// Disposable PostgreSQL (TEST_DATABASE_URL, loopback *_test) + two real services + headless Chromium at 390 and 1440 px.
// Faults are injected in the page (fetch wrapper installed before load); everything else goes through the real API.
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

const log = (...args) => console.log('[farmer-slice1-flow]', ...args);
const SHOTS = process.env.FARMER_SLICE1_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-farmer-slice1-shots-')));
await mkdir(SHOTS, { recursive: true });

const PASSWORD = 'TestPass!12345';
const AREA_M2 = 12960;
const DAY = 86400000;
const fmtNum = (n) => new Intl.NumberFormat('vi-VN').format(n);

const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const pageErrors = [];
const checks = [];
let browser;
let origin;

// Test-only: the first matching request fails the way the fault says. 'lost' commits on the server, then drops the response.
const FAULTS = `(() => {
  const realFetch = window.fetch.bind(window);
  window.__faults = [];
  window.__posts = [];
  window.fetch = async (input, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (method === 'POST') window.__posts.push(path);
    const i = window.__faults.findIndex((f) => f.method === method && f.path === path);
    if (i >= 0) {
      const [f] = window.__faults.splice(i, 1);
      if (f.kind === 'network') throw new TypeError('test-only: network down');
      if (f.kind === 'lost') { await realFetch(input, init); throw new TypeError('test-only: response lost after server commit'); }
      return new Response(JSON.stringify({ error: { code: f.code } }), { status: f.status, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
})();`;

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
  const res = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function makeFarmer(name) {
  const phone = `09${randomInt(10000000, 100000000)}`;
  const reg = await api('POST', '/api/auth/register', { body: { phone, password: PASSWORD, name } });
  const login = await api('POST', '/api/auth/login', { body: { phone, password: PASSWORD } });
  return { id: reg.user.id, phone, token: login.token };
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
const fault = (f) => browser.ev(`window.__faults.push(${JSON.stringify(f)})`);
const posts = (path) => browser.ev(`window.__posts.filter((p) => p === ${JSON.stringify(path)}).length`);
const formError = () => browser.ev(`(() => { const m = document.querySelector('#main .msg--error:not([hidden])'); return m ? m.textContent.trim() : null; })()`);
const inputValue = (name) => browser.ev(`document.querySelector('input[name=${name}]')?.value`);
// Narrow screens put the message below the fold; bring it into view so the screenshot shows it.
const showText = (text) => browser.ev(`(() => { const el = [...document.querySelectorAll('#main *')].filter((e) => e.children.length === 0 && e.textContent.includes(${JSON.stringify(text)})).pop(); el?.scrollIntoView({ block: 'center' }); })()`);
const hashNow = () => browser.ev('location.hash');
const bookingCount = async (ownerId) => (await pool.query('SELECT count(*)::int AS n FROM dispatch.bookings WHERE owner_id=$1', [ownerId])).rows[0].n;
const fieldCount = async (ownerId) => (await pool.query('SELECT count(*)::int AS n FROM dispatch.fields WHERE owner_id=$1', [ownerId])).rows[0].n;
const assertLayout = async (label) => {
  const layout = await browser.layout();
  assert.ok(layout.sw <= layout.w && layout.wide.length === 0, `${label}: ${JSON.stringify(layout)}`);
};

async function runAt(width) {
  const w = `[${width}px]`;
  const tag = randomBytes(4).toString('hex');
  const fieldName = `Thửa Bờ Đông ${tag}`;
  const locality = `Xã Vĩnh Lợi ${tag}`;
  const farmer = await makeFarmer(`Nông dân ${tag}`);
  const other = await makeFarmer(`Nông dân khác ${tag}`);
  const { items: services } = await api('GET', '/api/services?limit=100', { token: farmer.token });
  const harvest = services.find((s) => s.code === 'harvest-combine');
  assert.ok(harvest, 'seeded harvest-combine service missing');

  browser = await open({ width, height: width < 760 ? 844 : 900, mobile: width < 760 });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: FAULTS });
  await signInUi(farmer.phone);

  // ---- Bước 1: tạo thửa. Lỗi dữ liệu, mạng: báo lỗi, giữ nội dung đang nhập, không tạo thửa.
  await browser.hash('#/nong-dan/F-03');
  await browser.waitText('Lưu thửa ruộng');
  await browser.fill('input[name=name]', fieldName);
  await browser.fill('input[name=locality]', locality);
  await browser.fill('input[name=areaM2]', String(AREA_M2));
  const submitField = () => browser.ev(`document.querySelector('input[name=areaM2]').form.requestSubmit()`);
  const keptInput = async () => {
    assert.deepEqual([await inputValue('name'), await inputValue('locality'), await inputValue('areaM2')], [fieldName, locality, String(AREA_M2)], 'typed values lost');
    assert.ok((await hashNow()).startsWith('#/nong-dan/F-03'), 'left F-03 on error');
    assert.equal(await fieldCount(farmer.id), 0, 'field row created on failure');
  };

  await check(`${w} F-03 data error from server: message shown, input kept, nothing saved`, async () => {
    await fault({ method: 'POST', path: '/api/fields', kind: 'status', status: 400, code: 'VALIDATION_FAILED' });
    await submitField();
    await browser.waitText('Thông tin chưa hợp lệ');
    assert.equal(await formError(), 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.');
    await keptInput();
  });
  await check(`${w} F-03 network error: message shown, input kept, nothing saved`, async () => {
    await fault({ method: 'POST', path: '/api/fields', kind: 'network' });
    await submitField();
    await browser.waitText('Không kết nối được máy chủ');
    await keptInput();
  });
  await browser.shot(join(SHOTS, `${width}-1-f03-network-error.png`));
  await assertLayout(`${w} F-03 error`);

  await submitField();
  await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-02')`);
  await browser.waitText(fieldName);
  await browser.shot(join(SHOTS, `${width}-2-f02-after-create.png`));

  // ---- Bước 2: đặt đơn. Lỗi quyền: không báo thành công, không tạo đơn. Bấm hai lần liền: một yêu cầu, một đơn.
  const field = (await pool.query('SELECT id FROM dispatch.fields WHERE owner_id=$1', [farmer.id])).rows[0];
  await browser.hash(`#/nong-dan/F-05?field=${field.id}&service=${harvest.id}`);
  await browser.waitFor('!!document.querySelector("input[name=startLocal]")');
  await browser.clickText('Xem bảng giá và xác nhận', 'button');
  await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-06')`);
  await browser.waitText('Tổng tạm tính');
  await browser.shot(join(SHOTS, `${width}-3-f06-quote.png`));
  const f06Hash = await hashNow();

  await check(`${w} F-06 permission error: no success, no order, stays on F-06`, async () => {
    await fault({ method: 'POST', path: '/api/bookings', kind: 'status', status: 403, code: 'FORBIDDEN' });
    await browser.clickText('Xác nhận gửi yêu cầu', 'button');
    await browser.waitText('không có quyền');
    assert.equal(await browser.ev(`document.getElementById('toasts')?.innerText.trim() || ''`), '', 'success toast from the previous step still shown beside the error');
    assert.equal(await hashNow(), f06Hash, 'left F-06');
    assert.ok(!(await browser.ev(`document.body.innerText.includes('Đã gửi yêu cầu dịch vụ')`)), 'success toast on a refused order');
    assert.equal(await bookingCount(farmer.id), 0, 'order created on failure');
  });
  await showText('không có quyền');
  await browser.shot(join(SHOTS, `${width}-4-f06-permission-error.png`));
  await assertLayout(`${w} F-06 error`);

  await check(`${w} F-06 two quick clicks send one request and create one order`, async () => {
    const before = await posts('/api/bookings');
    await browser.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Xác nhận gửi yêu cầu'); b.click(); b.click(); })()`);
    await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-07?id=')`);
    assert.equal((await posts('/api/bookings')) - before, 1, 'second click sent another request');
    assert.equal(await bookingCount(farmer.id), 1);
  });
  await browser.waitText(fieldName);
  await browser.shot(join(SHOTS, `${width}-5-f07-after-order.png`));

  // Bước 2b: mất phản hồi sau khi máy chủ đã ghi. Bấm lại dùng cùng khóa chống trùng, vẫn chỉ thêm một đơn.
  await check(`${w} F-06 lost response: warns result unknown, retry adds exactly one order`, async () => {
    const start = new Date(Date.now() + 90 * DAY);
    const end = new Date(start.getTime() + 12 * 3600000);
    await browser.hash(`#/nong-dan/F-06?field=${field.id}&service=${harvest.id}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
    await browser.waitText('Tổng tạm tính');
    await fault({ method: 'POST', path: '/api/bookings', kind: 'lost' });
    await browser.clickText('Xác nhận gửi yêu cầu', 'button');
    await browser.waitText('chưa rõ kết quả');
    assert.ok((await hashNow()).startsWith('#/nong-dan/F-06'), 'left F-06 without a response');
    assert.equal(await bookingCount(farmer.id), 2, 'server should hold the committed order');
    await showText('chưa rõ kết quả');
    await browser.shot(join(SHOTS, `${width}-6-f06-lost-response.png`));
    await browser.clickText('Xác nhận gửi yêu cầu', 'button');
    await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-07?id=')`);
    assert.equal(await bookingCount(farmer.id), 2, 'retry created a duplicate');
  });

  // ---- Đọc lại sau khi tải lại trang (token chỉ nằm trong bộ nhớ, nên đăng nhập lại rồi đọc từ API).
  await signInUi(farmer.phone);
  await check(`${w} after reload: F-02 shows the stored field with the server area`, async () => {
    await browser.hash('#/nong-dan/F-02');
    await browser.waitText(fieldName);
    const text = await mainText();
    assert.ok(text.includes(locality) && text.includes(`${fmtNum(AREA_M2)} m²`), 'field card incomplete');
    const row = (await pool.query('SELECT name, area_m2 FROM dispatch.fields WHERE owner_id=$1', [farmer.id])).rows;
    assert.deepEqual(row.map((r) => [r.name, Number(r.area_m2)]), [[fieldName, AREA_M2]]);
    await assertLayout(`${w} F-02 reload`);
  });
  await browser.shot(join(SHOTS, `${width}-7-f02-after-reload.png`));

  await check(`${w} after reload: F-07 lists the two stored orders of this account`, async () => {
    await browser.hash('#/nong-dan/F-07');
    await browser.waitFor(`document.querySelectorAll('#main ul.list > li').length === 2`);
    const hrefs = await browser.ev(`[...document.querySelectorAll('#main ul.list > li a')].map((a) => a.getAttribute('href'))`);
    const ids = (await pool.query('SELECT id FROM dispatch.bookings WHERE owner_id=$1', [farmer.id])).rows.map((r) => r.id).sort();
    assert.deepEqual(hrefs.map((h) => h.split('id=')[1]).sort(), ids);
    assert.ok((await mainText()).includes(fieldName));
    await assertLayout(`${w} F-07 list reload`);
  });
  await browser.shot(join(SHOTS, `${width}-8-f07-list-after-reload.png`));

  await check(`${w} another account sees neither the field nor the orders`, async () => {
    await signInUi(other.phone);
    await browser.hash('#/nong-dan/F-02');
    await browser.waitText('Chưa có thửa ruộng nào');
    await browser.hash('#/nong-dan/F-07');
    await browser.waitText('Bạn chưa có đơn nào');
  });

  pageErrors.push(...browser.errors);
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

  await runAt(390);
  await runAt(1440);

  await check('no uncaught page errors at 390 or 1440', async () => {
    assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
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
  log('PASS farmer slice 1 flow', { shots: SHOTS });
}
