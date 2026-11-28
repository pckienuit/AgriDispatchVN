import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  formatVnd,
  keepsPendingReport,
  paymentInput,
  proposalInput,
  readAcceptance,
  readPayments,
  renderSettlement,
  settlementActions,
  settlementErrorMessage,
  settlementRoute,
  vndInput,
} from '../../web/settlement.js';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-11-20T03:00:00.000Z';
const ACC = { bookingId: id(1), version: 2, areaM2: 12000, totalVnd: '1080000', note: null, proposedAt: NOW, consents: { owner: false, provider: false }, agreed: false };
const READ = { acceptance: ACC, party: 'owner', canPropose: false, blockedByDispute: false };
const SUMMARY = { agreedVnd: '1080000', confirmedVnd: '300000', reportedVnd: '200000', outstandingVnd: '780000', availableToReportVnd: '580000' };
const PAYMENT = { id: id(5), amountVnd: '200000', status: 'REPORTED', createdAt: NOW, confirmedAt: null };

test('settlement route accepts only #settlement/<uuid> and lowercases the id', () => {
  assert.deepEqual(settlementRoute(`#settlement/${id(1).toUpperCase()}`), { name: 'settlement', id: id(1) });
  for (const hash of ['', '#', '#settlement', '#settlement/', '#settlement/bad', `#settlements/${id(1)}`, `#settlement/${id(1)}/x`, `#settlement/${id(1)}?x=1`, '#dispatch', undefined]) {
    assert.equal(settlementRoute(hash), null, String(hash));
  }
});

test('VND input is a plain digit string of at most 15 digits, no notation or separators', () => {
  assert.equal(vndInput(' 1080000 '), '1080000');
  assert.equal(vndInput('0'), '0');
  assert.equal(vndInput('0', { positive: true }), null);
  assert.equal(vndInput('999999999999999', { positive: true }), '999999999999999');
  for (const text of ['1000000000000000', '1e3', '1E3', '1.000', '1,000', '+5', '-1', '01', '1.5', 'Infinity', 'NaN', '', '   ', '١٢', '12 000']) {
    assert.equal(vndInput(text, { positive: true }), null, JSON.stringify(text));
  }
  assert.equal(vndInput(1080000), null);
});

test('money formatting groups exact digits and refuses anything outside the contract', () => {
  assert.equal(formatVnd('1080000'), '1.080.000 đ');
  assert.equal(formatVnd('0'), '0 đ');
  assert.equal(formatVnd('999999999999999'), '999.999.999.999.999 đ');
  assert.equal(formatVnd('9007199254740993'), null);
  assert.equal(formatVnd('1e3'), null);
  assert.equal(formatVnd(1080000), null);
});

test('proposal input bounds area, total and note by the API rules', () => {
  assert.deepEqual(proposalInput({ areaM2: ' 12000 ', totalVnd: '1080000', note: '  Đã đo lại  ' }), { errors: {}, payload: { areaM2: 12000, totalVnd: '1080000', note: 'Đã đo lại' } });
  assert.equal(proposalInput({ areaM2: '2147483647', totalVnd: '0', note: '' }).payload.areaM2, 2147483647);
  assert.deepEqual(proposalInput({ areaM2: '2147483647', totalVnd: '0', note: '   ' }).payload, { areaM2: 2147483647, totalVnd: '0' });
  for (const areaM2 of ['0', '-1', '1.5', '1e3', '2147483648', '']) {
    assert.ok(proposalInput({ areaM2, totalVnd: '1', note: '' }).errors.areaM2, areaM2);
  }
  for (const totalVnd of ['1e3', '1.5', '-1', '']) {
    assert.ok(proposalInput({ areaM2: '1', totalVnd, note: '' }).errors.totalVnd, totalVnd);
  }
  assert.ok(proposalInput({ areaM2: '1', totalVnd: '1', note: 'a'.repeat(500) }).payload);
  assert.ok(proposalInput({ areaM2: '1', totalVnd: '1', note: '😀'.repeat(500) }).payload);
  assert.ok(proposalInput({ areaM2: '1', totalVnd: '1', note: '😀'.repeat(501) }).errors.note);
});

