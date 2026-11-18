// Browser-only globals are declared here because the root ESLint config is Node-only (parent owns eslint.config.js).
/* global Response, DOMException */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Browser UI contracts. The module under test is plain ES module JS; no DOM library is used.
// API behavior is covered by the parent server tests. Here fetch is injected with fake responses.
const webUrl = new URL('../../web/', import.meta.url);
const read = (name) => readFile(new URL(name, webUrl), 'utf8');
const loadApp = () => import('../../web/app.js');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const BOOKING_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const PAYLOAD = { fieldId: UUID_A, serviceId: UUID_B, startAt: '2026-11-20T01:00:00.000Z', endAt: '2026-11-20T03:00:00.000Z' };
const OTHER_PAYLOAD = { ...PAYLOAD, endAt: '2026-11-20T04:00:00.000Z' };
const BOOKING_DTO = {
  id: BOOKING_ID, state: 'REQUESTED', fieldId: UUID_A, serviceId: UUID_B,
  startAt: PAYLOAD.startAt, endAt: PAYLOAD.endAt,
  field: { name: 'Thửa 1', areaM2: 12000 },
  service: { code: 'tillage-tractor', name: 'Cày', dataLabel: 'synthetic', pricePerHaVnd: '900000' },
  totalVnd: '1080000', createdAt: '2026-11-18T01:00:00.000Z',
};

