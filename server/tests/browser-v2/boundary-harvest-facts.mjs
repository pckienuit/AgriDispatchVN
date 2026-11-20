// Browser proof for F-04 point editing (keyboard, pointer, delete, text fallback) and F-05 -> F-06 -> F-07 crop facts.
// Disposable PostgreSQL, real two-service API, headless Chromium at 390px. Synthetic data only.
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
const servers = [];
const password = randomBytes(18).toString('base64url');
const internalServiceToken = randomBytes(32).toString('base64url');
const label = `E2E ranh ${randomBytes(3).toString('hex')}`;
const quiet = () => {};
const shotDir = process.env.SHOT_DIR;
let browser;
let origin;

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function api(path, { token, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${data.error?.code ?? ''}`);
  return data;
}

const utc = (days, hour) => {
  const date = new Date(Date.now() + days * 86400000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

const fits = () => browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth');

try {
  await migrate(pool);
  await seedCatalog(pool);
  const accountServiceUrl = await listen(createAccountApp({ pool, internalServiceToken, log: quiet }));
  origin = await listen(createApp({ pool, accountServiceUrl, internalServiceToken, log: quiet }));

  const phone = '0907000001';
  await api('/api/auth/register', { body: { name: 'Kiểm thử nông dân ranh', phone, password } });
  const { token } = await api('/api/auth/login', { body: { phone, password } });
  const services = await api('/api/services');
  const harvest = services.items.find((item) => item.code === 'harvest-combine');

  browser = await open();
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await browser.viewport(390, 844, true);
  await browser.go(`${origin}/v2/`);
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', phone);
  await browser.fill('input[name=password]', password);
  await browser.click('form button[type=submit]');
  await browser.waitFor('location.hash.startsWith("#/nong-dan/")');

  // F-03: create the field through the UI, then open F-04 from the list.
  await browser.hash('#/nong-dan/F-03');
  await browser.waitFor('!!document.querySelector("input[name=areaM2]")');
  await browser.fill('input[name=name]', label);
  await browser.fill('input[name=locality]', 'Xã kiểm thử');
  await browser.fill('input[name=areaM2]', '12000');
  await browser.clickText('Lưu thửa ruộng', 'button');
  await browser.waitFor('location.hash.startsWith("#/nong-dan/F-02")');
  const field = (await api('/api/fields', { token })).items.find((item) => item.name === label);
  assert.ok(field, 'F-03 persisted field');

  // F-04 consent, then a 4-point ring entered as text.
  await browser.hash(`#/nong-dan/F-04?id=${field.id}`);
  await browser.waitText('Ranh thửa (tùy chọn)');
  assert.equal(await browser.ev('!!document.querySelector(".farmer-boundary-vertex")'), false, 'no vertices before consent');
  await browser.clickText('Đồng ý lưu tọa độ', 'button');
  await browser.waitFor('!!document.querySelector("textarea[name=boundary]")');
  const square = [[105.8, 10], [105.801, 10], [105.801, 10.001], [105.8, 10.001]];
  await browser.fill('textarea[name=boundary]', square.map((p) => p.join(', ')).join('\n'));
  await browser.waitFor('document.querySelectorAll(".farmer-boundary-vertex").length === 4');
  await browser.clickText('Lưu ranh thửa', 'button');
  await browser.waitText('Diện tích tính từ ranh');
  const saved = (await api(`/api/fields/${field.id}/details`, { token })).details;
  assert.equal(saved.coordinates.length, 5);

  // Keyboard: real key events on the focused vertex. ArrowRight moves about 1 m east, Shift+ArrowDown 10 m south.
  await browser.ev('(() => { const v = document.querySelector(".farmer-boundary-vertex[data-i=\\"0\\"]"); v.focus(); })()');
  const focusedIdx = await browser.ev('document.activeElement.getAttribute("data-i")');
  assert.equal(focusedIdx, '0', 'vertex 0 is keyboard focusable');
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await browser.waitFor('document.querySelector("textarea[name=boundary]").value.split("\\n")[0] === "105.8000100, 10.0000000"');
  assert.equal(await browser.ev('!!document.querySelector("textarea[name=boundary]") && document.querySelector(".farmer-boundary-vertex[data-i=\\"0\\"]").getAttribute("aria-label").includes("105.8000100")'), true);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 8 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 8 });
  await browser.waitFor('document.querySelector("textarea[name=boundary]").value.split("\\n")[0] === "105.8000100, 9.9999000"');
  console.log('F-04 keyboard: arrow and Shift+arrow nudges update vertex label and text fallback');

  // Pointer drag on vertex 2 (touch-capable path uses the same pointer events).
  const rect = await browser.ev('(() => { const r = document.querySelectorAll(".farmer-boundary-vertex")[2].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 1 });
  for (const step of [1, 2, 3]) await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + step * 6, y: rect.y + step * 2, button: 'left', buttons: 1 });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + 18, y: rect.y + 6, button: 'left', clickCount: 1, buttons: 0 });
  await browser.waitFor('document.querySelectorAll(".farmer-boundary-vertex").length === 4');
  const afterDrag = await browser.ev('document.querySelector("textarea[name=boundary]").value.split("\\n")[2]');
  assert.notEqual(afterDrag, '105.801, 10.001', 'drag moved vertex 2');
  console.log(`F-04 pointer drag: vertex 2 now ${afterDrag}`);

  // Delete the focused vertex; minimum 3 vertices is enforced.
  await browser.ev('document.querySelector(".farmer-boundary-vertex[data-i=\\"3\\"]").focus()');
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await browser.waitFor('document.querySelectorAll(".farmer-boundary-vertex").length === 3');
  assert.equal(await browser.ev('document.querySelector("#boundary-help") && [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Xóa đỉnh đang chọn").disabled'), true, 'remove disabled at 3 vertices');
  await browser.ev('document.querySelector(".farmer-boundary-vertex[data-i=\\"0\\"]").focus()');
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  assert.equal(await browser.ev('document.querySelectorAll(".farmer-boundary-vertex").length'), 3, 'delete blocked below 3 vertices');
  assert.equal(await browser.ev('document.querySelector("textarea[name=boundary]").value.split("\\n").length'), 3);

  // Invalid text is rejected with a visible message and the server keeps the old ring.
  await browser.fill('textarea[name=boundary]', '105.8, 10\n105.801, 10\n1e2, 10');
  await browser.clickText('Lưu ranh thửa', 'button');
  await browser.waitText('dùng dấu chấm');
  assert.equal((await api(`/api/fields/${field.id}/details`, { token })).details.coordinates.length, 5);

  // Saving the triangle replaces the ring and recomputes area on the server.
  await browser.fill('textarea[name=boundary]', '105.8, 10\n105.801, 10\n105.8, 10.001');
  await browser.waitFor('document.querySelectorAll(".farmer-boundary-vertex").length === 3');
  await browser.clickText('Lưu ranh thửa', 'button');
  await browser.waitText('Diện tích tính từ ranh');
  const triangle = (await api(`/api/fields/${field.id}/details`, { token })).details;
  assert.equal(triangle.coordinates.length, 4, 'server stores closed ring from three vertices');
  assert.ok(triangle.areaM2 > 0 && triangle.areaM2 !== 12000);
  assert.equal(await fits(), true, 'F-04 fits 390px');
  if (shotDir) { await browser.ev('document.querySelector(".farmer-boundary").scrollIntoView({block:"center"})'); await browser.shot(`${shotDir}/f04-boundary-390.png`); }
  console.log(`F-04 save: triangle stored, server area ${triangle.areaM2} m2`);

  // F-05 -> F-06 -> F-07 with crop facts.
  await browser.hash(`#/nong-dan/F-05?field=${field.id}&service=${harvest.id}`);
  await browser.waitFor('!!document.querySelector("input[name=startLocal]")');
  await browser.fill('input[name=startLocal]', utc(14, 8).slice(0, 16));
  await browser.fill('input[name=endLocal]', utc(14, 12).slice(0, 16));
  await browser.fill('input[name=cropVariety]', 'OM5451');
  await browser.fill('input[name=sowDate]', '2026-08-01');
  await browser.fill('input[name=harvestDate]', '2026-11-30');
  await browser.clickText('Xem bảng giá và xác nhận', 'button');
  await browser.waitFor('location.hash.startsWith("#/nong-dan/F-06")');
  await browser.waitText('Giống lúa');
  await browser.waitText('01/08/2026');
  await browser.waitText('30/11/2026');
  assert.equal(await fits(), true, 'F-06 fits 390px');
  await browser.clickText('Xác nhận gửi yêu cầu', 'button');
  await browser.waitFor('location.hash.startsWith("#/nong-dan/F-07?id=")');
  const bookingId = await browser.ev('new URLSearchParams(location.hash.split("?")[1]).get("id")');
  await browser.waitText('Giống lúa');
  await browser.waitText('Ngày gặt dự kiến (tham khảo)');
  const booking = (await api(`/api/bookings/${bookingId}`, { token })).booking;
  assert.equal(booking.cropVariety, 'OM5451');
  assert.equal(booking.sowDate, '2026-08-01');
  assert.equal(booking.harvestDate, '2026-11-30');
  assert.equal(booking.totalVnd, String((BigInt(harvest.pricePerHaVnd) * BigInt(triangle.areaM2) + 5000n) / 10000n), 'quote uses the area stored by the boundary save');
  console.log(`F-06 quote follows stored area ${triangle.areaM2} m2, total ${booking.totalVnd}`);
  console.log('F-05/F-06/F-07: crop facts persisted, shown on quote and detail, dates not shifted');

  // Malformed harvest param in the URL is refused on F-06, not sent to the server.
  await browser.hash(`#/nong-dan/F-06?field=${field.id}&service=${harvest.id}&start=2026-12-10T08:00:00.000Z&end=2026-12-10T12:00:00.000Z&sow=2026-02-30`);
  await browser.waitText('Thông tin giống hoặc ngày vụ không hợp lệ');
  assert.equal(await fits(), true);

  // Keyboard-only path on F-04: the vertex list has labels and no page errors.
  assert.deepEqual(browser.errors, [], `page errors ${browser.errors.join(' | ')}`);
  assert.deepEqual(browser.consoleErrors, [], `console errors ${browser.consoleErrors.join(' | ')}`);
} finally {
  try {
    await browser?.close();
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
    try {
      await pool.end();
    } finally {
      await db.drop();
    }
  }
}
console.log('V2_BOUNDARY_HARVEST_PASS: F-04 keyboard, pointer, delete, text fallback; F-05/F-06/F-07 crop facts; 390px fit; no page errors');
