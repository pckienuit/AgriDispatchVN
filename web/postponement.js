/* global location */
// Package postponement UI: current window, pending proposal, consent and history.
// Plain ES module, no storage, no HTML sinks. Server data is written with textContent only.
// The server decides every permission and every state change. Success is shown only after a fresh GET.
// Postponing never changes fees, refunds or payment records. The current window holds until the server applies a proposal.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MAX_SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REASON = 500;
const MAX_HISTORY = 20;
const PACKAGE_STATUS = { OPEN: 'Đang mở nhận', CLAIMED: 'Đã có đơn vị nhận', CANCELLED: 'Đã hủy' };
const UNCERTAIN = 'Chưa xác nhận được thao tác đã được ghi nhận. Tải lại để xem trạng thái thật trước khi thử lại.';
const GENERIC = 'Không thực hiện được thao tác. Tải lại rồi thử lại.';
const ERRORS = {
  NOT_FOUND: 'Không tìm thấy gói hoặc bạn không có quyền xem lịch dời.',
  STALE_VERSION: 'Đề xuất đã có phiên bản mới. Tải lại để xem phiên bản mới nhất trước khi thao tác.',
  SHIFT_ACTIVE: 'Gói đã có ca làm việc được bắt đầu, không thể dời lịch. Xem mục Ca làm việc.',
  PACKAGE_UNAVAILABLE: 'Gói không còn ở trạng thái cho phép dời lịch. Tải lại để xem trạng thái mới.',
  DISPUTE_OPEN: 'Gói có nghĩa vụ còn tranh chấp nên chưa thể dời lịch. Xem mục Khiếu nại.',
  PARTY_CONFLICT: 'Xung đột bên liên quan trong gói nên không thể thực hiện. Tải lại để xem quyền hiện tại.',
  MACHINE_UNAVAILABLE: 'Máy không còn sẵn sàng cho khung giờ đề xuất. Chọn khung giờ khác.',
  OPERATOR_NOT_AUTHORIZED: 'Người vận hành không còn đề nghị hợp lệ cho khung giờ đề xuất. Tải lại trước khi thử lại.',
  SCHEDULE_CONFLICT: 'Máy hoặc người vận hành đã có lịch trùng khung giờ đề xuất. Chọn khung giờ khác.',
  INVALID_ID: 'Mã gói không hợp lệ. Mở lại từ danh sách gói.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Kiểm tra thời điểm và lý do rồi thử lại.',
  UNKNOWN_FIELD: 'Máy chủ không nhận một trường trong yêu cầu. Tải lại trang rồi thử lại.',
  DB_UNAVAILABLE: 'Hệ thống dữ liệu chưa sẵn sàng. Thử lại sau, chưa coi thao tác là hoàn tất.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  BAD_RESPONSE: 'Máy chủ trả về dữ liệu không hợp lệ. Tải lại trang.',
  NETWORK: UNCERTAIN,
  TIMEOUT: UNCERTAIN,
};

// ---- routing and pure helpers (no DOM) --------------------------------------

export function postponementRoute(hash) {
  const match = /^#postponement\/([^/?#]+)$/.exec(typeof hash === 'string' ? hash : '');
  return match && UUID.test(match[1]) ? { name: 'postponement', id: match[1].toLowerCase() } : null;
}

// Local wall time from datetime-local text to a UTC ISO string. Rejects impossible or DST-gap dates.
function localToUtcIso(text) {
  const match = typeof text === 'string' ? LOCAL_TIME.exec(text) : null;
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number);
  if (h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi);
  const same = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
    && date.getHours() === h && date.getMinutes() === mi;
  return same ? date.toISOString() : null;
}

export function postponementInput(values, currentStartAt) {
  const v = values ?? {};
  const errors = {};
  const startAt = localToUtcIso(v.startAt);
  const endAt = localToUtcIso(v.endAt);
  const current = Date.parse(currentStartAt);
  if (!startAt) errors.startAt = 'Nhập thời điểm bắt đầu hợp lệ.';
  else if (Number.isFinite(current) && Date.parse(startAt) <= current) errors.startAt = 'Thời điểm mới phải sau thời điểm bắt đầu hiện tại.';
  if (!endAt) errors.endAt = 'Nhập thời điểm kết thúc hợp lệ.';
  else if (startAt && Date.parse(endAt) <= Date.parse(startAt)) errors.endAt = 'Kết thúc phải sau thời điểm bắt đầu mới.';
  else if (startAt && Date.parse(endAt) - Date.parse(startAt) > MAX_SPAN_MS) errors.endAt = 'Khoảng thời gian tối đa là 30 ngày.';
  const reason = typeof v.reason === 'string' ? v.reason.trim() : '';
  if (!reason) errors.reason = 'Nhập lý do dời lịch.';
  else if ([...reason].length > MAX_REASON) errors.reason = 'Lý do tối đa 500 ký tự.';
  return Object.keys(errors).length ? { errors, payload: null } : { errors, payload: { startAt, endAt, reason } };
}

