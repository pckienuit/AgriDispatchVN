import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  closeInput,
  consentState,
  disputeActions,
  disputeInput,
  disputesRoute,
  errorMessage,
  freezeNotice,
  proposalInput,
  readDetail,
  readList,
  readMediators,
  readProposals,
  readReviewList,
  renderDisputes,
  responseInput,
  statusLabel,
} from '../../web/disputes.js';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-11-20T03:00:00.000Z';
const OWNER = id(11);
const PROVIDER = id(12);
const MEDIATOR = id(20);
const NEW_MEDIATOR = id(21);
const ADMIN_OUTSIDER = id(30);
const DISPUTE = { id: id(1), bookingId: id(2), claimantId: OWNER, respondentId: PROVIDER, reason: 'QUALITY', status: 'OPEN', mediatorId: MEDIATOR, createdAt: NOW };
const EVENT = { sequence: 1, type: 'DISPUTE_OPENED', actorId: OWNER, data: { reason: 'QUALITY', details: 'Đất chưa phẳng' }, createdAt: NOW };
const OLD = { version: 1, text: 'Đo lại diện tích.', mediatorId: MEDIATOR, createdAt: NOW, consents: [] };
const LATEST = { version: 2, text: 'Chia đôi chi phí đo lại.', mediatorId: MEDIATOR, createdAt: NOW, consents: [{ actorId: OWNER, at: '2026-11-20T10:00:00.123456+07:00' }] };
const PROPS = {
  dispute: { id: id(1), bookingId: id(2), status: 'OPEN', closedAt: null, closureReason: null, obligationsDisputed: false },
  proposals: [OLD, LATEST],
  events: [{ event_type: 'PROPOSED', version: 1, actor_id: MEDIATOR, details: null, created_at: NOW }],
};
const ROLES_ADMIN = ['admin'];
const owner = { id: OWNER, roles: ['farmer'] };
const provider = { id: PROVIDER, roles: ['provider'] };
const mediator = { id: MEDIATOR, roles: ROLES_ADMIN };
const outsider = { id: ADMIN_OUTSIDER, roles: ROLES_ADMIN };

test('dispute route accepts #disputes, #dispute/<uuid> and #complaint/<uuid> only', () => {
  assert.deepEqual(disputesRoute('#disputes'), { name: 'disputes' });
  assert.deepEqual(disputesRoute(`#dispute/${id(1).toUpperCase()}`), { name: 'dispute', id: id(1) });
  assert.deepEqual(disputesRoute(`#complaint/${id(2)}`), { name: 'complaint', id: id(2) });
  for (const hash of ['', '#', '#disputes/', '#dispute', '#dispute/bad', `#dispute/${id(1)}/x`, `#dispute/${id(1)}?x=1`, `#complaint/`, `#settlement/${id(1)}`, undefined]) {
    assert.equal(disputesRoute(hash), null, String(hash));
  }
});

test('dispute form input is trimmed, bounded to 2000 code points and uses the API reason codes', () => {
  assert.deepEqual(disputeInput({ reason: 'AREA_MISMATCH', details: '  Diện tích thiếu  ' }), { errors: {}, payload: { reason: 'AREA_MISMATCH', details: 'Diện tích thiếu' } });
  for (const reason of ['', 'area_mismatch', 'OTHERS', undefined]) {
    assert.ok(disputeInput({ reason, details: 'x' }).errors.reason, String(reason));
  }
  for (const details of ['', '   ', 'x'.repeat(2001), '😀'.repeat(2001)]) {
    assert.ok(disputeInput({ reason: 'OTHER', details }).errors.details, JSON.stringify(details).slice(0, 20));
  }
  assert.ok(disputeInput({ reason: 'OTHER', details: '😀'.repeat(2000) }).payload);
  assert.equal(disputeInput({ reason: 'OTHER', details: 42 }).payload, null);
});

test('response, proposal and closure text share the same bounds and payload shape', () => {
  assert.deepEqual(responseInput(' Đã làm đủ ca '), { error: null, payload: { text: 'Đã làm đủ ca' } });
  assert.deepEqual(proposalInput('Chia đôi chi phí.'), { error: null, payload: { text: 'Chia đôi chi phí.' } });
  assert.deepEqual(closeInput('Không đạt phương án.'), { error: null, payload: { reason: 'Không đạt phương án.' } });
  for (const fn of [responseInput, proposalInput, closeInput]) {
    assert.ok(fn('   ').error);
    assert.ok(fn('x'.repeat(2001)).error);
    assert.ok(fn(null).error);
    assert.equal(fn('x'.repeat(2000)).error, null);
  }
});