test('payment report needs a positive amount within outstanding and a bounded reference', () => {
  assert.deepEqual(paymentInput({ amountVnd: '580000', reference: 'GHI.2026_001-A' }, SUMMARY), { errors: {}, payload: { amountVnd: '580000', reference: 'GHI.2026_001-A' } });
  assert.ok(paymentInput({ amountVnd: '580001', reference: 'GHI-001' }, SUMMARY).errors.amountVnd);
  assert.equal(paymentInput({ amountVnd: '580000', reference: 'GHI-001' }, SUMMARY).errors.amountVnd, undefined);
  for (const amountVnd of ['0', '1e3', '1.000', '', '-5', '1000000000000000']) {
    assert.ok(paymentInput({ amountVnd, reference: 'GHI-001' }, SUMMARY).errors.amountVnd, amountVnd);
  }
  for (const reference of ['abc', 'a b c d', 'x'.repeat(65), 'GHI/001', 'Mã-001']) {
    assert.ok(paymentInput({ amountVnd: '1', reference }, SUMMARY).errors.reference, reference);
  }
  assert.ok(paymentInput({ amountVnd: '1', reference: 'x'.repeat(64) }, null).payload);
});

test('settlement controls follow party, consent, summary and dispute state', () => {
  const owner = { party: 'owner', canPropose: false, blockedByDispute: false };
  const provider = { party: 'provider', canPropose: true, blockedByDispute: false };
  const agreed = { ...ACC, consents: { owner: true, provider: true }, agreed: true };
  assert.deepEqual(settlementActions({party:null,canPropose:false,blockedByDispute:false},ACC,null), {propose:false,consent:false,report:false,confirm:false});
  assert.deepEqual(settlementActions(provider, null, null), { propose: true, consent: false, report: false, confirm: false });
  assert.deepEqual(settlementActions(owner, ACC, null), { propose: false, consent: true, report: false, confirm: false });
  assert.equal(settlementActions(provider, ACC, null).propose, true, 'provider may replace an unagreed version');
  assert.equal(settlementActions(provider, ACC, null).consent, true, 'provider consent offered without auto consent');
  assert.equal(settlementActions(owner, { ...ACC, consents: { owner: true, provider: false } }, null).consent, false);
  assert.equal(settlementActions({ ...provider, canPropose: false }, null, null).propose, false);
  assert.deepEqual(settlementActions(provider, agreed, SUMMARY), { propose: false, consent: false, report: false, confirm: true });
  assert.deepEqual(settlementActions(owner, agreed, SUMMARY), { propose: false, consent: false, report: true, confirm: false });
  assert.equal(settlementActions(owner, agreed, { ...SUMMARY, availableToReportVnd: '0' }).report, false);
  assert.equal(settlementActions(owner, agreed, null).report, false);
  const blocked = { ...provider, blockedByDispute: true };
  assert.deepEqual(settlementActions(blocked, agreed, SUMMARY), { propose: false, consent: false, report: false, confirm: false });
  assert.deepEqual(settlementActions({ ...owner, blockedByDispute: true }, ACC, null), { propose: false, consent: false, report: false, confirm: false });
});

test('acceptance read returns the exact shape and refuses inconsistent answers', () => {
  assert.deepEqual(readAcceptance({ acceptance:ACC, permissions:{party:'owner',canPropose:false,blockedByDispute:false} }), READ);
  const wire = value => ({acceptance:value.acceptance,permissions:{party:value.party,canPropose:value.canPropose,blockedByDispute:value.blockedByDispute}});
  assert.deepEqual(readAcceptance(wire({...READ,acceptance:null})), {...READ,acceptance:null});
  assert.deepEqual(readAcceptance(wire(READ)), READ);
  const bad = [
    { ...READ, party: 'coop' },
    { acceptance: ACC, canPropose: false, blockedByDispute: false },
    { acceptance: ACC, party: 'owner', blockedByDispute: false },
    { ...READ, canPropose: 'yes' },
    { ...READ, acceptance: { ...ACC, agreed: true } },
    { ...READ, acceptance: { ...ACC, totalVnd: '1e3' } },
    { ...READ, acceptance: { ...ACC, totalVnd: 1080000 } },
    { ...READ, acceptance: { ...ACC, version: 0 } },
    { ...READ, acceptance: { ...ACC, areaM2: 0 } },
    { ...READ, acceptance: { ...ACC, bookingId: [id(1)] } },
    { ...READ, acceptance: { ...ACC, consents: { owner: 'yes', provider: false } } },
    { ...READ, acceptance: { ...ACC, proposedAt: 'not-a-date' } },
    { ...READ, acceptance: { ...ACC, note: 42 } },
    { ...READ, acceptance: undefined },
    null,
    'text',
    [],
  ];
  for (const data of bad) assert.equal(readAcceptance(data && typeof data==='object' && !Array.isArray(data) ? wire(data) : data), null, JSON.stringify(data));
  assert.equal(readAcceptance(READ),null,'top-level permission fields are not the API contract');
});

