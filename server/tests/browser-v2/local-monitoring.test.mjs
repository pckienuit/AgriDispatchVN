// Edge-case regression for simulated telemetry (F-10, O-02) and HTX commission estimates (H-09).
// Covers API scope refusals, pre-shift and no-package states, live pause/complete transitions and gateway outage.
// The happy path for the same surfaces lives in harvest-journey.mjs. Uses real sign-in on the v2 form,
// the real gateway (createApp + createAccountApp) and disposable PostgreSQL. No injected tokens, no H-10.
// Run: TEST_DATABASE_URL=<loopback *_test root> CHROMIUM_BIN=<chromium> TMPDIR=<short dir> node server/tests/browser-v2/local-monitoring.test.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const internalServiceToken = randomBytes(32).toString('base64url');
const password = randomBytes(18).toString('base64url');
const quiet = () => {};
const servers = [];
const HOME = { farmer: 'nong-dan', operator: 'tho-lai', coop: 'htx' };
const utc = (days, hour) => {
  const date = new Date(Date.now() + days * 86400000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};
let origin;
let appServer;
let browser;

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function request(method, path, { token, body, key } = {}) {
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(key ? { 'idempotency-key': key } : {}),
  };
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, data: await response.json() };
}

async function call(method, path, opts = {}) {
  const { status, data } = await request(method, path, opts);
  assert.ok(status >= 200 && status < 300, `${method} ${path}: HTTP ${status} ${data.error?.code ?? ''}`);
  return data;
}

async function person(role, name) {
  const phone = `090${Math.floor(1000000 + Math.random() * 8999999)}`;
  const { user } = await call('POST', '/api/auth/register', { body: { name, phone, password } });
  if (role !== 'farmer') await pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user.id, role]);
  return { id: user.id, phone, role };
}

