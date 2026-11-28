import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  postponementErrorMessage,
  postponementInput,
  postponementRoute,
  readPostponement,
  renderPostponement,
} from '../../web/postponement.js';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Local wall time expected by the browser helper, so the test passes in any time zone.
const LOCAL = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString();
const CURRENT_START = LOCAL(2026, 11, 20, 8, 0);
const ok = { startAt: '2026-11-20T09:00', endAt: '2026-11-20T12:00', reason: 'Trời mưa lớn' };

const CURRENT_START_ISO = '2026-11-20T01:00:00.000Z';
const CURRENT_END_ISO = '2026-11-20T05:00:00.000Z';
const NEXT_START_ISO = '2026-11-21T01:00:00.000Z';
const NEXT_END_ISO = '2026-11-21T05:00:00.000Z';
const NOW = '2026-11-18T03:00:00.000Z';
const LATEST = {
  version: 2, oldStartAt: CURRENT_START_ISO, oldEndAt: CURRENT_END_ISO, startAt: NEXT_START_ISO, endAt: NEXT_END_ISO,
  reason: 'Trời mưa lớn', createdAt: NOW, requiredCount: 2, consentedCount: 1, ownConsented: true, appliedAt: null,
};
const PACKAGE = { id: id(1), status: 'CLAIMED', startAt: CURRENT_START_ISO, endAt: CURRENT_END_ISO };
const ENVELOPE = { package: PACKAGE, permissions: { canPropose: false, canConsent: false }, latest: LATEST, history: [LATEST] };

test('postponement route accepts only #postponement/<uuid> and lowercases the id', () => {
  assert.deepEqual(postponementRoute(`#postponement/${id(1).toUpperCase()}`), { name: 'postponement', id: id(1) });
  for (const hash of ['', '#', '#postponement', '#postponement/', '#postponement/bad', `#postponement/${id(1)}/x`, `#postponement/${id(1)}?x=1`, `#package/${id(1)}`, '#dispatch', undefined]) {
    assert.equal(postponementRoute(hash), null, String(hash));
  }
});

