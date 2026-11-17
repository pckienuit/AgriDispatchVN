import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAcceptanceRouter, validatePaymentInput, validateProposalInput } from '../src/acceptance.js';

test('router factory fails closed without pool or authenticate', () => {
  assert.throws(() => createAcceptanceRouter({ authenticate() {} }), TypeError);
  assert.throws(() => createAcceptanceRouter({ pool: { query() {}, connect() {} } }), TypeError);
});

test('proposal needs positive integer area and VND total as a non-negative decimal string', () => {
  assert.deepEqual(validateProposalInput({ areaM2: 9000, totalVnd: '81000', note: ' Synthetic ' }),
    { areaM2: 9000, totalVnd: '81000', note: 'Synthetic' });
  assert.deepEqual(validateProposalInput({ areaM2: 1, totalVnd: '0' }), { areaM2: 1, totalVnd: '0', note: null });
  for (const areaM2 of [0, -1, 1.5, '9000', 2147483648]) {
    assert.throws(() => validateProposalInput({ areaM2, totalVnd: '1' }), { code: 'VALIDATION_FAILED' });
  }
  for (const totalVnd of [1, '-1', '01', '1.5', '', '1000000000000000000']) {
    assert.throws(() => validateProposalInput({ areaM2: 1, totalVnd }), { code: 'VALIDATION_FAILED' });
  }
  assert.throws(() => validateProposalInput({ areaM2: 1, totalVnd: '1', settlement: 'PAID' }), { code: 'UNKNOWN_FIELD' });
});

test('payment needs positive integer VND string and bounded reference', () => {
  assert.deepEqual(validatePaymentInput({ amountVnd: '1000', reference: 'REF-0001' }), { amountVnd: '1000', reference: 'REF-0001' });
  for (const amountVnd of ['0', '-5', '1.5', 1000, '']) {
    assert.throws(() => validatePaymentInput({ amountVnd, reference: 'REF-0001' }), { code: 'VALIDATION_FAILED' });
  }
  for (const reference of ['abc', 'x'.repeat(65), 'has space', 'bad/slash']) {
    assert.throws(() => validatePaymentInput({ amountVnd: '1', reference }), { code: 'VALIDATION_FAILED' });
  }
  assert.throws(() => validatePaymentInput({ amountVnd: '1', reference: 'REF-0001', status: 'CONFIRMED' }), { code: 'UNKNOWN_FIELD' });
});