test('payment read validates status, money strings and summary shape', () => {
  assert.deepEqual(readPayments({ payments: [], summary: null }), { payments: [], summary: null });
  const confirmed = { ...PAYMENT, status: 'CONFIRMED', confirmedAt: NOW };
  assert.deepEqual(readPayments({ payments: [PAYMENT, confirmed], summary: SUMMARY }), { payments: [PAYMENT, confirmed], summary: SUMMARY });
  const bad = [
    { payments: [{ ...PAYMENT, status: 'PAID' }], summary: null },
    { payments: [{ ...PAYMENT, amountVnd: 200000 }], summary: null },
    { payments: [{ ...PAYMENT, amountVnd: '2e5' }], summary: null },
    { payments: [{ ...PAYMENT, confirmedAt: NOW }], summary: null },
    { payments: [{ ...confirmed, confirmedAt: null }], summary: null },
    { payments: [{ ...PAYMENT, id: 'nope' }], summary: null },
    { payments: [], summary: { ...SUMMARY, outstandingVnd: '1.5' } },
    { payments: [], summary: { ...SUMMARY, agreedVnd: undefined } },
    { payments: [] },
    { payments: {}, summary: null },
  ];
  for (const data of bad) assert.equal(readPayments(data), null, JSON.stringify(data));
});

test('error copy maps known codes to Vietnamese and never shows raw codes', () => {
  assert.match(settlementErrorMessage({ code: 'STALE_VERSION', status: 409 }), /Tải lại/);
  assert.match(settlementErrorMessage({ code: 'DISPUTE_OPEN', status: 409 }), /tranh chấp/);
  assert.match(settlementErrorMessage({ code: 'REFERENCE_CONFLICT', status: 409 }), /mã tham chiếu/i);
  assert.match(settlementErrorMessage({ code: 'UNAUTHENTICATED', status: 401 }), /đăng nhập/i);
  assert.match(settlementErrorMessage({ code: 'NETWORK', status: 0, uncertain: true }), /Tải lại/);
  assert.match(settlementErrorMessage({ code: 'UNKNOWN', status: 500, uncertain: true }), /Tải lại/);
  for (const code of ['SOME_NEW_CODE', 'constructor', 'toString', '__proto__', undefined]) {
    const message = settlementErrorMessage({ code, status: 400 });
    assert.doesNotMatch(message, /SOME_NEW_CODE|constructor|toString|__proto__|undefined|\[object/);
    assert.ok(message.length > 0);
  }
});

test('pending payment report survives uncertain failures and clears on a definitive answer', () => {
  assert.equal(keepsPendingReport({ status: 0, uncertain: true }), true);
  assert.equal(keepsPendingReport({ status: 503, code: 'DB_UNAVAILABLE', uncertain: true }), true);
  assert.equal(keepsPendingReport({ status: 401, code: 'UNAUTHENTICATED' }), true);
  assert.equal(keepsPendingReport({ status: 409, code: 'REFERENCE_CONFLICT' }), false);
  assert.equal(keepsPendingReport({ status: 400, code: 'VALIDATION_FAILED' }), false);
});

test('renderSettlement is exported for the parent router', () => {
  assert.equal(typeof renderSettlement, 'function');
});

test('settlement module avoids HTML sinks, storage, hard-coded hosts and dashes', async () => {
  const text = await readFile(new URL('../../web/settlement.js', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|\beval\(|new Function\(/);
  assert.doesNotMatch(text, /https?:\/\/|localhost|127\.0\.0\.1/);
  assert.doesNotMatch(text, /[\u2013\u2014]/);
});
