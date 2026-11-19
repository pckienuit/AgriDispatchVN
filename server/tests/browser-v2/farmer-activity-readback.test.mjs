// Browser check for farmer F-01 home, F-02 field list readback and C-03 activity pagination on /v2/.
// Disposable PostgreSQL (TEST_DATABASE_URL, loopback *_test) + two real services + headless Chromium at 1440 and 390 px.
// Accounts, bookings and disputes are created over real HTTP. Field creation goes through the F-03 form.
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

const log = (...args) => console.log('[farmer-activity-readback]', ...args);
const SHOTS = process.env.FARMER_ACTIVITY_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-farmer-activity-shots-')));
await mkdir(SHOTS, { recursive: true });

const PASSWORD = 'TestPass!12345';
const HOUR = 3600000;
const DAY = 86400000;
const AREA_M2 = 12960;
// Booking events: 4 on the claimed booking (requested, coordinator, grouped, assigned) + 20 extra requests.
// Plus 1 dispute opened = 25 feed items, so C-03 must show 20 then 5.
const EXTRA_BOOKINGS = 20;
const TOTAL_EVENTS = 25;

const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const pageErrors = [];
const consoleErrors = [];
const checks = [];
let browser;
let origin;

const fmtNum = (n, d = 0) => new Intl.NumberFormat('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hourCycle: 'h23', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// Mirrors ui.fmt.dateTime in web/v2/kit/ui.js: "HH:MM ngày DD/MM" in Asia/Ho_Chi_Minh.
const expectedDateTime = (iso) => {
  const p = {};
  dateFmt.formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
  return `${p.hour}:${p.minute} ngày ${p.day}/${p.month}`;
};
// Mirrors toV2Href in web/v2/screens/common.js for role nong-dan: booking -> F-07, dispute -> F-13.
const expectedV2Href = (feedHref) => {
  const m = /^#(booking|dispute)\/([0-9a-f-]{36})$/.exec(feedHref || '');
  if (!m) return null;
  return m[1] === 'booking' ? `#/nong-dan/F-07?id=${m[2]}` : `#/nong-dan/F-13?id=${m[2]}`;
};
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

// Synthetic identity. New accounts are farmers; other roles are granted by the same SQL the existing v2 browser tests use.
async function makeActor(name, role) {
  const phone = newPhone();
  const reg = await ok('POST', '/api/auth/register', { body: { phone, password: PASSWORD, name } });
  const id = reg.user.id;
  if (role) await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  const login = await ok('POST', '/api/auth/login', { body: { phone, password: PASSWORD } });
  return { id, phone, token: login.token };
}

// Predecessor events are created over HTTP by the real roles (farmer, HTX, provider, operator), not by SQL.
// Extra bookings are submitted first, then the dispute is opened on the main booking so both appear on page 1 of C-03.
async function buildActivity({ farmer, fieldId, tag }) {
  const coop = await makeActor(`HTX ${tag}`, 'coop');
  const prov = await makeActor(`Chủ máy ${tag}`, 'provider');
  const oper = await makeActor(`Thợ lái ${tag}`, 'operator');
  const T0 = Date.now() + 80 * DAY;
  const slot = (h, d) => ({ startAt: new Date(T0 + h * HOUR).toISOString(), endAt: new Date(T0 + (h + d) * HOUR).toISOString() });
  const key = (s) => `activity-${tag}-${s}`;
  const { items: services } = await ok('GET', '/api/services?limit=100', { token: farmer.token });
  const svc = services.find((s) => s.code === 'harvest-combine');
  assert.ok(svc, 'seeded harvest-combine service missing');

  const { booking: main } = await ok('POST', '/api/bookings', { token: farmer.token, headers: { 'Idempotency-Key': key('main') }, body: { fieldId, serviceId: svc.id, ...slot(0, 12) } });
  await ok('POST', `/api/bookings/${main.id}/coordinator`, { token: farmer.token, body: { coordinatorId: coop.id } });
  const { package: pkg } = await ok('POST', '/api/packages', { token: coop.token, body: { bookingIds: [main.id] } });
  const { job } = await ok('POST', '/api/jobs', { token: prov.token, body: { title: `Tuyển thợ lái ${tag}`, locality: 'Thới Bình', capacity: 1, ...slot(0, 48) } });
  const { application } = await ok('POST', `/api/jobs/${job.id}/applications`, { token: oper.token, body: {} });
  const { offer } = await ok('POST', `/api/applications/${application.id}/offers`, { token: prov.token, body: {} });
  await ok('POST', `/api/offers/${offer.id}/accept`, { token: oper.token, body: {} });
  const { machine } = await ok('POST', '/api/machines', { token: prov.token, body: { name: `Máy gặt ${tag}`, type: 'harvester' } });
  await ok('POST', `/api/packages/${pkg.id}/claim`, { token: prov.token, body: { machineId: machine.id, operatorId: oper.id } });

  for (let i = 0; i < EXTRA_BOOKINGS; i++) {
    await ok('POST', '/api/bookings', { token: farmer.token, headers: { 'Idempotency-Key': key(`x${String(i).padStart(2, '0')}`) }, body: { fieldId, serviceId: svc.id, ...slot(24 + i * 24, 12) } });
  }
  const { dispute } = await ok('POST', `/api/bookings/${main.id}/disputes`, { token: farmer.token, body: { reason: 'QUALITY', details: `Cần kiểm tra chất lượng ${tag}.` } });
  return { main, dispute };
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
const mainLinks = () => browser.ev(`[...document.querySelectorAll('#main a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))`);
const waitLink = (href, text) => browser.waitFor(`[...document.querySelectorAll('#main a')].some((a) => a.getAttribute('href') === ${JSON.stringify(href)} && a.textContent.includes(${JSON.stringify(text)}))`);
const hasLink = async (href, text) => (await mainLinks()).some((l) => l.href === href && l.text.includes(text));
const uiItems = () => browser.ev(`[...document.querySelectorAll('#main ul.list > li')].map((li) => ({
  title: li.querySelector('.item__title')?.textContent.trim() ?? null,
  meta: li.querySelector('.small.muted')?.textContent.trim() ?? null,
  href: li.querySelector('a')?.getAttribute('href') ?? null,
}))`);
const pager = () => browser.ev(`[...document.querySelectorAll('#main a.btn')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))`);
const clickPager = (label) => browser.ev(`(() => { const a = [...document.querySelectorAll('#main a.btn')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!a) throw new Error('no pager ' + ${JSON.stringify(label)}); a.click(); })()`);
const waitItems = (n) => browser.waitFor(`document.querySelectorAll('#main ul.list > li').length === ${n}`);
const submitFormOf = (selector) => browser.ev(`document.querySelector(${JSON.stringify(selector)}).form.requestSubmit()`);
const assertLayout = async (label) => {
  const layout = await browser.layout();
  assert.ok(layout.sw <= layout.w && layout.wide.length === 0, `${label}: ${JSON.stringify(layout)}`);
};
const expectItems = (uiList, apiItems) => {
  assert.equal(uiList.length, apiItems.length, 'item count');
  apiItems.forEach((it, i) => {
    assert.deepEqual(uiList[i], { title: it.text, meta: expectedDateTime(it.createdAt), href: expectedV2Href(it.href) }, `item ${i}`);
  });
};

async function runAt(width) {
  const w = `[${width}px]`;
  const tag = tagOf();
  const fieldName = `Thửa Bờ Bắc ${tag}`;
  const locality = `Xã Thới Bình ${tag}`;
  const farmer = await makeActor(`Nông dân ${tag}`, null);
  browser = await open({ width, height: width < 760 ? 844 : 900, mobile: width < 760 });
  await signInUi(farmer.phone);

  // 1. Empty state: no fields, no bookings, no events.
  await check(`${w} F-01 empty: prompt, action link, and empty activity in quick links`, async () => {
    await browser.waitText('Chưa có thửa ruộng nào');
    assert.ok(await hasLink('#/nong-dan/F-03', 'Thêm thửa đầu tiên'), 'F-03 action missing');
    assert.ok(!(await mainText()).includes('Đơn đang theo dõi'), 'order card shown without bookings');
    const text = await mainText();
    assert.ok(text.includes('Chưa có cập nhật'), 'activity empty meta missing');
    assert.ok(text.includes('Chưa có vụ việc'), 'disputes empty meta missing');
    await assertLayout(`${w} F-01 empty`);
  });
  await browser.shot(join(SHOTS, `${width}-f01-empty.png`));

  await check(`${w} F-02 empty: prompt and F-03 action link`, async () => {
    await browser.hash('#/nong-dan/F-02');
    await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-02')`);
    await waitLink('#/nong-dan/F-03', 'Thêm thửa ruộng');
    assert.ok(await hasLink('#/nong-dan/F-03', 'Thêm thửa ruộng'));
    assert.ok((await mainText()).includes('Chưa có thửa ruộng nào'));
    await assertLayout(`${w} F-02 empty`);
  });
  await browser.shot(join(SHOTS, `${width}-f02-empty.png`));

  await check(`${w} C-03 empty: no items and no pager`, async () => {
    await browser.hash('#/nong-dan/C-03');
    await browser.waitText('Chưa có hoạt động');
    assert.equal((await uiItems()).length, 0, 'items shown with no events');
    assert.equal((await pager()).length, 0, 'pager shown with no events');
  });
  await browser.shot(join(SHOTS, `${width}-c03-empty.png`));

  // 2. F-03 form creates the field; F-02 reads it back. DB row and API DTO must match the form.
  await browser.hash('#/nong-dan/F-03');
  await browser.waitText('Lưu thửa ruộng');
  await browser.fill('input[name=name]', fieldName);
  await browser.fill('input[name=locality]', locality);
  await browser.fill('input[name=areaM2]', String(AREA_M2));
  await submitFormOf('input[name=areaM2]');
  await browser.waitFor(`location.hash.startsWith('#/nong-dan/F-02')`);
  await browser.waitText(fieldName);

  let field;
  await check(`${w} F-03 -> DB row and GET /api/fields match form input`, async () => {
    const { rows } = await pool.query('SELECT id, name, locality, area_m2 FROM dispatch.fields WHERE owner_id=$1', [farmer.id]);
    assert.equal(rows.length, 1, 'expected one field row');
    assert.equal(rows[0].name, fieldName);
    assert.equal(rows[0].locality, locality);
    assert.equal(Number(rows[0].area_m2), AREA_M2);
    field = rows[0];
    const api1 = await ok('GET', '/api/fields?limit=100&offset=0', { token: farmer.token });
    assert.equal(api1.items.length, 1);
    assert.equal(api1.items[0].id, field.id);
    assert.equal(api1.items[0].areaM2, AREA_M2);
    assert.equal(api1.items[0].locality, locality);
  });

  await check(`${w} F-02 card: name, locality, m2 and ha/cong from stored area, F-04 and F-05 links`, async () => {
    const text = await mainText();
    assert.ok(text.includes(fieldName) && text.includes(locality), 'name or locality missing');
    assert.ok(text.includes(`${fmtNum(AREA_M2)} m²`), 'm² text missing');
    assert.ok(text.includes(`${fmtNum(AREA_M2 / 10000, 2)} ha · ${fmtNum(AREA_M2 / 1296, 1)} công`), `ha/công text missing: ${text.slice(0, 300)}`);
    assert.ok(text.includes('1 thửa') && text.includes('Chưa có đơn'), 'summary or no-order badge missing');
    assert.ok(await hasLink(`#/nong-dan/F-04?id=${field.id}`, 'Đường vào, đất và ranh'), 'F-04 link missing');
    assert.ok(await hasLink(`#/nong-dan/F-05?field=${field.id}`, 'Đặt dịch vụ'), 'F-05 link missing');
    await assertLayout(`${w} F-02 active-empty-order`);
  });

  await check(`${w} F-02 -> F-04 link opens field access screen`, async () => {
    await browser.ev(`document.querySelector('#main a[href="#/nong-dan/F-04?id=${field.id}"]').click()`);
    await browser.waitFor(`location.hash === '#/nong-dan/F-04?id=${field.id}'`);
    await browser.waitText('Đường vào và đất ruộng');
    await assertLayout(`${w} F-04`);
  });

  // 3. Real booking and dispute events through HTTP, then home and list readback.
  const { dispute } = await buildActivity({ farmer, fieldId: field.id, tag });
  const latest = (await pool.query('SELECT id FROM dispatch.bookings WHERE owner_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [farmer.id])).rows[0].id;

  await check(`${w} DB holds ${TOTAL_EVENTS} farmer feed events (booking + dispute) and 21 bookings`, async () => {
    const bev = (await pool.query('SELECT count(*)::int AS n FROM dispatch.booking_events e JOIN dispatch.bookings b ON b.id=e.booking_id WHERE b.owner_id=$1', [farmer.id])).rows[0].n;
    const dev = (await pool.query('SELECT count(*)::int AS n FROM dispatch.dispute_events e JOIN dispatch.disputes d ON d.id=e.dispute_id WHERE d.claimant_id=$1', [farmer.id])).rows[0].n;
    const bk = (await pool.query('SELECT count(*)::int AS n FROM dispatch.bookings WHERE owner_id=$1', [farmer.id])).rows[0].n;
    assert.equal(bev + dev, TOTAL_EVENTS, `events booking=${bev} dispute=${dev}`);
    assert.equal(bk, EXTRA_BOOKINGS + 1);
  });

  await check(`${w} F-01 active: field and order summary, dispute count, activity summary, action links`, async () => {
    await browser.hash('#/nong-dan/F-01');
    await browser.waitText(`1 thửa, tổng ${fmtNum(AREA_M2)} m²`);
    const text = await mainText();
    assert.ok(text.includes(`(${fmtNum(AREA_M2 / 10000, 2)} ha · ${fmtNum(AREA_M2 / 1296, 1)} công)`), 'area conversion missing');
    assert.ok(text.includes(`${EXTRA_BOOKINGS + 1} đơn đang theo dõi`), 'running booking count wrong');
    assert.ok(text.includes('Đơn đang theo dõi'), 'current order card missing');
    assert.ok(text.includes('1 vụ việc'), 'dispute count missing');
    assert.ok(text.includes('10 cập nhật mới'), 'activity summary missing');
    assert.ok(await hasLink(`#/nong-dan/F-07?id=${latest}`, 'Chi tiết'), 'order detail link missing');
    assert.ok(await hasLink('#/nong-dan/F-13', 'Khiếu nại của tôi'), 'F-13 link missing');
    assert.ok(await hasLink('#/nong-dan/C-03', 'Hoạt động gần đây'), 'C-03 link missing');
  });
  await browser.shot(join(SHOTS, `${width}-f01-active.png`));
  await assertLayout(`${w} F-01 active`);

  await check(`${w} F-01 quick links navigate to targets`, async () => {
    await browser.ev(`document.querySelector('#main a[href="#/nong-dan/C-03"]').click()`);
    await browser.waitFor(`location.hash === '#/nong-dan/C-03'`);
    await browser.waitText('Hoạt động gần đây');
    await browser.hash('#/nong-dan/F-01');
    await browser.waitFor(`location.hash === '#/nong-dan/F-01'`);
    await browser.ev(`document.querySelector('#main a[href="#/nong-dan/F-13"]').click()`);
    await browser.waitFor(`location.hash === '#/nong-dan/F-13'`);
    await browser.waitText('Khiếu nại');
  });

  await check(`${w} F-02 active: order link to latest booking F-07`, async () => {
    await browser.hash('#/nong-dan/F-02');
    await waitLink(`#/nong-dan/F-07?id=${latest}`, 'Xem đơn');
    assert.ok(!(await mainText()).includes('Chưa có đơn'), 'no-order badge still shown');
  });
  await browser.shot(join(SHOTS, `${width}-f02-active.png`));
  await assertLayout(`${w} F-02 active`);

  // 4. C-03 pagination: API page vs UI page, 20 then 5, pager links, no duplicates across pages.
  await check(`${w} C-03 page 1: 20 items match API, only "Cũ hơn" pager`, async () => {
    await browser.hash('#/nong-dan/C-03');
    await waitItems(20);
    const apiPage0 = (await ok('GET', '/api/activity?limit=20&offset=0', { token: farmer.token })).items;
    expectItems(await uiItems(), apiPage0);
    assert.deepEqual(await pager(), [{ text: 'Cũ hơn', href: '#/nong-dan/C-03?tu=20' }]);
  });
  await browser.shot(join(SHOTS, `${width}-c03-page1.png`));
  await browser.ev('window.scrollTo(0, document.body.scrollHeight)');
  await browser.shot(join(SHOTS, `${width}-c03-page1-bottom.png`));
  await assertLayout(`${w} C-03 page 1`);

  await check(`${w} C-03 "Cũ hơn" -> page 2: 5 items match API, only "Mới hơn" pager`, async () => {
    await clickPager('Cũ hơn');
    await browser.waitFor(`location.hash === '#/nong-dan/C-03?tu=20'`);
    await waitItems(TOTAL_EVENTS - 20);
    const apiPage1 = (await ok('GET', '/api/activity?limit=20&offset=20', { token: farmer.token })).items;
    expectItems(await uiItems(), apiPage1);
    assert.deepEqual(await pager(), [{ text: 'Mới hơn', href: '#/nong-dan/C-03' }]);
  });
  await browser.shot(join(SHOTS, `${width}-c03-page2.png`));
  await assertLayout(`${w} C-03 page 2`);

  await check(`${w} C-03 pages cover ${TOTAL_EVENTS} unique events equal to DB count`, async () => {
    const p0 = (await ok('GET', '/api/activity?limit=20&offset=0', { token: farmer.token })).items;
    const p1 = (await ok('GET', '/api/activity?limit=20&offset=20', { token: farmer.token })).items;
    const ids = [...p0, ...p1].map((it) => it.id);
    assert.equal(new Set(ids).size, TOTAL_EVENTS, 'duplicate or missing feed ids across pages');
    assert.equal(p1.length, TOTAL_EVENTS - 20);
  });

  await check(`${w} C-03 "Mới hơn" returns to page 1`, async () => {
    await clickPager('Mới hơn');
    await browser.waitFor(`location.hash === '#/nong-dan/C-03'`);
    await waitItems(20);
    expectItems(await uiItems(), (await ok('GET', '/api/activity?limit=20&offset=0', { token: farmer.token })).items);
  });

  // 5. Role-mapped targets: booking item -> F-07, dispute item -> F-13. Each must open the target cleanly.
  await check(`${w} C-03 booking item opens F-07 for that booking`, async () => {
    const bookingItem = (await uiItems()).find((it) => it.href?.startsWith('#/nong-dan/F-07?id='));
    assert.ok(bookingItem, 'no booking item on page 1');
    const expectedHref = bookingItem.href;
    const bid = expectedHref.split('id=')[1];
    const owned = (await pool.query('SELECT 1 FROM dispatch.bookings WHERE id=$1 AND owner_id=$2', [bid, farmer.id])).rowCount;
    assert.equal(owned, 1, 'linked booking is not the farmer booking in DB');
    await browser.ev(`document.querySelector('#main a[href="${expectedHref}"]').click()`);
    await browser.waitFor(`location.hash === ${JSON.stringify(expectedHref)}`);
    await browser.waitText(fieldName);
    assert.ok(!(await mainText()).includes('Mã đơn không hợp lệ'), 'F-07 rendered invalid-id screen');
    await assertLayout(`${w} F-07`);
    await browser.shot(join(SHOTS, `${width}-f07-from-c03.png`));
  });

  await check(`${w} C-03 dispute item opens F-13 for that dispute`, async () => {
    await browser.hash('#/nong-dan/C-03');
    await waitItems(20);
    const expectedHref = `#/nong-dan/F-13?id=${dispute.id}`;
    const item = (await uiItems()).find((it) => it.href === expectedHref);
    assert.ok(item, `dispute item not on page 1: ${JSON.stringify((await uiItems()).slice(0, 2))}`);
    await browser.ev(`document.querySelector('#main a[href="${expectedHref}"]').click()`);
    await browser.waitFor(`location.hash === ${JSON.stringify(expectedHref)}`);
    await browser.waitText('Chất lượng công việc');
    assert.ok(!(await mainText()).includes('Mã khiếu nại không hợp lệ'), 'F-13 rendered invalid-id screen');
    await assertLayout(`${w} F-13`);
    await browser.shot(join(SHOTS, `${width}-f13-from-c03.png`));
  });

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
  log('PASS farmer F-01/F-02/C-03 readback and pagination', { shots: SHOTS });
}
