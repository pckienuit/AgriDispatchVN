import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePhone } from '../../server/src/account-app.js';
import { quoteTotalVnd, validateBookingInput } from '../../server/src/booking.js';
import { packageWindow, validatePackageInput } from '../../server/src/dispatch.js';
import { codeAllowedInRole, homeSlugFor } from '../../web/v2/app/routes.js';
import { quoteTotalVnd as quoteUi } from '../../web/v2/screens/farmer.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const booking = { fieldId: id(1), serviceId: id(2), startAt: '2026-12-01T00:00:00Z' };
const windowAt = (start, end) => ({
  serviceId: id(2), locality: 'Xã thử nghiệm',
  startAt: new Date(`2026-12-01T${start}:00:00Z`), endAt: new Date(`2026-12-01T${end}:00:00Z`),
});

test('TC-01 chuẩn hóa số điện thoại', () => {
  for (const phone of ['0912.345.678', '+84 912 345 678', '84912345678']) {
    assert.equal(normalizePhone(phone), '0912345678');
  }
});

test('TC-02 số nội địa 9, 10 và 11 chữ số', () => {
  assert.equal(normalizePhone('0912345678'), '0912345678');
  for (const phone of ['091234567', '09123456789']) {
    assert.throws(() => normalizePhone(phone), { status: 400, code: 'INVALID_REQUEST' });
  }
});

test('TC-03 giao diện chọn trang nông dân và lọc mã màn theo vai trò', () => {
  assert.equal(homeSlugFor({ roles: ['farmer'] }), 'nong-dan');
  assert.equal(codeAllowedInRole('F-02', 'nong-dan'), true);
  assert.equal(codeAllowedInRole('H-01', 'nong-dan'), false);
});

test('TC-04 lịch đúng 30 ngày, lệch thêm 1 ms và bằng 0', () => {
  const endAt = '2026-12-31T00:00:00.000Z';
  assert.equal(validateBookingInput({ ...booking, endAt }).endAt, endAt);
  for (const invalid of ['2026-12-31T00:00:00.001Z', booking.startAt]) {
    assert.throws(() => validateBookingInput({ ...booking, endAt: invalid }),
      { status: 400, code: 'VALIDATION_FAILED', field: 'endAt' });
  }
});

test('TC-05 không tự dời ngày 30/02 sang tháng 3', () => {
  assert.throws(() => validateBookingInput({ ...booking, startAt: '2026-02-30T08:00:00Z', endAt: '2026-03-03T08:00:00Z' }),
    { status: 400, code: 'VALIDATION_FAILED', field: 'startAt' });
});

test('TC-06 giá dưới, đúng và trên nửa đồng làm tròn như nhau ở UI và API', () => {
  for (const [price, expected] of [[14999, 1], [15000, 2], [15001, 2]]) {
    assert.equal(quoteTotalVnd(price, 1), BigInt(expected));
    assert.equal(quoteUi(price, 1), String(expected));
  }
});

test('TC-07 gom gói chấp nhận 1 và 100 đơn, từ chối 0 và 101', () => {
  const ids = Array.from({ length: 101 }, (_, i) => id(i + 1));
  for (const n of [1, 100]) assert.deepEqual(validatePackageInput({ bookingIds: ids.slice(0, n) }).bookingIds, ids.slice(0, n));
  for (const bookingIds of [[], ids]) {
    assert.throws(() => validatePackageInput({ bookingIds }), { status: 400, code: 'VALIDATION_FAILED', field: 'bookingIds' });
  }
});

test('TC-08 gom gói từ chối ID đơn bị lặp', () => {
  assert.throws(() => validatePackageInput({ bookingIds: [id(1), id(1)] }),
    { status: 400, code: 'VALIDATION_FAILED', field: 'bookingIds' });
});

test('TC-09 giao lịch dương được giữ, hai lịch chỉ chạm mốc không có giao', () => {
  const first = windowAt('08', '12');
  const second = windowAt('10', '14');
  assert.deepEqual(packageWindow([first, second]), { start: second.startAt, end: first.endAt });
  assert.equal(packageWindow([first, windowAt('12', '14')]), null);
});
