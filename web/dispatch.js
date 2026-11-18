/* global location */
// Dispatch UI for coop and provider roles. Plain ES module. Server data is written with textContent only.
// Every action is confirmed by the server: lists and detail are refetched after a write, never patched locally.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MACHINE_TYPES = ['harvester', 'tractor', 'drone'];
const MACHINE_LABELS = { harvester: 'Máy gặt', tractor: 'Máy kéo', drone: 'Drone' };
// Service codes identify which machine type can serve a package. Availability still comes from the server on claim.
const SERVICE_MACHINE = { 'harvest-combine': 'harvester', 'tillage-tractor': 'tractor', 'drone-spray': 'drone' };
const STATUS_LABELS = { OPEN: 'Đang mở nhận', CLAIMED: 'Đã có đơn vị nhận', CANCELLED: 'Đã hủy' };
const ERROR_MESSAGES = {
  NOT_FOUND: 'Không tìm thấy gói hoặc bạn không có quyền xem. Tải lại danh sách.',
  PACKAGE_UNAVAILABLE: 'Gói đã đổi trạng thái. Tải lại trước khi thao tác.',
  PACKAGE_INCOMPATIBLE: 'Các đơn đã chọn không cùng dịch vụ và địa phương, hoặc không có khoảng thời gian chung. Bỏ bớt đơn không khớp rồi tạo lại gói.',
  BOOKING_NOT_REQUESTED: 'Có đơn đã được gom hoặc đổi trạng thái. Tải lại danh sách đơn.',
  MACHINE_UNAVAILABLE: 'Máy không còn sẵn sàng hoặc không đúng loại cho dịch vụ của gói.',
  OPERATOR_NOT_AUTHORIZED: 'Người vận hành không còn đề nghị hợp lệ cho khoảng thời gian của gói.',
  SCHEDULE_CONFLICT: 'Máy hoặc người vận hành đã có lịch trùng khoảng thời gian của gói. Chọn máy hoặc người khác.',
  SHIFT_ACTIVE: 'Gói đã có ca làm việc được bắt đầu, không thể hủy. Xem mục Ca làm việc.',
  INVALID_REASON: 'Nhập lý do hủy từ 1 đến 500 ký tự.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Kiểm tra lại các trường.',
  FORBIDDEN: 'Tài khoản này không có quyền thực hiện thao tác.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  DB_UNAVAILABLE: 'Hệ thống dữ liệu chưa sẵn sàng. Thử lại sau, chưa coi thao tác là hoàn tất.',
};
const UNCERTAIN_MESSAGE = 'Chưa xác nhận được thao tác đã được ghi nhận. Tải lại để xem trạng thái thật trước khi thử lại.';
const GENERIC_MESSAGE = 'Không thực hiện được thao tác. Tải lại rồi kiểm tra trạng thái gói.';

// ---- routing and pure helpers (no DOM) --------------------------------------

export function dispatchRoute(hash) {
  if (hash === '#dispatch') return { name: 'dispatch' };
  const match = /^#package\/([^/?#]+)$/.exec(hash ?? '');
  return match && UUID.test(match[1]) ? { name: 'package', id: match[1].toLowerCase() } : null;
}

// Returns lowercase unique booking IDs, 1 to 100 of them, or null.
export function bookingSelection(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) return null;
  const clean = ids.map((id) => (typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null));
  if (clean.includes(null) || new Set(clean).size !== clean.length) return null;
  return clean;
}

// Trimmed reason, at most 500 code points. Empty or too long returns null.
export function cancelReason(text) {
  const clean = typeof text === 'string' ? text.trim() : '';
  return clean !== '' && [...clean].length <= 500 ? clean : null;
}

export function machineInput({ name, type }) {
  const errors = {};
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean === '' || [...clean].length > 120) errors.name = 'Nhập tên máy, tối đa 120 ký tự.';
  if (!MACHINE_TYPES.includes(type)) errors.type = 'Chọn loại máy: máy gặt, máy kéo hoặc drone.';
  return { errors, payload: Object.keys(errors).length ? null : { name: clean, type } };
}

// Only strict ISO instants count. Date.parse accepts loose strings such as "1", so it is not used directly.
function instant(value) {
  return typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : NaN;
}

// Operators whose accepted offer covers the whole package window. Duplicate operator rows collapse to one choice.
export function operatorCandidates(rows, window) {
  const start = instant(window?.startAt);
  const end = instant(window?.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];
  const seen = new Map();
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !UUID.test(row.id) || typeof row.name !== 'string') continue;
    const from = instant(row.startAt);
    const to = instant(row.endAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > start || to < end) continue;
    const id = row.id.toLowerCase();
    if (!seen.has(id)) seen.set(id, { id, name: row.name });
  }
  return [...seen.values()];
}

