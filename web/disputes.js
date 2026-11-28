/* global location */
import {renderEvidence} from './evidence.js';
// Dispute UI: case list, case detail with proposals, complaint form, admin review queue.
// Plain ES module, no storage, no HTML sinks. Server data is written with textContent only.
// The server decides every permission. The UI only hides actions that cannot succeed.
// An open or unresolved dispute blocks financial writes. A consent is not an executed remedy.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT = 2000;
const PAGE = 20;
const REASONS = { AREA_MISMATCH: 'Diện tích không khớp', QUALITY: 'Chất lượng công việc', NO_SHOW: 'Không có mặt', PAYMENT: 'Thanh toán', OTHER: 'Lý do khác' };
const STATUSES = { OPEN: 'Đang mở', RESOLVED: 'Đã giải quyết', CLOSED_UNRESOLVED: 'Đóng chưa giải quyết', CLOSED: 'Đã đóng' };
const LEVELS = { HTX: 'Cấp HTX', ADMIN: 'Cấp quản trị' };
const CASE_EVENTS = { DISPUTE_OPENED: 'Mở khiếu nại', RESPONSE_ADDED: 'Phản hồi', MEDIATOR_ASSIGNED: 'Gán người hòa giải', MEDIATION_ESCALATED: 'Chuyển cấp hòa giải' };
const PROPOSAL_EVENTS = { PROPOSED: 'Đề xuất phương án', CONSENTED: 'Đồng ý phương án', RESOLVED: 'Hai bên đồng ý phương án', CLOSED_UNRESOLVED: 'Đóng chưa giải quyết' };
const FREEZE = {
  OPEN: 'Vụ việc đang mở. Đơn bị chặn ghi nhận tài chính cho đến khi vụ việc được giải quyết.',
  CLOSED_UNRESOLVED: 'Đóng chưa giải quyết. Đơn vẫn bị chặn ghi nhận tài chính. Đây không phải thỏa thuận hay công nợ.',
  RESOLVED: 'Hai bên đã đồng ý phương án. Đồng ý không phải là thực hiện: hệ thống không tự hoàn tiền hay thay đổi số liệu thanh toán.',
  CLOSED: 'Vụ việc đã đóng. Không thể thực hiện thao tác mới trên vụ việc này.',
};
const TITLES = { disputes: 'Tranh chấp', dispute: 'Chi tiết tranh chấp', complaint: 'Mở khiếu nại' };
const OPEN_ROLES = ['farmer', 'provider', 'coop'];
const UNCERTAIN = 'Chưa xác nhận được thao tác đã được ghi nhận. Tải lại để xem trạng thái thật trước khi thử lại.';
const GENERIC = 'Không thực hiện được thao tác. Tải lại rồi thử lại.';
const ERRORS = {
  NOT_FOUND: 'Không tìm thấy vụ việc hoặc bạn không có quyền xem.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Kiểm tra lý do và nội dung rồi thử lại.',
  FORBIDDEN: 'Tài khoản này không có quyền thực hiện thao tác.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  DISPUTE_OPEN: 'Đơn này đã có vụ tranh chấp đang mở. Mở danh sách để xem vụ việc đó.',
  DISPUTE_NOT_OPEN: 'Vụ việc đã đóng. Tải lại để xem trạng thái mới.',
  BOOKING_UNAVAILABLE: 'Đơn không còn ở trạng thái có thể khiếu nại.',
  RESPONDENT_ROLE_MISSING: 'Bên còn lại chưa đủ vai trò để nhận khiếu nại. Liên hệ quản trị.',
  PARTY_CONFLICT: 'Không thể chọn người này làm người hòa giải vì có liên quan đến vụ việc.',
  RECUSAL_REQUIRED: 'Bạn có liên quan đến vụ việc nên không thể hòa giải hoặc gán người hòa giải.',
  INVALID_MEDIATOR: 'Người được chọn không đủ điều kiện làm người hòa giải.',
  ESCALATION_REQUIRED: 'Vụ việc đang ở cấp HTX. Cần chuyển cấp lên quản trị trước khi gán người hòa giải.',
  ALREADY_ESCALATED: 'Vụ việc đã được chuyển lên cấp quản trị. Tải lại để xem trạng thái mới.',
  STALE_VERSION: 'Phương án đã có phiên bản mới. Tải lại để xem phiên bản mới nhất.',
  MEDIATOR_CHANGED: 'Người hòa giải đã thay đổi. Tải lại trước khi đồng ý.',
  STATE_CHANGED: 'Dữ liệu vừa thay đổi do thao tác khác. Tải lại trước khi thử lại.',
  DB_UNAVAILABLE: 'Hệ thống dữ liệu chưa sẵn sàng. Thử lại sau, chưa coi thao tác là hoàn tất.',
  BAD_RESPONSE: 'Máy chủ trả về dữ liệu không hợp lệ. Tải lại trang.',
  NETWORK: UNCERTAIN,
  TIMEOUT: UNCERTAIN,
};