export function postponementErrorMessage(error) {
  if (Object.hasOwn(ERRORS, error?.code)) return ERRORS[error.code];
  if (error?.status === 401) return ERRORS.UNAUTHENTICATED;
  return error?.uncertain ? UNCERTAIN : GENERIC;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const isInstant = (value) => typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function validPackage(p) {
  return isObject(p) && isUuid(p.id) && Object.hasOwn(PACKAGE_STATUS, p.status) && isInstant(p.startAt) && isInstant(p.endAt);
}

function validProposal(p) {
  return isObject(p) && Number.isSafeInteger(p.version) && p.version >= 1
    && [p.oldStartAt, p.oldEndAt, p.startAt, p.endAt, p.createdAt].every(isInstant)
    && Date.parse(p.endAt) > Date.parse(p.startAt)
    && typeof p.reason === 'string' && p.reason.trim() !== '' && [...p.reason].length <= MAX_REASON
    && isCount(p.requiredCount) && isCount(p.consentedCount) && p.consentedCount <= p.requiredCount
    && typeof p.ownConsented === 'boolean'
    && (p.appliedAt === null || isInstant(p.appliedAt));
}

// Returns null for any shape outside the server contract, so the page shows an error instead of guessing.
export function readPostponement(data) {
  if (!isObject(data) || !isObject(data.permissions)) return null;
  const { package: pkg, permissions, latest, history } = data;
  if (!validPackage(pkg)) return null;
  if (typeof permissions.canPropose !== 'boolean' || typeof permissions.canConsent !== 'boolean') return null;
  if (latest !== null && !validProposal(latest)) return null;
  if (!Array.isArray(history) || history.length > MAX_HISTORY || !history.every(validProposal)) return null;
  return { package: pkg, permissions, latest, history };
}

// ---- render (browser only) --------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = globalThis.document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === undefined || value === null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'click') node.addEventListener('click', value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const alertNode = (text) => el('p', { class: 'alert error', role: 'alert', tabindex: '-1', text });
const warningNode = (text) => el('p', { class: 'alert warning', role: 'alert', tabindex: '-1', text });
const successNode = (text) => el('p', { class: 'alert success', role: 'status', tabindex: '-1', text });
const loading = (text) => el('p', { role: 'status', text });
const shortTime = (iso) => new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const windowText = (startAt, endAt) => `${shortTime(startAt)} đến ${shortTime(endAt)}`;
const fact = (label, value) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })]);
const field = (id, label, control, hint) => {
  const children = [el('label', { for: id, text: label }), control];
  if (hint) {
    control.setAttribute('aria-describedby', `${id}-hint`);
    children.push(el('p', { class: 'hint', id: `${id}-hint`, text: hint }));
  }
  return el('div', { class: 'field' }, children);
};

