// Browser UI for the cloud branch. Plain ES module, no dependencies, no storage.
/* global location, TextEncoder, AbortController */
// The access token lives only in module memory and is cleared on logout or expiry.
// All API data is inserted with textContent or createElement; nothing from the server is parsed as HTML.

import { recruitmentRoute, renderRecruitment } from './recruitment.js';
import { operationsRoute, renderOperations } from './operations.js';

const API_TIMEOUT_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_BYTES = 16;
const MAX_SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_AREA_M2 = 10000000;

export class ApiError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.uncertain = false;
    Object.assign(this, extra);
  }
}

// ---- routing ----------------------------------------------------------------

export function parseRoute(hash) {
  const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  const [head = '', id = null, ...rest] = raw.split('/');
  if (rest.length > 0) return { name: 'notfound' };
  if (head === '' || head === 'services') {
    if (id === null) return { name: 'services' };
    return UUID.test(id) ? { name: 'service', id: id.toLowerCase() } : { name: 'notfound' };
  }
  if (head === 'fields' && id === null) return { name: 'fields' };
  if (head === 'register' && id === null) return { name: 'register' };
  if (head === 'request') return UUID.test(id ?? '') ? { name: 'request', id: id.toLowerCase() } : { name: 'notfound' };
  if (head === 'bookings' && id === null) return { name: 'bookings' };
  if (head === 'booking') return UUID.test(id ?? '') ? { name: 'booking', id: id.toLowerCase() } : { name: 'notfound' };
  if (head === 'login' && id === null) return { name: 'login' };
  return { name: 'notfound' };
}

// ---- validation -------------------------------------------------------------

export function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

// datetime-local text in local wall time -> UTC ISO string with milliseconds (the API's accepted shape).
export function localToUtcIso(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number);
  if (h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.toISOString();
}

export function validateBookingInput({ fieldId, serviceId, startLocal, endLocal }) {
  const errors = {};
  if (!UUID.test(fieldId ?? '')) errors.fieldId = 'Chọn thửa ruộng.';
  if (!UUID.test(serviceId ?? '')) errors.serviceId = 'Chọn dịch vụ.';
  const startAt = localToUtcIso(startLocal);
  const endAt = localToUtcIso(endLocal);
  if (!startAt) errors.startAt = 'Nhập thời điểm bắt đầu.';
  if (!endAt) errors.endAt = 'Nhập thời điểm kết thúc.';
  if (startAt && endAt) {
    const span = Date.parse(endAt) - Date.parse(startAt);
    if (span <= 0) errors.endAt = 'Thời điểm kết thúc phải sau thời điểm bắt đầu.';
    else if (span > MAX_SPAN_MS) errors.endAt = 'Khoảng thời gian tối đa là 30 ngày.';
  }
  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return { errors, payload: { fieldId, serviceId, startAt, endAt } };
}

export function validateFieldInput({ name, locality, areaText }) {
  const errors = {};
  const trimmedName = (name ?? '').trim();
  const trimmedLocality = (locality ?? '').trim();
  if (trimmedName === '' || [...trimmedName].length > 120) errors.name = 'Nhập tên thửa, tối đa 120 ký tự.';
  if (trimmedLocality === '' || [...trimmedLocality].length > 200) errors.locality = 'Nhập địa phương, tối đa 200 ký tự.';
  const areaM2 = /^\d+$/.test(areaText ?? '') ? Number(areaText) : NaN;
  if (!Number.isSafeInteger(areaM2) || areaM2 <= 0 || areaM2 > MAX_AREA_M2) {
    errors.areaM2 = 'Nhập diện tích bằng số m² nguyên, từ 1 đến 10.000.000.';
  }
  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return { errors, payload: { name: trimmedName, locality: trimmedLocality, areaM2 } };
}

export function validateRegistration({ email, password, name }) {
  const errors = {};
  const cleanEmail = (email ?? '').trim().toLowerCase();
  if (cleanEmail.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(cleanEmail)) {
    errors.email = 'Nhập email hợp lệ.';
  }
  const passwordBytes = utf8Length(password ?? '');
  if (passwordBytes < 12 || passwordBytes > 128) errors.password = 'Mật khẩu từ 12 đến 128 byte UTF-8.';
  const cleanName = (name ?? '').trim();
  if ([...cleanName].length < 1 || [...cleanName].length > 120) errors.name = 'Nhập họ tên, tối đa 120 ký tự.';
  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return { errors, payload: { email: cleanEmail, password, name: cleanName } };
}

export function validateLogin({ email, password }) {
  const errors = {};
  if (!(email ?? '').trim()) errors.email = 'Nhập email.';
  if (!password) errors.password = 'Nhập mật khẩu.';
  return { errors, payload: Object.keys(errors).length ? null : { email: email.trim().toLowerCase(), password } };
}

// ---- formatting -------------------------------------------------------------

export function formatVnd(text) {
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return null;
  return `${text.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} VND`;
}