// ---- routing and pure helpers (no DOM) --------------------------------------

export function disputesRoute(hash) {
  const text = typeof hash === 'string' ? hash : '';
  if (text === '#disputes') return { name: 'disputes' };
  const match = /^#(dispute|complaint)\/([^/?#]+)$/.exec(text);
  return match && UUID.test(match[2]) ? { name: match[1], id: match[2].toLowerCase() } : null;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const isInstant = (value) => typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const nullable = (value, check) => value === null || check(value);
const badResponse = () => Object.assign(new Error('BAD_RESPONSE'), { code: 'BAD_RESPONSE' });

// Text is trimmed and counted in code points, matching the server.
function boundedText(value) {
  if (typeof value !== 'string') return { error: 'Nhập nội dung trước khi gửi.', text: null };
  const text = value.trim();
  if (!text) return { error: 'Nhập nội dung trước khi gửi.', text: null };
  if ([...text].length > MAX_TEXT) return { error: 'Nội dung tối đa 2000 ký tự.', text: null };
  return { error: null, text };
}

export function responseInput(value) {
  const { error, text } = boundedText(value);
  return { error, payload: text === null ? null : { text } };
}

export function proposalInput(value) {
  return responseInput(value);
}

export function closeInput(value) {
  const { error, text } = boundedText(value);
  return { error, payload: text === null ? null : { reason: text } };
}

export function escalateInput(value) {
  return closeInput(value);
}

export function disputeInput({ reason, details } = {}) {
  const errors = {};
  if (!Object.hasOwn(REASONS, reason)) errors.reason = 'Chọn lý do khiếu nại.';
  const text = typeof details === 'string' ? details.trim() : '';
  if (!text) errors.details = 'Mô tả vụ việc trước khi gửi.';
  else if ([...text].length > MAX_TEXT) errors.details = 'Mô tả tối đa 2000 ký tự.';
  return Object.keys(errors).length ? { errors, payload: null } : { errors, payload: { reason, details: text } };
}

export function statusLabel(status) {
  return Object.hasOwn(STATUSES, status) ? STATUSES[status] : null;
}

export function levelLabel(level) {
  return Object.hasOwn(LEVELS, level) ? LEVELS[level] : null;
}

export function freezeNotice(status) {
  return Object.hasOwn(FREEZE, status) ? FREEZE[status] : null;
}

const validDispute = (d) => isObject(d) && isUuid(d.id) && isUuid(d.bookingId) && isUuid(d.claimantId) && isUuid(d.respondentId)
  && Object.hasOwn(REASONS, d.reason) && Object.hasOwn(STATUSES, d.status) && nullable(d.mediatorId, isUuid) && isInstant(d.createdAt)
  && (d.mediationLevel === undefined || Object.hasOwn(LEVELS, d.mediationLevel))
  && (d.escalatedAt === undefined || nullable(d.escalatedAt, isInstant))
  && (d.escalatedBy === undefined || nullable(d.escalatedBy, isUuid))
  && (d.escalationReason === undefined || nullable(d.escalationReason, (v) => typeof v === 'string'))
  && (d.escalationConflictType === undefined || nullable(d.escalationConflictType, (v) => typeof v === 'string'));

export function readList(data) {
  if (!isObject(data) || !Array.isArray(data.items) || !data.items.every(validDispute)) return null;
  if (!isCount(data.limit) || !isCount(data.offset)) return null;
  return { items: data.items, limit: data.limit, offset: data.offset };
}

const validCaseEvent = (e) => isObject(e) && Number.isSafeInteger(e.sequence) && Object.hasOwn(CASE_EVENTS, e.type)
  && isUuid(e.actorId) && isObject(e.data) && isInstant(e.createdAt);

const validEscalation = (e) => isObject(e) && Number.isSafeInteger(e.sequence) && isUuid(e.actorId)
  && typeof e.reason === 'string' && nullable(e.conflictType, (v) => typeof v === 'string')
  && nullable(e.previousMediatorId, isUuid) && isInstant(e.createdAt);

export function readDetail(data) {
  if (!isObject(data) || !validDispute(data.dispute) || !Array.isArray(data.events) || !data.events.every(validCaseEvent)) return null;
  if (data.escalations !== undefined && (!Array.isArray(data.escalations) || !data.escalations.every(validEscalation))) return null;
  return data.escalations === undefined
    ? { dispute: data.dispute, events: data.events }
    : { dispute: data.dispute, events: data.events, escalations: data.escalations };
}

const validConsent = (c) => isObject(c) && isUuid(c.actorId) && isInstant(c.at);
const validProposal = (p) => isObject(p) && Number.isSafeInteger(p.version) && p.version >= 1
  && typeof p.text === 'string' && p.text.trim() !== '' && [...p.text].length <= MAX_TEXT
  && isUuid(p.mediatorId) && isInstant(p.createdAt) && Array.isArray(p.consents) && p.consents.every(validConsent);
const validProposalEvent = (e) => isObject(e) && Object.hasOwn(PROPOSAL_EVENTS, e.event_type)
  && nullable(e.version, (v) => Number.isSafeInteger(v) && v >= 1) && isUuid(e.actor_id)
  && nullable(e.details, (v) => typeof v === 'string') && isInstant(e.created_at);

// The proposals answer must name the same case the page asked for. Otherwise it is a bad response.
export function readProposals(data, disputeId) {
  const d = data?.dispute;
  if (!isObject(data) || !isObject(d) || d.id !== disputeId || !isUuid(d.bookingId) || !Object.hasOwn(STATUSES, d.status)) return null;
  if (typeof d.obligationsDisputed !== 'boolean' || !nullable(d.closedAt, isInstant) || !nullable(d.closureReason, (v) => typeof v === 'string')) return null;
  if (!Array.isArray(data.proposals) || !data.proposals.every(validProposal)) return null;
  if (!Array.isArray(data.events) || !data.events.every(validProposalEvent)) return null;
  return { dispute: d, proposals: data.proposals, events: data.events };
}

const validReview = (r) => isObject(r) && isUuid(r.id) && isUuid(r.bookingId) && Object.hasOwn(REASONS, r.reason) && Object.hasOwn(STATUSES, r.status)
  && (r.mediationLevel === undefined || Object.hasOwn(LEVELS, r.mediationLevel));

export function readReviewList(data) {
  if (!isObject(data) || !Array.isArray(data.items) || !data.items.every(validReview)) return null;
  if (!isCount(data.limit) || !isCount(data.offset)) return null;
  return { items: data.items, limit: data.limit, offset: data.offset };
}

export function readMediators(data) {
  const valid = (m) => isObject(m) && isUuid(m.id) && typeof m.name === 'string' && m.name.trim() !== '';
  if (!isObject(data) || !Array.isArray(data.items) || !data.items.every(valid)) return null;
  return { items: data.items };
}

// Party identity comes from the dispute ids, never from the role label. Admin triage escalates HTX cases before assignment.
export function disputeActions(actor, dispute) {
  const open = dispute.status === 'OPEN';
  const isAdmin = Array.isArray(actor.roles) && actor.roles.includes('admin');
  const party = actor.id === dispute.claimantId || actor.id === dispute.respondentId;
  const adminLevel = dispute.mediationLevel === 'ADMIN';
  const mediating = open && isAdmin && adminLevel && actor.id === dispute.mediatorId;
  const triage = open && isAdmin && !party;
  return {
    respond: open && actor.id === dispute.respondentId,
    propose: mediating,
    close: mediating,
    escalate: triage && !adminLevel,
    assign: triage && adminLevel,
  };
}

// Consent only on the latest version, while the current mediator still owns it, for a party, on an open case.
export function consentState(actor, dispute, shown, latest) {
  if (dispute.status !== 'OPEN' || !latest || !shown || shown.version !== latest.version) return 'none';
  if (actor.id !== dispute.claimantId && actor.id !== dispute.respondentId) return 'none';
  if (latest.mediatorId !== dispute.mediatorId) return 'stale-mediator';
  return latest.consents.some((c) => c.actorId === actor.id) ? 'signed' : 'open';
}

// Known codes get their own copy. Unknown codes fall back to generic text, never the raw code.
export function errorMessage(error) {
  if (Object.hasOwn(ERRORS, error?.code)) return ERRORS[error.code];
  if (error?.status === 401) return ERRORS.UNAUTHENTICATED;
  return error?.uncertain ? UNCERTAIN : GENERIC;
}

// ---- render (browser only) --------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = globalThis.document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === undefined) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'click') node.addEventListener('click', value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const alertNode = (text) => el('p', { class: 'alert error', role: 'alert', tabindex: '-1', text });
const retryButton = (fn) => el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại', click: fn });
const link = (href, text) => el('a', { href, text });
const section = (title, ...children) => el('section', {}, [el('h2', { text: title }), ...children]);
const fact = (label, value) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })]);
const shortTime = (iso) => new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const who = (d, actorId) => (actorId === d.claimantId ? 'bên khiếu nại' : actorId === d.respondentId ? 'bên bị khiếu nại' : 'quản trị viên');
const eventNote = (e) => {
  if (typeof e.data.details === 'string') return ` ${e.data.details}`;
  return typeof e.data.text === 'string' ? ` ${e.data.text}` : '';
};