function fakeFetch(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra request');
    if (step instanceof Error) throw step;
    if (step.hang) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const text = step.raw ?? (step.body === undefined ? null : JSON.stringify(step.body));
    return new Response(text, { status: step.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}
const reply = (status, body) => ({ status, body });

// Local wall-clock text in datetime-local format, the same shape the browser input produces.
function localInput(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

// ---- static contracts -------------------------------------------------------

test('index.html shell is Vietnamese, responsive, and loads one module script', async () => {
  const html = await read('index.html');
  assert.match(html, /<html lang="vi"/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /<link rel="stylesheet" href="styles\.css"/);
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.match(html, /<a class="skip-link" href="#main"/);
  assert.match(html, /<main id="main"/);
});

test('web files avoid HTML string sinks, browser storage, and fixed hosts', async () => {
  for (const name of ['index.html', 'app.js']) {
    const text = await read(name);
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|\beval\(|new Function\(/, name);
    assert.doesNotMatch(text, /https?:\/\/|localhost|127\.0\.0\.1|:300[01]\b|Access-Control/, name);
  }
});

test('web files contain no em dash or en dash', async () => {
  for (const name of ['index.html', 'app.js', 'styles.css']) {
    assert.doesNotMatch(await read(name), /[\u2013\u2014]/, name);
  }
});

test('frontend calls only same-origin contract paths', async () => {
  const text = await read('app.js');
  const paths = new Set([...text.matchAll(/['"`](\/api\/[a-z/]+)/g)].map((m) => m[1].replace(/\/$/, '')));
  const allowed = ['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/me', '/api/services', '/api/fields', '/api/bookings', '/api/coordinators'];
  assert.ok(paths.size >= 6, `found only ${[...paths].join(', ')}`);
  for (const path of paths) assert.ok(allowed.includes(path), `unexpected path ${path}`);
  assert.equal(paths.has('/api/config'), false);
});

test('styles keep the accent palette, 18px body text, 56px primary buttons, focus and reduced motion', async () => {
  const css = (await read('styles.css')).toLowerCase();
  for (const token of ['#15803d', '#faf9f5', '#0f172a']) assert.ok(css.includes(token), token);
  assert.match(css, /font-size:\s*18px/);
  assert.match(css, /min-height:\s*56px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 480px\)/);
});

// ---- routing and input rules -------------------------------------------------

test('parseRoute maps hash routes and rejects malformed ids', async () => {
  const { parseRoute } = await loadApp();
  assert.deepEqual(parseRoute(''), { name: 'services' });
  assert.deepEqual(parseRoute('#services'), { name: 'services' });
  assert.deepEqual(parseRoute(`#services/${UUID_A}`), { name: 'service', id: UUID_A });
  assert.deepEqual(parseRoute(`#request/${UUID_A}`), { name: 'request', id: UUID_A });
  assert.deepEqual(parseRoute('#fields'), { name: 'fields' });
  assert.deepEqual(parseRoute('#register'), { name: 'register' });
  assert.deepEqual(parseRoute('#bookings'), { name: 'bookings' });
  assert.deepEqual(parseRoute(`#booking/${UUID_B}`), { name: 'booking', id: UUID_B });
  assert.deepEqual(parseRoute('#login'), { name: 'login' });
  assert.deepEqual(parseRoute('#services/not-a-uuid'), { name: 'notfound' });
  assert.deepEqual(parseRoute('#unknown'), { name: 'notfound' });
});

test('hidden attribute wins over component display rules', async () => {
  const css = await read('styles.css');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test('missing or invalid price never renders as a number-like fallback', async () => {
  const { priceText } = await loadApp();
  assert.equal(priceText('900000'), '900.000 VND mỗi ha');
  assert.equal(priceText(undefined), 'Chưa có giá');
  assert.equal(priceText('12.5'), 'Chưa có giá');
});

test('server field errors map to the matching input id, unknown fields map to nothing', async () => {
  const { inputIdForServerField } = await loadApp();
  assert.equal(inputIdForServerField('endAt'), 'booking-end');
  assert.equal(inputIdForServerField('startAt'), 'booking-start');
  assert.equal(inputIdForServerField('fieldId'), 'booking-field');
  assert.equal(inputIdForServerField('areaM2'), 'field-area');
  assert.equal(inputIdForServerField('password'), null);
  assert.equal(inputIdForServerField(undefined), null);
});

test('datetime-local input converts to the UTC instant the API expects', async () => {
  const { localToUtcIso } = await loadApp();
  assert.equal(localToUtcIso('2026-11-20T08:00'), new Date(2026, 10, 20, 8, 0).toISOString());
  assert.match(localToUtcIso('2026-11-20T08:00'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(localToUtcIso('2026-02-30T08:00'), null);
  assert.equal(localToUtcIso('2026-11-20T24:00'), null);
  assert.equal(localToUtcIso('20/11/2026 08:00'), null);
  assert.equal(localToUtcIso(''), null);
});

test('booking input sends exactly four keys, requires end after start, and caps span at 30 days', async () => {
  const { validateBookingInput } = await loadApp();
  const base = { fieldId: UUID_A, serviceId: UUID_B, startLocal: '2026-11-20T08:00', endLocal: '2026-11-20T10:00' };
  const ok = validateBookingInput(base);
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(Object.keys(ok.payload).sort(), ['endAt', 'fieldId', 'serviceId', 'startAt']);
  assert.equal(ok.payload.startAt, new Date(2026, 10, 20, 8, 0).toISOString());

  assert.ok(validateBookingInput({ ...base, endLocal: base.startLocal }).errors.endAt);
  assert.ok(validateBookingInput({ ...base, endLocal: '2026-11-19T08:00' }).errors.endAt);

  const start = new Date(2026, 10, 20, 8, 0);
  const exactly30 = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  const plus1Minute = new Date(exactly30.getTime() + 60 * 1000);
  assert.deepEqual(validateBookingInput({ ...base, endLocal: localInput(exactly30) }).errors, {});
  assert.ok(validateBookingInput({ ...base, endLocal: localInput(plus1Minute) }).errors.endAt);

  assert.ok(validateBookingInput({ ...base, fieldId: '' }).errors.fieldId);
  assert.ok(validateBookingInput({ ...base, serviceId: 'bad' }).errors.serviceId);
  assert.ok(validateBookingInput({ ...base, startLocal: '' }).errors.startAt);
  assert.equal(validateBookingInput({ ...base, startLocal: '' }).payload, null);
});

test('field input needs a name, locality and whole m2 within API bounds', async () => {
  const { validateFieldInput } = await loadApp();
  assert.deepEqual(
    validateFieldInput({ name: ' Thửa 1 ', locality: 'Cần Thơ', areaText: '12000' }),
    { errors: {}, payload: { name: 'Thửa 1', locality: 'Cần Thơ', areaM2: 12000 } },
  );
  for (const areaText of ['12.000', '0', '10000001', '1.5', '', 'abc']) {
    assert.ok(validateFieldInput({ name: 'A', locality: 'B', areaText }).errors.areaM2, areaText);
  }
  assert.ok(validateFieldInput({ name: '', locality: 'B', areaText: '1' }).errors.name);
  assert.ok(validateFieldInput({ name: 'A', locality: '', areaText: '1' }).errors.locality);
  assert.ok(validateFieldInput({ name: 'x'.repeat(121), locality: 'B', areaText: '1' }).errors.name);
});

test('registration and login follow account rules before any request', async () => {
  const { validateRegistration, validateLogin, utf8Length } = await loadApp();
  const ok = validateRegistration({ email: ' Farmer@Example.COM ', password: 'x'.repeat(12), name: ' Nông dân ' });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.payload, { email: 'farmer@example.com', password: 'x'.repeat(12), name: 'Nông dân' });
  assert.ok(validateRegistration({ email: 'a@b.co', password: 'x'.repeat(11), name: 'A' }).errors.password);
  assert.ok(validateRegistration({ email: 'a@b.co', password: 'ệ'.repeat(43), name: 'A' }).errors.password);
  assert.equal(validateRegistration({ email: 'a@b.co', password: 'ệ'.repeat(42), name: 'A' }).errors.password, undefined);
  assert.ok(validateRegistration({ email: 'bad', password: 'x'.repeat(12), name: 'A' }).errors.email);
  assert.ok(validateRegistration({ email: 'a@b.co', password: 'x'.repeat(12), name: '' }).errors.name);
  assert.equal(utf8Length('ệ'), 3);
  assert.ok(validateLogin({ email: 'a@b.co', password: '' }).errors.password);
});

test('formatting keeps VND integers and m2 with ha consistent', async () => {
  const { formatVnd, formatArea, priceLabel } = await loadApp();
  assert.equal(formatVnd('1200000'), '1.200.000 VND');
  assert.equal(formatVnd('12.5'), null);
  assert.equal(formatVnd(1200000), null);
  assert.equal(formatArea(12000), '12.000 m² (1,2 ha)');
  assert.equal(formatArea(0), null);
  assert.equal(priceLabel({ dataLabel: 'synthetic' }), 'Giá mô phỏng');
  assert.doesNotMatch(priceLabel({ dataLabel: 'real-labelled' }), /mô phỏng/);
  assert.equal(priceLabel({ dataLabel: 'other' }), null);
});

test('error messages are Vietnamese and never echo unknown raw codes', async () => {
  const { messageForError, ApiError } = await loadApp();
  assert.match(messageForError(new ApiError(401, 'UNAUTHENTICATED')), /hết hạn/);
  assert.match(messageForError(new ApiError(0, 'NETWORK', { uncertain: true })), /kết nối/);
  assert.match(messageForError(new ApiError(503, 'DB_UNAVAILABLE', { uncertain: true })), /chưa sẵn sàng/);
  assert.equal(messageForError(new ApiError(400, 'WHATEVER')).includes('WHATEVER'), false);
});

test('generic 503 on a public read does not blame identity or ask to check bookings', async () => {
  const { messageForError, ApiError } = await loadApp();
  const generic = messageForError(new ApiError(503, 'SERVICE_UNAVAILABLE'));
  assert.match(generic, /chưa sẵn sàng/);
  assert.doesNotMatch(generic, /đăng nhập|đơn của tôi/);
  const unknown = messageForError(new ApiError(503, 'UNKNOWN'));
  assert.doesNotMatch(unknown, /đăng nhập|đơn của tôi/);
});

test('error block shows the booking-check hint only through write-specific messages', async () => {
  const text = await read('app.js');
  // The generic hint line was shown on every read error; it must not come back as a blanket sentence.
  assert.doesNotMatch(text, /Tải lại đơn của tôi để xem trạng thái thực tế trước khi gửi lại/);
});

test('idempotency keys match the server pattern and differ per call', async () => {
  const { newIdempotencyKey } = await loadApp();
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  assert.match(a, /^[A-Za-z0-9._~-]{16,128}$/);
  assert.notEqual(a, b);
});

// ---- API client -------------------------------------------------------------

test('api client sends bearer only on protected calls and refuses protected calls without a token', async () => {
  const { createApiClient, ApiError } = await loadApp();
  const { fetchImpl, calls } = fakeFetch(reply(200, { items: [] }), reply(200, { items: [] }));
  const api = createApiClient({ fetchImpl, getToken: () => TOKEN });
  await api.request('GET', '/api/services');
  await api.request('GET', '/api/bookings', { auth: true });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${TOKEN}`);

  const none = fakeFetch();
  const anon = createApiClient({ fetchImpl: none.fetchImpl, getToken: () => null });
  await assert.rejects(anon.request('GET', '/api/bookings', { auth: true }), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(none.calls.length, 0);
});

test('401 on a protected call fires session expiry, but a failed login does not', async () => {
  const { createApiClient, ApiError } = await loadApp();
  let expired = 0;
  const { fetchImpl } = fakeFetch(reply(401, { error: { code: 'UNAUTHENTICATED' } }), reply(401, { error: { code: 'INVALID_CREDENTIALS' } }));
  const api = createApiClient({ fetchImpl, getToken: () => TOKEN, onUnauthorized: () => { expired += 1; } });
  await assert.rejects(api.request('GET', '/api/bookings', { auth: true }), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(expired, 1);
  await assert.rejects(api.request('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'x' } }), (e) => e.code === 'INVALID_CREDENTIALS');
  assert.equal(expired, 1);
});

test('5xx, timeouts and dropped connections are uncertain, never success', async () => {
  const { createApiClient, ApiError } = await loadApp();
  const { fetchImpl } = fakeFetch(reply(503, { error: { code: 'DB_UNAVAILABLE' } }), new TypeError('fetch failed'), { hang: true });
  const api = createApiClient({ fetchImpl, getToken: () => TOKEN, timeoutMs: 5 });
  await assert.rejects(api.request('POST', '/api/bookings', { auth: true, body: {} }), (e) => e instanceof ApiError && e.status === 503 && e.uncertain === true);
  await assert.rejects(api.request('POST', '/api/bookings', { auth: true, body: {} }), (e) => e instanceof ApiError && e.uncertain === true);
  await assert.rejects(api.request('POST', '/api/bookings', { auth: true, body: {} }), (e) => e instanceof ApiError && e.code === 'TIMEOUT' && e.uncertain === true);
});

test('204 returns no body and a malformed 2xx body is an error', async () => {
  const { createApiClient, ApiError } = await loadApp();
  const { fetchImpl } = fakeFetch(reply(204), { status: 200, raw: 'not json' });
  const api = createApiClient({ fetchImpl, getToken: () => TOKEN });
  assert.deepEqual(await api.request('POST', '/api/auth/logout', { auth: true }), { status: 204, data: null });
  await assert.rejects(api.request('GET', '/api/services'), (e) => e instanceof ApiError && e.code === 'BAD_RESPONSE');
});

test('response body timeout stays bounded after headers arrive', async () => {
  const { createApiClient, ApiError } = await loadApp();
  const api = createApiClient({ getToken: () => TOKEN, timeoutMs: 5, fetchImpl: async (_path, init) => ({
    status: 200, ok: true,
    text: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  }) });
  const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Body timeout was cleared at headers')), 80));
  await assert.rejects(Promise.race([api.request('GET', '/api/services'), timeout]), (error) => error instanceof ApiError && error.code === 'TIMEOUT');
});

// ---- booking submit and idempotency ----------------------------------------

test('retry after a dropped connection reuses the same Idempotency-Key and ends created', async () => {
  const { createApiClient, createAttemptTracker, submitBooking, ApiError } = await loadApp();
  const { fetchImpl, calls } = fakeFetch(new TypeError('network down'), reply(201, { booking: BOOKING_DTO }));
  const api = createApiClient({ fetchImpl, getToken: () => TOKEN });
  const tracker = createAttemptTracker();
  await assert.rejects(submitBooking({ api, tracker, payload: PAYLOAD }), (e) => e instanceof ApiError && e.uncertain === true);
  assert.equal(tracker.current().uncertain, true);
  const result = await submitBooking({ api, tracker, payload: PAYLOAD });
  assert.equal(result.kind, 'created');
  assert.equal(result.booking.id, BOOKING_ID);
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
  assert.ok(calls[0].init.headers['Idempotency-Key'].length >= 16);
  assert.equal(tracker.current(), null);
});

test('changed payload after an uncertain attempt is blocked until an explicit new attempt', async () => {
  const { createApiClient, createAttemptTracker, submitBooking } = await loadApp();
  const { fetchImpl, calls } = fakeFetch(new TypeError('network down'), reply(201, { booking: BOOKING_DTO }));
  const api = createApiClient({ fetchImpl, getToken: () => TOKEN });
  const tracker = createAttemptTracker();
  await assert.rejects(submitBooking({ api, tracker, payload: PAYLOAD }));
  const blocked = await submitBooking({ api, tracker, payload: OTHER_PAYLOAD });
  assert.equal(blocked.kind, 'blocked');
  assert.equal(calls.length, 1);
  const created = await submitBooking({ api, tracker, payload: OTHER_PAYLOAD, newAttempt: true });
  assert.equal(created.kind, 'created');
  assert.notEqual(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
});

test('definitive validation error clears the attempt and keeps the server field name', async () => {
  const { createApiClient, createAttemptTracker, submitBooking, ApiError } = await loadApp();
  const { fetchImpl } = fakeFetch(reply(400, { error: { code: 'VALIDATION_FAILED', field: 'endAt' } }));
  const api = createApiClient({ fetchImpl, getToken: () => TOKEN });
  const tracker = createAttemptTracker();
  await assert.rejects(submitBooking({ api, tracker, payload: PAYLOAD }), (e) => e instanceof ApiError && e.field === 'endAt' && e.uncertain === false);
  assert.equal(tracker.current(), null);
});

test('expired session keeps the pending key so a re-login retry cannot duplicate', async () => {
  const { createApiClient, createAttemptTracker, submitBooking, ApiError } = await loadApp();
  const { fetchImpl, calls } = fakeFetch(reply(401, { error: { code: 'UNAUTHENTICATED' } }), reply(201, { booking: BOOKING_DTO }));
  const api = createApiClient({ fetchImpl, getToken: () => TOKEN });
  const tracker = createAttemptTracker();
  await assert.rejects(submitBooking({ api, tracker, payload: PAYLOAD }), (e) => e instanceof ApiError && e.status === 401);
  assert.notEqual(tracker.current(), null);
  assert.equal((await submitBooking({ api, tracker, payload: PAYLOAD })).kind, 'created');
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
});

test('503 never reports a created booking, and a 2xx without a booking is not success', async () => {
  const { createApiClient, createAttemptTracker, submitBooking, ApiError } = await loadApp();
  const first = fakeFetch(reply(503, { error: { code: 'DB_UNAVAILABLE' } }));
  const tracker = createAttemptTracker();
  await assert.rejects(submitBooking({ api: createApiClient({ fetchImpl: first.fetchImpl, getToken: () => TOKEN }), tracker, payload: PAYLOAD }), (e) => e.status === 503 && e.uncertain);
  assert.equal(tracker.current().uncertain, true);

  const second = fakeFetch(reply(201, {}));
  await assert.rejects(submitBooking({ api: createApiClient({ fetchImpl: second.fetchImpl, getToken: () => TOKEN }), tracker, payload: PAYLOAD }), (e) => e instanceof ApiError && e.code === 'BAD_RESPONSE');
});
