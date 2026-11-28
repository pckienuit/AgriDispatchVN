import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { END, HARVEST, START, fixture } from '../fixture.js';

const invalid = (status, code, field) => ({ status, body: { error: { code, ...(field ? { field } : {}) } } });
const bookingInput = (fieldId, startAt = START, endAt = END) => ({ fieldId, serviceId: HARVEST, startAt, endAt });

async function sessions(f, userId) {
  return f.rows('SELECT token_hash, revoked_at IS NOT NULL AS revoked FROM account.sessions WHERE user_id = $1', [userId]);
}

test('TC-10 đăng nhập hợp lệ, đọc phiên, đăng xuất thu hồi', async (t) => {
  const f = await fixture(t);
  const u = await f.user(1, { login: false });
  const login = await f.request('POST', '/api/auth/login', { body: u.credentials });
  assert.equal(login.status, 200);
  const { token, expiresAt } = login.body;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(expiresAt) > Date.now());
  const publicUser = { id: u.id, phone: u.credentials.phone, email: null, name: u.name, roles: ['farmer'] };
  assert.deepEqual(login.body.user, publicUser);
  const token_hash = createHash('sha256').update(token).digest('hex');
  assert.deepEqual(await sessions(f, u.id), [{ token_hash, revoked: false }]);
  const [{ password_hash: hash }] = await f.rows('SELECT password_hash FROM account.users WHERE id = $1', [u.id]);
  assert.ok(hash.startsWith('scrypt:v1:') && !JSON.stringify(login.body).includes(hash), 'password hash must stay in DB');
  assert.deepEqual(await f.request('GET', '/api/me', { token }), { status: 200, body: { user: publicUser } });
  assert.deepEqual(await f.request('POST', '/api/auth/logout', { token }), { status: 204, body: null });
  assert.deepEqual(await f.request('GET', '/api/me', { token }), invalid(401, 'UNAUTHORIZED'));
  assert.deepEqual(await sessions(f, u.id), [{ token_hash, revoked: true }]);
});

test('TC-11 sai mật khẩu không tạo phiên', async (t) => {
  const f = await fixture(t);
  const u = await f.user(1, { login: false });
  const before = await f.rows('SELECT id, phone, name, created_at FROM account.users WHERE id = $1', [u.id]);
  const body = { ...u.credentials, password: 'WrongBtth5!123' };
  assert.deepEqual(await f.request('POST', '/api/auth/login', { body }), invalid(401, 'INVALID_CREDENTIALS'));
  assert.deepEqual(await sessions(f, u.id), []);
  assert.deepEqual(await f.rows('SELECT id, phone, name, created_at FROM account.users WHERE id = $1', [u.id]), before);
});

test('TC-12 gửi lại cùng khóa chỉ tạo một đơn, một sự kiện và một khóa', async (t) => {
  const f = await fixture(t);
  const { token, id } = await f.user(1);
  const fieldId = await f.field(token);
  const input = { token, body: bookingInput(fieldId), key: 'btth5-booking-key-12' };
  const first = await f.request('POST', '/api/bookings', input);
  assert.equal(first.status, 201);
  const { booking } = first.body;
  assert.deepEqual([booking.fieldId, booking.startAt, booking.endAt, booking.state, booking.totalVnd],
    [fieldId, START, END, 'REQUESTED', '1440000']);
  assert.deepEqual(await f.request('POST', '/api/bookings', input), first);
  assert.deepEqual(await f.rows('SELECT id, state, total_vnd FROM dispatch.bookings WHERE owner_id = $1', [id]),
    [{ id: booking.id, state: 'REQUESTED', total_vnd: '1440000' }]);
  assert.deepEqual(await f.rows('SELECT event_type, to_state FROM dispatch.booking_events WHERE booking_id = $1', [booking.id]),
    [{ event_type: 'BOOKING_REQUESTED', to_state: 'REQUESTED' }]);
  assert.deepEqual(await f.rows('SELECT idempotency_key, booking_id FROM dispatch.idempotency_keys WHERE actor_id = $1', [id]),
    [{ idempotency_key: input.key, booking_id: booking.id }]);
});