test('postponement input converts local wall time to UTC ISO and trims the reason', () => {
  const { errors, payload } = postponementInput({ ...ok, reason: '  Trời mưa  ' }, CURRENT_START);
  assert.deepEqual(errors, {});
  assert.deepEqual(payload, { startAt: LOCAL(2026, 11, 20, 9, 0), endAt: LOCAL(2026, 11, 20, 12, 0), reason: 'Trời mưa' });
  assert.match(payload.startAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('new start must be after the current start and end after the new start', () => {
  assert.ok(postponementInput({ ...ok, startAt: '2026-11-20T08:00' }, CURRENT_START).errors.startAt, 'equal to current start');
  assert.ok(postponementInput({ ...ok, startAt: '2026-11-20T07:59' }, CURRENT_START).errors.startAt, 'earlier than current start');
  assert.ok(postponementInput({ ...ok, endAt: '2026-11-20T09:00' }, CURRENT_START).errors.endAt, 'end equal to start');
  assert.ok(postponementInput({ ...ok, endAt: '2026-11-20T08:30' }, CURRENT_START).errors.endAt, 'end before start');
});

test('proposed window spans at most 30 days', () => {
  assert.deepEqual(postponementInput({ ...ok, endAt: '2026-12-20T09:00' }, CURRENT_START).errors, {});
  assert.ok(postponementInput({ ...ok, endAt: '2026-12-20T09:01' }, CURRENT_START).errors.endAt);
});

test('impossible calendar dates and non-datetime-local text are rejected', () => {
  for (const startAt of ['2026-02-30T09:00', '2026-11-20T24:00', '2026-11-20 09:00', '', null]) {
    assert.ok(postponementInput({ ...ok, startAt }, CURRENT_START).errors.startAt, String(startAt));
  }
  assert.ok(postponementInput({ ...ok, endAt: '2026-11-31T12:00' }, CURRENT_START).errors.endAt, 'Nov 31');
});

test('reason is required, trimmed and capped at 500 code points', () => {
  for (const reason of ['', '   ', undefined, 42, 'x'.repeat(501), '😀'.repeat(501)]) {
    assert.ok(postponementInput({ ...ok, reason }, CURRENT_START).errors.reason, String(reason).slice(0, 10));
  }
  assert.deepEqual(postponementInput({ ...ok, reason: '😀'.repeat(500) }, CURRENT_START).errors, {});
  assert.equal(postponementInput({ ...ok, reason: '' }, CURRENT_START).payload, null);
});

const CODES = ['STALE_VERSION', 'SHIFT_ACTIVE', 'PACKAGE_UNAVAILABLE', 'DISPUTE_OPEN', 'PARTY_CONFLICT', 'MACHINE_UNAVAILABLE',
  'OPERATOR_NOT_AUTHORIZED', 'SCHEDULE_CONFLICT', 'INVALID_ID', 'VALIDATION_FAILED', 'UNKNOWN_FIELD', 'DB_UNAVAILABLE'];

test('every listed server code has its own copy and never echoes the raw code', () => {
  const generic = postponementErrorMessage({ code: 'UNLISTED_CODE', status: 400 });
  for (const code of CODES) {
    const message = postponementErrorMessage({ code, status: 409 });
    assert.notEqual(message, generic, code);
    assert.doesNotMatch(message, new RegExp(code), code);
  }
});

test('stale, uncertain and unknown errors give explicit recovery copy', () => {
  assert.match(postponementErrorMessage({ code: 'STALE_VERSION', status: 409 }), /Tải lại/);
  assert.match(postponementErrorMessage({ code: 'NETWORK', status: 0, uncertain: true }), /Tải lại/);
  assert.match(postponementErrorMessage({ code: 'TIMEOUT', status: 0, uncertain: true }), /Tải lại/);
  assert.match(postponementErrorMessage({ code: 'UNAUTHENTICATED', status: 401 }), /đăng nhập/i);
  assert.match(postponementErrorMessage({ code: 'UNKNOWN_X', status: 500, uncertain: true }), /Tải lại/);
  for (const code of ['SOME_NEW_CODE', 'constructor', '__proto__', undefined]) {
    assert.doesNotMatch(postponementErrorMessage({ code, status: 400 }), /SOME_NEW_CODE|constructor|__proto__|undefined|\[object/);
  }
});

test('reader accepts the server envelope and rejects any shape outside the contract', () => {
  assert.deepEqual(readPostponement(ENVELOPE), ENVELOPE);
  assert.deepEqual(readPostponement({ ...ENVELOPE, latest: null, history: [] }).latest, null);
  const bad = [
    { ...ENVELOPE, latest: { ...LATEST, appliedAt: 'soon' } },
    { ...ENVELOPE, latest: { ...LATEST, version: 0 } },
    { ...ENVELOPE, latest: { ...LATEST, requiredCount: -1 } },
    { ...ENVELOPE, latest: { ...LATEST, consentedCount: 3 } },
    { ...ENVELOPE, latest: { ...LATEST, ownConsented: 'yes' } },
    { ...ENVELOPE, latest: 'x' },
    { ...ENVELOPE, history: {} },
    { ...ENVELOPE, history: Array.from({ length: 21 }, () => LATEST) },
    { ...ENVELOPE, package: { ...PACKAGE, status: 'PAID' } },
    { ...ENVELOPE, permissions: { canPropose: true } },
    { ...ENVELOPE, latest: undefined },
    null,
  ];
  for (const data of bad) assert.equal(readPostponement(data), null, JSON.stringify(data).slice(0, 60));
});

test('module keeps its boundaries and the neighbor render signature', async () => {
  const text = await readFile(new URL('../../web/postponement.js', import.meta.url), 'utf8');
  assert.equal(typeof renderPostponement, 'function');
  assert.match(text, /export async function renderPostponement\(\{ main, api, session, announce, route, signIn \}\)/);
  assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|\beval\(|new Function\(/);
  assert.doesNotMatch(text, /https?:\/\/|localhost|127\.0\.0\.1/);
  assert.doesNotMatch(text, /from ['"]\.\/app\.js['"]/);
  assert.doesNotMatch(text, /roles\.includes\(['"]farmer/);
  assert.doesNotMatch(text, /[\u2013\u2014]/);
});

// ---- render behavior through a minimal DOM double (no dependency) -----------
const FOCUS = { last: null };
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.parent = null;
    this.listeners = {}; this.value = ''; this.disabled = false; this.text = '';
  }
  get isConnected() { return true; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...nodes) { for (const n of nodes) if (n) { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.text = ''; this.append(...nodes); }
  after(node) { node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); }
  remove() { this.parent.children = this.parent.children.filter((c) => c !== this); }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  dispatch(ev) { for (const fn of this.listeners[ev] ?? []) fn({ preventDefault() {} }); }
  focus() { FOCUS.last = this; }
  matches(sel) {
    return sel.split(', ').some((s) => (s[0] === '#' ? this.attrs.id === s.slice(1)
      : s[0] === '.' ? (this.attrs.class ?? '').split(' ').includes(s.slice(1)) : this.tagName === s.toUpperCase()));
  }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const apiError = (fields) => Object.assign(new Error(fields.code), fields);

async function run({ hash = `#postponement/${id(1)}`, token = 'tok', responses = [] }) {
  const calls = []; const announced = []; const signedIn = [];
  globalThis.location = { hash };
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
  const queue = [...responses];
  const api = {
    request: async (method, path, opts = {}) => {
      calls.push({ method, path, body: opts.body });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { data: next };
    },
  };
  const main = new FakeNode('main');
  const session = { token, user: { id: id(11), roles: ['farmer'] } };
  await renderPostponement({ main, api, session, announce: (t) => announced.push(t), route: { name: 'postponement', id: id(1) }, signIn: (h) => signedIn.push(h) });
  await flush();
  return { main, calls, announced, signedIn };
}
const button = (main, prefix) => main.querySelectorAll('button').find((b) => b.textContent.startsWith(prefix));
const fill = (main, values) => {
  // Typing fires input events in a browser; the double replays them so the draft reflects the fields.
  for (const [sel, key] of [['#postponement-start', 'startAt'], ['#postponement-end', 'endAt'], ['#postponement-reason', 'reason']]) {
    const node = main.querySelector(sel);
    node.value = values[key];
    for (const fn of node.listeners.input ?? []) fn({});
  }
};
const OPEN_LATEST = { ...LATEST, ownConsented: false, consentedCount: 0 };
const envelope = (over = {}) => ({ ...ENVELOPE, ...over });

test('render without a session asks the parent to sign in and makes no request', async () => {
  const { calls, signedIn } = await run({ token: null });
  assert.deepEqual(signedIn, [`#postponement/${id(1)}`]);
  assert.equal(calls.length, 0);
});

test('invalid route id shows a message and makes no request', async () => {
  const { calls, main } = await run({ hash: '#postponement/not-an-id' });
  assert.equal(calls.length, 0);
  assert.match(main.textContent, /không hợp lệ/);
});

test('current window and latest proposal show counts, no financial claim and no consent button when already consented', async () => {
  const { calls, main } = await run({ responses: [envelope()] });
  assert.equal(calls[0].path, `/api/packages/${id(1)}/postponement`);
  assert.equal(calls[0].method, 'GET');
  assert.match(main.textContent, /1 trên 2 bên/);
  assert.match(main.textContent, /Đã đồng ý/);
  assert.match(main.textContent, /không làm thay đổi phí/);
  assert.equal(button(main, 'Đồng ý đề xuất'), undefined);
});

test('proposing posts only startAt, endAt and reason, then reloads from GET and never auto-consents', async () => {
  const { calls, main, announced } = await run({
    responses: [
      envelope({ latest: null, permissions: { canPropose: true, canConsent: false } }),
      envelope({ permissions: { canPropose: false, canConsent: false } }),
      envelope({ permissions: { canPropose: false, canConsent: false } }),
    ],
  });
  fill(main, { startAt: '2026-11-21T09:00', endAt: '2026-11-21T12:00', reason: '  Trời mưa lớn ' });
  main.querySelector('form').dispatch('submit');
  await flush();
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'GET']);
  assert.deepEqual(Object.keys(calls[1].body).sort(), ['endAt', 'reason', 'startAt']);
  assert.equal(calls[1].body.reason, 'Trời mưa lớn');
  assert.equal(calls[1].body.startAt, LOCAL(2026, 11, 21, 9, 0));
  assert.ok(announced.some((t) => t.startsWith('Đã gửi đề xuất')));
  assert.match(main.textContent, /Phiên bản 2/);
});

test('invalid proposal blocks the request and marks the field', async () => {
  const { calls, main } = await run({
    responses: [envelope({ latest: null, permissions: { canPropose: true, canConsent: false } })],
  });
  fill(main, { startAt: '2026-02-30T09:00', endAt: '2026-11-21T12:00', reason: 'Trời mưa' });
  main.querySelector('form').dispatch('submit');
  assert.equal(calls.length, 1, 'only the initial GET');
  assert.equal(main.querySelector('#postponement-start').attrs['aria-invalid'], 'true');
});

test('stale 409 on consent reloads current state and never announces success', async () => {
  const stale = apiError({ code: 'STALE_VERSION', status: 409 });
  const { calls, main, announced } = await run({
    responses: [envelope({ latest: OPEN_LATEST, permissions: { canPropose: false, canConsent: true } }), stale, envelope()],
  });
  button(main, 'Đồng ý đề xuất').dispatch('click');
  await flush();
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'GET']);
  assert.equal(announced.some((t) => /ghi nhận đồng ý/.test(t)), false);
  assert.match(main.textContent, /Đề xuất đã có phiên bản mới/);
});

test('uncertain network failure on proposal keeps the typed draft and never claims success', async () => {
  const network = apiError({ code: 'NETWORK', status: 0, uncertain: true });
  const { calls, main, announced } = await run({
    responses: [envelope({ latest: null, permissions: { canPropose: true, canConsent: false } }), network, envelope({ latest: null, permissions: { canPropose: true, canConsent: false } })],
  });
  fill(main, { startAt: '2026-11-21T09:00', endAt: '2026-11-21T12:00', reason: 'Trời mưa lớn' });
  main.querySelector('form').dispatch('submit');
  await flush();
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'GET']);
  assert.equal(announced.some((t) => t.startsWith('Đã gửi đề xuất')), false);
  assert.match(main.textContent, /Chưa xác nhận được thao tác/);
  assert.equal(main.querySelector('#postponement-reason').value, 'Trời mưa lớn');
});

test('page exposes reload and a usable way back for a booking owner', async () => {
  const {main}=await run({responses:[envelope()]});
  assert.ok(button(main,'Tải lại'));
  assert.ok(main.querySelectorAll('a').some(n=>n.attrs.href==='#bookings'));
});

test('a successful write followed by failed verification does not announce success', async () => {
  const {main,announced}=await run({responses:[
    envelope({latest:OPEN_LATEST,permissions:{canPropose:false,canConsent:true}}),
    envelope(),apiError({code:'NETWORK',uncertain:true,status:0}),
  ]});
  button(main,'Đồng ý đề xuất').dispatch('click');await flush();
  assert.deepEqual(announced,[]);
  assert.doesNotMatch(main.textContent,/Đã ghi nhận đồng ý/);
});
