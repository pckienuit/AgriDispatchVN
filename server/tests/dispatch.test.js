import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDispatchRouter, packageWindow, validateCoordinatorInput, validatePackageInput } from '../src/dispatch.js';

const COOP = '10000000-0000-4000-8000-000000000003';
const B1 = '20000000-0000-4000-8000-000000000001';
const SERVICE = '00000000-0000-4000-8000-000000000101';
const at = (hour) => new Date(Date.UTC(2026, 10, 25, hour));

test('router factory fails closed without pool or authenticate', () => {
  assert.throws(() => createDispatchRouter({ authenticate() {} }), TypeError);
  assert.throws(() => createDispatchRouter({ pool: { query() {}, connect() {} } }), TypeError);
});

test('coordinator body accepts only coordinatorId as a UUID', () => {
  assert.deepEqual(validateCoordinatorInput({ coordinatorId: COOP.toUpperCase() }), { coordinatorId: COOP });
  assert.throws(() => validateCoordinatorInput({ coordinatorId: 'x' }), { code: 'VALIDATION_FAILED', field: 'coordinatorId' });
  assert.throws(() => validateCoordinatorInput({ coordinatorId: COOP, owner: COOP }), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateCoordinatorInput(['x']), { code: 'INVALID_BODY' });
});

test('package body bounds count to 1..100 distinct UUIDs and normalizes case', () => {
  assert.deepEqual(validatePackageInput({ bookingIds: [B1.toUpperCase()] }), { bookingIds: [B1] });
  assert.throws(() => validatePackageInput({ bookingIds: [] }), { code: 'VALIDATION_FAILED', field: 'bookingIds' });
  assert.throws(() => validatePackageInput({ bookingIds: [B1, B1.toUpperCase()] }), { code: 'VALIDATION_FAILED' });
  assert.throws(() => validatePackageInput({ bookingIds: [B1, 'x'] }), { code: 'VALIDATION_FAILED' });
  const many = Array.from({ length: 101 }, (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.throws(() => validatePackageInput({ bookingIds: many }), { code: 'VALIDATION_FAILED' });
  assert.throws(() => validatePackageInput({ bookingIds: [B1], status: 'OPEN' }), { code: 'UNKNOWN_FIELD' });
});

test('packageWindow returns the interval intersection for compatible bookings', () => {
  const window = packageWindow([
    { serviceId: SERVICE, locality: 'Châu Thành', startAt: at(8), endAt: at(12) },
    { serviceId: SERVICE, locality: 'Châu Thành', startAt: at(10), endAt: at(14) },
  ]);
  assert.deepEqual(window, { start: at(10), end: at(12) });
});

test('packageWindow rejects touching windows, mixed service and mixed locality', () => {
  const base = { serviceId: SERVICE, locality: 'Châu Thành', startAt: at(8), endAt: at(12) };
  assert.equal(packageWindow([base, { ...base, startAt: at(12), endAt: at(16) }]), null);
  assert.equal(packageWindow([base, { ...base, serviceId: '00000000-0000-4000-8000-000000000102' }]), null);
  assert.equal(packageWindow([base, { ...base, locality: 'Long Hồ' }]), null);
  assert.equal(packageWindow([base]) !== null, true);
});
