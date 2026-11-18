/* global location */
// Role request page and admin review queue. Plain ES module, no storage, no HTML sinks.
// Server data is written with textContent only. The server decides every permission; the UI hides
// only actions the server would refuse. A decision is announced only after a fresh list read shows
// the exact status. Uncertain outcomes (network, timeout, 5xx) re-read the list before controls return.

const PAGE = 20;
const MAX_OFFSET = 10000;
const MAX_REASON = 500;
const MAX_NAME = 120;
const REQUESTABLE = ['provider', 'operator', 'coop'];
const ROLE_LABELS = {
  farmer: 'Nông dân',
  provider: 'Chủ máy',
  operator: 'Thợ lái hoặc phi công drone',
  coop: 'HTX hoặc điều phối viên',
  admin: 'Quản trị viên',
};
const STATUS_LABELS = { PENDING: 'Đang chờ duyệt', APPROVED: 'Đã duyệt', REJECTED: 'Đã từ chối' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const UNCERTAIN = 'Chưa xác nhận được thao tác đã được ghi nhận. Tải lại danh sách để xem trạng thái thật trước khi thử lại.';
const GENERIC = 'Không thực hiện được. Tải lại rồi thử lại.';
const MISMATCH = 'Trạng thái trên máy chủ chưa khớp. Tải lại danh sách để kiểm tra.';
const REQUEST_SENT = 'Đã gửi yêu cầu. Yêu cầu đang chờ quản trị viên duyệt.';
const NOT_LISTED = 'Chưa thấy yêu cầu vừa gửi trong danh sách. Tải lại danh sách để kiểm tra trước khi gửi lại.';
const APPROVED_DONE = 'Đã duyệt yêu cầu. Máy chủ đã xác nhận trạng thái.';
const REJECTED_DONE = 'Đã từ chối yêu cầu. Máy chủ đã xác nhận trạng thái.';
const ERRORS = {
  REQUEST_PENDING: 'Bạn đã có yêu cầu đang chờ cho vai trò này.',
  ROLE_ALREADY_GRANTED: 'Bạn đã có vai trò này.',
  REQUEST_DECIDED: 'Yêu cầu này đã được quyết định. Tải lại danh sách để xem trạng thái mới.',
  SELF_APPROVAL_FORBIDDEN: 'Bạn không thể tự duyệt hoặc từ chối yêu cầu của chính mình.',
  FORBIDDEN: 'Tài khoản này không có quyền thực hiện thao tác.',
  INVALID_ROLE: 'Vai trò này không thể yêu cầu ở đây.',
  INVALID_PAGINATION: 'Trang danh sách không hợp lệ. Tải lại từ trang đầu.',
  UNKNOWN_FIELD: 'Yêu cầu có trường không được phép. Tải lại trang rồi thử lại.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  DB_UNAVAILABLE: 'Hệ thống dữ liệu chưa sẵn sàng. Chưa coi thao tác là hoàn tất. Tải lại danh sách trước khi thử lại.',
  BAD_RESPONSE: 'Dữ liệu từ máy chủ không hợp lệ. Tải lại trang để xem trạng thái thật.',
};

// ---- routing and pure helpers (no DOM) --------------------------------------

export function accountsRoute(hash) {
  if (hash === '#roles') return { name: 'roles' };
  if (hash === '#admin/roles') return { name: 'adminRoles' };
  return null;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const isInstant = (value) => typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
const isReason = (value) => typeof value === 'string' && value.trim() !== '' && [...value].length <= MAX_REASON;
const badResponse = () => Object.assign(new Error('BAD_RESPONSE'), { code: 'BAD_RESPONSE', uncertain: true });
const isUncertain = (error) => error?.uncertain === true || error?.status === 0 || error?.status >= 500;

export function requestableRoles(granted = []) {
  return REQUESTABLE.filter((role) => !granted.includes(role));
}

export function roleRequestInput({ role } = {}, granted = []) {
  if (!REQUESTABLE.includes(role)) return { error: 'Chọn vai trò cần yêu cầu.', payload: null };
  if (granted.includes(role)) return { error: 'Bạn đã có vai trò này.', payload: null };
  return { error: null, payload: { role } };
}

export function rejectReasonInput(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { error: 'Nhập lý do từ chối trước khi gửi.', payload: null };
  if ([...text].length > MAX_REASON) return { error: 'Lý do từ chối tối đa 500 ký tự.', payload: null };
  return { error: null, payload: { reason: text } };
}

const validRequest = (r) => isObject(r) && isUuid(r.id) && isUuid(r.userId)
  && typeof r.userName === 'string' && r.userName.trim() !== '' && [...r.userName].length <= MAX_NAME
  && REQUESTABLE.includes(r.role) && Object.hasOwn(STATUS_LABELS, r.status) && isInstant(r.createdAt)
  && typeof r.canDecide === 'boolean'
  && (r.status === 'PENDING'
    ? r.decidedAt === null && r.decisionReason === null
    : isInstant(r.decidedAt) && r.canDecide === false
      && (r.status === 'REJECTED' ? isReason(r.decisionReason) : r.decisionReason === null));

// The page must answer for the offset and limit the client asked for. Otherwise it is a bad response.
export function readRequestPage(data, offset) {
  if (!isObject(data) || !Array.isArray(data.items) || data.items.length > PAGE) return null;
  if (!data.items.every(validRequest) || data.limit !== PAGE || data.offset !== offset) return null;
  return { items: data.items, limit: data.limit, offset: data.offset };
}

export function pageControls(offset, count) {
  return {
    prev: offset > 0 ? Math.max(0, offset - PAGE) : null,
    next: count === PAGE && offset + PAGE <= MAX_OFFSET ? offset + PAGE : null,
  };
}

export function readDecision(data, id, status) {
  const request = isObject(data) ? data.request : null;
  return validRequest(request) && request.id === id && request.status === status ? request : null;
}

// Known codes get their own copy. Uncertain outcomes never claim failure or success. Unknown codes never show raw text.
export function roleErrorMessage(error) {
  if (Object.hasOwn(ERRORS, error?.code)) return ERRORS[error.code];
  if (error?.status === 401) return ERRORS.UNAUTHENTICATED;
  if (isUncertain(error)) return UNCERTAIN;
  return GENERIC;
}

const historyPath = (offset) => `/api/role-requests?limit=${PAGE}&offset=${offset}`;
const queuePath = (offset) => `/api/admin/role-requests?limit=${PAGE}&offset=${offset}`;
const roleLabel = (role) => (Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role] : 'Vai trò khác');
const shortTime = (iso) => new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const note = (text, tone = 'error') => ({ tone, text });

// ---- render (browser only) --------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = globalThis.document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === undefined || value === null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'click') node.addEventListener('click', value);
    else if (key === 'disabled') node.disabled = true;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const alertNode = (text) => el('p', { class: 'alert error', role: 'alert', tabindex: '-1', text });

export async function renderAccounts({ main, api, session, announce, route, signIn }) {
  const hash = location.hash;
  if (!session.token) {
    signIn(hash);
    return;
  }
  const active = () => location.hash === hash && content.isConnected;
  const admin = route.name === 'adminRoles';
  const heading = el('h1', { tabindex: '-1', text: admin ? 'Duyệt vai trò' : 'Vai trò tài khoản' });
  const content = el('section', { class: 'page', 'aria-live': 'polite' });
  main.replaceChildren(heading, content);
  heading.focus();
  if (admin && !(session.user.roles ?? []).includes('admin')) {
    content.replaceChildren(el('p', { class: 'alert error', role: 'alert', tabindex: '-1', text: 'Tài khoản này không có quyền xem hàng đợi duyệt vai trò.' }));
    return;
  }

  let offset = 0;
  let page = null;
  let notice = null;
  const roleNames = () => session.user.roles ?? [];

  function noticeNode() {
    if (!notice) return null;
    return notice.tone === 'status'
      ? el('p', { class: 'alert success', role: 'status', tabindex: '-1', text: notice.text })
      : alertNode(notice.text);
  }

  function pager() {
    const { prev, next } = pageControls(offset, page.items.length);
    const go = (to) => () => { offset = to; load(); };
    return el('p', { class: 'pager' }, [
      el('button', { type: 'button', class: 'btn secondary', text: 'Trang trước', disabled: prev === null, click: go(prev) }),
      el('button', { type: 'button', class: 'btn secondary', text: 'Trang sau', disabled: next === null, click: go(next) }),
    ]);
  }

  // One draw path for both pages. Focus goes to the notice when there is one, otherwise to the heading,
  // unless the caller asks to keep focus on the control it just used (refresh).
  let refreshButton = null;
  function draw({ keepRefresh = false } = {}) {
    const top = noticeNode();
    const nodes = admin ? adminNodes(top) : roleNodes(top);
    content.replaceChildren(...nodes.filter(Boolean));
    if (keepRefresh && refreshButton) refreshButton.focus();
    else (top ?? heading).focus();
  }

  async function load(next = null) {
    if (!active()) return;
    notice = next;
    content.replaceChildren(el('p', { role: 'status', text: 'Đang tải…' }));
    try {
      const { data } = await api.request('GET', admin ? queuePath(offset) : historyPath(offset), { auth: true });
      if (!active()) return;
      page = readRequestPage(data, offset);
      if (!page) throw badResponse();
      draw();
    } catch (error) {
      if (!active()) return;
      notice = null;
      content.replaceChildren(alertNode(roleErrorMessage(error)), el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại', click: () => load() }),
      ]));
    }
  }

  // ---- roles page (own requests) ----

  function roleNodes(top) {
    const granted = roleNames();
    const options = requestableRoles(granted);
    const refreshFeedback = el('div', { 'aria-live': 'polite' });
    const refresh = el('button', { type: 'button', class: 'btn secondary', text: 'Làm mới vai trò', click: () => refreshRoles(refresh, refreshFeedback) });
    refreshButton = refresh;
    return [
      top,
      el('p', { text: 'Yêu cầu vai trò cần quản trị viên duyệt. Duyệt vai trò chỉ mở quyền trên tài khoản, không phải chứng nhận máy móc hoặc chứng chỉ phi công. Thao tác này không thu tiền.' }),
      el('section', {}, [
        el('h2', { text: 'Vai trò hiện có' }),
        el('p', { text: granted.length ? granted.map(roleLabel).join(', ') : 'Chưa có vai trò nào.' }),
        el('p', { class: 'hint', text: 'Sau khi quản trị viên duyệt, bấm Làm mới vai trò để cập nhật từ máy chủ.' }),
        el('div', { class: 'actions' }, [refresh]),
        refreshFeedback,
      ]),
      options.length ? requestSection(options) : el('p', { text: 'Bạn đã có đủ các vai trò có thể yêu cầu.' }),
      el('section', {}, [
        el('h2', { text: 'Yêu cầu của bạn' }),
        el('div', { class: 'actions' }, [el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại danh sách', click: () => load() })]),
        page.items.length
          ? el('ul', { class: 'cards' }, page.items.map(historyCard))
          : el('p', { text: offset ? 'Không còn yêu cầu ở trang này.' : 'Bạn chưa gửi yêu cầu vai trò nào.' }),
        pager(),
      ]),
    ];
  }

  function historyCard(r) {
    return el('li', { class: 'card' }, [
      el('h3', { text: roleLabel(r.role) }),
      el('p', { text: `${STATUS_LABELS[r.status]}. Gửi lúc ${shortTime(r.createdAt)}.` }),
      r.decidedAt ? el('p', { text: `Quyết định lúc ${shortTime(r.decidedAt)}.` }) : null,
      r.decisionReason ? el('p', { text: `Lý do: ${r.decisionReason}` }) : null,
    ]);
  }

  function requestSection(options) {
    const select = el('select', { id: 'role-request-role', name: 'role', 'aria-describedby': 'role-request-hint' }, [
      el('option', { value: '', text: 'Chọn vai trò' }),
      ...options.map((role) => el('option', { value: role, text: roleLabel(role) })),
    ]);
    const feedback = el('div', { 'aria-live': 'polite' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Gửi yêu cầu' });
    const form = el('form', { class: 'form', novalidate: true, 'aria-label': 'Yêu cầu vai trò' }, [
      el('div', { class: 'field' }, [
        el('label', { for: 'role-request-role', text: 'Vai trò cần yêu cầu' }),
        el('p', { id: 'role-request-hint', class: 'hint', text: 'Chỉ hiện vai trò bạn chưa có. Không thể tự yêu cầu quyền quản trị viên.' }),
        select,
      ]),
      feedback,
      submit,
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const { error, payload } = roleRequestInput({ role: select.value }, roleNames());
      if (error) {
        select.setAttribute('aria-invalid', 'true');
        feedback.replaceChildren(alertNode(error));
        select.focus();
        return;
      }
      select.removeAttribute('aria-invalid');
      submit.disabled = true;
      select.disabled = true;
      feedback.replaceChildren();
      try {
        const { data } = await api.request('POST', '/api/role-requests', { auth: true, body: payload });
        if (!active()) return;
        const created = isObject(data) && validRequest(data.request) && data.request.role === payload.role && data.request.status === 'PENDING'
          ? data.request : null;
        if (!created) throw badResponse();
        const { data: list } = await api.request('GET', historyPath(0), { auth: true });
        if (!active()) return;
        const check = readRequestPage(list, 0);
        if (!check) throw badResponse();
        offset = 0;
        page = check;
        if (!check.items.some((r) => r.id === created.id && r.status === 'PENDING')) {
          await load(note(NOT_LISTED));
          return;
        }
        announce(REQUEST_SENT);
        notice = note(REQUEST_SENT, 'status');
        draw();
      } catch (error) {
        if (!active()) return;
        if (isUncertain(error)) {
          await load(note(roleErrorMessage(error)));
          return;
        }
        submit.disabled = false;
        select.disabled = false;
        const alert = alertNode(roleErrorMessage(error));
        feedback.replaceChildren(alert);
        alert.focus();
      }
    });
    return el('section', {}, [el('h2', { text: 'Yêu cầu vai trò mới' }), form]);
  }

  async function refreshRoles(button, feedback) {
    if (button.disabled) return;
    button.disabled = true;
    feedback.replaceChildren();
    try {
      const { data } = await api.request('GET', '/api/me', { auth: true });
      if (!active()) return;
      const user = data?.user;
      if (!isObject(user) || user.id !== session.user.id || !Array.isArray(user.roles) || !user.roles.every((r) => typeof r === 'string')) {
        throw badResponse();
      }
      session.user.roles = [...user.roles];
      announce('Đã cập nhật vai trò từ máy chủ.');
      draw({ keepRefresh: true });
    } catch (error) {
      if (!active()) return;
      button.disabled = false;
      feedback.replaceChildren(alertNode(roleErrorMessage(error)));
    }
  }

  // ---- admin queue ----

  function adminNodes(top) {
    return [
      top,
      el('p', { text: 'Yêu cầu đang chờ hiển thị trước. Trình duyệt không sắp xếp lại danh sách; máy chủ quyết định quyền duyệt cuối cùng.' }),
      el('div', { class: 'actions' }, [el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại danh sách', click: () => load() })]),
      page.items.length
        ? el('ul', { class: 'cards' }, page.items.map(queueCard))
        : el('p', { text: offset ? 'Không còn yêu cầu ở trang này.' : 'Chưa có yêu cầu vai trò nào.' }),
      pager(),
    ];
  }

  function queueCard(r) {
    const card = el('li', { class: 'card' }, [
      el('h3', { text: r.userName }),
      el('p', { text: `Vai trò: ${roleLabel(r.role)}. ${STATUS_LABELS[r.status]}. Gửi lúc ${shortTime(r.createdAt)}.` }),
      r.decidedAt ? el('p', { text: `Quyết định lúc ${shortTime(r.decidedAt)}.` }) : null,
      r.decisionReason ? el('p', { text: `Lý do: ${r.decisionReason}` }) : null,
    ]);
    if (r.canDecide) card.append(decisionBox(r));
    else if (r.status === 'PENDING' && r.userId === session.user.id) {
      card.append(el('p', { class: 'hint', text: 'Bạn không thể tự quyết định yêu cầu của chính mình.' }));
    }
    return card;
  }

  function decisionBox(r) {
    const feedback = el('div', { 'aria-live': 'polite' });
    const formSlot = el('div');
    const controls = [];
    const lock = (busy) => { for (const control of controls) control.disabled = busy; };
    const approve = el('button', { type: 'button', class: 'btn primary', text: 'Duyệt' });
    const reject = el('button', { type: 'button', class: 'btn secondary', text: 'Từ chối' });
    controls.push(approve, reject);

    approve.addEventListener('click', () => {
      if (approve.disabled) return;
      if (!globalThis.confirm(`Duyệt vai trò ${roleLabel(r.role)} cho ${r.userName}? Sau khi duyệt, màn hình này không có thao tác thu hồi.`)) return;
      decide({ lock, feedback, path: `/api/admin/role-requests/${r.id}/approve`, body: {}, id: r.id, expected: 'APPROVED', done: APPROVED_DONE });
    });

    reject.addEventListener('click', () => {
      if (reject.disabled) return;
      reject.hidden = true;
      const area = el('textarea', { id: `reject-${r.id}`, name: 'reason', rows: 3, 'aria-describedby': `reject-${r.id}-hint` });
      const submitReject = el('button', { type: 'submit', class: 'btn primary', text: 'Xác nhận từ chối' });
      const cancel = el('button', {
        type: 'button',
        class: 'btn secondary',
        text: 'Hủy',
        click: () => { formSlot.replaceChildren(); reject.hidden = false; reject.focus(); },
      });
      controls.push(submitReject);
      const form = el('form', { class: 'form', novalidate: true, 'aria-label': `Lý do từ chối ${r.userName}` }, [
        el('div', { class: 'field' }, [
          el('label', { for: `reject-${r.id}`, text: 'Lý do từ chối' }),
          el('p', { id: `reject-${r.id}-hint`, class: 'hint', text: 'Nêu lý do ngắn, tối đa 500 ký tự. Lý do được lưu trên máy chủ.' }),
          area,
        ]),
        el('div', { class: 'actions' }, [submitReject, cancel]),
      ]);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (submitReject.disabled) return;
        const { error, payload } = rejectReasonInput(area.value);
        if (error) {
          area.setAttribute('aria-invalid', 'true');
          feedback.replaceChildren(alertNode(error));
          area.focus();
          return;
        }
        area.removeAttribute('aria-invalid');
        decide({ lock, feedback, path: `/api/admin/role-requests/${r.id}/reject`, body: payload, id: r.id, expected: 'REJECTED', done: REJECTED_DONE });
      });
      formSlot.replaceChildren(form);
      area.focus();
    });

    return el('div', { class: 'decision' }, [el('div', { class: 'actions' }, [approve, reject]), feedback, formSlot]);
  }

  // Definitive refusal keeps the draft and re-enables controls. Uncertain or already-decided outcomes re-read first.
  async function decide({ lock, feedback, path, body, id, expected, done }) {
    lock(true);
    feedback.replaceChildren();
    try {
      const { data } = await api.request('POST', path, { auth: true, body });
      if (!active()) return;
      if (!readDecision(data, id, expected)) throw badResponse();
      const { data: list } = await api.request('GET', queuePath(offset), { auth: true });
      if (!active()) return;
      const check = readRequestPage(list, offset);
      if (!check) throw badResponse();
      page = check;
      const matched = check.items.find((r) => r.id === id)?.status === expected;
      announce(matched ? done : MISMATCH);
      notice = matched ? note(done, 'status') : note(MISMATCH);
      draw();
    } catch (error) {
      if (!active()) return;
      if (error?.code === 'REQUEST_DECIDED' || isUncertain(error)) {
        await load(note(roleErrorMessage(error)));
        return;
      }
      const alert = alertNode(roleErrorMessage(error));
      feedback.replaceChildren(alert);
      lock(false);
      alert.focus();
    }
  }

  await load();
}