export function formatArea(m2) {
  if (!Number.isSafeInteger(m2) || m2 <= 0) return null;
  const ha = (m2 / 10000).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  return `${m2.toLocaleString('vi-VN')} m² (${ha} ha)`;
}

// Price text per hectare. Missing or non-integer values never render as a number.
export function priceText(pricePerHaVnd) {
  const vnd = formatVnd(pricePerHaVnd);
  return vnd ? `${vnd} mỗi ha` : 'Chưa có giá';
}

// Maps a server validation field name to the id of the input that should show it. Unknown names map to null.
const SERVER_FIELD_INPUT_IDS = {
  fieldId: 'booking-field',
  serviceId: 'booking-service',
  startAt: 'booking-start',
  endAt: 'booking-end',
  areaM2: 'field-area',
  name: 'field-name',
  locality: 'field-locality',
};
export function inputIdForServerField(field) {
  return Object.hasOwn(SERVER_FIELD_INPUT_IDS, field) ? SERVER_FIELD_INPUT_IDS[field] : null;
}

export function priceLabel(service) {
  if (service.dataLabel === 'synthetic') return 'Giá mô phỏng';
  if (service.dataLabel === 'real-labelled') return 'Giá đã gắn nhãn dữ liệu thật';
  return null;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

const ERROR_MESSAGES = {
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  INVALID_CREDENTIALS: 'Email hoặc mật khẩu không đúng.',
  RATE_LIMITED: 'Bạn thử quá nhiều lần. Vui lòng đợi rồi thử lại.',
  CONFLICT: 'Email này đã được đăng ký.',
  NOT_FOUND: 'Không tìm thấy dữ liệu này.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.',
  IDEMPOTENCY_CONFLICT: 'Yêu cầu này đã gửi với nội dung khác. Hãy tải lại đơn của tôi trước khi gửi lại.',
  DB_UNAVAILABLE: 'Hệ thống dữ liệu chưa sẵn sàng. Yêu cầu có thể chưa được ghi nhận, hãy kiểm tra trong đơn của tôi trước khi gửi lại.',
  SERVICE_UNAVAILABLE: 'Máy chủ chưa sẵn sàng. Vui lòng thử lại sau.',
  IDENTITY_UNAVAILABLE: 'Dịch vụ đăng nhập chưa sẵn sàng. Vui lòng thử lại sau.',
  NETWORK: 'Không kết nối được máy chủ. Yêu cầu có thể chưa được ghi nhận, hãy kiểm tra trong đơn của tôi trước khi gửi lại.',
  TIMEOUT: 'Máy chủ phản hồi quá chậm. Yêu cầu có thể chưa được ghi nhận, hãy kiểm tra trong đơn của tôi trước khi gửi lại.',
  BAD_RESPONSE: 'Máy chủ trả về dữ liệu không hợp lệ.',
};

export function messageForError(error) {
  if (error instanceof ApiError && ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
  if (error instanceof ApiError && error.status >= 500) return ERROR_MESSAGES.SERVICE_UNAVAILABLE;
  return 'Có lỗi xảy ra. Vui lòng thử lại.';
}

// ---- idempotency and attempt tracking ---------------------------------------

export function newIdempotencyKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(IDEMPOTENCY_KEY_BYTES));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('') + Date.now().toString(36);
}

// Keeps one pending booking attempt. Retrying the same payload reuses its key; a changed payload is blocked
// until the caller explicitly starts a new attempt. A definitive server answer clears the attempt.
export function createAttemptTracker() {
  let pending = null;
  return {
    current: () => pending,
    start(payload) {
      pending = { key: newIdempotencyKey(), payload: JSON.stringify(payload), uncertain: false };
      return pending;
    },
    mark(uncertain) {
      if (pending) pending.uncertain = uncertain;
    },
    clear() {
      pending = null;
    },
  };
}

export async function submitBooking({ api, tracker, payload, newAttempt = false }) {
  const same = tracker.current() && tracker.current().payload === JSON.stringify(payload);
  if (tracker.current() && !same && !newAttempt) return { kind: 'blocked' };
  const attempt = same && !newAttempt ? tracker.current() : tracker.start(payload);
  try {
    const { data } = await api.request('POST', '/api/bookings', {
      auth: true,
      body: payload,
      headers: { 'Idempotency-Key': attempt.key },
    });
    if (!data || typeof data.booking !== 'object' || data.booking === null) {
      throw new ApiError(0, 'BAD_RESPONSE');
    }
    tracker.clear();
    return { kind: 'created', booking: data.booking };
  } catch (error) {
    // Definitive 4xx answers end the attempt. 401, 5xx, network, timeout and bad 2xx keep it pending for an exact retry.
    const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401;
    if (definitive) tracker.clear();
    else tracker.mark(true);
    throw error;
  }
}

// ---- API client -------------------------------------------------------------

