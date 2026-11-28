import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  accountsRoute,
  pageControls,
  readDecision,
  readRequestPage,
  rejectReasonInput,
  renderAccounts,
  requestableRoles,
  roleErrorMessage,
  roleRequestInput,
} from '../../web/accounts.js';

const ID = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = ID(11);
const ADMIN = ID(20);
const NOW = '2026-11-20T03:00:00.000Z';
const dto = (over = {}) => ({
  id: ID(1), userId: USER, userName: 'Nguyễn Văn An', role: 'provider', status: 'PENDING',
  createdAt: NOW, decidedAt: null, decisionReason: null, canDecide: false, ...over,
});
const page = (items, offset = 0) => ({ items, limit: 20, offset });
const ok = (data, status = 200) => ({ status, data });
const fail = (code, status, uncertain = status === 0 || status >= 500) => Object.assign(new Error(code), { code, status, uncertain });

// ---- pure helpers -----------------------------------------------------------

test('accounts route accepts only #roles and #admin/roles', () => {
  assert.deepEqual(accountsRoute('#roles'), { name: 'roles' });
  assert.deepEqual(accountsRoute('#admin/roles'), { name: 'adminRoles' });
  for (const hash of ['', '#', '#roles/', '#roles?x=1', '#admin', '#admin/roles/', '#admin/roles?x=1', '#role', undefined]) {
    assert.equal(accountsRoute(hash), null, String(hash));
  }
});

test('role request offers only provider, operator and coop that are not yet granted', () => {
  assert.deepEqual(requestableRoles(['farmer', 'operator']), ['provider', 'coop']);
  assert.deepEqual(roleRequestInput({ role: 'coop' }, ['farmer']), { error: null, payload: { role: 'coop' } });
  for (const role of ['admin', 'farmer', 'PROVIDER', '', undefined]) {
    assert.ok(roleRequestInput({ role }, []).error, String(role));
  }
  assert.ok(roleRequestInput({ role: 'operator' }, ['operator']).error);
});

test('reject reason is trimmed and bounded to 500 code points', () => {
  assert.deepEqual(rejectReasonInput('  Thiếu ảnh  '), { error: null, payload: { reason: 'Thiếu ảnh' } });
  for (const value of ['', '   ', null, '😀'.repeat(501)]) assert.ok(rejectReasonInput(value).error, JSON.stringify(value));
  assert.equal(rejectReasonInput('😀'.repeat(500)).error, null);
});

test('page reader keeps server order and rejects drifted or inconsistent rows', () => {
  const rows = [dto({ id: ID(3), canDecide: true }), dto({ id: ID(2), status: 'APPROVED', decidedAt: NOW })];
  assert.deepEqual(readRequestPage(page(rows, 0), 0).items.map((r) => r.id), [ID(3), ID(2)]);
  assert.equal(readRequestPage(page(rows, 20), 0), null, 'offset mismatch');
  assert.equal(readRequestPage({ items: [], limit: 10, offset: 0 }, 0), null, 'limit mismatch');
  const bad = [
    { id: 'x' }, dto({ role: 'admin' }), dto({ role: 'farmer' }), dto({ status: 'DONE' }), dto({ createdAt: 'hôm qua' }),
    dto({ status: 'PENDING', decidedAt: NOW }), dto({ status: 'APPROVED', decidedAt: null }), dto({ canDecide: 'yes' }),
    dto({ status: 'APPROVED', decidedAt: NOW, canDecide: true }), dto({ userName: '' }), dto({ decisionReason: 42 }),
  ];
  for (const row of bad) assert.equal(readRequestPage(page([row], 0), 0), null, JSON.stringify(row));
});

test('paging stays within offset 0 to 10000 in steps of 20', () => {
  assert.deepEqual(pageControls(0, 20), { prev: null, next: 20 });
  assert.deepEqual(pageControls(20, 3), { prev: 0, next: null });
  assert.deepEqual(pageControls(9980, 20), { prev: 9960, next: 10000 });
  assert.deepEqual(pageControls(10000, 20), { prev: 9980, next: null });
});