function viewerRole(actor, d) {
  if (actor.id === d.claimantId) return 'Bạn là bên khiếu nại.';
  if (actor.id === d.respondentId) return 'Bạn là bên bị khiếu nại.';
  if (actor.id === d.mediatorId) return 'Bạn là người hòa giải của vụ việc này.';
  return 'Bạn xem với tư cách quản trị viên, chưa là người hòa giải.';
}

function field(id, label, control, hint) {
  const children = [el('label', { for: id, text: label }), control];
  if (hint) {
    control.setAttribute('aria-describedby', `${id}-hint`);
    children.push(el('p', { class: 'hint', id: `${id}-hint`, text: hint }));
  }
  return el('div', { class: 'field' }, children);
}

function invalid(feedback, control, message) {
  control.setAttribute('aria-invalid', 'true');
  feedback.replaceChildren(alertNode(message));
  control.focus();
}

function pager(page, go) {
  return el('p', { class: 'pager' }, [
    el('button', { type: 'button', class: 'btn secondary', text: 'Trang trước', disabled: page.offset === 0, click: () => go(Math.max(0, page.offset - PAGE)) }),
    el('button', { type: 'button', class: 'btn secondary', text: 'Trang sau', disabled: page.items.length < PAGE, click: () => go(page.offset + PAGE) }),
  ]);
}

