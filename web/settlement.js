/* global location */
// Acceptance and payment record UI for one booking. Plain ES module, no storage, no HTML sinks.
// Server data is written with textContent only. Every write is confirmed by the server, then the page reloads from the API.
// Payments are claims. No funds move and nothing is checked against a bank.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const VND_NONNEGATIVE = /^(0|[1-9][0-9]{0,14})$/;
const VND_POSITIVE = /^[1-9][0-9]{0,14}$/;
const SIGNED_VND = /^-?(0|[1-9][0-9]{0,14})$/;
const AREA_TEXT = /^[1-9][0-9]{0,9}$/;
const REFERENCE = /^[A-Za-z0-9._-]{4,64}$/;
const MAX_AREA_M2 = 2147483647;
const MAX_NOTE = 500;
const UNCERTAIN = 'Chưa xác nhận được thao tác đã được ghi nhận. Tải lại để xem trạng thái thật trước khi thử lại.';
const GENERIC = 'Không thực hiện được thao tác. Tải lại rồi kiểm tra trạng thái nghiệm thu.';
const ERRORS = {
  NOT_FOUND: 'Không tìm thấy đơn hoặc bạn không có quyền xem nghiệm thu này.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Kiểm tra diện tích, số tiền, ghi chú và mã tham chiếu.',
  FORBIDDEN: 'Tài khoản này không có quyền thực hiện thao tác.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  DISPUTE_OPEN: 'Đơn còn nghĩa vụ đang tranh chấp. Chỉ xem được, chưa ghi nhận thêm cho đến khi được giải quyết.',
  PARTY_CONFLICT: 'Tài khoản này vừa là chủ ruộng vừa là đơn vị nhận của đơn. Không thể nghiệm thu.',
  BOOKING_UNAVAILABLE: 'Đơn không còn ở trạng thái có thể nghiệm thu.',
  SHIFT_NOT_COMPLETED: 'Cần có ca làm việc đã kết thúc trước khi đề nghị nghiệm thu.',
  ACCEPTANCE_AGREED: 'Hai bên đã đồng ý nghiệm thu. Tải lại để xem bản đã chốt.',
  STALE_VERSION: 'Phiên bản nghiệm thu đã thay đổi. Tải lại để xem bản mới nhất trước khi đồng ý.',
  STATE_CHANGED: 'Dữ liệu vừa thay đổi do thao tác khác. Tải lại trước khi thử lại.',
  ACCEPTANCE_NOT_AGREED: 'Cần hai bên đồng ý nghiệm thu trước khi ghi nhận thanh toán.',
  REFERENCE_CONFLICT: 'Mã tham chiếu này đã dùng cho số tiền khác. Nhập mã tham chiếu mới.',
  AMOUNT_EXCEEDS_OUTSTANDING: 'Số tiền vượt phần còn có thể ghi báo. Tải lại để xem số liệu mới.',
  OVER_CONFIRMED: 'Xác nhận này sẽ vượt tổng đã thỏa thuận. Tải lại để xem số liệu mới.',
  DB_UNAVAILABLE: 'Hệ thống dữ liệu chưa sẵn sàng. Thử lại sau, chưa coi thao tác là hoàn tất.',
  BAD_RESPONSE: 'Máy chủ trả về dữ liệu không hợp lệ. Tải lại trang.',
  NETWORK: UNCERTAIN,
  TIMEOUT: UNCERTAIN,
};
const DEFINITIONS = [
  'Đã thỏa thuận: tổng tiền trong nghiệm thu đã được hai bên đồng ý.',
  'Đã xác nhận: khoản bên nhận đã xác nhận là đã nhận ngoài hệ thống.',
  'Đang chờ bên nhận xác nhận: khoản chủ ruộng đã ghi báo. Khoản này chưa làm giảm số còn lại.',
  'Còn lại chưa xác nhận: đã thỏa thuận trừ đã xác nhận.',
  'Có thể ghi báo thêm: đã thỏa thuận trừ đã xác nhận trừ đang chờ bên nhận xác nhận.',
];