export function compatibleMachines(machines, serviceCode) {
  const type = Object.hasOwn(SERVICE_MACHINE, serviceCode) ? SERVICE_MACHINE[serviceCode] : null;
  return type ? machines.filter((machine) => machine.type === type && machine.status === 'available') : [];
}

// Coop cancels OPEN or CLAIMED packages it owns. Provider cancels only its own CLAIMED package. Claim needs OPEN.
export function packageActions(pkg, roles) {
  const coop = roles.includes('coop');
  const provider = roles.includes('provider');
  const actions = [];
  if (provider && pkg.status === 'OPEN') actions.push('claim');
  if ((coop && ['OPEN', 'CLAIMED'].includes(pkg.status)) || (provider && pkg.status === 'CLAIMED')) actions.push('cancel');
  return actions;
}

export function dispatchErrorMessage(error) {
  if (ERROR_MESSAGES[error?.code]) return ERROR_MESSAGES[error.code];
  if (error?.status === 401) return ERROR_MESSAGES.UNAUTHENTICATED;
  if (error?.uncertain) return UNCERTAIN_MESSAGE;
  return GENERIC_MESSAGE;
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

const alertNode = (text) => el('p', { class: 'alert error', role: 'alert', text });
const loading = (text) => el('p', { role: 'status', text });
const failure = (error, retry) => [alertNode(dispatchErrorMessage(error)), el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại', click: retry })];
const shortTime = (iso) => new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const windowText = ({ startAt, endAt }) => (instant(startAt) && instant(endAt)
  ? `${shortTime(startAt)} đến ${shortTime(endAt)}`
  : 'Thời gian không hợp lệ');

export async function renderDispatch({ main, api, session, announce, route, signIn }) {
  const hash = location.hash;
  if (!session.token) {
    signIn(hash);
    return;
  }
  const roles = session.user.roles;
  const coop = roles.includes('coop');
  const provider = roles.includes('provider');
  const active = () => location.hash === hash;
  const heading = el('h1', { tabindex: '-1', text: route.name === 'package' ? 'Chi tiết gói' : 'Điều phối gói dịch vụ' });
  const content = el('section', { class: 'page', 'aria-live': 'polite' });
  main.replaceChildren(heading, content);
  heading.focus();
  if (!coop && !provider) {
    content.textContent = 'Tài khoản này không có quyền điều phối gói.';
    return;
  }

  // Coop: pick delegated REQUESTED bookings and group them. Server rejects incompatible sets with an explanation.
  function bookingForm(items) {
    const form = el('form', { class: 'form', novalidate: true });
    const feedback = el('div', { 'aria-live': 'polite' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Tạo gói từ đơn đã chọn' });
    const boxes = items.map((item) => {
      const box = el('input', { type: 'checkbox', name: 'booking', value: item.id });
      form.append(el('label', { class: 'check-row' }, [box, el('span', { text: `${item.fieldName}, ${item.locality}. ${item.serviceName}, ${item.areaM2} m². ${windowText(item)}` })]));
      return box;
    });
    form.append(feedback, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const ids = bookingSelection(boxes.filter((box) => box.checked).map((box) => box.value));
      if (!ids) {
        feedback.replaceChildren(alertNode('Chọn ít nhất 1 đơn và tối đa 100 đơn, không trùng.'));
        return;
      }
      submit.disabled = true;
      feedback.replaceChildren();
      try {
        const { data } = await api.request('POST', '/api/packages', { auth: true, body: { bookingIds: ids } });
        const id = data?.package?.id;
        if (!UUID.test(id ?? '')) throw Object.assign(new Error('BAD_RESPONSE'), { code: 'BAD_RESPONSE' });
        if (active()) {
          announce('Máy chủ đã tạo gói. Đang mở chi tiết.');
          location.hash = `#package/${id.toLowerCase()}`;
        }
      } catch (error) {
        if (active()) feedback.replaceChildren(alertNode(dispatchErrorMessage(error)), el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại danh sách', click: renderList }));
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  // Provider: owned machines, plus a create form so the claim flow is not blocked by missing machines.
  function machineSection(machines) {
    const list = el('ul', { class: 'cards' }, machines.map((machine) => el('li', { class: 'card' }, [
      el('h3', { text: machine.name }),
      el('p', { text: `${MACHINE_LABELS[machine.type] ?? machine.type}. ${machine.status === 'available' ? 'Đăng ký sẵn sàng' : 'Tạm ngừng'}` }),
    ])));
    return el('section', {}, [
      el('h2', { text: 'Máy của tôi' }),
      machines.length ? list : el('p', { text: 'Chưa có máy. Thêm máy để có thể nhận gói.' }),
      el('section', { class: 'page' }, [el('h3', { text: 'Thêm máy mới' }), machineForm()]),
    ]);
  }

  function machineForm() {
    const form = el('form', { class: 'form', novalidate: true });
    const feedback = el('div', { 'aria-live': 'polite' });
    const name = el('input', { id: 'machine-name', name: 'name', type: 'text', maxlength: 120 });
    const type = el('select', { id: 'machine-type', name: 'type' }, [
      el('option', { value: '', text: 'Chọn loại máy' }),
      ...Object.entries(MACHINE_LABELS).map(([value, text]) => el('option', { value, text })),
    ]);
    const submit = el('button', { type: 'submit', class: 'btn secondary', text: 'Thêm máy' });
    form.append(
      el('div', { class: 'field' }, [el('label', { for: 'machine-name', text: 'Tên máy' }), name]),
      el('div', { class: 'field' }, [el('label', { for: 'machine-type', text: 'Loại máy' }), type]),
      feedback,
      submit,
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const { errors, payload } = machineInput({ name: name.value, type: type.value });
      if (!payload) {
        feedback.replaceChildren(alertNode(Object.values(errors).join(' ')));
        (errors.name ? name : type).focus();
        return;
      }
      submit.disabled = true;
      feedback.replaceChildren();
      try {
        await api.request('POST', '/api/machines', { auth: true, body: payload });
        if (!active()) return;
        announce('Máy chủ đã ghi nhận máy mới.');
        await renderList();
      } catch (error) {
        if (active()) feedback.replaceChildren(alertNode(dispatchErrorMessage(error)));
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function packageSection(packages) {
    const list = el('ul', { class: 'cards' }, packages.map((pkg) => el('li', { class: 'card' }, [
      el('h3', {}, [el('a', { href: `#package/${pkg.id}`, text: pkg.locality })]),
      el('p', { text: STATUS_LABELS[pkg.status] ?? pkg.status }),
      el('p', { text: `${pkg.bookingCount} đơn.` }),
      el('p', { text: `Bắt đầu: ${shortTime(pkg.window.startAt)}` }),
      el('p', { text: `Kết thúc: ${shortTime(pkg.window.endAt)}` }),
    ])));
    return el('section', {}, [el('h2', { text: 'Gói dịch vụ' }), packages.length ? list : el('p', { text: 'Chưa có gói nào để hiển thị.' })]);
  }

  async function renderList() {
    content.replaceChildren(loading('Đang tải gói…'));
    try {
      const [packages, bookings, machines] = await Promise.all([
        api.request('GET', '/api/packages?limit=100', { auth: true }),
        coop ? api.request('GET', '/api/dispatch/bookings?limit=100', { auth: true }) : null,
        provider ? api.request('GET', '/api/machines?limit=100', { auth: true }) : null,
      ]);
      if (!active()) return;
      const sections = [];
      if (coop) {
        const items = bookings.data.items;
        sections.push(el('section', {}, [
          el('h2', { text: 'Đơn ủy quyền chờ gom' }),
          items.length ? bookingForm(items) : el('p', { text: 'Chưa có đơn ủy quyền nào đang chờ gom.' }),
        ]));
      }
      if (provider) sections.push(machineSection(machines.data.items));
      sections.push(packageSection(packages.data.items));
      content.replaceChildren(...sections);
    } catch (error) {
      if (active()) content.replaceChildren(...failure(error, renderList));
    }
  }

  // Provider claim: the server checks machine type, availability, operator consent and schedule conflicts.
  function claimForm(pkg, options) {
    const machines = compatibleMachines(options.machines, options.code);
    const form = el('form', { class: 'form', novalidate: true });
    const feedback = el('div', { 'aria-live': 'polite' });
    if (!machines.length) {
      form.append(el('p', { text: 'Chưa có máy đúng loại cho dịch vụ này. Thêm máy ở trang Điều phối gói dịch vụ.' }), el('a', { href: '#dispatch', text: 'Quản lý máy' }));
      return form;
    }
    if (!options.operators.length) {
      form.append(el('p', { text: 'Chưa có người vận hành nhận đề nghị có khoảng thời gian bao trọn gói này.' }));
      return form;
    }
    const picker = (id, label, items, textOf) => {
      const select = el('select', { id, name: id }, [el('option', { value: '', text: 'Chọn' }), ...items.map((item) => el('option', { value: item.id, text: textOf(item) }))]);
      return { select, node: el('div', { class: 'field' }, [el('label', { for: id, text: label }), select]) };
    };
    const machine = picker('claim-machine', 'Máy', machines, (item) => `${item.name} (${MACHINE_LABELS[item.type]})`);
    const operator = picker('claim-operator', 'Người vận hành', options.operators, (item) => item.name);
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Nhận gói' });
    form.append(machine.node, operator.node, feedback, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      if (!machine.select.value || !operator.select.value) {
        feedback.replaceChildren(alertNode('Chọn máy và người vận hành trước khi nhận gói.'));
        return;
      }
      submit.disabled = true;
      feedback.replaceChildren();
      try {
        await api.request('POST', `/api/packages/${pkg.id}/claim`, { auth: true, body: { machineId: machine.select.value, operatorId: operator.select.value } });
        if (!active()) return;
        announce('Đã nhận gói trên máy chủ. Đang tải lại trạng thái.');
        await renderDetail();
      } catch (error) {
        if (active()) feedback.replaceChildren(alertNode(dispatchErrorMessage(error)));
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function cancelForm(pkg) {
    const form = el('form', { class: 'form', novalidate: true });
    const feedback = el('div', { 'aria-live': 'polite' });
    const reason = el('input', { id: 'cancel-reason', name: 'reason', type: 'text', maxlength: 500 });
    const submit = el('button', { type: 'submit', class: 'btn secondary', text: 'Hủy gói' });
    form.append(el('div', { class: 'field' }, [el('label', { for: 'cancel-reason', text: 'Lý do hủy' }), reason]), feedback, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const text = cancelReason(reason.value);
      if (!text) {
        feedback.replaceChildren(alertNode(ERROR_MESSAGES.INVALID_REASON));
        reason.focus();
        return;
      }
      submit.disabled = true;
      feedback.replaceChildren();
      try {
        await api.request('POST', `/api/packages/${pkg.id}/cancel`, { auth: true, body: { reason: text } });
        if (!active()) return;
        announce('Máy chủ đã ghi nhận hủy gói. Đang tải lại trạng thái.');
        await renderDetail();
      } catch (error) {
        if (active()) feedback.replaceChildren(alertNode(dispatchErrorMessage(error)));
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  // Claim options are loaded only when the provider can claim. Services map the package to a machine type.
  async function loadClaimOptions(pkg) {
    const [services, machines, operators] = await Promise.all([
      api.request('GET', '/api/services?limit=100', { auth: true }),
      api.request('GET', '/api/machines?limit=100', { auth: true }),
      api.request('GET', '/api/dispatch/operators?limit=100', { auth: true }),
    ]);
    const service = services.data.items.find((item) => item.id === pkg.serviceId);
    return {
      code: service?.code,
      machines: machines.data.items,
      operators: operatorCandidates(operators.data.items, pkg.window),
    };
  }

  async function renderDetail() {
    content.replaceChildren(loading('Đang tải gói…'));
    try {
      const { data } = await api.request('GET', `/api/packages/${route.id}`, { auth: true });
      if (!active()) return;
      const pkg = data.package;
      const actions = packageActions(pkg, roles);
      const options = actions.includes('claim') ? await loadClaimOptions(pkg) : null;
      if (!active()) return;
      const nodes = [
        el('p', {}, [el('a', { href: '#dispatch', text: 'Danh sách gói' })]),
        el('h2', { text: STATUS_LABELS[pkg.status] ?? pkg.status }),
        el('p', { text: `${pkg.locality}. ${pkg.bookingCount} đơn. ${windowText(pkg.window)}` }),
      ];
      if (pkg.status === 'CLAIMED') nodes.push(el('a', {class:'btn secondary',href:`#postponement/${pkg.id}`,text:'Đề xuất và xem dời lịch'}));
      if (pkg.status === 'CLAIMED') nodes.push(el('section', {}, [el('h2', { text:'Nghiệm thu từng đơn' }), el('ul', {}, pkg.bookingIds.map((id,index) => el('li', {}, [el('a', {href:`#settlement/${id}`,text:`Đơn ${index+1}: nghiệm thu và ghi nhận tiền`})])))]));
      if (options) nodes.push(el('section', {}, [el('h2', { text: 'Nhận gói' }), claimForm(pkg, options)]));
      if (actions.includes('cancel')) nodes.push(el('section', {}, [el('h2', { text: 'Hủy gói' }), cancelForm(pkg)]));
      content.replaceChildren(...nodes);
    } catch (error) {
      if (active()) content.replaceChildren(...failure(error, renderDetail));
    }
  }

  await (route.name === 'package' ? renderDetail() : renderList());
}
