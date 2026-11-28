import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URLSearchParams } from 'node:url';
import { open } from '../../server/tests/browser-v2/cdp.mjs';
import { END, FIELD, HARVEST, START, fixture } from '../fixture.js';

async function browserFixture(t) {
  const f = await fixture(t);
  const farmer = await f.user(1, { login: false });
  const b = await open({ width: 390, height: 844, mobile: true });
  try { await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Ho_Chi_Minh' }); }
  catch (error) { await b.close(); throw error; }
  return { f, farmer, b };
}

async function signIn(b, credentials) {
  await b.waitFor('!!document.querySelector("input[name=phone]")');
  await b.fill('input[name=phone]', credentials.phone);
  await b.fill('input[name=password]', credentials.password);
  await b.click('form button[type=submit]');
}

async function reloadAndSignIn(b, credentials) {
  // Deliberate product policy: reload clears the in-memory browser session.
  await b.send('Page.reload');
  await b.waitFor("location.hash.startsWith('#/chung/C-01?tiep=')");
  await signIn(b, credentials);
}

test('TC-16 mật khẩu sai giữ ở C-01, nhập lại đúng quay về F-02', async (t) => {
  const { f, farmer, b } = await browserFixture(t);
  try {
    await b.go(`${f.origin}/v2/#/nong-dan/F-02`);
    await b.waitFor("location.hash === '#/chung/C-01?tiep=%2Fnong-dan%2FF-02'");
    await signIn(b, { ...farmer.credentials, password: 'WrongBtth5!123' });
    await b.waitText('Số điện thoại hoặc mật khẩu không đúng.');
    assert.match(await b.ev('location.hash'), /^#\/chung\/C-01/);
    assert.deepEqual(await f.rows('SELECT user_id FROM account.sessions'), []);
    await signIn(b, farmer.credentials);
    await b.waitFor("location.hash === '#/nong-dan/F-02'");
    await b.waitText('Thửa ruộng');
    assert.equal(await b.ev("document.querySelector('h1').textContent"), 'Thửa ruộng');
    await b.hash('#/chung/C-02');
    await b.waitText(farmer.name);
    await b.hash('#/htx/H-01');
    await b.waitText('Tài khoản chưa có quyền xem nội dung này');
    assert.deepEqual(await f.rows('SELECT user_id, revoked_at FROM account.sessions'), [{ user_id: farmer.id, revoked_at: null }]);
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); }
});

async function openBooking(b, f, endLocal) {
  await b.hash('#/nong-dan/F-03');
  await b.waitText('Lưu thửa ruộng');
  await b.fill('input[name=name]', FIELD.name);
  await b.fill('input[name=locality]', FIELD.locality);
  await b.fill('input[name=areaM2]', String(FIELD.areaM2));
  await b.clickText('Lưu thửa ruộng', 'button');
  await b.waitFor("location.hash.startsWith('#/nong-dan/F-02')");
  const [{ id }] = await f.rows('SELECT id FROM dispatch.fields');
  await b.hash(`#/nong-dan/F-05?field=${id}&service=${HARVEST}`);
  await b.waitFor('!!document.querySelector("input[name=startLocal]")');
  await b.fill('input[name=startLocal]', '2026-12-01T15:00');
  await b.fill('input[name=endLocal]', endLocal);
  return id;
}

test('TC-17 đặt dịch vụ qua F-05, F-06, F-07; tải lại vẫn đọc được đơn', async (t) => {
  const { f, farmer, b } = await browserFixture(t);
  try {
    await b.go(`${f.origin}/v2/#/chung/C-01`);
    await signIn(b, farmer.credentials);
    await b.waitFor("location.hash === '#/nong-dan/F-01'");
    const fieldId = await openBooking(b, f, '2026-12-01T19:00');
    await b.clickText('Xem bảng giá và xác nhận', 'button');
    await b.waitFor("location.hash.startsWith('#/nong-dan/F-06')");
    await b.waitText('Tổng tạm tính');
    await b.waitText('1.440.000 đ');
    await b.clickText('Xác nhận gửi yêu cầu', 'button');
    await b.waitFor("location.hash.startsWith('#/nong-dan/F-07?id=')");
    const path = await b.ev('location.href');
    // Use a full page reload, not a repeated navigation to the same hash.
    await reloadAndSignIn(b, farmer.credentials);
    await b.waitFor("location.hash.startsWith('#/nong-dan/F-07?id=') && document.querySelector('#main')?.innerText.includes('Tổng tạm tính')");
    await b.waitText(FIELD.name);
    await b.waitText('Đã gửi yêu cầu');
    await b.waitText('1.440.000 đ');
    const id = new URLSearchParams(new URL(path).hash.split('?')[1]).get('id');
    assert.deepEqual(await f.rows('SELECT id, owner_id, field_id, service_id, state, total_vnd, start_at, end_at FROM dispatch.bookings'),
      [{ id, owner_id: farmer.id, field_id: fieldId, service_id: HARVEST, state: 'REQUESTED', total_vnd: '1440000',
        start_at: new Date(START), end_at: new Date(END) }]);
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); }
});

test('TC-18 mở lại báo giá có thông tin vụ, quay về sửa giữ nguyên dữ liệu', async (t) => {
  const { f, farmer, b } = await browserFixture(t);
  try {
    await b.go(`${f.origin}/v2/#/chung/C-01`);
    await signIn(b, farmer.credentials);
    await b.waitFor("location.hash === '#/nong-dan/F-01'");
    const fieldId = await openBooking(b, f, '2026-12-01T19:00');
    await b.fill('input[name=cropVariety]', 'OM 5451');
    await b.fill('input[name=sowDate]', '2026-09-01');
    await b.fill('input[name=harvestDate]', '2026-12-01');
    await b.clickText('Xem bảng giá và xác nhận', 'button');
    await b.waitFor("location.hash.startsWith('#/nong-dan/F-06')");
    await b.waitText('Tổng tạm tính');
    await reloadAndSignIn(b, farmer.credentials);
    await b.waitFor("location.hash.startsWith('#/nong-dan/F-06') && document.querySelector('#main')?.innerText.includes('Tổng tạm tính')");
    await b.clickText('Sửa thông tin đặt dịch vụ', 'a');
    await b.waitFor("location.hash.startsWith('#/nong-dan/F-05') && !!document.querySelector('input[name=endLocal]')");
    assert.deepEqual(await f.rows('SELECT id FROM dispatch.bookings'), []);
    assert.deepEqual(await b.ev("['startLocal','endLocal'].map(name => document.querySelector(`input[name=${name}]`).value)"),
      ['2026-12-01T15:00', '2026-12-01T19:00']);
    assert.deepEqual(await b.ev("['cropVariety','sowDate','harvestDate'].map(name => document.querySelector(`input[name=${name}]`).value)"),
      ['OM 5451', '2026-09-01', '2026-12-01']);
    assert.equal(await b.ev("document.querySelector('select[name=fieldId]').value"), fieldId);
    assert.equal(await b.ev("document.querySelector('input[name=serviceId]:checked').value"), HARVEST);
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); }
});