const caseCards = (items) => el('ul', { class: 'cards' }, items.map((d) => el('li', { class: 'card' }, [
  el('h3', {}, [link(`#dispute/${d.id}`, REASONS[d.reason])]),
  el('p', { text: `${statusLabel(d.status)}. ${levelLabel(d.mediationLevel ?? 'HTX')}. Mở lúc ${shortTime(d.createdAt)}.` }),
])));

const reviewCards = (items) => el('ul', { class: 'cards' }, items.map((r) => el('li', { class: 'card' }, [
  el('h3', {}, [link(`#dispute/${r.id}`, `Vụ việc: ${REASONS[r.reason]}`)]),
  el('p', { text: `${statusLabel(r.status)}. ${levelLabel(r.mediationLevel ?? 'HTX')}. Mở chi tiết để xem và xử lý.` }),
])));

// One list panel with its own loading, error and retry, so a failing queue does not hide personal cases.
function listPanel({ api, alive, path, read, draw }) {
  const node = el('div', { 'aria-live': 'polite' });
  async function load(offset = 0) {
    node.replaceChildren(el('p', { role: 'status', text: 'Đang tải danh sách…' }));
    try {
      const { data } = await api.request('GET', `${path}?limit=${PAGE}&offset=${offset}`, { auth: true });
      if (!alive()) return;
      const page = read(data);
      if (!page) throw badResponse();
      node.replaceChildren(...draw(page, load).filter(Boolean));
    } catch (error) {
      if (alive()) node.replaceChildren(alertNode(errorMessage(error)), retryButton(() => load(offset)));
    }
  }
  load();
  return node;
}

