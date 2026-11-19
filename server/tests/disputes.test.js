import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDisputeRouter,
  validateEscalateInput,
  validateHtxMediatorInput,
  validateMediatorInput,
  validateOpenInput,
  validateResponseInput,
} from '../src/disputes.js';

test('router factory fails closed without pool or authenticate', () => {
  assert.throws(() => createDisputeRouter({ authenticate() {} }), TypeError);
  assert.throws(() => createDisputeRouter({ pool: { query() {}, connect() {} } }), TypeError);
});

test('open input needs a known reason and trimmed details of 1 to 2000 characters', () => {
  assert.deepEqual(validateOpenInput({ reason: 'QUALITY', details: '  Synthetic detail  ' }),
    { reason: 'QUALITY', details: 'Synthetic detail' });
  for (const reason of ['quality', '', 'FRAUD', null, undefined]) {
    assert.throws(() => validateOpenInput({ reason, details: 'Synthetic' }), { code: 'VALIDATION_FAILED' });
  }
  for (const details of ['', '   ', 42, null, 'x'.repeat(2001), '\u{1F33E}'.repeat(2001)]) {
    assert.throws(() => validateOpenInput({ reason: 'OTHER', details }), { code: 'VALIDATION_FAILED' });
  }
  assert.equal(validateOpenInput({ reason: 'OTHER', details: 'x'.repeat(2000) }).details.length, 2000);
  assert.equal(validateOpenInput({ reason: 'OTHER', details: '\u{1F33E}'.repeat(2000) }).details.length, 4000);
});

test('open input refuses actor, party, status and evidence fields', () => {
  for (const extra of ['actorId', 'claimantId', 'respondentId', 'status', 'evidence', 'mediatorId']) {
    assert.throws(() => validateOpenInput({ reason: 'OTHER', details: 'Synthetic', [extra]: 'x' }), { code: 'UNKNOWN_FIELD' });
  }
  for (const body of [undefined, null, [], 'text']) {
    assert.throws(() => validateOpenInput(body), { code: 'INVALID_BODY' });
  }
});

test('response input needs trimmed text of 1 to 2000 characters and no other fields', () => {
  assert.deepEqual(validateResponseInput({ text: ' Synthetic reply ' }), { text: 'Synthetic reply' });
  for (const text of ['', '  ', 7, 'x'.repeat(2001)]) {
    assert.throws(() => validateResponseInput({ text }), { code: 'VALIDATION_FAILED' });
  }
  assert.throws(() => validateResponseInput({ text: 'Synthetic', actorId: 'x' }), { code: 'UNKNOWN_FIELD' });
});

test('mediator input is one UUID, normalised to lower case', () => {
  assert.equal(validateMediatorInput({ mediatorId: '10000000-0000-4000-8000-00000000ABCD' }),
    '10000000-0000-4000-8000-00000000abcd');
  for (const mediatorId of ['', 'not-a-uuid', 12, null, undefined]) {
    assert.throws(() => validateMediatorInput({ mediatorId }), { code: 'VALIDATION_FAILED' });
  }
  assert.throws(() => validateMediatorInput({ mediatorId: '10000000-0000-4000-8000-000000000001', role: 'admin' }),
    { code: 'UNKNOWN_FIELD' });
});

test('htx mediator input accepts empty object for self-claim or one UUID', () => {
  assert.equal(validateHtxMediatorInput(undefined), null);
  assert.equal(validateHtxMediatorInput({}), null);
  assert.equal(validateHtxMediatorInput({ mediatorId: '10000000-0000-4000-8000-00000000ABCD' }),
    '10000000-0000-4000-8000-00000000abcd');
  for (const body of [null, [], 'text']) {
    assert.throws(() => validateHtxMediatorInput(body), { code: 'INVALID_BODY' });
  }
  for (const mediatorId of ['', 'not-a-uuid', 12, null]) {
    assert.throws(() => validateHtxMediatorInput({ mediatorId }), { code: 'VALIDATION_FAILED' });
  }
  assert.throws(() => validateHtxMediatorInput({ mediatorId: '10000000-0000-4000-8000-000000000001', level: 'HTX' }),
    { code: 'UNKNOWN_FIELD' });
});

test('escalate input requires trimmed reason of 1 to 2000 code points and optional known conflictType', () => {
  assert.deepEqual(validateEscalateInput({ reason: '  HTX co lien quan  ' }),
    { reason: 'HTX co lien quan', conflictType: null });
  assert.deepEqual(validateEscalateInput({ reason: '  Thanh vien HTX  ', conflictType: 'AFFILIATION_CONFLICT' }),
    { reason: 'Thanh vien HTX', conflictType: 'AFFILIATION_CONFLICT' });
  for (const reason of ['', '   ', 42, null, undefined, 'x'.repeat(2001), '\u{1F33E}'.repeat(2001)]) {
    assert.throws(() => validateEscalateInput({ reason }), { code: 'VALIDATION_FAILED' });
  }
  assert.equal(validateEscalateInput({ reason: '\u{1F33E}'.repeat(2000) }).reason.length, 4000);
  for (const conflictType of ['', 'UNKNOWN_CONFLICT', 12, null]) {
    assert.throws(() => validateEscalateInput({ reason: 'Synthetic', conflictType }), { code: 'VALIDATION_FAILED' });
  }
  assert.throws(() => validateEscalateInput({ reason: 'Synthetic', mediatorId: 'x' }), { code: 'UNKNOWN_FIELD' });
  for (const body of [undefined, null, [], 'text']) {
    assert.throws(() => validateEscalateInput(body), { code: 'INVALID_BODY' });
  }
});