test('status labels map exactly the four closure states and reject anything else', () => {
  assert.equal(statusLabel('OPEN'), 'Đang mở');
  assert.equal(statusLabel('RESOLVED'), 'Đã giải quyết');
  assert.equal(statusLabel('CLOSED_UNRESOLVED'), 'Đóng chưa giải quyết');
  assert.equal(statusLabel('CLOSED'), 'Đã đóng');
  for (const status of ['PAID', 'open', '', undefined, 'constructor']) assert.equal(statusLabel(status), null, String(status));
});

test('freeze notice says open and unresolved cases block financial writes, and resolution does not refund', () => {
  assert.match(freezeNotice('OPEN'), /chặn ghi nhận tài chính/);
  assert.match(freezeNotice('CLOSED_UNRESOLVED'), /chặn ghi nhận tài chính/);
  assert.match(freezeNotice('CLOSED_UNRESOLVED'), /không phải thỏa thuận/);
  assert.match(freezeNotice('RESOLVED'), /không tự hoàn tiền/);
  assert.doesNotMatch(freezeNotice('RESOLVED'), /chặn/);
});

test('case list reader accepts the API page and rejects unknown statuses or bad ids', () => {
  const page = { items: [DISPUTE], limit: 20, offset: 0 };
  assert.deepEqual(readList(page), page);
  assert.deepEqual(readList({ items: [{ ...DISPUTE, mediatorId: null }], limit: 20, offset: 0 }).items[0].mediatorId, null);
  assert.deepEqual(readList({ items: [], limit: 20, offset: 40 }), { items: [], limit: 20, offset: 40 });
  for (const data of [
    { items: [{ ...DISPUTE, status: 'PAID' }], limit: 20, offset: 0 },
    { items: [{ ...DISPUTE, reason: 'FRAUD' }], limit: 20, offset: 0 },
    { items: [{ ...DISPUTE, claimantId: 'nope' }], limit: 20, offset: 0 },
    { items: [{ ...DISPUTE, createdAt: 'yesterday' }], limit: 20, offset: 0 },
    { items: {}, limit: 20, offset: 0 },
    { items: [] },
    null,
  ]) {
    assert.equal(readList(data), null, JSON.stringify(data).slice(0, 60));
  }
});

test('case detail reader keeps events in order and rejects unknown event types', () => {
  assert.deepEqual(readDetail({ dispute: DISPUTE, events: [EVENT] }), { dispute: DISPUTE, events: [EVENT] });
  assert.equal(readDetail({ dispute: DISPUTE, events: [{ ...EVENT, type: 'REMEDY_EXECUTED' }] }), null);
  assert.equal(readDetail({ dispute: { ...DISPUTE, status: 'CLOSED' }, events: [] }).dispute.status, 'CLOSED');
  assert.equal(readDetail({ dispute: DISPUTE, events: 'none' }), null);
  assert.equal(readDetail({ dispute: DISPUTE }), null);
});

test('proposal reader accepts microsecond consent times and refuses a mismatched dispute', () => {
  const read = readProposals(PROPS, id(1));
  assert.deepEqual(read.proposals.map((p) => p.version), [1, 2]);
  assert.equal(read.proposals[1].consents[0].actorId, OWNER);
  assert.equal(readProposals(PROPS, id(9)), null, 'other dispute id is a bad response');
  assert.equal(readProposals({ ...PROPS, proposals: [{ ...LATEST, consents: [{ actorId: OWNER, at: 'soon' }] }] }, id(1)), null);
  assert.equal(readProposals({ ...PROPS, dispute: { ...PROPS.dispute, obligationsDisputed: 'no' } }, id(1)), null);
  assert.equal(readProposals({ ...PROPS, events: [{ event_type: 'PAID', version: null, actor_id: OWNER, details: null, created_at: NOW }] }, id(1)), null);
});

test('reader for review queue and mediator directory accept only the agreed shapes', () => {
  const review = { items: [{ id: id(1), bookingId: id(2), reason: 'PAYMENT', status: 'OPEN' }], limit: 20, offset: 0 };
  assert.deepEqual(readReviewList(review), review);
  assert.equal(readReviewList({ items: [{ id: id(1), bookingId: id(2), reason: 'PAYMENT', status: 'PAID' }], limit: 20, offset: 0 }), null);
  assert.deepEqual(readMediators({ items: [{ id: NEW_MEDIATOR, name: 'Quản trị A' }] }), { items: [{ id: NEW_MEDIATOR, name: 'Quản trị A' }] });
  assert.equal(readMediators({ items: [{ id: NEW_MEDIATOR, name: '' }] }), null);
  assert.equal(readMediators({ items: [{ id: 'x', name: 'A' }] }), null);
});