export async function renderDisputes({ main, api, session, announce, route, signIn }) {
  const hash = location.hash;
  if (!session.token) {
    signIn(hash);
    return;
  }
  const actor = session.user;
  const heading = el('h1', { tabindex: '-1', text: TITLES[route.name] });
  const content = el('section', { class: 'page', 'aria-live': 'polite' });
  const alive = () => location.hash === hash && content.isConnected;
  let reload = null;
  main.replaceChildren(heading, content);
  heading.focus();

  // Every write waits for the server answer. Success reloads from the API, never from local state.
  async function send(path, body, button, feedback, done, after = () => reload?.()) {
    if (button.disabled) return;
    button.disabled = true;
    feedback.replaceChildren();
    try {
      const { data } = await api.request('POST', path, { auth: true, body });
      if (!alive()) return;
      announce(done.replace(/ Đang (tải lại|mở vụ việc)\.$/, ''));
      await after(data);
    } catch (error) {
      if (alive()) {
        const message = alertNode(errorMessage(error));
        feedback.replaceChildren(message, ...(reload ? [retryButton(reload)] : []));
        message.focus();
      }
    } finally {
      button.disabled = false;
    }
  }

  function textForm({ name, label, hint, submit, validate, path, done, confirm }) {
    const control = el('textarea', { id: `dispute-${name}`, name, rows: 5 });
    const feedback = el('div', { 'aria-live': 'polite' });
    const button = el('button', { type: 'submit', class: 'btn primary', text: submit });
    const form = el('form', { class: 'form', novalidate: true }, [field(`dispute-${name}`, label, control, hint), feedback, button]);
    control.addEventListener('input', () => control.removeAttribute('aria-invalid'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const { error, payload } = validate(control.value);
      if (error) return invalid(feedback, control, error);
      if (confirm && !globalThis.confirm(confirm)) return;
      send(path, payload, button, feedback, done);
    });
    return form;
  }

  function listPage() {
    reload = null;
    const nodes = [
      el('p', { text: 'Chỉ hiện vụ việc bạn là bên khiếu nại, bên bị khiếu nại hoặc người hòa giải.' }),
      el('section', {}, [
        el('h2', { text: 'Vụ việc của bạn' }),
        listPanel({
          api, alive, path: '/api/disputes', read: readList,
          draw: (page, go) => [
            page.items.length ? caseCards(page.items) : el('p', { text: page.offset ? 'Không còn vụ việc ở trang này.' : 'Chưa có vụ tranh chấp nào liên quan đến bạn.' }),
            page.items.length || page.offset ? pager(page, go) : null,
          ],
        }),
      ]),
    ];
    if (actor.roles.includes('admin')) {
      nodes.push(el('section', {}, [
        el('h2', { text: 'Vụ việc để quản trị xem xét' }),
        el('p', { text: 'Danh sách này chỉ mời xem xét. Quyền hòa giải chỉ có khi bạn được gán và không liên quan đến vụ việc.' }),
        listPanel({
          api, alive, path: '/api/dispute-review', read: readReviewList,
          draw: (page, go) => [
            page.items.length ? reviewCards(page.items) : el('p', { text: 'Chưa có vụ việc nào cần xem xét.' }),
            page.items.length || page.offset ? pager(page, go) : null,
          ],
        }),
      ]));
    }
    content.replaceChildren(...nodes);
  }

  function complaintPage(bookingId) {
    reload = null;
    // The server decides booking party authority. This gate only hides a form that the server would refuse.
    if (!actor.roles.some((role) => OPEN_ROLES.includes(role))) {
      content.textContent = 'Tài khoản này không thể mở khiếu nại. Chỉ chủ ruộng, đơn vị nhận hoặc HTX được mở khiếu nại.';
      return;
    }
    const reasonInput = el('select', { id: 'dispute-reason', name: 'reason' }, [
      el('option', { value: '', text: 'Chọn lý do' }),
      ...Object.entries(REASONS).map(([value, text]) => el('option', { value, text })),
    ]);
    const detailsInput = el('textarea', { id: 'dispute-details', name: 'details', rows: 6 });
    const feedback = el('div', { 'aria-live': 'polite' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Gửi khiếu nại' });
    const form = el('form', { class: 'form', novalidate: true }, [
      field('dispute-reason', 'Lý do khiếu nại', reasonInput),
      field('dispute-details', 'Mô tả vụ việc', detailsInput, 'Mô tả việc đã xảy ra, tối đa 2000 ký tự.'),
      feedback,
      submit,
    ]);
    for (const input of [reasonInput, detailsInput]) input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const { errors, payload } = disputeInput({ reason: reasonInput.value, details: detailsInput.value });
      if (!payload) {
        const first = errors.reason ? reasonInput : detailsInput;
        for (const [input, key] of [[reasonInput, 'reason'], [detailsInput, 'details']]) input.setAttribute('aria-invalid', String(Boolean(errors[key])));
        feedback.replaceChildren(alertNode(Object.values(errors).join(' ')));
        first.focus();
        return;
      }
      send(`/api/bookings/${bookingId}/disputes`, payload, submit, feedback, 'Đã ghi nhận khiếu nại. Đang mở vụ việc.', (data) => {
        location.hash = `#dispute/${data.dispute.id}`;
      });
    });
    content.replaceChildren(
      el('p', { class: 'back' }, [link('#disputes', 'Danh sách tranh chấp')]),
      el('p', { text: 'Khiếu nại ghi nhận bất đồng giữa bạn và bên còn lại của đơn. Đây không phải quyết định trọng tài. Khi đang mở, các ghi nhận tài chính của đơn bị chặn cho đến khi giải quyết.' }),
      form,
    );
  }

  function assignPicker(dispute) {
    const box = el('div', { 'aria-live': 'polite' });
    async function load() {
      box.replaceChildren(el('p', { role: 'status', text: 'Đang tải danh sách người hòa giải…' }));
      try {
        const { data } = await api.request('GET', `/api/dispute-review/${dispute.id}/mediators`, { auth: true });
        if (!alive()) return;
        const read = readMediators(data);
        if (!read) throw badResponse();
        box.replaceChildren(read.items.length ? pickerForm(read.items) : el('p', { text: 'Chưa có quản trị viên đủ điều kiện và không liên quan đến vụ việc.' }));
      } catch (error) {
        if (alive()) box.replaceChildren(alertNode(errorMessage(error)), retryButton(load));
      }
    }
    function pickerForm(items) {
      const select = el('select', { id: 'dispute-mediator', name: 'mediatorId' }, items.map((m) => el('option', { value: m.id, text: m.name })));
      const feedback = el('div', { 'aria-live': 'polite' });
      const button = el('button', { type: 'submit', class: 'btn primary', text: 'Gán người hòa giải' });
      const form = el('form', { class: 'form', novalidate: true }, [field('dispute-mediator', 'Người hòa giải', select, 'Máy chủ kiểm tra lại tính độc lập khi lưu.'), feedback, button]);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        send(`/api/disputes/${dispute.id}/mediator`, { mediatorId: select.value }, button, feedback, 'Đã gán người hòa giải. Đang tải lại.');
      });
      return form;
    }
    load();
    return section('Gán người hòa giải', box);
  }

  function proposalCard(dispute, p, latest, state) {
    const consentItems = p.consents.map((c) => el('li', { text: `${who(dispute, c.actorId)} đồng ý lúc ${shortTime(c.at)}` }));
    const children = [
      el('h3', { text: `Phiên bản ${p.version}. ${p === latest ? 'Phiên bản mới nhất' : 'Đã thay thế'}` }),
      el('p', { text: p.text }),
      el('p', { text: `Đề xuất lúc ${shortTime(p.createdAt)}.` }),
      consentItems.length ? el('ul', {}, consentItems) : el('p', { text: 'Chưa có bên nào đồng ý.' }),
    ];
    if (p === latest && state === 'stale-mediator') children.push(el('p', { class: 'alert warning', role: 'status', text: 'Người hòa giải đã thay đổi, phương án này không còn nhận đồng ý. Chờ phương án mới từ người hòa giải hiện tại.' }));
    if (p === latest && state === 'signed') children.push(el('p', { role: 'status', text: 'Bạn đã đồng ý phiên bản này. Chờ bên còn lại.' }));
    if (p === latest && state === 'open') {
      const feedback = el('div', { 'aria-live': 'polite' });
      const button = el('button', {
        type: 'button', class: 'btn primary', text: `Đồng ý phương án phiên bản ${p.version}`,
        click: () => send(`/api/disputes/${dispute.id}/proposals/${p.version}/consent`, {}, button, feedback, 'Đã ghi nhận đồng ý. Đang tải lại.'),
      });
      children.push(el('p', { text: 'Đồng ý là ghi nhận của bạn. Hệ thống không tự đồng ý thay bạn và không thi hành phương án.' }), button, feedback);
    }
    return el('article', { class: 'card' }, children);
  }

  function detailPage(disputeId) {
    let disposeEvidence=()=>{};
    async function load() {
      disposeEvidence();
      content.replaceChildren(el('p', { role: 'status', text: 'Đang tải vụ việc…' }));
      try {
        const [detailRes, proposalRes] = await Promise.all([
          api.request('GET', `/api/disputes/${disputeId}`, { auth: true }),
          api.request('GET', `/api/disputes/${disputeId}/proposals`, { auth: true }),
        ]);
        if (!alive()) return;
        const detail = readDetail(detailRes.data);
        const proposals = readProposals(proposalRes.data, disputeId);
        if (!detail || !proposals || detail.dispute.id !== disputeId) throw badResponse();
        draw(detail, proposals);
      } catch (error) {
        if (alive()) content.replaceChildren(alertNode(errorMessage(error)), retryButton(load));
      }
    }

    function draw({ dispute, events, escalations = [] }, { dispute:closure, proposals, events: remedyEvents }) {
      const actions = disputeActions(actor, dispute);
      const latest = proposals.reduce((top, p) => (top === null || p.version > top.version ? p : top), null);
      const state = consentState(actor, dispute, latest, latest);
      const timeline = [
        ...events.map((e) => ({ sequence: e.sequence, text: `${CASE_EVENTS[e.type]}, ${who(dispute, e.actorId)}, ${shortTime(e.createdAt)}.${eventNote(e)}` })),
        ...escalations.map((e) => ({ sequence: e.sequence, text: `${CASE_EVENTS.MEDIATION_ESCALATED}, ${who(dispute, e.actorId)}, ${shortTime(e.createdAt)}. ${e.reason}` })),
      ].sort((a, b) => a.sequence - b.sequence);
      const nodes = [
        el('p', { class: 'back' }, [link('#disputes', 'Danh sách tranh chấp')]),
        el('p', { class: 'alert warning', role: 'status', text: freezeNotice(dispute.status) }),
        el('dl', { class: 'facts' }, [
          fact('Trạng thái', statusLabel(dispute.status)),
          fact('Cấp hòa giải', levelLabel(dispute.mediationLevel ?? 'HTX')),
          fact('Lý do', REASONS[dispute.reason]),
          fact('Mở lúc', shortTime(dispute.createdAt)),
          fact('Vai trò của bạn', viewerRole(actor, dispute)),
          ...(dispute.escalatedAt ? [fact('Chuyển cấp lúc', shortTime(dispute.escalatedAt))] : []),
          ...(dispute.escalationReason ? [fact('Lý do chuyển cấp', dispute.escalationReason)] : []),
        ]),
      ];
      if (closure.closedAt) nodes.push(section('Kết thúc vụ việc', el('p', {text:`Đóng lúc ${shortTime(closure.closedAt)}`}), el('p', {text:closure.closureReason ?? 'Không có lý do được ghi nhận.'})));
      nodes.push(section('Diễn biến vụ việc', timeline.length
        ? el('ol', {}, timeline.map((e) => el('li', { text: e.text })))
        : el('p', { text: 'Chưa có diễn biến.' })));
      if (actions.respond) {
        nodes.push(section('Phản hồi của bạn', el('p', { text: 'Phản hồi được ghi thành mục mới. Không sửa hay xóa phản hồi đã gửi.' }), textForm({
          name: 'response', label: 'Nội dung phản hồi', hint: 'Tối đa 2000 ký tự.', submit: 'Gửi phản hồi',
          validate: responseInput, path: `/api/disputes/${dispute.id}/responses`, done: 'Đã ghi nhận phản hồi. Đang tải lại.',
        })));
      }
      nodes.push(section('Phương án hòa giải',
        el('p', { text: 'Phương án chỉ là đề xuất bằng văn bản. Đồng ý không tự hoàn tiền hay sửa số liệu thanh toán.' }),
        ...(proposals.length ? proposals.map((p) => proposalCard(dispute, p, latest, state)) : [el('p', { text: 'Chưa có phương án.' })]),
        actions.propose ? textForm({
          name: 'proposal', label: 'Nội dung phương án', hint: 'Tối đa 2000 ký tự.', submit: 'Gửi phương án mới',
          validate: proposalInput, path: `/api/disputes/${dispute.id}/proposals`, done: 'Đã gửi phương án. Đang tải lại.',
        }) : null,
      ));
      nodes.push(section('Lịch sử phương án', remedyEvents.length
        ? el('ol', {}, remedyEvents.map((e) => el('li', { text: `${PROPOSAL_EVENTS[e.event_type]}${e.version ? ` phiên bản ${e.version}` : ''}, ${who(dispute, e.actor_id)}, ${shortTime(e.created_at)}.${e.details ? ` ${e.details}` : ''}` })))
        : el('p', { text: 'Chưa có sự kiện phương án.' })));
      if (actions.escalate) {
        nodes.push(section('Chuyển cấp hòa giải',
          el('p', { text: 'Vụ việc đang ở cấp HTX. Cần chuyển cấp lên quản trị kèm lý do trước khi gán người hòa giải độc lập.' }),
          textForm({
            name: 'escalate', label: 'Lý do chuyển cấp lên quản trị', hint: 'Tối đa 2000 ký tự.', submit: 'Chuyển cấp lên quản trị',
            validate: escalateInput, path: `/api/disputes/${dispute.id}/escalate`, done: 'Đã chuyển cấp lên quản trị. Đang tải lại.',
          }),
        ));
      }
      if (actions.assign) nodes.push(assignPicker(dispute));
      if (actions.close) {
        nodes.push(section('Đóng chưa giải quyết', el('p', { text: 'Đóng chưa giải quyết không phải thỏa thuận và không tạo công nợ. Nghĩa vụ liên quan vẫn chặn ghi nhận tài chính. Đã đóng thì không mở lại.' }), textForm({
          name: 'close', label: 'Lý do đóng chưa giải quyết', hint: 'Tối đa 2000 ký tự.', submit: 'Đóng chưa giải quyết',
          validate: closeInput, path: `/api/disputes/${dispute.id}/close-unresolved`, done: 'Đã đóng chưa giải quyết. Đang tải lại.',
          confirm: 'Đóng vụ việc chưa giải quyết? Thao tác này không thể hoàn tác.',
        })));
      }
      content.replaceChildren(...nodes);
      const evidence=el('section',{class:'page','aria-label':'Bằng chứng ảnh riêng tư'});
      content.append(evidence);
      renderEvidence({container:evidence,api,active:()=>alive()&&evidence.isConnected,announce,disputeId:dispute.id}).then(cleanup=>{
        if(!alive()||!evidence.isConnected){cleanup();return;}
        const leave=()=>{cleanup();globalThis.removeEventListener('hashchange',leave);};
        globalThis.addEventListener('hashchange',leave,{once:true});
        disposeEvidence=leave;
      });
    }

    reload = load;
    load();
  }

  if (route.name === 'disputes') listPage();
  else if (route.name === 'dispute') detailPage(route.id);
  else complaintPage(route.id);
}