// Real sign-in through the v2 form, with a clean cookie jar for each actor.
async function signIn(who) {
  // A deliberate actor switch needs an empty browser cookie jar.
  await browser.send('Network.clearBrowserCookies');
  await browser.go(`${origin}/v2/?signin=${Date.now()}#/chung/C-01`);
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', who.phone);
  await browser.fill('input[name=password]', password);
  await browser.click('form button[type=submit]');
  await browser.waitFor(`location.hash.startsWith(${JSON.stringify(`#/${HOME[who.role]}/`)})`);
}

// Same-hash assignment does not re-render. Bounce to another route, then back, to force a fresh telemetry read.
async function rerender(route, bounce) {
  await browser.hash(bounce);
  await browser.hash(route);
}

const bodyText = () => browser.ev('document.body.innerText');
const progressNow = () => browser.ev('document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow") ?? null');
const cardText = () => browser.ev(`(() => { const t = document.body.innerText; const i = t.indexOf('Chỉ số máy mô phỏng'); return i < 0 ? '' : t.slice(i, i + 600); })()`);
const speedOf = (card) => card.match(/([\d.,]+) km\/h/)?.[1] ?? null;

try {
  await migrate(pool);
  await seedCatalog(pool);
  const account = await listen(createAccountApp({ pool, internalServiceToken, log: quiet }));
  const app = await listen(createApp({ pool, accountServiceUrl: account.url, internalServiceToken, log: quiet }));
  appServer = app.server;
  origin = app.url;

  const farmer = await person('farmer', 'Kiểm thử nông dân A');
  const outsider = await person('farmer', 'Kiểm thử nông dân B');
  const coop = await person('coop', 'Kiểm thử HTX A');
  const otherCoop = await person('coop', 'Kiểm thử HTX B');
  const provider = await person('provider', 'Kiểm thử chủ máy');
  const operator = await person('operator', 'Kiểm thử thợ lái A');
  const otherOperator = await person('operator', 'Kiểm thử thợ lái B');
  for (const who of [farmer, outsider, coop, otherCoop, provider, operator, otherOperator]) {
    who.token = (await call('POST', '/api/auth/login', { body: { phone: who.phone, password } })).token;
  }

  const services = await call('GET', '/api/services');
  const harvest = services.items.find((item) => item.code === 'harvest-combine');
  assert.ok(harvest, 'harvest-combine service seeded');

  // Setup through real endpoints: job -> application -> offer -> accept -> machine -> bookings -> package -> claim.
  const job = (await call('POST', '/api/jobs', { token: provider.token, body: { title: 'Kiểm thử telemetry biên', locality: 'Xã thử nghiệm', capacity: 1, startAt: utc(14, 7), endAt: utc(14, 13) } })).job;
  const application = (await call('POST', `/api/jobs/${job.id}/applications`, { token: operator.token, body: {} })).application;
  const offer = (await call('POST', `/api/applications/${application.id}/offers`, { token: provider.token, body: {} })).offer;
  await call('POST', `/api/offers/${offer.id}/accept`, { token: operator.token, body: {} });
  const machine = (await call('POST', '/api/machines', { token: provider.token, body: { name: 'Máy gặt kiểm thử', type: 'harvester' } })).machine;

  const createBooking = async (name, coordinatorId) => {
    const field = (await call('POST', '/api/fields', { token: farmer.token, body: { name, locality: 'Xã thử nghiệm', areaM2: 10000 } })).field;
    const { booking } = await call('POST', '/api/bookings', {
      token: farmer.token,
      key: randomBytes(12).toString('base64url'),
      body: { fieldId: field.id, serviceId: harvest.id, startAt: utc(14, 8), endAt: utc(14, 12) },
    });
    if (coordinatorId) await call('POST', `/api/bookings/${booking.id}/coordinator`, { token: farmer.token, body: { coordinatorId } });
    return booking;
  };
  const b1 = await createBooking('Thửa được gom', coop.id); // in coop package
  const b2 = await createBooking('Thửa chưa gom', null); // no package, no HTX delegation
  const packageId = (await call('POST', '/api/packages', { token: coop.token, body: { bookingIds: [b1.id] } })).package.id;
  await call('POST', `/api/packages/${packageId}/claim`, { token: provider.token, body: { machineId: machine.id, operatorId: operator.id } });
  await call('POST', `/api/bookings/${b1.id}/readiness`, { token: farmer.token, body: { drained: true, mature: true, intakeReady: true } });
  await call('POST', `/api/bookings/${b1.id}/inspections`, { token: coop.token, body: { result: 'PASSED' } });

  // API-level scope refusals before any browser step: 401 without token, 403 wrong role, 404 foreign scope.
  const shiftPlaceholder = '00000000-0000-4000-8000-000000000000';
  assert.equal((await request('GET', `/api/bookings/${b1.id}/telemetry`)).status, 401);
  assert.equal((await request('GET', '/api/htx/commission-estimates', { token: farmer.token })).status, 403);
  assert.equal((await request('GET', `/api/bookings/${b1.id}/telemetry`, { token: outsider.token })).status, 404);
  assert.equal((await request('GET', `/api/packages/${packageId}/telemetry`, { token: otherCoop.token })).status, 404);
  assert.equal((await request('GET', `/api/packages/${packageId}/telemetry`, { token: farmer.token })).status, 403);
  assert.equal((await request('GET', `/api/shifts/${shiftPlaceholder}/telemetry`, { token: operator.token })).status, 404);
  console.log('PASS API scope: 401 anonymous, 403 wrong role, 404 foreign booking/package');

  browser = await open({ width: 1440, height: 900, mobile: false });
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });

  // 1. Pre-shift and no-package states show zero progress with simulated label.
  await signIn(farmer);
  await browser.hash(`#/nong-dan/F-10?id=${b1.id}`);
  await browser.waitText('Chưa mở ca');
  await browser.waitText('Không phải GPS thật');
  assert.equal(await progressNow(), '0');
  await browser.hash(`#/nong-dan/F-10?id=${b2.id}`);
  await browser.waitText('Chờ nhận gói');
  assert.equal(await progressNow(), '0');
  assert.equal(speedOf(await cardText()), '0');
  console.log('PASS F-10 pre-shift and no-package states show zero progress, simulated label');

  // 2. Operator: no shift id shows empty state; live pause and complete transitions reflect after re-render.
  await signIn(operator);
  await browser.hash('#/tho-lai/O-02');
  await browser.waitText('Chưa chọn ca');
  const shiftId = (await call('POST', `/api/packages/${packageId}/shifts/start`, { token: operator.token, body: {} })).shift.id;
  await browser.hash(`#/tho-lai/O-02?id=${shiftId}`);
  await browser.waitText('Đang làm');
  assert.ok(Number(speedOf(await cardText())) > 0, 'running shift shows non-zero simulated speed');
  await call('POST', `/api/shifts/${shiftId}/pause`, { token: operator.token, body: { reason: 'Kiểm thử tạm dừng' } });
  await rerender(`#/tho-lai/O-02?id=${shiftId}`, '#/tho-lai/O-01');
  await browser.waitText('Tạm dừng');
  assert.equal(speedOf(await cardText()), '0', 'paused shift shows zero simulated speed');
  await call('POST', `/api/shifts/${shiftId}/resume`, { token: operator.token, body: {} });
  await call('POST', `/api/shifts/${shiftId}/complete`, { token: operator.token, body: { areaM2: 9000 } });
  await rerender(`#/tho-lai/O-02?id=${shiftId}`, '#/tho-lai/O-01');
  await browser.waitText('Đã xong');
  assert.equal(await progressNow(), '100');
  await browser.waitText('Diện tích báo khi kết thúc ca');
  console.log('PASS O-02 running, paused, completed transitions reflect after re-render');

  // 3. Farmer sees completed state for own booking.
  await signIn(farmer);
  await browser.hash(`#/nong-dan/F-10?id=${b1.id}`);
  await browser.waitText('Đã xong');
  assert.equal(await progressNow(), '100');
  console.log('PASS F-10 completed state after operator completion');

  // 4. Access scope in browser: outsider farmer, other operator, other HTX see no telemetry.
  await signIn(outsider);
  await browser.hash(`#/nong-dan/F-10?id=${b1.id}`);
  await browser.waitText('Không tìm thấy dữ liệu này.');
  assert.equal((await bodyText()).includes('Chỉ số máy mô phỏng'), false, 'outsider farmer sees no telemetry card');
  await browser.hash('#/htx/H-09');
  await browser.waitText('Tài khoản chưa có quyền xem nội dung này');
  console.log('PASS outsider farmer refused on F-10 and H-09 role gate');

  await signIn(otherOperator);
  await browser.hash(`#/tho-lai/O-02?id=${shiftId}`);
  await browser.waitText('Không tìm thấy dữ liệu này.');
  assert.equal((await bodyText()).includes('Chỉ số máy mô phỏng'), false, 'other operator sees no telemetry card');
  console.log('PASS other operator refused on O-02');

  await signIn(otherCoop);
  await browser.hash('#/htx/H-09');
  await browser.waitText('Chưa có đơn trong phạm vi');
  assert.equal((await bodyText()).includes(b1.id.slice(0, 8)), false, 'other HTX does not see booking commission row');
  await browser.hash(`#/htx/H-06?id=${shiftId}`);
  await browser.waitText('Không tìm thấy dữ liệu này.');
  assert.equal((await bodyText()).includes('Chỉ số máy mô phỏng'), false, 'other HTX sees no shift telemetry');
  console.log('PASS other HTX: H-09 empty scope and H-06 shift refused');

  // 5. Positive control: in-scope HTX sees its delegated booking, not the undelegated one.
  await signIn(coop);
  await browser.hash('#/htx/H-09');
  await browser.waitText(b1.id.slice(0, 8));
  assert.equal((await bodyText()).includes(b2.id.slice(0, 8)), false, 'undelegated booking stays out of HTX scope');
  await browser.hash(`#/htx/H-06?id=${shiftId}`);
  await browser.waitText('Không phải GPS thật');
  console.log('PASS in-scope HTX: H-09 lists only delegated booking; H-06 shift telemetry renders');

  // 6. H-10 is not registered even for HTX; F-10 remains usable on mobile.
  await browser.hash('#/htx/H-10');
  await browser.waitText('Không tìm thấy trang này');
  assert.equal((await bodyText()).includes('Chỉ số máy mô phỏng'), false);
  await browser.viewport(390, 844, true);
  await signIn(farmer);
  await browser.hash(`#/nong-dan/F-10?id=${b1.id}`);
  await browser.waitText('Đã xong');
  const layout = await browser.layout();
  assert.ok(layout.sw <= layout.w + 1, `F-10 mobile horizontal overflow: ${JSON.stringify(layout)}`);
  await browser.hash('#/nong-dan/F-07');
  console.log('PASS mobile F-10 no overflow; H-10 route not found');

  // 7. Outage: gateway stops while farmer screen is open. Must show network error, never stale or fabricated telemetry.
  const outageFrom = browser.consoleErrors.length;
  await new Promise((resolve) => { appServer.close(resolve); appServer.closeAllConnections(); });
  await browser.hash(`#/nong-dan/F-10?id=${b1.id}`);
  await browser.waitText('Không kết nối được máy chủ');
  assert.equal((await bodyText()).includes('Chỉ số máy mô phỏng'), false, 'outage shows no telemetry card');
  const outageErrors = browser.consoleErrors.slice(outageFrom);
  assert.ok(outageErrors.length > 0 && outageErrors.every((e) => e.includes('ERR_CONNECTION_REFUSED')), JSON.stringify(outageErrors));
  console.log('PASS gateway outage shows NETWORK error, no telemetry rendered');

  // Global: no uncaught exceptions; console entries limited to expected 403/404 denials and outage refusals.
  assert.deepEqual(browser.errors, [], 'no uncaught exceptions');
  const unexpected = browser.consoleErrors.filter((e) => !/status of (403|404)|ERR_CONNECTION_REFUSED/.test(e));
  assert.deepEqual(unexpected, [], 'no unexpected console errors');
  console.log(`expected console denial/outage entries: ${browser.consoleErrors.length}`);

  // Reads never mutate: event log has exactly the four real transitions and shift is COMPLETED.
  const events = (await pool.query('SELECT event_type FROM dispatch.shift_events WHERE shift_id = $1 ORDER BY sequence', [shiftId])).rows.map((r) => r.event_type);
  assert.deepEqual(events, ['SHIFT_STARTED', 'SHIFT_PAUSED', 'SHIFT_RESUMED', 'SHIFT_COMPLETED']);
  const shift = (await pool.query('SELECT status, area_m2 FROM dispatch.shifts WHERE id = $1', [shiftId])).rows[0];
  assert.equal(shift.status, 'COMPLETED');
  assert.equal(shift.area_m2, 9000);
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
console.log('LOCAL_MONITORING_EDGE_PASS: scope, pre-shift/no-package, transitions, outage through real gateway and browser');
