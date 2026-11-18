import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bookingSelection,
  cancelReason,
  compatibleMachines,
  dispatchErrorMessage,
  dispatchRoute,
  machineInput,
  operatorCandidates,
  packageActions,
} from '../../web/dispatch.js';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WINDOW = { startAt: '2026-11-20T01:00:00.000Z', endAt: '2026-11-20T05:00:00.000Z' };

test('dispatch routes accept only the exact list and package detail paths', () => {
  assert.deepEqual(dispatchRoute('#dispatch'), { name: 'dispatch' });
  assert.deepEqual(dispatchRoute(`#package/${id(1).toUpperCase()}`), { name: 'package', id: id(1) });
  for (const hash of ['', '#', '#dispatches', '#dispatch/extra', '#package/', '#package/bad', `#package/${id(1)}/extra`, `#package/${id(1)}?x=1`]) {
    assert.equal(dispatchRoute(hash), null, hash);
  }
});

test('booking selection is lowercase, unique and holds 1 to 100 ids', () => {
  assert.deepEqual(bookingSelection([id(2).toUpperCase(), id(1)]), [id(2), id(1)]);
  assert.equal(bookingSelection([]), null);
  assert.equal(bookingSelection([id(1), id(1).toUpperCase()]), null);
  assert.equal(bookingSelection([id(1), 'nope']), null);
  assert.equal(bookingSelection(id(1)), null);
  assert.equal(bookingSelection(Array.from({ length: 101 }, (_, i) => id(i + 1))), null);
  assert.equal(bookingSelection(Array.from({ length: 100 }, (_, i) => id(i + 1))).length, 100);
});

test('cancel reason is trimmed and bounded by code points, not bytes', () => {
  assert.equal(cancelReason('  Trời mưa  '), 'Trời mưa');
  assert.equal(cancelReason('   '), null);
  assert.equal(cancelReason(undefined), null);
  assert.equal(cancelReason('a'.repeat(500)).length, 500);
  assert.equal(cancelReason('a'.repeat(501)), null);
  assert.equal(cancelReason('😀'.repeat(500)), '😀'.repeat(500));
  assert.equal(cancelReason('😀'.repeat(501)), null);
});

test('machine input trims the name and accepts only the three machine types', () => {
  assert.deepEqual(machineInput({ name: '  Máy kéo 1 ', type: 'tractor' }), { errors: {}, payload: { name: 'Máy kéo 1', type: 'tractor' } });
  const bad = machineInput({ name: '   ', type: 'truck' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['name', 'type']);
  assert.equal(bad.payload, null);
  assert.ok(machineInput({ name: 'a'.repeat(120), type: 'drone' }).payload);
  assert.ok(machineInput({ name: 'a'.repeat(121), type: 'drone' }).errors.name);
  for (const type of ['constructor', '__proto__', 'harvest-combine', undefined]) {
    assert.ok(machineInput({ name: 'Máy', type }).errors.type, String(type));
  }
});

test('operator candidates need an exact covering window and appear once each', () => {
  const rows = [
    { id: id(1), name: 'An', startAt: '2026-11-20T00:00:00.000Z', endAt: '2026-11-21T00:00:00.000Z', jobId: id(9) },
    { id: id(1), name: 'An', startAt: WINDOW.startAt, endAt: WINDOW.endAt, jobId: id(8) },
    { id: id(2), name: 'Bình', startAt: '2026-11-20T02:00:00.000Z', endAt: '2026-11-21T00:00:00.000Z', jobId: id(7) },
    { id: id(3), name: 'Cường', startAt: '2026-11-20T00:00:00.000Z', endAt: '2026-11-20T04:59:59.999Z', jobId: id(6) },
    { id: id(4), name: 'Dũng', startAt: 'not-a-date', endAt: '2026-11-21T00:00:00.000Z', jobId: id(5) },
    { id: id(5), name: 'Em', startAt: '1', endAt: '2026-11-21T00:00:00.000Z', jobId: id(4) },
    { name: 'Không id', startAt: WINDOW.startAt, endAt: WINDOW.endAt, jobId: id(3) },
  ];
  assert.deepEqual(operatorCandidates(rows, WINDOW), [{ id: id(1), name: 'An' }]);
  assert.deepEqual(operatorCandidates(rows, { startAt: 'bad', endAt: WINDOW.endAt }), []);
  assert.deepEqual(operatorCandidates(rows, { startAt: WINDOW.endAt, endAt: WINDOW.startAt }), []);
});

test('compatible machines follow the service code and only available machines', () => {
  const machines = [
    { id: id(1), name: 'Máy gặt A', type: 'harvester', status: 'available' },
    { id: id(2), name: 'Máy gặt B', type: 'harvester', status: 'unavailable' },
    { id: id(3), name: 'Máy kéo', type: 'tractor', status: 'available' },
  ];
  assert.deepEqual(compatibleMachines(machines, 'harvest-combine'), [machines[0]]);
  assert.deepEqual(compatibleMachines(machines, 'tillage-tractor'), [machines[2]]);
  assert.deepEqual(compatibleMachines(machines, 'drone-spray'), []);
  for (const code of ['constructor', 'unknown', undefined]) assert.deepEqual(compatibleMachines(machines, code), []);
});

test('package actions follow role and status', () => {
  assert.deepEqual(packageActions({ status: 'OPEN' }, ['provider']), ['claim']);
  assert.deepEqual(packageActions({ status: 'CLAIMED' }, ['provider']), ['cancel']);
  assert.deepEqual(packageActions({ status: 'OPEN' }, ['coop']), ['cancel']);
  assert.deepEqual(packageActions({ status: 'CLAIMED' }, ['coop']), ['cancel']);
  assert.deepEqual(packageActions({ status: 'OPEN' }, ['provider', 'coop']), ['claim', 'cancel']);
  for (const status of ['CANCELLED', 'UNKNOWN']) {
    assert.deepEqual(packageActions({ status }, ['coop']), []);
    assert.deepEqual(packageActions({ status }, ['provider']), []);
  }
  assert.deepEqual(packageActions({ status: 'OPEN' }, ['operator']), []);
});

test('error messages name the failure, never show raw codes, never claim success', () => {
  assert.match(dispatchErrorMessage({ code: 'SHIFT_ACTIVE', status: 409 }), /ca làm việc được bắt đầu/);
  assert.notEqual(dispatchErrorMessage({ code: 'PACKAGE_INCOMPATIBLE' }), dispatchErrorMessage({ code: 'SCHEDULE_CONFLICT' }));
  assert.doesNotMatch(dispatchErrorMessage({ code: 'SOMETHING_NEW', status: 400 }), /SOMETHING_NEW/);
  assert.match(dispatchErrorMessage({ code: 'UNAUTHENTICATED', status: 401 }), /đăng nhập/i);
  assert.match(dispatchErrorMessage({ code: 'NETWORK', uncertain: true }), /Tải lại/);
  assert.match(dispatchErrorMessage({ code: 'UNKNOWN', status: 500, uncertain: true }), /Tải lại/);
});