test('decision reply must name the same request with the expected final status', () => {
  const approved = dto({ status: 'APPROVED', decidedAt: NOW });
  assert.deepEqual(readDecision({ request: approved }, ID(1), 'APPROVED'), approved);
  assert.equal(readDecision({ request: approved }, ID(1), 'REJECTED'), null);
  assert.equal(readDecision({ request: approved }, ID(2), 'APPROVED'), null);
  assert.equal(readDecision({}, ID(1), 'APPROVED'), null);
});

test('errors show Vietnamese copy and never a raw server code', () => {
  assert.equal(roleErrorMessage(fail('REQUEST_PENDING', 409)), 'Bạn đã có yêu cầu đang chờ cho vai trò này.');
  assert.equal(roleErrorMessage(fail('SELF_APPROVAL_FORBIDDEN', 403)), 'Bạn không thể tự duyệt hoặc từ chối yêu cầu của chính mình.');
  assert.match(roleErrorMessage(fail('NETWORK', 0, true)), /Chưa xác nhận/);
  assert.match(roleErrorMessage(fail('DB_UNAVAILABLE', 503)), /chưa sẵn sàng/);
  assert.match(roleErrorMessage(fail('UNAUTHENTICATED', 401)), /đăng nhập lại/);
  assert.match(roleErrorMessage(fail('UNEXPECTED_CODE', 418, false)), /Không thực hiện được/);
  assert.doesNotMatch(roleErrorMessage(fail('UNEXPECTED_CODE', 418, false)), /UNEXPECTED_CODE/);
  assert.match(roleErrorMessage(fail('UNEXPECTED_CODE', 502)), /Chưa xác nhận/);
});