export async function renderPostponement({ main, api, session, announce, route, signIn }) {
  const hash = location.hash;
  if (!session.token) {
    signIn(hash);
    return;
  }
  const current = postponementRoute(hash);
  const heading = el('h1', { tabindex: '-1', text: 'Dời lịch gói dịch vụ' });
  const content = el('section', { class: 'page', 'aria-live': 'polite' });
  main.replaceChildren(heading, content);
  heading.focus();
  if (!current || current.id !== route?.id) {
    content.replaceChildren(el('p', { text: 'Địa chỉ dời lịch này không hợp lệ.' }), el('a', { href: '#dispatch', text: 'Về điều phối gói' }));
    return;
  }
  const id = current.id;
  const active = () => location.hash === hash && content.isConnected;
  // Draft survives failed or uncertain writes. It is cleared only after a definitive server success.
  const draft = { startAt: '', endAt: '', reason: '' };

  async function load({ notice = '', warning = '' } = {}) {
    content.replaceChildren(loading('Đang tải lịch dời…'));
    try {
      const { data } = await api.request('GET', `/api/packages/${id}/postponement`, { auth: true });
      if (!active()) return;
      const read = readPostponement(data);
      if (!read) throw Object.assign(new Error('BAD_RESPONSE'), { code: 'BAD_RESPONSE' });
      draw(read, { notice, warning });
      if (notice) announce(notice);
    } catch (error) {
      if (!active()) return;
      const retry = el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại', click: () => load() });
      const message = alertNode(postponementErrorMessage(error));
      content.replaceChildren(message, retry);
      message.focus();
    }
  }

  // One write path: disabled while in flight, success means a fresh GET, uncertain or stale answers reload before any retry.
  async function write(path, body, button, feedback, notice, { clearDraft = false } = {}) {
    if (button.disabled) return;
    button.disabled = true;
    feedback.replaceChildren();
    try {
      await api.request('POST', path, { auth: true, body });
      if (!active()) return;
      if (clearDraft) Object.assign(draft, { startAt: '', endAt: '', reason: '' });
      await load({ notice });
    } catch (error) {
      if (!active()) return;
      const reloadFirst = error?.status === 409 || error?.code === 'STALE_VERSION' || ['NETWORK','TIMEOUT'].includes(error?.code) || error?.uncertain === true || error?.status >= 500;
      if (reloadFirst) {
        await load({ warning: postponementErrorMessage(error) });
      } else {
        const message = alertNode(postponementErrorMessage(error));
        feedback.replaceChildren(message, el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại', click: () => load() }));
        message.focus();
      }
    } finally {
      button.disabled = false;
    }
  }

  function invalidFields(form, errors, feedback, ids) {
    for (const node of form.querySelectorAll('input, textarea')) node.removeAttribute('aria-invalid');
    for (const node of form.querySelectorAll('.field-error')) node.remove();
    let first = null;
    for (const [key, message] of Object.entries(errors)) {
      const input = form.querySelector(`#${ids[key]}`);
      input.setAttribute('aria-invalid', 'true');
      input.after(el('p', { class: 'field-error', text: message }));
      first ??= input;
    }
    feedback.replaceChildren(alertNode(Object.values(errors).join(' ')));
    first?.focus();
  }

  function proposalForm(pkg) {
    const ids = { startAt: 'postponement-start', endAt: 'postponement-end', reason: 'postponement-reason' };
    const start = el('input', { id: ids.startAt, name: 'startAt', type: 'datetime-local', value: draft.startAt });
    const end = el('input', { id: ids.endAt, name: 'endAt', type: 'datetime-local', value: draft.endAt });
    const reason = el('textarea', { id: ids.reason, name: 'reason', rows: 4 });
    reason.value = draft.reason;
    start.addEventListener('input', () => { draft.startAt = start.value; start.removeAttribute('aria-invalid'); });
    end.addEventListener('input', () => { draft.endAt = end.value; end.removeAttribute('aria-invalid'); });
    reason.addEventListener('input', () => { draft.reason = reason.value; reason.removeAttribute('aria-invalid'); });
    const feedback = el('div', { 'aria-live': 'polite' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Gửi đề xuất dời lịch' });
    const form = el('form', { class: 'form', novalidate: true, 'aria-label': 'Đề xuất dời lịch' }, [
      field(ids.startAt, 'Bắt đầu mới', start, 'Nhập theo giờ địa phương của bạn. Phải sau khung giờ hiện tại.'),
      field(ids.endAt, 'Kết thúc mới', end, 'Phải sau bắt đầu mới, tối đa 30 ngày.'),
      field(ids.reason, 'Lý do dời lịch', reason, 'Tối đa 500 ký tự.'),
      feedback,
      submit,
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const { errors, payload } = postponementInput(draft, pkg.startAt);
      if (!payload) return invalidFields(form, errors, feedback, ids);
      write(`/api/packages/${id}/postponement`, payload, submit, feedback,
        'Đã gửi đề xuất dời lịch trên máy chủ. Khung giờ hiện tại vẫn giữ nguyên cho đến khi áp dụng.', { clearDraft: true });
    });
    return el('section', {}, [el('h2', { text: 'Đề xuất dời lịch mới' }), form]);
  }

  function latestSection(read) {
    const { latest, permissions } = read;
    if (!latest) return el('p', { text: 'Chưa có đề xuất dời lịch.' });
    const applied = latest.appliedAt !== null;
    const feedback = el('div', { 'aria-live': 'polite' });
    const consentable = permissions.canConsent && !applied && !latest.ownConsented;
    const consent = consentable ? el('button', {
      type: 'button', class: 'btn primary', text: `Đồng ý đề xuất phiên bản ${latest.version}`,
      click: () => write(`/api/packages/${id}/postponement/${latest.version}/consent`, {}, consent, feedback,
        'Đã ghi nhận đồng ý. Trạng thái hiện tại đã được tải lại.'),
    }) : null;
    return el('section', {}, [
      el('h2', { text: `Đề xuất phiên bản ${latest.version}` }),
      el('dl', { class: 'facts' }, [
        fact('Khung giờ đề xuất', windowText(latest.startAt, latest.endAt)),
        fact('Khung giờ trước đề xuất', windowText(latest.oldStartAt, latest.oldEndAt)),
        fact('Lý do', latest.reason),
        fact('Số bên đã đồng ý', `${latest.consentedCount} trên ${latest.requiredCount} bên`),
        fact('Bạn đã đồng ý', latest.ownConsented ? 'Đã đồng ý' : 'Chưa đồng ý'),
        fact('Trạng thái', applied ? `Đã áp dụng lúc ${shortTime(latest.appliedAt)}` : 'Đang chờ đủ đồng ý. Khung giờ hiện tại chưa đổi.'),
      ]),
      el('p', { text: 'Đề xuất này không làm thay đổi phí, tiền đã ghi nhận hay số liệu thanh toán.' }),
      consent ? el('div', { class: 'actions' }, [consent]) : null,
      feedback,
    ]);
  }

  function historySection(history) {
    return el('section', {}, [
      el('h2', { text: `Lịch sử dời lịch (tối đa ${MAX_HISTORY} mục gần nhất)` }),
      history.length
        ? el('ol', { class: 'timeline' }, history.map((p) => el('li', {
          text: `Phiên bản ${p.version}: từ ${windowText(p.oldStartAt, p.oldEndAt)} sang ${windowText(p.startAt, p.endAt)}, đề xuất lúc ${shortTime(p.createdAt)}. ${p.appliedAt ? `Đã áp dụng lúc ${shortTime(p.appliedAt)}.` : 'Chưa áp dụng.'}`,
        })))
        : el('p', { class: 'state', text: 'Chưa có lịch sử dời lịch.' }),
    ]);
  }

  function draw(read, { notice, warning }) {
    const { package: pkg, permissions, history } = read;
    const noticeNode = notice ? successNode(notice) : null;
    const warningEl = warning ? warningNode(warning) : null;
    content.replaceChildren(...[
      el('div', { class: 'actions' }, [
        el('a', { href: '#bookings', text: 'Đơn của tôi' }),
        ...(session.user.roles.some(role=>['coop','provider'].includes(role)) ? [el('a', { href: `#package/${id}`, text: 'Chi tiết gói' })] : []),
        el('button', { type:'button', class:'btn secondary', text:'Tải lại trạng thái', click:()=>load() }),
      ]),
      el('p', { class: 'lead', text: 'Dời lịch cần mọi bên liên quan đồng ý trước khi áp dụng. Khung giờ hiện tại vẫn giữ nguyên cho đến khi đề xuất được áp dụng sau khi kiểm tra lịch máy và người vận hành.' }),
      noticeNode,
      warningEl,
      el('section', {}, [
        el('h2', { text: 'Khung giờ hiện tại' }),
        el('dl', { class: 'facts' }, [
          fact('Trạng thái gói', PACKAGE_STATUS[pkg.status]),
          fact('Bắt đầu', shortTime(pkg.startAt)),
          fact('Kết thúc', shortTime(pkg.endAt)),
        ]),
      ]),
      latestSection(read),
      permissions.canPropose ? proposalForm(pkg) : el('p', { class: 'state', text: 'Tài khoản này chưa được phép gửi đề xuất dời lịch cho gói này.' }),
      historySection(history),
    ].filter(Boolean));
    // Focus moves to the result message only; a plain reload keeps focus on the heading set by the route.
    (noticeNode ?? warningEl)?.focus();
  }

  await load();
}
