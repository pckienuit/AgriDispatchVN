import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import {
  MAX_SCHEDULE_SPAN_MS,
  canonicalPayloadHash,
  createBookingRouter,
  parseIdempotencyKey,
  quoteTotalVnd,
  validateBookingInput,
} from '../src/booking.js';

const FARMER_ID = '11111111-1111-4111-8111-111111111111';
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
const FIELD_ID = '44444444-4444-4444-8444-444444444444';
const SERVICE_ID = '55555555-5555-4555-8555-555555555555';
const KEY = 'booking-key-000000000001';
const VALID = {
  fieldId: FIELD_ID,
  serviceId: SERVICE_ID,
  startAt: '2026-11-25T08:00:00Z',
  endAt: '2026-11-25T12:00:00Z',
};

// TEST SEAM ONLY: static bearer tokens stand in for the parent's cross-service authenticate middleware.
const TEST_ACTORS = {
  'tok-farmer': { id: FARMER_ID, roles: ['farmer'], name: 'Farmer' },
  'tok-provider': { id: PROVIDER_ID, roles: ['provider'], name: 'Provider' },
  'tok-no-actor': null,
};

function testAuthenticate(req, res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!Object.hasOwn(TEST_ACTORS, token)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  if (TEST_ACTORS[token]) req.actor = TEST_ACTORS[token];
  return next();
}

function noDbPool() {
  const calls = [];
  const refuse = async (...args) => {
    calls.push(args);
    throw new Error('DB must not be queried');
  };
  return { calls, query: refuse, connect: refuse };
}