// ---- routing and pure helpers (no DOM) --------------------------------------

export function settlementRoute(hash) {
  const match = /^#settlement\/([^/?#]+)$/.exec(typeof hash === 'string' ? hash : '');
  return match && UUID.test(match[1]) ? { name: 'settlement', id: match[1].toLowerCase() } : null;
}

// Plain digits only: no sign, separators, decimals, or exponent. At most 15 digits.
export function vndInput(text, { positive = false } = {}) {
  if (typeof text !== 'string') return null;
  const clean = text.trim();
  return (positive ? VND_POSITIVE : VND_NONNEGATIVE).test(clean) ? clean : null;
}

export function formatVnd(text) {
  const clean = vndInput(text);
  return clean === null ? null : `${clean.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;
}

export function proposalInput({ areaM2, totalVnd, note } = {}) {
  const errors = {};
  const area = typeof areaM2 === 'string' ? areaM2.trim() : '';
  const areaNumber = Number(area);
  if (!AREA_TEXT.test(area) || areaNumber > MAX_AREA_M2) errors.areaM2 = 'Nhập diện tích là số nguyên dương, tối đa 2147483647 m².';
  const total = vndInput(totalVnd);
  if (total === null) errors.totalVnd = 'Nhập tổng tiền là số nguyên không âm, không dùng dấu chấm, phẩy hay ký hiệu khoa học.';
  const text = typeof note === 'string' ? note.trim() : '';
  if ([...text].length > MAX_NOTE) errors.note = 'Ghi chú tối đa 500 ký tự.';
  if (Object.keys(errors).length) return { errors, payload: null };
  return { errors, payload: { areaM2: areaNumber, totalVnd: total, ...(text ? { note: text } : {}) } };
}

// summary is null before agreement; the amount limit only applies once the server reports one.
export function paymentInput({ amountVnd, reference } = {}, summary) {
  const errors = {};
  const amount = vndInput(amountVnd, { positive: true });
  const ref = typeof reference === 'string' ? reference.trim() : '';
  if (amount === null) errors.amountVnd = 'Nhập số tiền là số nguyên dương, không dùng dấu chấm, phẩy hay ký hiệu khoa học.';
  else if (summary && BigInt(amount) > BigInt(summary.availableToReportVnd)) errors.amountVnd = 'Số tiền vượt phần còn có thể ghi báo.';
  if (!REFERENCE.test(ref)) errors.reference = 'Mã tham chiếu dài 4 đến 64 ký tự: chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.';
  if (Object.keys(errors).length) return { errors, payload: null };
  return { errors, payload: { amountVnd: amount, reference: ref } };
}

// The server sends permissions with the acceptance. Dispute blocks every write; reads stay available.
export function settlementActions(read, acceptance, summary) {
  const none = { propose: false, consent: false, report: false, confirm: false };
  if (!read || read.blockedByDispute || !['owner','provider'].includes(read.party)) return none;
  const owner = read.party === 'owner';
  const provider = read.party === 'provider';
  const agreed = acceptance?.agreed === true;
  const consented = Boolean(acceptance) && (owner ? acceptance.consents.owner : acceptance.consents.provider);
  return {
    propose: provider && read.canPropose === true && !agreed,
    consent: Boolean(acceptance) && !agreed && !consented,
    report: owner && agreed && Boolean(summary) && BigInt(summary.availableToReportVnd) > 0n,
    confirm: provider && agreed && Boolean(summary),
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const isInstant = (value) => typeof value === 'string' && ISO_INSTANT.test(value);
const isBool = (value) => typeof value === 'boolean';

function validAcceptance(a) {
  return Boolean(isObject(a) && isUuid(a.bookingId)
    && Number.isSafeInteger(a.version) && a.version >= 1
    && Number.isSafeInteger(a.areaM2) && a.areaM2 >= 1 && a.areaM2 <= MAX_AREA_M2
    && vndInput(a.totalVnd) !== null
    && (a.note === null || typeof a.note === 'string')
    && isInstant(a.proposedAt)
    && isObject(a.consents) && isBool(a.consents.owner) && isBool(a.consents.provider)
    && a.agreed === (a.consents.owner && a.consents.provider));
}

// Returns null for any shape the server contract does not allow, so the page shows an error instead of guessing.
export function readAcceptance(data) {
  if (!isObject(data)) return null;
  const { acceptance, permissions } = data;
  if (!isObject(permissions)) return null;
  const { party, canPropose, blockedByDispute } = permissions;
  const valid = (acceptance === null || validAcceptance(acceptance))
    && (party === 'owner' || party === 'provider' || party === null)
    && isBool(canPropose) && isBool(blockedByDispute);
  return valid ? { acceptance, party, canPropose, blockedByDispute } : null;
}

const signedVnd = (value) => typeof value === 'string' && SIGNED_VND.test(value);

function validPayment(p) {
  return isObject(p) && isUuid(p.id) && vndInput(p.amountVnd, { positive: true }) !== null && isInstant(p.createdAt)
    && ((p.status === 'REPORTED' && p.confirmedAt === null) || (p.status === 'CONFIRMED' && isInstant(p.confirmedAt)));
}

function validSummary(s) {
  return isObject(s)
    && ['agreedVnd', 'confirmedVnd', 'reportedVnd'].every((key) => vndInput(s[key]) !== null)
    && ['outstandingVnd', 'availableToReportVnd'].every((key) => signedVnd(s[key]));
}

export function readPayments(data) {
  if (!isObject(data) || !Array.isArray(data.payments) || !data.payments.every(validPayment)) return null;
  if (data.summary !== null && !validSummary(data.summary)) return null;
  return { payments: data.payments, summary: data.summary };
}

// Known codes get their own copy. Unknown codes fall back to generic text, never the raw code.
export function settlementErrorMessage(error) {
  if (Object.hasOwn(ERRORS, error?.code)) return ERRORS[error.code];
  if (error?.status === 401) return ERRORS.UNAUTHENTICATED;
  return error?.uncertain ? UNCERTAIN : GENERIC;
}

// A reference-keyed report stays pending when the answer is unknown or auth failed, so the retry sends the same payload.
export function keepsPendingReport(error) {
  return error?.uncertain === true || error?.status === 401 || error?.status === 0 || error?.status >= 500;
}

// ---- render (browser only) --------------------------------------------------

// Pending report per booking, in memory only. Cleared on any definitive server answer.
const pendingReports = new Map();

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
const loading = (text) => el('p', { role: 'status', text });
const shortTime = (iso) => new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const moneyText = (text) => {
  const negative = text.startsWith('-');
  const shown = formatVnd(negative ? text.slice(1) : text);
  return shown === null ? 'Không hiển thị được' : `${negative ? '-' : ''}${shown}`;
};
const field = (name, label, attrs = {}) => {
  const input = el('input', { id: `settle-${name}`, name, type: 'text', ...attrs });
  return { key: name, input, node: el('div', { class: 'field' }, [el('label', { for: `settle-${name}`, text: label }), input]) };
};

export async function renderSettlement({ main, api, session, announce, route, signIn }) {
  const hash = location.hash;
  if (!session.token) {
    signIn(hash);
    return;
  }
  const roles = session.user.roles;
  const id = route.id;
  const pendingKey = `${session.user.id}:${id}`;
  const active = () => location.hash === hash;
  const heading = el('h1', { tabindex: '-1', text: 'Nghiệm thu và thanh toán' });
  const content = el('section', { class: 'page', 'aria-live': 'polite' });
  main.replaceChildren(heading, content);
  heading.focus();
  // A coop can own a booking. Actual party authority comes from the server, not the role label.
  if (!['farmer', 'coop', 'provider'].some((role) => roles.includes(role))) {
    content.textContent = 'Tài khoản này không phải bên nghiệm thu của đơn. Chỉ chủ ruộng hoặc đơn vị nhận được nghiệm thu.';
    return;
  }

  async function load() {
    content.replaceChildren(loading('Đang tải nghiệm thu…'));
    try {
      const [acceptance, payments] = await Promise.all([
        api.request('GET', `/api/bookings/${id}/acceptance`, { auth: true }),
        api.request('GET', `/api/bookings/${id}/payments`, { auth: true }),
      ]);
      if (!active()) return;
      const read = readAcceptance(acceptance.data);
      const money = readPayments(payments.data);
      if (!read || !money) throw Object.assign(new Error('BAD_RESPONSE'), { code: 'BAD_RESPONSE' });
      draw(read, money);
    } catch (error) {
      if (active()) content.replaceChildren(alertNode(settlementErrorMessage(error)), el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại', click: load }));
    }
  }

  // Every write is confirmed by the server before the page reloads from the API.
  async function send(path, body, button, feedback, done) {
    if (button.disabled) return;
    button.disabled = true;
    feedback.replaceChildren();
    try {
      await api.request('POST', path, { auth: true, body });
      if (!active()) return;
      announce(done);
      await load();
    } catch (error) {
      if (active()) writeError(feedback, error);
    } finally {
      button.disabled = false;
    }
  }

  function writeError(feedback, error) {
    const message = alertNode(settlementErrorMessage(error));
    feedback.replaceChildren(message, el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại', click: load }));
    message.focus();
  }

  function invalid(feedback, errors, fields) {
    for (const f of fields) f.input.setAttribute('aria-invalid', String(Boolean(errors[f.key])));
    feedback.replaceChildren(alertNode(Object.values(errors).join(' ')));
    fields.find((f) => errors[f.key])?.input.focus();
  }

  function acceptanceFacts(a) {
    const rows = [
      ['Phiên bản', String(a.version)],
      ['Diện tích', `${a.areaM2} m²`],
      ['Tổng tiền đề nghị', formatVnd(a.totalVnd)],
      ['Ghi chú', a.note ?? 'Không có'],
      ['Đề nghị lúc', shortTime(a.proposedAt)],
      ['Chủ ruộng', a.consents.owner ? 'Đã đồng ý' : 'Chưa đồng ý'],
      ['Đơn vị nhận', a.consents.provider ? 'Đã đồng ý' : 'Chưa đồng ý'],
      ['Kết quả', a.agreed ? 'Hai bên đã đồng ý' : 'Chưa đủ hai bên đồng ý'],
    ];
    return el('dl', { class: 'facts' }, rows.map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })])));
  }

  function consentBlock(a) {
    const feedback = el('div', { 'aria-live': 'polite' });
    const button = el('button', {
      type: 'button',
      class: 'btn primary',
      text: `Đồng ý nghiệm thu phiên bản ${a.version}`,
      click: () => send(`/api/bookings/${id}/acceptance/${a.version}/consent`, {}, button, feedback, 'Máy chủ đã ghi nhận đồng ý. Đang tải lại.'),
    });
    return el('section', {}, [
      el('h3', { text: 'Đồng ý' }),
      el('p', { text: 'Chỉ đồng ý khi số liệu đang hiển thị đúng với thỏa thuận. Hệ thống không tự đồng ý thay bạn.' }),
      button,
      feedback,
    ]);
  }

  function proposeForm(a) {
    const form = el('form', { class: 'form', novalidate: true });
    const feedback = el('div', { 'aria-live': 'polite' });
    const fields = [
      field('areaM2', 'Diện tích nghiệm thu (m²)', { inputmode: 'numeric' }),
      field('totalVnd', 'Tổng tiền (VND)', { inputmode: 'numeric' }),
      field('note', 'Ghi chú (không bắt buộc)'),
    ];
    const submit = el('button', { type: 'submit', class: 'btn primary', text: a ? 'Gửi đề nghị thay thế' : 'Gửi đề nghị nghiệm thu' });
    form.append(
      ...fields.map((f) => f.node),
      el('p', { text: a ? `Đề nghị mới thay thế phiên bản ${a.version}. Đề nghị chỉ là đề xuất, chưa có hiệu lực cho đến khi hai bên đồng ý.` : 'Đề nghị chỉ là đề xuất, chưa có hiệu lực cho đến khi hai bên đồng ý.' }),
      el('p', { text: 'Ghi chú chỉ bổ sung thông tin. Không dùng ghi chú để ghi rằng hai bên đã thỏa thuận trước đó.' }),
      feedback,
      submit,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(fields.map((f) => [f.key, f.input.value]));
      const { errors, payload } = proposalInput(values);
      if (!payload) return invalid(feedback, errors, fields);
      send(`/api/bookings/${id}/acceptance`, payload, submit, feedback, 'Máy chủ đã ghi nhận đề nghị. Đang tải lại.');
    });
    return form;
  }

  // A report that failed without a definitive answer is shown read-only and resent unchanged.
  function reportForm(summary) {
    const saved = pendingReports.get(pendingKey);
    const form = el('form', { class: 'form', novalidate: true });
    const feedback = el('div', { 'aria-live': 'polite' });
    const fields = [
      field('amountVnd', 'Số tiền đã chuyển bên ngoài (VND)', { inputmode: 'numeric', readonly: Boolean(saved) }),
      field('reference', 'Mã tham chiếu giao dịch (4 đến 64 ký tự)', { autocomplete: 'off', readonly: Boolean(saved) }),
    ];
    if (saved) {
      fields[0].input.value = saved.amountVnd;
      fields[1].input.value = saved.reference;
      feedback.append(el('p', { class: 'alert warning', role: 'status', text: 'Lần ghi báo trước chưa rõ kết quả. Bấm lại để gửi đúng số tiền và mã này.' }));
    }
    const submit = el('button', { type: 'submit', class: 'btn primary', text: saved ? 'Gửi lại ghi báo' : 'Ghi báo đã chuyển bên ngoài' });
    form.append(...fields.map((f) => f.node), feedback, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      let payload = pendingReports.get(pendingKey);
      if (!payload) {
        const result = paymentInput({ amountVnd: fields[0].input.value, reference: fields[1].input.value }, summary);
        if (!result.payload) return invalid(feedback, result.errors, fields);
        payload = result.payload;
        pendingReports.set(pendingKey, payload);
      }
      submit.disabled = true;
      feedback.replaceChildren();
      try {
        await api.request('POST', `/api/bookings/${id}/payments`, { auth: true, body: payload });
        pendingReports.delete(pendingKey);
        if (!active()) return;
        announce('Máy chủ đã ghi nhận khai báo.');
        await load();
      } catch (error) {
        if (!keepsPendingReport(error)) {
          pendingReports.delete(pendingKey);
          fields.forEach(f => { f.input.readOnly = false; });
          submit.textContent = 'Ghi báo đã chuyển bên ngoài';
        }
        if (active()) {
          if (keepsPendingReport(error)) {
            fields[0].input.value = payload.amountVnd;
            fields[1].input.value = payload.reference;
            fields.forEach(f => { f.input.readOnly = true; });
            submit.textContent = 'Gửi lại đúng ghi báo trước';
          }
          writeError(feedback, error);
        }
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function paymentCard(p, actions) {
    const feedback = el('div', { 'aria-live': 'polite' });
    const confirmed = p.status === 'CONFIRMED';
    const children = [
      el('h3', { text: formatVnd(p.amountVnd) }),
      el('p', { text: confirmed ? `Đã xác nhận nhận bên ngoài lúc ${shortTime(p.confirmedAt)}.` : `Đã ghi báo chuyển bên ngoài lúc ${shortTime(p.createdAt)}. Chờ bên nhận xác nhận.` }),
    ];
    if (!confirmed && actions.confirm) {
      const button = el('button', {
        type: 'button',
        class: 'btn primary',
        text: 'Xác nhận đã nhận bên ngoài',
        click: () => send(`/api/payments/${p.id}/confirm`, {}, button, feedback, 'Máy chủ đã ghi nhận xác nhận. Đang tải lại.'),
      });
      children.push(el('p', { text: 'Chỉ bấm khi bạn đã nhận đủ khoản này ngoài hệ thống. Hệ thống không kiểm tra ngân hàng hay chứng từ.' }), button, feedback);
    }
    return el('li', { class: 'card' }, children);
  }

  function paymentNodes(payments, summary, actions, canRetry) {
    const out = [];
    if (summary) {
      const rows = [
        ['Đã thỏa thuận', summary.agreedVnd],
        ['Đã xác nhận đã nhận', summary.confirmedVnd],
        ['Đang chờ bên nhận xác nhận', summary.reportedVnd],
        ['Còn lại chưa xác nhận', summary.outstandingVnd],
        ['Có thể ghi báo thêm', summary.availableToReportVnd],
      ];
      out.push(
        el('dl', { class: 'facts' }, rows.map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: moneyText(value) })]))),
        el('ul', {}, DEFINITIONS.map((text) => el('li', { text }))),
      );
    } else {
      out.push(el('p', { text: 'Chưa có số liệu thanh toán. Cần hai bên đồng ý nghiệm thu trước khi ghi báo.' }));
    }
    if (actions.report || canRetry) {
      out.push(el('section', {}, [
        el('h3', { text: 'Ghi báo đã chuyển bên ngoài' }),
        el('p', { text: 'Đây là khai báo của bạn, chưa phải thanh toán đã được thực hiện hay đã được xác nhận.' }),
        reportForm(summary),
      ]));
    }
    out.push(payments.length
      ? el('ul', { class: 'cards' }, payments.map((p) => paymentCard(p, actions)))
      : el('p', { text: 'Chưa có khoản ghi báo nào.' }));
    return out;
  }

  function draw(read, money) {
    const { acceptance, party, canPropose, blockedByDispute } = read;
    const { payments, summary } = money;
    const actions = settlementActions(read, acceptance, summary);
    const canRetry = party === 'owner' && !blockedByDispute && Boolean(summary) && pendingReports.has(pendingKey);
    const nodes = [
      el('p', { class: 'lead', text: 'Bản thử nghiệm. Hệ thống chỉ ghi nhận đề nghị, đồng ý và khai báo thanh toán. Không chuyển tiền, không hoàn tiền, không giữ tiền ký quỹ.' }),
      el('p', { class: 'back' }, [el('a', { href: party === 'provider' ? '#dispatch' : `#booking/${id}`, text: party === 'provider' ? 'Quay lại gói dịch vụ' : 'Quay lại đơn' })]),
      el('a', {href:`#complaint/${id}`,text:'Mở khiếu nại về đơn này'}),
      el('a', {href:'#disputes',text:'Xem vụ việc đang theo dõi'}),
    ];
    if (blockedByDispute) {
      nodes.push(el('p', { class: 'alert warning', role: 'status', text: 'Đơn còn nghĩa vụ đang tranh chấp. Bạn vẫn xem được số liệu, nhưng chưa thể đề nghị, đồng ý, ghi báo hay xác nhận.' }));
    }
    let emptyText = 'Chưa có đề nghị nghiệm thu từ đơn vị nhận.';
    if (party === 'provider') emptyText = canPropose ? 'Chưa có đề nghị nghiệm thu. Gửi đề nghị bên dưới.' : 'Chưa có đề nghị nghiệm thu. Đề nghị cần ca làm việc đã kết thúc.';
    nodes.push(el('section', {}, [
      el('h2', { text: 'Nghiệm thu' }),
      acceptance ? acceptanceFacts(acceptance) : el('p', { text: emptyText }),
    ]));
    if (actions.consent) nodes.push(consentBlock(acceptance));
    if (actions.propose) nodes.push(el('section', {}, [el('h2', { text: acceptance ? 'Đề nghị thay thế' : 'Đề nghị nghiệm thu' }), proposeForm(acceptance)]));
    nodes.push(el('section', {}, [el('h2', { text: 'Thanh toán bên ngoài' }), ...paymentNodes(payments, summary, actions, canRetry)]));
    content.replaceChildren(...nodes);
  }

  await load();
}