test('TC-13 lịch bằng 0 không tạo đơn, sự kiện hay giữ khóa', async (t) => {
  const f = await fixture(t);
  const { token } = await f.user(1);
  const body = bookingInput(await f.field(token), START, START);
  assert.deepEqual(await f.request('POST', '/api/bookings', { token, body, key: 'btth5-booking-key-13' }),
    invalid(400, 'VALIDATION_FAILED', 'endAt'));
  for (const table of ['bookings', 'booking_events', 'idempotency_keys']) {
    assert.deepEqual(await f.rows(`SELECT count(*)::int AS n FROM dispatch.${table}`), [{ n: 0 }]);
  }
});

async function delegated(f, secondStart) {
  const farmer = await f.user(1);
  const coop = await f.user(2, { coop: true });
  const token = farmer.token;
  const fieldId = await f.field(token);
  const bookingIds = [];
  for (const [i, body] of [bookingInput(fieldId), bookingInput(fieldId, secondStart, '2026-12-01T14:00:00.000Z')].entries()) {
    const created = await f.request('POST', '/api/bookings', { token, body, key: `btth5-delegated-key-${i}` });
    assert.equal(created.status, 201);
    const { id } = created.body.booking;
    const delegation = await f.request('POST', `/api/bookings/${id}/coordinator`, { token, body: { coordinatorId: coop.id } });
    assert.deepEqual(delegation, { status: 200, body: { booking: { id, state: 'REQUESTED', coordinatorId: coop.id } } });
    bookingIds.push(id);
  }
  return { coop, farmer, bookingIds };
}

test('TC-14 HTX gom hai đơn có giao lịch, chuyển cả hai sang GROUPED', async (t) => {
  const f = await fixture(t);
  const startAt = '2026-12-01T10:00:00.000Z';
  const { coop, farmer, bookingIds } = await delegated(f, startAt);
  const body = { bookingIds };
  assert.deepEqual(await f.request('POST', '/api/packages', { token: farmer.token, body }), invalid(403, 'FORBIDDEN'));
  assert.deepEqual(await f.rows('SELECT id FROM dispatch.packages'), []);
  const grouped = await f.request('POST', '/api/packages', { token: coop.token, body });
  assert.equal(grouped.status, 201);
  const pkg = grouped.body.package;
  assert.deepEqual([pkg.status, pkg.window, pkg.bookingCount], ['OPEN', { startAt, endAt: END }, 2]);
  assert.deepEqual(await f.rows('SELECT id, status, coop_id FROM dispatch.packages'), [{ id: pkg.id, status: 'OPEN', coop_id: coop.id }]);
  assert.deepEqual(await f.rows('SELECT booking_id FROM dispatch.package_bookings WHERE package_id = $1 ORDER BY booking_id', [pkg.id]),
    bookingIds.slice().sort().map((booking_id) => ({ booking_id })));
  assert.deepEqual(await f.rows('SELECT state FROM dispatch.bookings ORDER BY id'), [{ state: 'GROUPED' }, { state: 'GROUPED' }]);
  assert.deepEqual(await f.rows("SELECT booking_id, to_state FROM dispatch.booking_events WHERE event_type = 'BOOKING_GROUPED' ORDER BY booking_id"),
    bookingIds.slice().sort().map((booking_id) => ({ booking_id, to_state: 'GROUPED' })));
});

test('TC-15 HTX không gom khi hai lịch chỉ chạm mốc', async (t) => {
  const f = await fixture(t);
  const { coop, bookingIds } = await delegated(f, END);
  assert.deepEqual(await f.request('POST', '/api/packages', { token: coop.token, body: { bookingIds } }),
    invalid(409, 'PACKAGE_INCOMPATIBLE'));
  for (const table of ['packages', 'package_bookings']) assert.deepEqual(await f.rows(`SELECT * FROM dispatch.${table}`), []);
  assert.deepEqual(await f.rows('SELECT state FROM dispatch.bookings ORDER BY id'), [{ state: 'REQUESTED' }, { state: 'REQUESTED' }]);
  assert.deepEqual(await f.rows("SELECT booking_id FROM dispatch.booking_events WHERE event_type = 'BOOKING_GROUPED'"), []);
});