async function serve(t, pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(createBookingRouter({ pool, authenticate: testAuthenticate }));
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('router factory requires a pool with query() and an authenticate middleware', () => {
  assert.throws(() => createBookingRouter({ authenticate: testAuthenticate }), TypeError);
  assert.throws(() => createBookingRouter({ pool: {}, authenticate: testAuthenticate }), TypeError);
  assert.throws(() => createBookingRouter({ pool: noDbPool() }), TypeError);
});

test('instants must be canonical UTC ISO and are normalized to milliseconds', () => {
  const normalized = validateBookingInput(VALID);
  assert.deepEqual(normalized, {
    fieldId: FIELD_ID,
    serviceId: SERVICE_ID,
    startAt: '2026-11-25T08:00:00.000Z',
    endAt: '2026-11-25T12:00:00.000Z',
  });
  assert.equal(validateBookingInput({ ...VALID, startAt: '2026-11-25T08:00:00.000Z' }).startAt, normalized.startAt);
  for (const startAt of [
    '2026-11-25T08:00:00+07:00', '2026-11-25 08:00:00Z', '2026-11-25T08:00Z', '2026-02-30T08:00:00Z',
    '2026-11-25T24:00:00Z', 'yesterday', 20261125,
  ]) {
    assert.throws(() => validateBookingInput({ ...VALID, startAt }), { status: 400, code: 'VALIDATION_FAILED', field: 'startAt' }, String(startAt));
  }
});

test('booking body accepts exactly four keys and lowercases UUIDs', () => {
  assert.equal(validateBookingInput({ ...VALID, fieldId: FIELD_ID.toUpperCase() }).fieldId, FIELD_ID);
  for (const body of [[], 'text', null, undefined]) {
    assert.throws(() => validateBookingInput(body), { status: 400, code: 'INVALID_BODY' }, String(body));
  }
  for (const key of ['ownerId', 'requesterId', 'state', 'status', 'totalVnd']) {
    assert.throws(() => validateBookingInput({ ...VALID, [key]: 'x' }), { status: 400, code: 'UNKNOWN_FIELD' }, key);
  }
  assert.throws(() => validateBookingInput({ ...VALID, fieldId: undefined }), { status: 400, code: 'VALIDATION_FAILED', field: 'fieldId' });
  assert.throws(() => validateBookingInput({ ...VALID, serviceId: 'svc-1' }), { status: 400, code: 'VALIDATION_FAILED', field: 'serviceId' });
  assert.throws(() => validateBookingInput({ ...VALID, fieldId: 12345 }), { status: 400, code: 'VALIDATION_FAILED', field: 'fieldId' });
});

test('schedule must be strictly ordered and within the demo span bound', () => {
  assert.equal(MAX_SCHEDULE_SPAN_MS, 30 * 24 * 60 * 60 * 1000);
  assert.throws(() => validateBookingInput({ ...VALID, endAt: VALID.startAt }), { status: 400, code: 'VALIDATION_FAILED', field: 'endAt' });
  assert.throws(() => validateBookingInput({ ...VALID, endAt: '2026-11-25T07:59:59Z' }), { status: 400, code: 'VALIDATION_FAILED', field: 'endAt' });
  const exactly = validateBookingInput({ ...VALID, startAt: '2026-11-01T00:00:00Z', endAt: '2026-12-01T00:00:00Z' });
  assert.equal(exactly.endAt, '2026-12-01T00:00:00.000Z');
  assert.throws(
    () => validateBookingInput({ ...VALID, startAt: '2026-11-01T00:00:00Z', endAt: '2026-12-01T00:00:01Z' }),
    { status: 400, code: 'VALIDATION_FAILED', field: 'endAt' },
  );
});

test('idempotency key accepts a UUID or 16 to 128 safe ASCII characters only', () => {
  for (const key of ['a'.repeat(16), 'A'.repeat(128), 'booking.key_~-1234567', '0f9c2a7e-6b1d-4c2a-9e8f-1a2b3c4d5e6f']) {
    assert.equal(parseIdempotencyKey(key), key);
  }
  for (const key of [undefined, '', 'a'.repeat(15), 'a'.repeat(129), 'bad key with spaces', 'bad/slash/key/16', 'ký-tự-unicode-dài-16', ['a'.repeat(16)]]) {
    assert.throws(() => parseIdempotencyKey(key), { status: 400, code: 'VALIDATION_FAILED', field: 'Idempotency-Key' }, String(key));
  }
});

test('canonical payload hash is stable for equivalent input and changes with every field', () => {
  const base = canonicalPayloadHash(validateBookingInput(VALID));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(canonicalPayloadHash(validateBookingInput({
    ...VALID, fieldId: FIELD_ID.toUpperCase(), startAt: '2026-11-25T08:00:00.000Z',
  })), base);
  const changed = [
    { fieldId: '44444444-4444-4444-8444-444444444445' },
    { serviceId: '55555555-5555-4555-8555-555555555556' },
    { startAt: '2026-11-25T08:00:01Z' },
    { endAt: '2026-11-25T12:00:01Z' },
  ];
  for (const patch of changed) {
    assert.notEqual(canonicalPayloadHash(validateBookingInput({ ...VALID, ...patch })), base, JSON.stringify(patch));
  }
});

test('quote rounds total VND half up to whole dong using BigInt', () => {
  assert.equal(quoteTotalVnd(900000, 12000), 1080000n);
  assert.equal(quoteTotalVnd('1000000', 2000), 200000n);
  assert.equal(quoteTotalVnd(15, 1000), 2n);
  assert.equal(quoteTotalVnd(5, 1000), 1n);
  assert.equal(quoteTotalVnd(4, 1000), 0n);
  assert.equal(quoteTotalVnd(5, 999), 0n);
  assert.equal(quoteTotalVnd(900000n * 10000n, 10000000), 9000000000000n);
});

test('router rejects auth, role, key and body errors before touching the database', async (t) => {
  const pool = noDbPool();
  const url = await serve(t, pool);
  const cases = [
    ['POST', '/api/bookings', undefined, KEY, VALID, 401, { error: { code: 'UNAUTHENTICATED' } }],
    ['POST', '/api/bookings', 'tok-no-actor', KEY, VALID, 401, { error: { code: 'UNAUTHENTICATED' } }],
    ['POST', '/api/bookings', 'tok-provider', KEY, VALID, 403, { error: { code: 'FORBIDDEN' } }],
    ['POST', '/api/bookings', 'tok-farmer', undefined, VALID, 400, { error: { code: 'VALIDATION_FAILED', field: 'Idempotency-Key' } }],
    ['POST', '/api/bookings', 'tok-farmer', 'short', VALID, 400, { error: { code: 'VALIDATION_FAILED', field: 'Idempotency-Key' } }],
    ['POST', '/api/bookings', 'tok-farmer', KEY, { ...VALID, ownerId: PROVIDER_ID }, 400, { error: { code: 'UNKNOWN_FIELD' } }],
    ['POST', '/api/bookings', 'tok-farmer', KEY, { ...VALID, endAt: VALID.startAt }, 400, { error: { code: 'VALIDATION_FAILED', field: 'endAt' } }],
    ['GET', '/api/bookings', undefined, undefined, undefined, 401, { error: { code: 'UNAUTHENTICATED' } }],
    ['GET', '/api/bookings/not-a-uuid', 'tok-farmer', undefined, undefined, 400, { error: { code: 'INVALID_ID' } }],
    ['GET', '/api/bookings?limit=0', 'tok-farmer', undefined, undefined, 400, { error: { code: 'INVALID_PAGINATION' } }],
  ];
  for (const [method, path, token, key, body, status, expected] of cases) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (key !== undefined) headers['idempotency-key'] = key;
    const init = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${url}${path}`, init);
    assert.equal(response.status, status, `${method} ${path} ${token}`);
    assert.deepEqual(await response.json(), expected, `${method} ${path} ${token}`);
  }
  assert.deepEqual(pool.calls, []);
});