test('module keeps text-only sinks and no dash characters in UI copy', async () => {
  const source = await readFile(new URL('../../web/accounts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(source, /[\u2013\u2014]/);
});

// ---- render through a minimal DOM double (same pattern as web-evidence.test.js) ----

const FOCUS = { last: null };
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.parent = null;
    this.listeners = {}; this.text = ''; this.value = ''; this.hidden = false; this.disabled = false;
  }
  get isConnected() { return true; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...nodes) { for (const n of nodes) if (n) { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.text = ''; this.append(...nodes); }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  dispatch(ev, extra = {}) { for (const fn of this.listeners[ev] ?? []) fn({ preventDefault() {}, ...extra }); }
  click() { this.dispatch('click'); }
  focus() { FOCUS.last = this; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const find = (root, tag, pred = () => true) => root.all().find((n) => n.tagName === tag && pred(n));
const findAll = (root, tag) => root.all().filter((n) => n.tagName === tag);
const button = (root, label) => find(root, 'BUTTON', (n) => n.textContent === label);

async function mount({
  hash = '#roles', route = { name: 'roles' }, token = 'token-for-test',
  user = { id: USER, name: 'Nguyễn Văn An', roles: ['farmer'] }, responses = [], confirmAnswer = true,
} = {}) {
  const calls = [], announced = [], signedIn = [], confirms = [];
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
  globalThis.location = { hash };
  globalThis.confirm = (text) => { confirms.push(text); return confirmAnswer; };
  const session = { token, user: JSON.parse(JSON.stringify(user)) };
  const main = new FakeNode('main');
  const api = {
    request: async (method, path, options = {}) => {
      calls.push({ method, path, body: options.body });
      const next = responses.shift();
      if (next === undefined) throw new Error(`unexpected ${method} ${path}`);
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
  };
  await renderAccounts({ main, api, session, announce: (t) => announced.push(t), route, signIn: (h) => signedIn.push(h) });
  await flush();
  return { main, calls, announced, session, signedIn, confirms };
}

const ROLE_FORM = (main) => find(main, 'FORM');
const SUBMIT = (main) => find(main, 'BUTTON', (n) => n.attrs.type === 'submit');
const ADMIN_ROUTE = { hash: '#admin/roles', route: { name: 'adminRoles' }, user: { id: ADMIN, name: 'Quản trị', roles: ['admin'] } };

test('without a session the page asks for sign-in and makes no request', async () => {
  const { calls, signedIn } = await mount({ token: null });
  assert.deepEqual(calls, []);
  assert.deepEqual(signedIn, ['#roles']);
});

test('roles page shows own history and offers only roles not yet granted, never admin', async () => {
  const { main, calls } = await mount({
    user: { id: USER, name: 'Nguyễn Văn An', roles: ['farmer', 'provider'] },
    responses: [ok(page([dto({ status: 'REJECTED', decidedAt: NOW, decisionReason: 'Thiếu hồ sơ' })]))],
  });
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/role-requests?limit=20&offset=0', body: undefined }]);
  assert.deepEqual(findAll(main, 'OPTION').map((o) => o.attrs.value), ['', 'operator', 'coop']);
  assert.match(main.textContent, /Đã từ chối/);
  assert.match(main.textContent, /Thiếu hồ sơ/);
  assert.match(main.textContent, /không phải chứng nhận máy móc/);
  assert.match(main.textContent, /Thao tác này không thu tiền/);
});

test('submitting a role posts the exact body and announces only after the list shows it pending', async () => {
  const requested = dto({ id: ID(2), role: 'coop' });
  const { main, calls, announced } = await mount({
    responses: [ok(page([])), ok({ request: requested }, 201), ok(page([requested]))],
  });
  find(main, 'SELECT').value = 'coop';
  ROLE_FORM(main).dispatch('submit');
  await flush();
  assert.deepEqual(calls.slice(1), [
    { method: 'POST', path: '/api/role-requests', body: { role: 'coop' } },
    { method: 'GET', path: '/api/role-requests?limit=20&offset=0', body: undefined },
  ]);
  assert.deepEqual(announced, ['Đã gửi yêu cầu. Yêu cầu đang chờ quản trị viên duyệt.']);
});

test('a definitive refusal keeps the chosen role and shows copy without the raw code', async () => {
  const { main, announced } = await mount({ responses: [ok(page([])), fail('REQUEST_PENDING', 409)] });
  find(main, 'SELECT').value = 'coop';
  ROLE_FORM(main).dispatch('submit');
  await flush();
  assert.match(main.textContent, /Bạn đã có yêu cầu đang chờ/);
  assert.doesNotMatch(main.textContent, /REQUEST_PENDING/);
  assert.equal(find(main, 'SELECT').value, 'coop');
  assert.equal(SUBMIT(main).disabled, false);
  assert.deepEqual(announced, []);
});

test('an uncertain request re-reads the history and never announces success', async () => {
  const { main, calls, announced } = await mount({ responses: [ok(page([])), fail('NETWORK', 0, true), ok(page([]))] });
  find(main, 'SELECT').value = 'coop';
  ROLE_FORM(main).dispatch('submit');
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].method, 'GET');
  assert.deepEqual(announced, []);
  assert.match(main.textContent, /Chưa xác nhận được/);
});

test('refresh takes roles from /api/me only when the user id matches', async () => {
  const { main, session } = await mount({
    responses: [ok(page([])), ok({ user: { id: USER, name: 'Nguyễn Văn An', roles: ['farmer', 'operator'] } })],
  });
  button(main, 'Làm mới vai trò').click();
  await flush();
  assert.deepEqual(session.user.roles, ['farmer', 'operator']);
  assert.deepEqual(findAll(main, 'OPTION').map((o) => o.attrs.value), ['', 'provider', 'coop']);
});

test('refresh keeps keyboard focus on the refresh control after redraw', async () => {
  const { main } = await mount({ responses: [ok(page([])), ok({ user: { id: USER, name: 'Nguyễn Văn An', roles: ['farmer', 'coop'] } })] });
  button(main, 'Làm mới vai trò').click();
  await flush();
  assert.equal(FOCUS.last, button(main, 'Làm mới vai trò'));
});

test('refresh ignores an /api/me answer for another user', async () => {
  const { main, session } = await mount({ responses: [ok(page([])), ok({ user: { id: ADMIN, roles: ['admin'] } })] });
  button(main, 'Làm mới vai trò').click();
  await flush();
  assert.deepEqual(session.user.roles, ['farmer']);
  assert.match(main.textContent, /không hợp lệ/);
});

test('a late history reply after navigating away changes nothing on screen', async () => {
  const { main } = await mount({
    responses: [async () => { globalThis.location.hash = '#services'; return ok(page([dto()])); }],
  });
  assert.doesNotMatch(main.textContent, /Đang chờ duyệt/);
});

test('admin queue is refused without the admin role and makes no request', async () => {
  const { main, calls } = await mount({ hash: '#admin/roles', route: { name: 'adminRoles' } });
  assert.deepEqual(calls, []);
  assert.match(main.textContent, /không có quyền xem hàng đợi/);
});

test('queue shows names and roles, hides approval on own or final requests', async () => {
  const own = dto({ id: ID(3), userId: ADMIN, userName: 'Quản trị A', role: 'coop', canDecide: false });
  const open = dto({ id: ID(4), userName: 'Trần Thị B', role: 'operator', canDecide: true });
  const done = dto({ id: ID(5), status: 'REJECTED', decidedAt: NOW, decisionReason: 'Thiếu giấy tờ' });
  const { main, calls } = await mount({ ...ADMIN_ROUTE, responses: [ok(page([own, open, done]))] });
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/admin/role-requests?limit=20&offset=0', body: undefined }]);
  assert.equal(findAll(main, 'BUTTON').filter((b) => b.textContent === 'Duyệt').length, 1);
  assert.match(main.textContent, /Bạn không thể tự quyết định/);
  assert.match(main.textContent, /Thiếu giấy tờ/);
  assert.match(main.textContent, /Trần Thị B/);
});

test('approve posts once, then re-reads the queue before announcing', async () => {
  const req = dto({ id: ID(4), userName: 'Trần Thị B', role: 'operator', canDecide: true });
  const approved = { ...req, status: 'APPROVED', decidedAt: NOW, canDecide: false };
  const { main, calls, announced, confirms } = await mount({
    ...ADMIN_ROUTE, responses: [ok(page([req])), ok({ request: approved }), ok(page([approved]))],
  });
  button(main, 'Duyệt').click();
  await flush();
  assert.equal(confirms.length, 1);
  assert.deepEqual(calls.slice(1), [
    { method: 'POST', path: `/api/admin/role-requests/${ID(4)}/approve`, body: {} },
    { method: 'GET', path: '/api/admin/role-requests?limit=20&offset=0', body: undefined },
  ]);
  assert.deepEqual(announced, ['Đã duyệt yêu cầu. Máy chủ đã xác nhận trạng thái.']);
  assert.equal(button(main, 'Duyệt'), undefined);
});

test('declining the approval confirmation sends nothing', async () => {
  const req = dto({ id: ID(4), canDecide: true });
  const { main, calls } = await mount({ ...ADMIN_ROUTE, confirmAnswer: false, responses: [ok(page([req]))] });
  button(main, 'Duyệt').click();
  await flush();
  assert.equal(calls.length, 1);
});

test('a decision is not announced when the re-read shows another status', async () => {
  const req = dto({ id: ID(4), canDecide: true });
  const approved = { ...req, status: 'APPROVED', decidedAt: NOW, canDecide: false };
  const { main, announced } = await mount({ ...ADMIN_ROUTE, responses: [ok(page([req])), ok({ request: approved }), ok(page([req]))] });
  button(main, 'Duyệt').click();
  await flush();
  assert.deepEqual(announced, ['Trạng thái trên máy chủ chưa khớp. Tải lại danh sách để kiểm tra.']);
});

test('reject needs a reason of 1 to 500 code points and sends the trimmed text', async () => {
  const req = dto({ id: ID(4), canDecide: true });
  const rejected = { ...req, status: 'REJECTED', decidedAt: NOW, decisionReason: 'Thiếu ảnh', canDecide: false };
  const { main, calls, announced } = await mount({
    ...ADMIN_ROUTE, responses: [ok(page([req])), ok({ request: rejected }), ok(page([rejected]))],
  });
  button(main, 'Từ chối').click();
  const area = find(main, 'TEXTAREA');
  area.value = '   ';
  ROLE_FORM(main).dispatch('submit');
  await flush();
  assert.equal(calls.length, 1);
  assert.match(main.textContent, /Nhập lý do từ chối/);
  area.value = '  Thiếu ảnh  ';
  ROLE_FORM(main).dispatch('submit');
  await flush();
  assert.deepEqual(calls[1], { method: 'POST', path: `/api/admin/role-requests/${ID(4)}/reject`, body: { reason: 'Thiếu ảnh' } });
  assert.deepEqual(announced, ['Đã từ chối yêu cầu. Máy chủ đã xác nhận trạng thái.']);
});

test('a definitive reject refusal keeps the reason draft and re-enables actions', async () => {
  const req = dto({ id: ID(4), canDecide: true });
  const { main, calls } = await mount({ ...ADMIN_ROUTE, responses: [ok(page([req])), fail('UNKNOWN_FIELD', 400)] });
  button(main, 'Từ chối').click();
  const area = find(main, 'TEXTAREA');
  area.value = 'Thiếu ảnh';
  ROLE_FORM(main).dispatch('submit');
  await flush();
  assert.equal(area.value, 'Thiếu ảnh');
  assert.match(main.textContent, /trường không được phép/);
  assert.equal(calls.length, 2, 'no re-read on a definitive refusal');
  assert.equal(button(main, 'Duyệt').disabled, false);
});

test('REQUEST_DECIDED re-reads the queue and shows the decided state', async () => {
  const req = dto({ id: ID(4), canDecide: true });
  const approved = { ...req, status: 'APPROVED', decidedAt: NOW, canDecide: false };
  const { main, calls } = await mount({ ...ADMIN_ROUTE, responses: [ok(page([req])), fail('REQUEST_DECIDED', 409), ok(page([approved]))] });
  button(main, 'Duyệt').click();
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(button(main, 'Duyệt'), undefined);
  assert.match(main.textContent, /Yêu cầu này đã được quyết định/);
});

test('an uncertain decision keeps actions off until the queue is re-read', async () => {
  const req = dto({ id: ID(4), canDecide: true });
  let visibleDuringRead;
  const { main, calls, announced } = await mount({
    ...ADMIN_ROUTE,
    responses: [
      ok(page([req])),
      fail('TIMEOUT', 0, true),
      () => { visibleDuringRead = button(main, 'Duyệt'); return ok(page([req])); },
    ],
  });
  button(main, 'Duyệt').click();
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(visibleDuringRead, undefined, 'no enabled approval while the re-read is pending');
  assert.deepEqual(announced, []);
  assert.match(main.textContent, /Chưa xác nhận được/);
  assert.equal(button(main, 'Duyệt').disabled, false);
});

test('a list answer that breaks the contract shows a bad-response message', async () => {
  const { main } = await mount({ ...ADMIN_ROUTE, responses: [ok({ items: [{ id: 'bad' }], limit: 20, offset: 0 })] });
  assert.match(main.textContent, /không hợp lệ/);
  assert.ok(button(main, 'Tải lại'), 'a retry control is offered');
});