export function createApiClient({ fetchImpl = globalThis.fetch, getToken, onUnauthorized = () => {}, timeoutMs = API_TIMEOUT_MS }) {
  async function request(method, path, { auth = false, body, headers = {} } = {}) {
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (auth) {
      const token = getToken();
      if (!token) {
        onUnauthorized();
        throw new ApiError(401, 'UNAUTHENTICATED');
      }
      requestHeaders.Authorization = `Bearer ${token}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await fetchImpl(path, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (response.status !== 204) text = await response.text();
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new ApiError(0, timedOut ? 'TIMEOUT' : 'NETWORK', { uncertain: true });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 204) return { status: 204, data: null };
    let parsed = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError(response.status, 'BAD_RESPONSE', { uncertain: response.status >= 500 });
      }
    }
    if (!response.ok) {
      const code = parsed?.error?.code ?? 'UNKNOWN';
      const field = typeof parsed?.error?.field === 'string' ? parsed.error.field : undefined;
      const uncertain = response.status >= 500;
      if (response.status === 401 && auth) onUnauthorized();
      throw new ApiError(response.status, code, { uncertain, ...(field ? { field } : {}) });
    }
    if (parsed === null) throw new ApiError(response.status, 'BAD_RESPONSE');
    return { status: response.status, data: parsed };
  }
  return { request };
}

// ---- browser shell (runs only in a document) --------------------------------

const isBrowser = typeof globalThis.document !== 'undefined' && typeof globalThis.window !== 'undefined';

if (isBrowser) {
  const doc = globalThis.document;
  const session = { token: null, user: null, expiresAt: null };
  const ui = { selectedServiceId: null, returnHash: '#services' };
  const tracker = createAttemptTracker();

  const api = createApiClient({
    getToken: () => session.token,
    onUnauthorized: () => {
      if (session.token) clearSession('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    },
  });

  const main = doc.getElementById('main');
  const status = doc.getElementById('status');
  const sessionState = doc.getElementById('session-state');
  const logoutButton = doc.getElementById('logout-button');
  const authLink = doc.getElementById('auth-link');

  function el(tag, props = {}, children = []) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function announce(text) {
    status.textContent = text;
  }

  function setSessionUi() {
    const signedIn = Boolean(session.token);
    sessionState.textContent = signedIn ? `Đang đăng nhập: ${session.user.name}` : 'Chưa đăng nhập';
    logoutButton.hidden = !signedIn;
    authLink.hidden = signedIn;
  }

  function clearSession(message) {
    session.token = null;
    session.user = null;
    session.expiresAt = null;
    setSessionUi();
    announce(message);
    if (location.hash !== '#login') location.hash = '#login';
    else render();
  }

  function setMainHeading(text) {
    const heading = el('h1', { tabindex: '-1', text });
    return heading;
  }

  function focusMain() {
    const heading = main.querySelector('h1');
    (heading ?? main).focus();
  }

  function errorBlock(error, retry) {
    const message = messageForError(error);
    return el('div', { class: 'alert error', role: 'alert' }, [
      el('p', { text: message }),
      retry ? el('div', { class: 'actions' }, [el('button', { type: 'button', class: 'btn secondary', on: { click: retry }, text: 'Thử lại' })]) : null,
    ]);
  }

  function loadingBlock(text) {
    return el('p', { class: 'state', role: 'status', text });
  }

  function requireSignIn(hashBack) {
    ui.returnHash = hashBack;
    location.hash = '#login';
  }

  // ---- pages ----

  async function renderServices() {
    const routeHash = location.hash;
    main.replaceChildren(setMainHeading('Dịch vụ cơ giới hóa'), loadingBlock('Đang tải danh sách dịch vụ…'));
    focusMain();
    try {
      const { data } = await api.request('GET', '/api/services?limit=100&offset=0');
      if (location.hash !== routeHash) return;
      const items = data.items ?? [];
      const list = el('ul', { class: 'cards' });
      if (items.length === 0) {
        main.replaceChildren(setMainHeading('Dịch vụ cơ giới hóa'), el('p', { class: 'state', text: 'Chưa có dịch vụ nào đang mở.' }));
        return;
      }
      for (const service of items) {
        list.append(el('li', { class: 'card' }, [
          el('h2', {}, [el('a', { href: `#services/${service.id}`, text: service.name })]),
          el('p', { class: 'tag' + (service.dataLabel === 'synthetic' ? ' sim' : ''), text: priceLabel(service) ?? '' }),
          el('p', { text: priceText(service.pricePerHaVnd) }),
        ]));
      }
      main.replaceChildren(setMainHeading('Dịch vụ cơ giới hóa'), el('p', { class: 'lead', text: 'Chọn dịch vụ để xem chi tiết và gửi yêu cầu.' }), list);
      focusMain();
    } catch (error) {
      if (location.hash !== routeHash) return;
      main.replaceChildren(setMainHeading('Dịch vụ cơ giới hóa'), errorBlock(error, renderServices));
      focusMain();
    }
  }

  async function renderService(id) {
    const routeHash = location.hash;
    main.replaceChildren(loadingBlock('Đang tải dịch vụ…'));
    try {
      const { data } = await api.request('GET', `/api/services/${id}`);
      if (location.hash !== routeHash) return;
      const s = data.service;
      ui.selectedServiceId = s.id;
      const createAction = session.token
        ? el('a', { class: 'btn primary', href: `#request/${s.id}`, text: 'Gửi yêu cầu cho dịch vụ này' })
        : el('a', { class: 'btn primary', href: `#login`, text: 'Đăng nhập để gửi yêu cầu', on: { click: () => { ui.returnHash = `#request/${s.id}`; } } });
      main.replaceChildren(
        el('p', { class: 'back' }, [el('a', { href: '#services', text: '← Quay lại danh sách dịch vụ' })]),
        setMainHeading(s.name),
        el('dl', { class: 'facts' }, [
          el('div', {}, [el('dt', { text: 'Nguồn giá' }), el('dd', { text: priceLabel(s) ?? '' })]),
          el('div', {}, [el('dt', { text: 'Đơn giá' }), el('dd', { text: priceText(s.pricePerHaVnd) })]),
          el('div', { class: 'wide' }, [el('dt', { text: 'Ghi chú' }), el('dd', { text: 'Gửi yêu cầu chỉ tạo đơn ở trạng thái Đã gửi yêu cầu. Chưa có điều máy, chưa thanh toán và chưa thỏa thuận giá.' })]),
        ]),
        el('div', { class: 'actions' }, [createAction]),
      );
      focusMain();
    } catch (error) {
      if (location.hash !== routeHash) return;
      if (error instanceof ApiError && error.status === 404) {
        main.replaceChildren(setMainHeading('Không tìm thấy dịch vụ'), el('p', { text: 'Dịch vụ này không tồn tại hoặc đã ngừng mở.' }), el('a', { href: '#services', text: 'Xem danh sách dịch vụ' }));
      } else {
        main.replaceChildren(setMainHeading('Dịch vụ'), errorBlock(error, () => renderService(id)));
      }
      focusMain();
    }
  }

  function fieldOption(field) {
    return el('option', { value: field.id, text: `${field.name} (${formatArea(field.areaM2)})` });
  }

  async function renderFields() {
    const routeHash = location.hash;
    if (!session.token) return requireSignIn('#fields');
    main.replaceChildren(setMainHeading('Thửa ruộng của tôi'), loadingBlock('Đang tải thửa ruộng…'));
    focusMain();
    try {
      const { data } = await api.request('GET', '/api/fields?limit=100&offset=0', { auth: true });
      if (location.hash !== routeHash) return;
      const list = el('ul', { class: 'cards' }, data.items.map((f) => el('li', { class: 'card' }, [
        el('h2', { text: f.name }),
        el('p', { text: f.locality }),
        el('p', { text: formatArea(f.areaM2) }),
      ])));
      main.replaceChildren(setMainHeading('Thửa ruộng của tôi'), data.items.length ? list : el('p', { class: 'state', text: 'Bạn chưa có thửa ruộng nào.' }), buildFieldForm());
      focusMain();
    } catch (error) {
      if (location.hash !== routeHash) return;
      main.replaceChildren(setMainHeading('Thửa ruộng của tôi'), errorBlock(error, renderFields));
      focusMain();
    }
  }

  function buildFieldForm() {
    const errorSlot = el('div', { 'aria-live': 'polite' });
    const nameInput = el('input', { id: 'field-name', name: 'name', required: true, maxlength: 120, autocomplete: 'off' });
    const localityInput = el('input', { id: 'field-locality', name: 'locality', required: true, maxlength: 200, autocomplete: 'off' });
    const areaInput = el('input', { id: 'field-area', name: 'areaM2', required: true, inputmode: 'numeric', autocomplete: 'off', 'aria-describedby': 'field-area-hint' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Lưu thửa ruộng' });
    const form = el('form', { class: 'form', novalidate: true, 'aria-label': 'Thêm thửa ruộng' }, [
      el('div', { class: 'field' }, [el('label', { for: 'field-name', text: 'Tên thửa' }), nameInput]),
      el('div', { class: 'field' }, [el('label', { for: 'field-locality', text: 'Địa phương' }), localityInput]),
      el('div', { class: 'field' }, [
        el('label', { for: 'field-area', text: 'Diện tích (m²)' }),
        el('p', { id: 'field-area-hint', class: 'hint', text: 'Nhập số m² nguyên. Ví dụ 12000 m² bằng 1,2 ha.' }),
        areaInput,
      ]),
      errorSlot,
      el('div', { class: 'actions' }, [submit]),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const { errors, payload } = validateFieldInput({ name: nameInput.value, locality: localityInput.value, areaText: areaInput.value });
      showFieldErrors(form, errors, errorSlot);
      if (!payload) return;
      submit.disabled = true;
      announce('Đang lưu thửa ruộng…');
      try {
        await api.request('POST', '/api/fields', { auth: true, body: payload });
        announce('Đã lưu thửa ruộng.');
        renderFields();
      } catch (error) {
        submit.disabled = false;
        const serverFieldId = error instanceof ApiError ? inputIdForServerField(error.field) : null;
        if (serverFieldId && form.querySelector(`#${serverFieldId}`)) {
          showFieldErrors(form, { [error.field]: messageForError(error) }, errorSlot);
        } else {
          errorSlot.replaceChildren(errorBlock(error));
          announce(messageForError(error));
        }
      }
    });
    return el('section', { 'aria-labelledby': 'field-form-title' }, [el('h2', { id: 'field-form-title', text: 'Thêm thửa ruộng' }), form]);
  }

  function showFieldErrors(form, errors, slot) {
    for (const field of form.querySelectorAll('input')) field.removeAttribute('aria-invalid');
    for (const node of form.querySelectorAll('.field-error')) node.remove();
    const map = { name: 'field-name', locality: 'field-locality', areaM2: 'field-area' };
    let first = null;
    for (const [key, message] of Object.entries(errors)) {
      const input = form.querySelector(`#${map[key]}`);
      input.setAttribute('aria-invalid', 'true');
      input.after(el('p', { class: 'field-error', text: message }));
      first ??= input;
    }
    slot.replaceChildren();
    if (first) {
      first.focus();
      announce('Kiểm tra lại các trường được đánh dấu.');
    }
  }

  async function renderRequest(serviceId) {
    const routeHash = location.hash;
    if (!session.token) return requireSignIn(`#request/${serviceId}`);
    main.replaceChildren(setMainHeading('Gửi yêu cầu dịch vụ'), loadingBlock('Đang tải dữ liệu…'));
    focusMain();
    try {
      const [service, fields] = await Promise.all([
        api.request('GET', `/api/services/${serviceId}`),
        api.request('GET', '/api/fields?limit=100&offset=0', { auth: true }),
      ]);
      if (location.hash !== routeHash) return;
      const s = service.data.service;
      ui.selectedServiceId = s.id;
      const options = fields.data.items;
      if (options.length === 0) {
        main.replaceChildren(setMainHeading('Gửi yêu cầu dịch vụ'), el('p', { text: 'Bạn cần thêm thửa ruộng trước khi gửi yêu cầu.' }), el('a', { class: 'btn primary', href: '#fields', text: 'Thêm thửa ruộng' }));
        focusMain();
        return;
      }
      buildRequestForm(s, options);
      focusMain();
    } catch (error) {
      if (location.hash !== routeHash) return;
      main.replaceChildren(setMainHeading('Gửi yêu cầu dịch vụ'), errorBlock(error, () => renderRequest(serviceId)));
      focusMain();
    }
  }

  function buildRequestForm(service, fields) {
    const fieldSelect = el('select', { id: 'booking-field', name: 'fieldId', required: true }, [
      el('option', { value: '', text: 'Chọn thửa ruộng' }),
      ...fields.map(fieldOption),
    ]);
    const serviceSelect = el('select', { id: 'booking-service', name: 'serviceId', required: true, disabled: true }, [
      el('option', { value: service.id, text: service.name, selected: true }),
    ]);
    const startInput = el('input', { id: 'booking-start', type: 'datetime-local', name: 'startLocal', required: true });
    const endInput = el('input', { id: 'booking-end', type: 'datetime-local', name: 'endLocal', required: true, 'aria-describedby': 'booking-span' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Gửi yêu cầu' });
    const errorSlot = el('div', { 'aria-live': 'polite' });
    const form = el('form', { class: 'form', novalidate: true, 'aria-label': 'Gửi yêu cầu dịch vụ' }, [
      el('div', { class: 'field' }, [el('label', { for: 'booking-field', text: 'Thửa ruộng' }), fieldSelect]),
      el('div', { class: 'field' }, [el('label', { for: 'booking-service', text: 'Dịch vụ' }), serviceSelect]),
      el('div', { class: 'field' }, [
        el('label', { for: 'booking-start', text: 'Bắt đầu' }),
        el('p', { class: 'hint', text: 'Nhập theo giờ địa phương của bạn.' }),
        startInput,
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'booking-end', text: 'Kết thúc' }),
        el('p', { id: 'booking-span', class: 'hint', text: 'Kết thúc phải sau bắt đầu, tối đa 30 ngày.' }),
        endInput,
      ]),
      errorSlot,
      el('div', { class: 'actions' }, [submit]),
    ]);

    const ids = { fieldId: 'booking-field', serviceId: 'booking-service', startAt: 'booking-start', endAt: 'booking-end' };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const { errors, payload } = validateBookingInput({
        fieldId: fieldSelect.value,
        serviceId: serviceSelect.value,
        startLocal: startInput.value,
        endLocal: endInput.value,
      });
      showBookingErrors(form, errors, errorSlot, ids);
      if (!payload) return;
      submit.disabled = true;
      announce('Đang gửi yêu cầu…');
      try {
        const result = await submitBooking({ api, tracker, payload, newAttempt: false });
        if (result.kind === 'blocked') {
          submit.disabled = false;
          errorSlot.replaceChildren(el('div', { class: 'alert warning', role: 'alert' }, [
            el('p', { text: 'Có yêu cầu trước chưa rõ kết quả. Hãy tải lại đơn của tôi để kiểm tra. Nếu vẫn muốn gửi nội dung mới, hãy xác nhận gửi như yêu cầu mới.' }),
            el('div', { class: 'actions' }, [
              el('a', { class: 'btn secondary', href: '#bookings', text: 'Xem đơn của tôi' }),
              el('button', { type: 'button', class: 'btn secondary', text: 'Gửi như yêu cầu mới', on: { click: () => { retryAsNewAttempt(payload, submit, errorSlot); } } }),
            ]),
          ]));
          announce('Có yêu cầu trước chưa rõ kết quả.');
          return;
        }
        announce('Đã gửi yêu cầu dịch vụ.');
        location.hash = `#booking/${result.booking.id}`;
      } catch (error) {
        submit.disabled = false;
        if (error instanceof ApiError && error.status === 401) return;
        const serverFieldId = error instanceof ApiError ? inputIdForServerField(error.field) : null;
        const target = serverFieldId ? form.querySelector(`#${serverFieldId}`) : null;
        if (target) {
          showBookingErrors(form, { [error.field]: messageForError(error) }, errorSlot, ids);
        } else {
          errorSlot.replaceChildren(errorBlock(error));
          announce(messageForError(error));
        }
      }
    });
    main.replaceChildren(
      el('p', { class: 'back' }, [el('a', { href: `#services/${service.id}`, text: '← Quay lại dịch vụ' })]),
      setMainHeading('Gửi yêu cầu dịch vụ'),
      el('p', { class: 'lead', text: `Dịch vụ: ${service.name}. Đơn sẽ ở trạng thái Đã gửi yêu cầu, chưa được điều máy hay thanh toán.` }),
      form,
    );
  }

  async function retryAsNewAttempt(payload, submit, errorSlot) {
    submit.disabled = true;
    try {
      const result = await submitBooking({ api, tracker, payload, newAttempt: true });
      location.hash = `#booking/${result.booking.id}`;
    } catch (error) {
      submit.disabled = false;
      errorSlot.replaceChildren(errorBlock(error));
      announce(messageForError(error));
    }
  }

  function showBookingErrors(form, errors, slot, ids) {
    for (const node of form.querySelectorAll('select, input')) node.removeAttribute('aria-invalid');
    for (const node of form.querySelectorAll('.field-error')) node.remove();
    let first = null;
    for (const [key, message] of Object.entries(errors)) {
      const input = form.querySelector(`#${ids[key]}`);
      if (!input) continue;
      input.setAttribute('aria-invalid', 'true');
      input.after(el('p', { class: 'field-error', text: message }));
      first ??= input;
    }
    slot.replaceChildren();
    if (first) {
      first.focus();
      announce('Kiểm tra lại các trường được đánh dấu.');
    }
  }

  async function renderBookings() {
    const routeHash = location.hash;
    if (!session.token) return requireSignIn('#bookings');
    main.replaceChildren(setMainHeading('Đơn của tôi'), loadingBlock('Đang tải đơn…'));
    focusMain();
    try {
      const { data } = await api.request('GET', '/api/bookings?limit=50&offset=0', { auth: true });
      if (location.hash !== routeHash) return;
      const items = data.items ?? [];
      const content = items.length === 0
        ? el('p', { class: 'state', text: 'Bạn chưa có đơn nào.' })
        : el('ul', { class: 'cards' }, items.map((b) => el('li', { class: 'card' }, [
          el('h2', {}, [el('a', { href: `#booking/${b.id}`, text: `${b.service.name}, ${b.field.name}` })]),
          el('p', { text: `Trạng thái: ${stateLabel(b.state)}` }),
          el('p', { text: `Thời gian: ${formatDateTime(b.startAt)} đến ${formatDateTime(b.endAt)}` }),
        ])));
      main.replaceChildren(
        setMainHeading('Đơn của tôi'),
        el('div', { class: 'actions' }, [el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại danh sách', on: { click: renderBookings } }), el('a', { class: 'btn secondary', href: '#services', text: 'Đặt dịch vụ mới' })]),
        content,
      );
      focusMain();
    } catch (error) {
      if (location.hash !== routeHash) return;
      main.replaceChildren(setMainHeading('Đơn của tôi'), errorBlock(error, renderBookings));
      focusMain();
    }
  }

  async function renderBooking(id) {
    const routeHash = location.hash;
    if (!session.token) return requireSignIn(`#booking/${id}`);
    main.replaceChildren(loadingBlock('Đang tải đơn…'));
    try {
      const { data } = await api.request('GET', `/api/bookings/${id}`, { auth: true });
      if (location.hash !== routeHash) return;
      const b = data.booking;
      main.replaceChildren(
        el('p', { class: 'back' }, [el('a', { href: '#bookings', text: '← Quay lại đơn của tôi' })]),
        setMainHeading(`Đơn ${b.service.name}`),
        el('p', { class: 'alert success', role: 'status' }, [el('span', { text: `Trạng thái: ${stateLabel(b.state)}. Yêu cầu đã được ghi nhận nhưng chưa được điều máy hay thanh toán.` })]),
        el('dl', { class: 'facts' }, [
          el('div', {}, [el('dt', { text: 'Thửa ruộng' }), el('dd', { text: `${b.field.name} (${formatArea(b.field.areaM2)})` })]),
          el('div', {}, [el('dt', { text: 'Dịch vụ' }), el('dd', { text: b.service.name })]),
          el('div', {}, [el('dt', { text: 'Nguồn giá' }), el('dd', { text: priceLabel(b.service) ?? '' })]),
          el('div', {}, [el('dt', { text: 'Đơn giá' }), el('dd', { text: priceText(b.service.pricePerHaVnd) })]),
          el('div', {}, [el('dt', { text: 'Tổng tạm tính' }), el('dd', { text: formatVnd(b.totalVnd) ?? 'Chưa có tổng' })]),
          el('div', {}, [el('dt', { text: 'Bắt đầu' }), el('dd', { text: formatDateTime(b.startAt) })]),
          el('div', {}, [el('dt', { text: 'Kết thúc' }), el('dd', { text: formatDateTime(b.endAt) })]),
        ]),
        el('h2', { text: 'Lịch sử' }),
        el('ol', { class: 'timeline' }, data.events.map((ev) => el('li', { text: `${eventLabel(ev.type)}: ${stateLabel(ev.state)}, ${formatDateTime(ev.createdAt)}` }))),
      );
      focusMain();
    } catch (error) {
      if (location.hash !== routeHash) return;
      if (error instanceof ApiError && error.status === 404) {
        main.replaceChildren(setMainHeading('Không tìm thấy đơn'), el('p', { text: 'Đơn này không tồn tại hoặc không thuộc tài khoản của bạn.' }), el('a', { href: '#bookings', text: 'Quay lại đơn của tôi' }));
      } else {
        main.replaceChildren(setMainHeading('Đơn'), errorBlock(error, () => renderBooking(id)));
      }
      focusMain();
    }
  }

  function stateLabel(state) {
    return state === 'REQUESTED' ? 'Đã gửi yêu cầu' : state;
  }

  function eventLabel(type) {
    return type === 'BOOKING_REQUESTED' ? 'Đã gửi yêu cầu' : type;
  }

  function renderLogin() {
    if (session.token) {
      location.hash = ui.returnHash || '#services';
      return;
    }
    const errorSlot = el('div', { 'aria-live': 'polite' });
    const emailInput = el('input', { id: 'login-email', name: 'email', type: 'email', required: true, autocomplete: 'email' });
    const passwordInput = el('input', { id: 'login-password', name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Đăng nhập' });
    const form = el('form', { class: 'form', novalidate: true, 'aria-label': 'Đăng nhập' }, [
      el('div', { class: 'field' }, [el('label', { for: 'login-email', text: 'Email' }), emailInput]),
      el('div', { class: 'field' }, [el('label', { for: 'login-password', text: 'Mật khẩu' }), passwordInput]),
      errorSlot,
      el('div', { class: 'actions' }, [submit, el('a', { class: 'btn secondary', href: '#register', text: 'Đăng ký tài khoản nông dân' })]),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const { errors, payload } = validateLogin({ email: emailInput.value, password: passwordInput.value });
      showSimpleErrors(form, errors, errorSlot, { email: 'login-email', password: 'login-password' });
      if (!payload) return;
      submit.disabled = true;
      announce('Đang đăng nhập…');
      try {
        const { data } = await api.request('POST', '/api/auth/login', { body: payload });
        session.token = data.token;
        session.user = data.user;
        session.expiresAt = data.expiresAt;
        setSessionUi();
        announce(`Đã đăng nhập: ${data.user.name}`);
        passwordInput.value = '';
        location.hash = ui.returnHash || '#services';
        ui.returnHash = '#services';
      } catch (error) {
        submit.disabled = false;
        errorSlot.replaceChildren(errorBlock(error));
        announce(messageForError(error));
      }
    });
    main.replaceChildren(setMainHeading('Đăng nhập'), el('p', { class: 'lead', text: 'Đăng nhập để tạo thửa ruộng và gửi yêu cầu dịch vụ.' }), form);
    focusMain();
  }

  function renderRegister() {
    const errorSlot = el('div', { 'aria-live': 'polite' });
    const nameInput = el('input', { id: 'reg-name', name: 'name', required: true, autocomplete: 'name' });
    const emailInput = el('input', { id: 'reg-email', name: 'email', type: 'email', required: true, autocomplete: 'email' });
    const passwordInput = el('input', { id: 'reg-password', name: 'password', type: 'password', required: true, autocomplete: 'new-password', 'aria-describedby': 'reg-password-hint' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Tạo tài khoản' });
    const form = el('form', { class: 'form', novalidate: true, 'aria-label': 'Đăng ký' }, [
      el('div', { class: 'field' }, [el('label', { for: 'reg-name', text: 'Họ tên' }), nameInput]),
      el('div', { class: 'field' }, [el('label', { for: 'reg-email', text: 'Email' }), emailInput]),
      el('div', { class: 'field' }, [
        el('label', { for: 'reg-password', text: 'Mật khẩu' }),
        el('p', { id: 'reg-password-hint', class: 'hint', text: 'Ít nhất 12 ký tự, tối đa 128 byte.' }),
        passwordInput,
      ]),
      errorSlot,
      el('div', { class: 'actions' }, [submit]),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const { errors, payload } = validateRegistration({ email: emailInput.value, password: passwordInput.value, name: nameInput.value });
      showSimpleErrors(form, errors, errorSlot, { name: 'reg-name', email: 'reg-email', password: 'reg-password' });
      if (!payload) return;
      submit.disabled = true;
      announce('Đang tạo tài khoản…');
      try {
        await api.request('POST', '/api/auth/register', { body: payload });
        passwordInput.value = '';
        announce('Đã tạo tài khoản. Vui lòng đăng nhập.');
        location.hash = '#login';
      } catch (error) {
        submit.disabled = false;
        errorSlot.replaceChildren(errorBlock(error));
        announce(messageForError(error));
      }
    });
    main.replaceChildren(setMainHeading('Đăng ký tài khoản nông dân'), el('p', { class: 'lead', text: 'Tài khoản mới chỉ có vai trò nông dân. Các vai trò khác do quản trị viên phê duyệt.' }), form);
    focusMain();
  }

  function showSimpleErrors(form, errors, slot, map) {
    for (const node of form.querySelectorAll('input')) node.removeAttribute('aria-invalid');
    for (const node of form.querySelectorAll('.field-error')) node.remove();
    let first = null;
    for (const [key, message] of Object.entries(errors)) {
      const input = form.querySelector(`#${map[key]}`);
      input.setAttribute('aria-invalid', 'true');
      input.after(el('p', { class: 'field-error', text: message }));
      first ??= input;
    }
    slot.replaceChildren();
    if (first) {
      first.focus();
      announce('Kiểm tra lại các trường được đánh dấu.');
    }
  }

  function renderNotFound() {
    main.replaceChildren(setMainHeading('Không tìm thấy trang'), el('p', { text: 'Địa chỉ này không tồn tại.' }), el('a', { href: '#services', text: 'Về danh sách dịch vụ' }));
    focusMain();
  }

  async function logout() {
    const token = session.token;
    logoutButton.disabled = true;
    try {
      if (token) await api.request('POST', '/api/auth/logout', { auth: true });
    } catch {
      // The local session is cleared regardless; a server-side revoke failure must not keep the browser signed in.
    } finally {
      logoutButton.disabled = false;
      clearSession('Đã đăng xuất. Phiên trên máy này đã bị xóa.');
    }
  }

  function render() {
    const route = parseRoute(location.hash);
    setSessionUi();
    const recruitment = recruitmentRoute(location.hash);
    if (recruitment) return renderRecruitment({ main, api, session, announce, route: recruitment, signIn: requireSignIn });
    const operations = operationsRoute(location.hash);
    if (operations) return renderOperations({ main, api, session, announce, route: operations, signIn: requireSignIn });
    if (route.name === 'services') return renderServices();
    if (route.name === 'service') return renderService(route.id);
    if (route.name === 'fields') return renderFields();
    if (route.name === 'request') return renderRequest(route.id);
    if (route.name === 'bookings') return renderBookings();
    if (route.name === 'booking') return renderBooking(route.id);
    if (route.name === 'login') return renderLogin();
    if (route.name === 'register') return renderRegister();
    return renderNotFound();
  }

  main.addEventListener('input', (event) => {
    const input = event.target;
    if (input.matches('input, select')) {
      input.removeAttribute('aria-invalid');
      if (input.nextElementSibling?.classList.contains('field-error')) input.nextElementSibling.remove();
    }
  });
  doc.querySelector('.skip-link').addEventListener('click', (event) => {
    event.preventDefault();
    main.focus();
    main.scrollIntoView();
  });
  logoutButton.addEventListener('click', logout);
  globalThis.addEventListener('hashchange', render);
  if (!location.hash) location.hash = '#services';
  else render();
}