test('actions follow party identity and the OPEN state, never the role label alone', () => {
  assert.deepEqual(disputeActions(provider, DISPUTE), { respond: true, propose: false, close: false, assign: false });
  assert.deepEqual(disputeActions(owner, DISPUTE), { respond: false, propose: false, close: false, assign: false });
  assert.deepEqual(disputeActions(mediator, DISPUTE), { respond: false, propose: true, close: true, assign: true });
  assert.deepEqual(disputeActions(outsider, DISPUTE), { respond: false, propose: false, close: false, assign: true });
  assert.deepEqual(disputeActions({ id: id(31), roles: ROLES_ADMIN }, { ...DISPUTE, mediatorId: null }), { respond: false, propose: false, close: false, assign: true }, 'unassigned case: admin may pick');
  assert.deepEqual(disputeActions({ id: id(32), roles: ROLES_ADMIN }, { ...DISPUTE, mediatorId: NEW_MEDIATOR }), { respond: false, propose: false, close: false, assign: true }, 'replaced mediator loses propose and close');
  assert.deepEqual(disputeActions({ id: OWNER, roles: ['farmer', 'admin'] }, DISPUTE), { respond: false, propose: false, close: false, assign: false }, 'admin party cannot pick mediator');
  assert.deepEqual(disputeActions({ id: MEDIATOR, roles: ['farmer'] }, DISPUTE), { respond: false, propose: false, close: false, assign: false }, 'mediator id without admin role');
  const closed = { ...DISPUTE, status: 'RESOLVED' };
  assert.deepEqual(disputeActions(mediator, closed), { respond: false, propose: false, close: false, assign: false });
  assert.deepEqual(disputeActions(provider, closed), { respond: false, propose: false, close: false, assign: false });
});

test('consent state is offered only to a party on the latest version under the current mediator', () => {
  assert.equal(consentState(owner, DISPUTE, LATEST, LATEST), 'signed');
  assert.equal(consentState(provider, DISPUTE, LATEST, LATEST), 'open');
  assert.equal(consentState(provider, DISPUTE, OLD, LATEST), 'none', 'older version is read only');
  assert.equal(consentState(mediator, DISPUTE, LATEST, LATEST), 'none', 'mediator never consents');
  assert.equal(consentState(outsider, DISPUTE, LATEST, LATEST), 'none');
  assert.equal(consentState(provider, DISPUTE, null, null), 'none');
  assert.equal(consentState(provider, { ...DISPUTE, mediatorId: NEW_MEDIATOR }, LATEST, LATEST), 'stale-mediator');
  assert.equal(consentState(provider, { ...DISPUTE, status: 'CLOSED_UNRESOLVED' }, LATEST, LATEST), 'none');
});

test('error copy maps known codes, marks uncertain writes and never echoes raw codes', () => {
  assert.match(errorMessage({ code: 'STALE_VERSION', status: 409 }), /Tải lại/);
  assert.match(errorMessage({ code: 'DISPUTE_OPEN', status: 409 }), /đang mở/);
  assert.match(errorMessage({ code: 'NOT_FOUND', status: 404 }), /không có quyền/);
  assert.match(errorMessage({ code: 'UNAUTHENTICATED', status: 401 }), /đăng nhập/i);
  assert.match(errorMessage({ code: 'NETWORK', status: 0, uncertain: true }), /chưa coi|Tải lại/);
  assert.match(errorMessage({ code: 'UNKNOWN', status: 500, uncertain: true }), /Tải lại/);
  for (const code of ['SOME_NEW_CODE', 'constructor', '__proto__', undefined]) {
    const message = errorMessage({ code, status: 400 });
    assert.doesNotMatch(message, /SOME_NEW_CODE|constructor|__proto__|undefined|\[object/);
    assert.ok(message.length > 0);
  }
});

test('renderDisputes is exported for the parent router', () => {
  assert.equal(typeof renderDisputes, 'function');
});

test('dispute module avoids HTML sinks, storage, hard-coded hosts and dashes', async () => {
  const text = await readFile(new URL('../../web/disputes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|\beval\(|new Function\(/);
  assert.doesNotMatch(text, /https?:\/\/|localhost|127\.0\.0\.1/);
  assert.doesNotMatch(text, /[\u2013\u2014]/);
});
