import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShiftRouter, validateCompleteInput, validatePauseInput, validateReadinessInput, validateResumeInput } from '../src/shifts.js';

test('router factory fails closed without pool or authenticate', () => {
  assert.throws(() => createShiftRouter({ authenticate() {} }), TypeError);
  assert.throws(() => createShiftRouter({ pool: { query() {}, connect() {} } }), TypeError);
});

test('readiness body needs exactly three boolean confirmations', () => {
  const ok = { drained: true, mature: false, intakeReady: true };
  assert.deepEqual(validateReadinessInput(ok), ok);
  assert.throws(() => validateReadinessInput({ drained: 'true', mature: true, intakeReady: true }), { code: 'VALIDATION_FAILED' });
  assert.throws(() => validateReadinessInput({ drained: true, mature: true }), { code: 'VALIDATION_FAILED' });
  assert.throws(() => validateReadinessInput({ ...ok, bookingId: 'x' }), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateReadinessInput(null), { code: 'INVALID_BODY' });
});

test('pause reason is trimmed, nonempty and at most 500 characters', () => {
  assert.deepEqual(validatePauseInput({ reason: '  Mưa lớn  ' }), { reason: 'Mưa lớn' });
  assert.throws(() => validatePauseInput({ reason: ' ' }), { code: 'VALIDATION_FAILED' });
  assert.throws(() => validatePauseInput({ reason: 'x'.repeat(501) }), { code: 'VALIDATION_FAILED' });
  assert.throws(() => validatePauseInput({}), { code: 'VALIDATION_FAILED' });
});

test('resume accepts only an empty body', () => {
  assert.deepEqual(validateResumeInput(undefined), {});
  assert.deepEqual(validateResumeInput({}), {});
  assert.throws(() => validateResumeInput({ reason: 'x' }), { code: 'UNKNOWN_FIELD' });
});

test('complete needs a positive integer area and optional note', () => {
  assert.deepEqual(validateCompleteInput({ areaM2: 9000 }), { areaM2: 9000, note: null });
  assert.deepEqual(validateCompleteInput({ areaM2: 9000, note: ' Synthetic ' }), { areaM2: 9000, note: 'Synthetic' });
  for (const areaM2 of [0, -1, 1.5, '9000', 2147483648]) {
    assert.throws(() => validateCompleteInput({ areaM2 }), { code: 'VALIDATION_FAILED' });
  }
  assert.throws(() => validateCompleteInput({ areaM2: 1, settlement: 'PAID' }), { code: 'UNKNOWN_FIELD' });
});
