// Man hinh Chu may (P-01 den P-10) tren API that.
// Chi goi API hien co; khong gia lap GPS, telemetry, dat coc hay chuyen tien trong he thong.
/* global FormData */
import { ApiError } from '../../api.js';
import { ui } from '../kit/ui.js';
import { apiForm, assumedBadge, errorText } from '../app/actions.js';
import { providerDepositList } from './deposits.js';

const h = ui.h;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const VND_NONNEG_RE = /^(0|[1-9][0-9]{0,14})$/;
const MAX_TEXT = 500;
const MAX_LONG_TEXT = 2000;
const MAX_AREA_M2 = 2147483647;
const PAGE_LIMIT = 100;
const MAX_OFFSET = 10000;

export const SERVICE_MACHINE_TYPE = {
  'harvest-combine': 'harvester',
  'tillage-tractor': 'tractor',
  'drone-spray': 'drone',
};

const MACHINE_TYPES = ['harvester', 'tractor', 'drone'];

const MACHINE_TYPE_LABEL = {
  harvester: 'Máy gặt đập liên hợp',
  tractor: 'Máy cày, bừa',
  drone: 'Drone phun thuốc',
};

const MACHINE_ICON = {
  harvester: 'tractor',
  tractor: 'wrench',
  drone: 'drone',
};

const MACHINE_STATUS_BADGE = {
  available: ['Sẵn sàng', 'ok'],
  unavailable: ['Tạm ngưng', 'muted'],
};

const PACKAGE_STATUS_BADGE = {
  OPEN: ['Đang mở', 'ok'],
  CLAIMED: ['Đã nhận', 'info'],
  CANCELLED: ['Đã hủy', 'muted'],
};

const JOB_STATUS_BADGE = {
  OPEN: ['Đang tuyển', 'ok'],
  CLOSED: ['Đã đóng', 'muted'],
};

const APP_STATUS_BADGE = {
  APPLIED: ['Chờ chọn', 'info'],
  OFFERED: ['Đã gửi đề nghị', 'warn'],
  ACCEPTED: ['Đã nhận việc', 'ok'],
  WITHDRAWN: ['Thợ rút đơn', 'muted'],
};

const OFFER_STATUS_BADGE = {
  OFFERED: ['Chờ thợ trả lời', 'warn'],
  ACCEPTED: ['Đã nhận đề nghị', 'ok'],
  DECLINED: ['Thợ từ chối', 'stop'],
  WITHDRAWN: ['Đã rút', 'muted'],
};

const SHIFT_EVENT_LABEL = {
  SHIFT_STARTED: 'Bắt đầu ca',
  SHIFT_PAUSED: 'Tạm dừng ca',
  SHIFT_RESUMED: 'Tiếp tục ca',
  SHIFT_COMPLETED: 'Kết thúc ca',
};

const DISPUTE_REASON_LABEL = {
  AREA_MISMATCH: 'Sai diện tích',
  QUALITY: 'Chất lượng công việc',
  NO_SHOW: 'Không đến làm',
  PAYMENT: 'Thanh toán',
  OTHER: 'Khác',
};

const DISPUTE_EVENT_LABEL = {
  DISPUTE_OPENED: 'Mở khiếu nại',
  RESPONSE_ADDED: 'Phản hồi',
  MEDIATOR_ASSIGNED: 'Chỉ định hòa giải viên',
  MEDIATION_ESCALATED: 'Chuyển cấp hòa giải',
};

const DISPUTE_STATUS_BADGE = {
  OPEN: ['Đang mở', 'warn'],
  RESOLVED: ['Đã hòa giải', 'ok'],
  CLOSED_UNRESOLVED: ['Đóng chưa giải quyết', 'stop'],
};

const PAYMENT_STATUS_BADGE = {
  REPORTED: ['Chờ bạn xác nhận', 'warn'],
  CONFIRMED: ['Đã xác nhận nhận', 'ok'],
};

const REFUSAL_MESSAGES = {
  PACKAGE_UNAVAILABLE: 'Gói việc không còn mở hoặc vừa có chủ máy khác nhận.',
  MACHINE_UNAVAILABLE: 'Máy đã chọn đang tạm ngưng hoặc không đúng loại với dịch vụ của gói.',
  OPERATOR_NOT_AUTHORIZED: 'Thợ lái chưa có đề nghị đã nhận bao trọn khung giờ của gói, hoặc không còn vai trò thợ lái.',
  SCHEDULE_CONFLICT: 'Máy hoặc thợ lái đã bị trùng lịch với gói việc khác trong khung giờ này.',
  SHIFT_ACTIVE: 'Thợ lái đã bắt đầu ca máy nên không thể hủy gói hoặc dời lịch.',
  INVALID_REASON: 'Nhập lý do từ 1 đến 500 ký tự.',
  JOB_CLOSED: 'Tin tuyển đã đóng, không thể gửi thêm đề nghị.',
  APPLICATION_WITHDRAWN: 'Ứng viên đã rút đơn ứng tuyển.',
  CAPACITY_FULL: 'Tin tuyển đã đủ số lượng thợ nhận việc.',
  DISPUTE_OPEN: 'Đơn đang có tranh chấp hoặc đã đóng chưa giải quyết nên thao tác này bị khóa.',
  PARTY_CONFLICT: 'Chủ ruộng và chủ máy cùng một tài khoản nên không thể nghiệm thu hoặc dời lịch.',
  STALE_VERSION: 'Đã có phiên bản đề xuất mới hơn. Tải lại màn hình để xem bản mới nhất.',
  MEDIATOR_CHANGED: 'Người hòa giải đã thay đổi, phương án này không còn hiệu lực.',
  DISPUTE_NOT_OPEN: 'Vụ khiếu nại đã đóng.',
  PAYMENT_EXCEEDS_AGREED: 'Số tiền vượt quá phần còn lại có thể ghi nhận.',
  ALREADY_CONFIRMED: 'Khoản này đã được xác nhận trước đó.',
  SHIFT_NOT_COMPLETED: 'Thợ lái chưa kết thúc ca máy cho gói việc này.',
  ACCEPTANCE_AGREED: 'Nghiệm thu đã được hai bên đồng ý, không thể đề nghị thay thế.',
  STATE_CHANGED: 'Trạng thái dữ liệu vừa thay đổi. Tải lại màn hình rồi thử lại.',
  NOT_FOUND: 'Không tìm thấy dữ liệu hoặc tài khoản không có quyền truy cập.',
};

export function refusalText(code) {
  return Object.hasOwn(REFUSAL_MESSAGES, code) ? REFUSAL_MESSAGES[code] : null;
}

function withMappedRefusal(error) {
  if (error instanceof ApiError) {
    const msg = refusalText(error.code);
    if (msg) return new Error(msg);
  }
  return error;
}

function formatButtonError(error) {
  if (error instanceof ApiError) {
    return refusalText(error.code) || errorText(error);
  }
  return String(error?.message || error);
}

function pButton(opts) {
  const msg = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
  let busy = false;
  const btn = ui.button({
    label: opts.label,
    icon: opts.icon,
    kind: opts.kind || 'primary',
    size: opts.size,
    block: opts.block,
    disabled: opts.disabled,
    onClick: () => (opts.confirm ? ask() : go()),
  });
  async function go() {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    msg.hidden = true;
    try {
      const result = await opts.run();
      if (opts.okText) ui.toast(opts.okText, 'ok');
      if (opts.onDone) await opts.onDone(result);
    } catch (error) {
      msg.textContent = formatButtonError(error);
      msg.hidden = false;
    } finally {
      busy = false;
      if (btn.isConnected) {
        btn.disabled = Boolean(opts.disabled);
        btn.removeAttribute('aria-busy');
      }
    }
  }
  function ask() {
    const cfg = typeof opts.confirm === 'string' ? { title: opts.confirm } : opts.confirm;
    ui.confirm({
      title: cfg.title,
      text: cfg.text,
      confirmLabel: cfg.confirmLabel || opts.label,
      tone: opts.kind === 'danger' ? 'danger' : cfg.tone,
      onConfirm: go,
    });
  }
  return h('div', { class: `action${opts.block ? ' action--block' : ''}` }, btn, opts.hint ? h('p', { class: 'small muted' }, opts.hint) : null, msg);
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '';
}

function foldVi(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function formatDateTime(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : ui.fmt.dateTime(ms);
}

function formatWindow(startIso, endIso) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return '';
  const startText = ui.fmt.dateTime(startMs);
  const endText = ui.fmt.dateTime(endMs);
  if (startText.split(' ngày ')[1] === endText.split(' ngày ')[1]) {
    return `${ui.fmt.time(startMs)} đến ${endText}`;
  }
  return `${startText} đến ${endText}`;
}

function formatAreaM2(m2) {
  const n = Number(m2);
  if (!Number.isFinite(n)) return '';
  return `${ui.fmt.num(n, 0)} m² (${ui.fmt.ha(n / 10000)})`;
}

function formatVnd(value) {
  if (value === null || value === undefined || value === '') return '0 đ';
  const s = String(value).trim();
  if (/^-?\d+$/.test(s)) {
    return `${new Intl.NumberFormat('vi-VN').format(BigInt(s))} đ`;
  }
  const n = Number(s);
  return Number.isFinite(n) ? ui.fmt.vnd(n) : s;
}

function parseLocalDatetime(value) {
  const m = LOCAL_TIME_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d, hh, mm] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, hh, mm);
  if (
    date.getFullYear() !== y
    || date.getMonth() !== mo - 1
    || date.getDate() !== d
    || date.getHours() !== hh
    || date.getMinutes() !== mm
  ) {
    return null;
  }
  return date.toISOString();
}

function parseDayStartMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}

function parseDayEndMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
}

// Loads all pages within server offset ceiling (10000); fails closed when truncated.
export async function loadAllPages(fetchPage, limit = PAGE_LIMIT) {
  const out = [];
  for (let offset = 0; offset <= MAX_OFFSET; offset += limit) {
    const page = await fetchPage(offset, limit);
    const items = Array.isArray(page?.items) ? page.items : [];
    out.push(...items);
    if (items.length < limit) return out;
    if (offset + limit > MAX_OFFSET) {
      throw new Error('Danh sách quá dài vượt giới hạn phân trang của máy chủ.');
    }
  }
  return out;
}

/* ---------- Pure domain rules (exported for unit tests) ---------- */

export function filterAndSortPackages(items, servicesById, filters = {}) {
  const list = Array.isArray(items) ? items : [];
  const qNeedle = foldVi(filters.q);
  const fromMs = filters.from ? parseDayStartMs(filters.from) : null;
  const toMs = filters.to ? parseDayEndMs(filters.to) : null;
  const serviceId = filters.serviceId && filters.serviceId !== 'all' ? filters.serviceId : null;

  const filtered = list.filter((pkg) => {
    if (!pkg) return false;
    if (serviceId && pkg.serviceId !== serviceId) return false;
    const svc = servicesById instanceof Map ? servicesById.get(pkg.serviceId) : null;
    if (qNeedle) {
      const hay = `${foldVi(pkg.locality)} ${foldVi(svc?.name || '')} ${foldVi(pkg.id)}`;
      if (!hay.includes(qNeedle)) return false;
    }
    const startMs = Date.parse(pkg.window?.startAt);
    const endMs = Date.parse(pkg.window?.endAt);
    if (fromMs !== null && !Number.isNaN(endMs) && endMs < fromMs) return false;
    if (toMs !== null && !Number.isNaN(startMs) && startMs > toMs) return false;
    return true;
  });

  const sort = filters.sort || 'newest';
  return filtered.slice().sort((a, b) => {
    if (sort === 'start-asc') return Date.parse(a.window?.startAt) - Date.parse(b.window?.startAt);
    if (sort === 'bookings-desc') return (Number(b.bookingCount) || 0) - (Number(a.bookingCount) || 0);
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

export function machineCompatibility(machine, serviceCode) {
  if (!machine) return { compatible: false, reason: 'Không tìm thấy máy.' };
  if (machine.status !== 'available') {
    return { compatible: false, reason: 'Máy đang tạm ngưng.' };
  }
  const expectedType = Object.hasOwn(SERVICE_MACHINE_TYPE, serviceCode) ? SERVICE_MACHINE_TYPE[serviceCode] : null;
  if (expectedType && machine.type !== expectedType) {
    return {
      compatible: false,
      reason: `Cần ${MACHINE_TYPE_LABEL[expectedType] || expectedType}.`,
    };
  }
  return { compatible: true, reason: null };
}

export function operatorCoversWindow(operatorRow, pkgWindow) {
  if (!operatorRow || !pkgWindow) return false;
  const opStart = Date.parse(operatorRow.startAt);
  const opEnd = Date.parse(operatorRow.endAt);
  const pkgStart = Date.parse(pkgWindow.startAt);
  const pkgEnd = Date.parse(pkgWindow.endAt);
  if ([opStart, opEnd, pkgStart, pkgEnd].some(Number.isNaN)) return false;
  return opStart <= pkgStart && opEnd >= pkgEnd;
}

export function validateMachineForm({ name, type }) {
  const errors = {};
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const nameLen = [...trimmedName].length;
  if (nameLen < 1 || nameLen > 120) {
    errors.name = 'Nhập tên máy từ 1 đến 120 ký tự.';
  }
  if (!MACHINE_TYPES.includes(type)) {
    errors.type = 'Chọn loại máy hợp lệ.';
  }
  if (Object.keys(errors).length) return { errors, payload: null };
  return { errors, payload: { name: trimmedName, type } };
}

export function validateJobForm({ title, locality, capacity, startLocal, endLocal }) {
  const errors = {};
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanLocality = typeof locality === 'string' ? locality.trim() : '';
  if ([...cleanTitle].length < 1 || [...cleanTitle].length > 120) {
    errors.title = 'Nhập tên công việc từ 1 đến 120 ký tự.';
  }
  if ([...cleanLocality].length < 1 || [...cleanLocality].length > 200) {
    errors.locality = 'Nhập địa phương từ 1 đến 200 ký tự.';
  }
  const capStr = String(capacity ?? '').trim();
  const capNum = /^[0-9]+$/.test(capStr) ? Number(capStr) : NaN;
  if (!Number.isSafeInteger(capNum) || capNum < 1 || capNum > 100) {
    errors.capacity = 'Số lượng thợ phải là số nguyên từ 1 đến 100.';
  }
  const startAt = parseLocalDatetime(startLocal);
  const endAt = parseLocalDatetime(endLocal);
  if (!startAt) errors.startLocal = 'Chọn thời gian bắt đầu hợp lệ.';
  if (!endAt) errors.endLocal = 'Chọn thời gian kết thúc hợp lệ.';
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) {
    errors.endLocal = 'Thời gian kết thúc phải sau thời gian bắt đầu.';
  }
  if (Object.keys(errors).length) return { errors, payload: null };
  return {
    errors,
    payload: {
      title: cleanTitle,
      locality: cleanLocality,
      capacity: capNum,
      startAt,
      endAt,
    },
  };
}

export function validateAcceptanceProposal({ areaM2, totalVnd, note }) {
  const errors = {};
  const areaStr = String(areaM2 ?? '').trim();
  const areaNum = /^[0-9]+$/.test(areaStr) ? Number(areaStr) : NaN;
  if (!Number.isSafeInteger(areaNum) || areaNum < 1 || areaNum > MAX_AREA_M2) {
    errors.areaM2 = 'Nhập diện tích thực tế (m²) là số nguyên dương.';
  }
  const vndStr = String(totalVnd ?? '').trim();
  if (!VND_NONNEG_RE.test(vndStr)) {
    errors.totalVnd = 'Nhập tổng tiền (đồng) là số nguyên không âm.';
  }
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  if ([...cleanNote].length > MAX_TEXT) {
    errors.note = 'Ghi chú tối đa 500 ký tự.';
  }
  if (Object.keys(errors).length) return { errors, payload: null };
  return {
    errors,
    payload: cleanNote
      ? { areaM2: areaNum, totalVnd: vndStr, note: cleanNote }
      : { areaM2: areaNum, totalVnd: vndStr },
  };
}

export function applicationStatusKey(application) {
  if (!application) return 'APPLIED';
  if (application.activeOffer?.status === 'ACCEPTED') return 'ACCEPTED';
  return application.status || 'APPLIED';
}

export function applicationCanOffer(job, application) {
  if (!job || !application) return false;
  if (job.status !== 'OPEN') return false;
  if (application.status === 'WITHDRAWN') return false;
  return !application.activeOffer;
}

export function disputeActions(actorId, dispute) {
  if (!actorId || !dispute) return { respond: false, isParty: false };
  const isParty = actorId === dispute.claimantId || actorId === dispute.respondentId;
  return {
    respond: dispute.status === 'OPEN' && actorId === dispute.respondentId,
    isParty,
  };
}

export function disputeCanConsentProposal(actorId, dispute, proposal) {
  if (!actorId || !dispute || !proposal) return false;
  if (dispute.status !== 'OPEN') return false;
  if (actorId !== dispute.claimantId && actorId !== dispute.respondentId) return false;
  if (proposal.mediatorId !== dispute.mediatorId) return false;
  const consents = Array.isArray(proposal.consents) ? proposal.consents : [];
  return !consents.some((c) => c.actorId === actorId);
}

/* ---------- Shared data loaders ---------- */

async function loadServicesMap(ctx) {
  const items = await loadAllPages(async (offset, limit) => {
    const { data } = await ctx.api.request('GET', `/api/services?limit=${limit}&offset=${offset}`);
    return data;
  });
  return new Map(items.map((s) => [s.id, s]));
}

async function loadAllPackages(ctx) {
  return loadAllPages(async (offset, limit) => {
    const { data } = await ctx.api.request('GET', `/api/packages?limit=${limit}&offset=${offset}`, { auth: true });
    return data;
  });
}

async function loadMachines(ctx) {
  return loadAllPages(async (offset, limit) => {
    const { data } = await ctx.api.request('GET', `/api/machines?limit=${limit}&offset=${offset}`, { auth: true });
    return data;
  });
}

async function loadDispatchOperators(ctx) {
  return loadAllPages(async (offset, limit) => {
    const { data } = await ctx.api.request('GET', `/api/dispatch/operators?limit=${limit}&offset=${offset}`, { auth: true });
    return data;
  });
}

async function loadMyJobs(ctx) {
  return loadAllPages(async (offset, limit) => {
    const { data } = await ctx.api.request('GET', `/api/jobs/mine?limit=${limit}&offset=${offset}`, { auth: true });
    return data;
  });
}

async function loadShifts(ctx) {
  const { data } = await ctx.api.request('GET', '/api/shifts', { auth: true });
  return Array.isArray(data?.shifts) ? data.shifts : [];
}

function servicePriceNode(svc) {
  if (!svc) return h('span', { class: 'muted' }, 'Chưa rõ dịch vụ');
  return h('div', { class: 'stack-sm' },
    h('strong', null, svc.name),
    h('div', { class: 'row' },
      h('span', { class: 'small muted' }, `${formatVnd(svc.pricePerHaVnd)}/ha`),
      svc.dataLabel === 'synthetic' ? assumedBadge('Giá mô phỏng') : null));
}

/* ---------- P-01: Bảng tin gói việc ---------- */

async function feed(ctx) {
  const [packages, servicesById] = await Promise.all([
    loadAllPackages(ctx),
    loadServicesMap(ctx),
  ]);

  const openPackages = packages.filter((p) => p.status === 'OPEN');
  const myPackages = packages.filter((p) => p.status !== 'OPEN');
  const openBookingTotal = openPackages.reduce((sum, p) => sum + (Number(p.bookingCount) || 0), 0);

  const filterState = {
    serviceId: 'all',
    q: '',
    from: '',
    to: '',
    sort: 'newest',
  };

  const serviceOptions = [['all', 'Tất cả dịch vụ'], ...Array.from(servicesById.values()).map((s) => [s.id, s.name])];
  const sortOptions = [
    ['newest', 'Mới tạo gần đây'],
    ['start-asc', 'Ngày bắt đầu sớm nhất'],
    ['bookings-desc', 'Nhiều đơn nhất'],
  ];

  const listWrap = h('div', { class: 'stack' });
  const serviceSel = ui.select({
    name: 'serviceId',
    value: filterState.serviceId,
    options: serviceOptions,
    on: { change(e) { filterState.serviceId = e.target.value; paintOpen(); } },
  });
  const searchIn = ui.input({
    name: 'q',
    value: filterState.q,
    on: { input(e) { filterState.q = e.target.value; paintOpen(); } },
  });
  searchIn.placeholder = 'Xã, huyện, tỉnh...';
  const fromIn = ui.input({
    type: 'date',
    name: 'from',
    value: filterState.from,
    on: { change(e) { filterState.from = e.target.value; paintOpen(); } },
  });
  const toIn = ui.input({
    type: 'date',
    name: 'to',
    value: filterState.to,
    on: { change(e) { filterState.to = e.target.value; paintOpen(); } },
  });
  const sortSel = ui.select({
    name: 'sort',
    value: filterState.sort,
    options: sortOptions,
    on: { change(e) { filterState.sort = e.target.value; paintOpen(); } },
  });

  function resetFilters() {
    filterState.serviceId = 'all';
    filterState.q = '';
    filterState.from = '';
    filterState.to = '';
    filterState.sort = 'newest';
    serviceSel.value = 'all';
    searchIn.value = '';
    fromIn.value = '';
    toIn.value = '';
    sortSel.value = 'newest';
    paintOpen();
  }

  function paintOpen() {
    listWrap.textContent = '';
    const filtered = filterAndSortPackages(openPackages, servicesById, filterState);
    if (!filtered.length) {
      const hasFilter = filterState.serviceId !== 'all' || filterState.q || filterState.from || filterState.to;
      listWrap.appendChild(ui.empty({
        icon: 'package',
        title: hasFilter ? 'Không có gói việc khớp bộ lọc' : 'Chưa có gói việc đang mở',
        text: hasFilter
          ? 'Thử xóa bộ lọc để xem lại toàn bộ gói việc đang mở.'
          : 'HTX chưa mở gói việc mới hoặc các gói hiện có đã được nhận.',
        action: hasFilter
          ? ui.button({ label: 'Xóa bộ lọc', icon: 'arrows-clockwise', kind: 'secondary', onClick: resetFilters })
          : ui.button({ label: 'Quản lý đội máy', icon: 'wrench', kind: 'secondary', href: ctx.url('chu-may', 'P-04') }),
      }));
      return;
    }

    listWrap.appendChild(ui.table({
      caption: 'Danh sách gói việc đang mở',
      rows: filtered,
      cols: [
        {
          label: 'Gói / Địa phương',
          render: (p) => h('div', { class: 'stack-sm' },
            h('span', { class: 'provider-strong' }, p.locality),
            h('span', { class: 'small muted mono' }, `Gói ${shortId(p.id)}`)),
        },
        {
          label: 'Dịch vụ',
          render: (p) => servicePriceNode(servicesById.get(p.serviceId)),
        },
        {
          label: 'Số đơn',
          align: 'r',
          render: (p) => h('strong', null, `${p.bookingCount} đơn`),
        },
        {
          label: 'Khung thời gian',
          render: (p) => h('span', { class: 'small' }, formatWindow(p.window?.startAt, p.window?.endAt)),
        },
        {
          label: 'Thao tác',
          render: (p) => h('div', { class: 'btn-row' },
            ui.button({ label: 'Chi tiết', kind: 'secondary', size: 'sm', href: ctx.url('chu-may', 'P-02', { id: p.id }) }),
            ui.button({ label: 'Nhận việc', kind: 'primary', size: 'sm', href: ctx.url('chu-may', 'P-03', { id: p.id }) })),
        },
      ],
    }));
  }

  paintOpen();

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Bảng tin gói việc',
    }),
    ui.summaryLine([
      ['Gói đang mở', openPackages.length],
      ['Đơn trong gói mở', openBookingTotal],
      ['Gói bạn đã nhận', myPackages.filter((p) => p.status === 'CLAIMED').length],
    ]),
    ui.card({
      title: 'Gói việc đang mở',
      subtitle: 'Giá dịch vụ hiển thị là giá mô phỏng tham khảo, không phải báo giá chính thức.',
      body: h('div', { class: 'stack' },
        h('details', null,
          h('summary', { class: 'btn btn--secondary btn--sm' }, 'Lọc và sắp xếp'),
          h('div', { class: 'provider-filter', style: 'margin-top:12px' },
            ui.field({ label: 'Dịch vụ', input: serviceSel }),
            ui.field({ label: 'Địa phương', input: searchIn }),
            ui.field({ label: 'Từ ngày', input: fromIn }),
            ui.field({ label: 'Đến ngày', input: toIn }),
            ui.field({ label: 'Sắp xếp', input: sortSel }),
            ui.button({ label: 'Đặt lại', kind: 'ghost', size: 'sm', onClick: resetFilters }))),
        listWrap),
    }),
    myPackages.length
      ? ui.card({
        title: 'Gói việc của bạn',
        subtitle: 'Các gói bạn đã nhận hoặc đã hủy.',
        body: ui.table({
          caption: 'Gói việc của chủ máy',
          rows: myPackages,
          cols: [
            {
              label: 'Gói / Địa phương',
              render: (p) => h('div', { class: 'stack-sm' },
                h('span', { class: 'provider-strong' }, p.locality),
                h('span', { class: 'small muted mono' }, `Gói ${shortId(p.id)}`)),
            },
            {
              label: 'Dịch vụ',
              render: (p) => servicePriceNode(servicesById.get(p.serviceId)),
            },
            {
              label: 'Trạng thái',
              render: (p) => ui.badge(...(PACKAGE_STATUS_BADGE[p.status] || [p.status, 'outline'])),
            },
            {
              label: 'Khung thời gian',
              render: (p) => h('span', { class: 'small' }, formatWindow(p.window?.startAt, p.window?.endAt)),
            },
            {
              label: 'Thao tác',
              render: (p) => h('div', { class: 'btn-row' },
                ui.button({ label: 'Chi tiết', kind: 'secondary', size: 'sm', href: ctx.url('chu-may', 'P-02', { id: p.id }) }),
                p.status === 'CLAIMED'
                  ? ui.button({ label: 'Ca máy', kind: 'ghost', size: 'sm', href: ctx.url('chu-may', 'P-06') })
                  : null),
            },
          ],
        }),
      })
      : null);
}

/* ---------- P-02: Chi tiết gói việc & dời lịch ---------- */

async function packageDetail(ctx) {
  let targetId = ctx.params.id;
  if (!targetId) {
    const all = await loadAllPackages(ctx);
    const first = all.find((p) => p.status === 'OPEN') || all[0];
    if (!first) {
      return ui.empty({
        icon: 'package',
        title: 'Chưa có gói việc để xem',
        text: 'Quay lại bảng tin gói việc khi HTX mở gói mới.',
        action: ui.button({ label: 'Về bảng tin gói việc', kind: 'primary', href: ctx.url('chu-may', 'P-01') }),
      });
    }
    targetId = first.id;
  }

  if (!isUuid(targetId)) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Không tìm thấy gói việc',
      text: 'Mã gói việc không hợp lệ.',
      action: ui.button({ label: 'Về bảng tin gói việc', href: ctx.url('chu-may', 'P-01') }),
    });
  }
  const pkgId = targetId.toLowerCase();

  let pkg;
  const servicesById = await loadServicesMap(ctx);
  try {
    const { data } = await ctx.api.request('GET', `/api/packages/${pkgId}`, { auth: true });
    pkg = data?.package;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return ui.empty({
        icon: 'magnifying-glass',
        title: 'Gói việc không tồn tại',
        text: 'Gói này có thể đã được chủ máy khác nhận hoặc không thuộc phạm vi tài khoản của bạn.',
        action: ui.button({ label: 'Về bảng tin gói việc', href: ctx.url('chu-may', 'P-01') }),
      });
    }
    throw error;
  }

  const svc = servicesById.get(pkg.serviceId);
  const bookingIds = Array.isArray(pkg.bookingIds) ? pkg.bookingIds : [];

  let postponement = null;
  let shiftForPkg = null;
  if (pkg.status !== 'OPEN') {
    const [postRes, shifts] = await Promise.all([
      ctx.api.request('GET', `/api/packages/${pkg.id}/postponement`, { auth: true }).catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
      loadShifts(ctx),
    ]);
    postponement = postRes?.data || null;
    shiftForPkg = shifts.find((s) => s.packageId === pkg.id) || null;
  }

  const actions = [];
  if (pkg.status === 'OPEN') {
    actions.push(ui.button({ label: 'Nhận gói việc', icon: 'check', kind: 'primary', href: ctx.url('chu-may', 'P-03', { id: pkg.id }) }));
  } else if (pkg.status === 'CLAIMED') {
    if (shiftForPkg) {
      actions.push(ui.button({ label: 'Xem ca máy', icon: 'tractor', kind: 'secondary', href: ctx.url('chu-may', 'P-06', { id: shiftForPkg.id }) }));
    }
    if (bookingIds.length) {
      actions.push(ui.button({ label: 'Nghiệm thu và tiền', icon: 'hand-coins', kind: 'primary', href: ctx.url('chu-may', 'P-07', { id: bookingIds[0] }) }));
    }
  }
  ctx.setAction(ui.actionBar({
    info: `${pkg.locality} · ${bookingIds.length} đơn`,
    actions: [
      ui.button({ label: 'Bảng tin', icon: 'arrow-left', kind: 'ghost', href: ctx.url('chu-may', 'P-01') }),
      ...actions,
    ],
  }));

  function buildPostponementSection() {
    if (!postponement) return null;
    const { permissions, latest, history } = postponement;
    const kids = [];

    if (latest) {
      kids.push(ui.card({
        title: `Đề xuất dời lịch phiên bản ${latest.version}`,
        subtitle: latest.appliedAt ? `Đã áp dụng lúc ${formatDateTime(latest.appliedAt)}` : 'Đang chờ đủ các bên đồng ý',
        actions: ui.badge(
          latest.appliedAt ? 'Đã áp dụng' : (latest.ownConsented ? 'Bạn đã đồng ý' : 'Chờ bạn đồng ý'),
          latest.appliedAt ? 'ok' : (latest.ownConsented ? 'info' : 'warn'),
        ),
        body: h('div', { class: 'stack' },
          ui.kv([
            ['Khung giờ cũ', formatWindow(latest.oldStartAt, latest.oldEndAt)],
            ['Khung giờ đề xuất', formatWindow(latest.startAt, latest.endAt)],
            ['Lý do', latest.reason],
            ['Tiến độ đồng ý', `${latest.consentedCount}/${latest.requiredCount} bên liên quan`],
            ['Trạng thái của bạn', latest.ownConsented ? 'Đã đồng ý' : 'Chưa đồng ý'],
          ]),
          permissions?.canConsent
            ? pButton({
              label: `Đồng ý dời lịch phiên bản ${latest.version}`,
              icon: 'check',
              kind: 'primary',
              size: 'lg',
              confirm: {
                title: `Đồng ý dời lịch phiên bản ${latest.version}?`,
                text: `Khi đủ ${latest.requiredCount} bên đồng ý, khung giờ gói việc sẽ chuyển sang ${formatWindow(latest.startAt, latest.endAt)}.`,
                confirmLabel: 'Đồng ý dời lịch',
              },
              run: () => ctx.api.request('POST', `/api/packages/${pkg.id}/postponement/${latest.version}/consent`, { auth: true, body: {} }),
              okText: 'Đã ghi nhận đồng ý dời lịch',
              onDone: () => ctx.rerender(),
            })
            : null),
      }));
    } else {
      kids.push(ui.note({ tone: 'info', text: 'Chưa có đề xuất dời lịch nào cho gói việc này.' }));
    }

    if (permissions?.canPropose) {
      const startIn = ui.input({ type: 'datetime-local', name: 'startLocal' });
      const endIn = ui.input({ type: 'datetime-local', name: 'endLocal' });
      const reasonIn = ui.textarea({ name: 'reason', rows: 2, maxlength: MAX_TEXT });
      kids.push(ui.card({
        title: 'Đề xuất dời lịch mới',
        subtitle: 'Tất cả chủ ruộng trong gói và chủ máy phải đồng ý cùng một phiên bản. HTX có thể đề xuất, không đồng ý thay.',
        body: apiForm({
          fields: [
            ui.field({ label: 'Bắt đầu mới', input: startIn, required: true }),
            ui.field({ label: 'Kết thúc mới', input: endIn, required: true }),
            ui.field({ label: 'Lý do dời lịch', hint: 'Từ 1 đến 500 ký tự.', input: reasonIn, required: true }),
          ],
          submitLabel: 'Gửi đề xuất dời lịch',
          submitKind: 'secondary',
          async run(fd) {
            const startAt = parseLocalDatetime(fd.get('startLocal'));
            const endAt = parseLocalDatetime(fd.get('endLocal'));
            const reason = String(fd.get('reason') || '').trim();
            if (!startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) {
              throw new Error('Chọn khung giờ bắt đầu và kết thúc mới hợp lệ.');
            }
            if ([...reason].length < 1 || [...reason].length > MAX_TEXT) {
              throw new Error('Nhập lý do từ 1 đến 500 ký tự.');
            }
            try {
              return await ctx.api.request('POST', `/api/packages/${pkg.id}/postponement`, {
                auth: true,
                body: { startAt, endAt, reason },
              });
            } catch (error) {
              throw withMappedRefusal(error);
            }
          },
          onDone() {
            ctx.toast('Đã gửi đề xuất dời lịch', 'ok');
            ctx.rerender();
          },
        }),
      }));
    }

    if (Array.isArray(history) && history.length > 1) {
      kids.push(ui.card({
        title: 'Lịch sử đề xuất dời lịch',
        body: ui.timeline(history.map((item) => ({
          done: Boolean(item.appliedAt),
          title: `Phiên bản ${item.version}: ${formatWindow(item.startAt, item.endAt)}`,
          meta: `${item.reason} · ${item.consentedCount}/${item.requiredCount} đồng ý`,
        }))),
      }));
    }

    return ui.section('Dời lịch gói việc', ...kids);
  }

  function buildCancelCard() {
    if (pkg.status !== 'CLAIMED' || shiftForPkg) return null;
    const reasonIn = ui.textarea({ name: 'reason', rows: 2, maxlength: MAX_TEXT });
    return ui.card({
      title: 'Hủy nhận gói việc',
      subtitle: 'Chỉ hủy được trước khi thợ lái bắt đầu ca máy.',
      body: apiForm({
        fields: [
          ui.field({ label: 'Lý do hủy nhận gói', hint: 'Từ 1 đến 500 ký tự.', input: reasonIn, required: true }),
        ],
        submitLabel: 'Xác nhận hủy nhận gói',
        submitKind: 'secondary',
        async run(fd) {
          const reason = String(fd.get('reason') || '').trim();
          if ([...reason].length < 1 || [...reason].length > MAX_TEXT) {
            throw new Error('Nhập lý do hủy từ 1 đến 500 ký tự.');
          }
          try {
            return await ctx.api.request('POST', `/api/packages/${pkg.id}/cancel`, {
              auth: true,
              body: { reason },
            });
          } catch (error) {
            throw withMappedRefusal(error);
          }
        },
        onDone() {
          ctx.toast('Đã hủy nhận gói việc', 'ok');
          ctx.rerender();
        },
      }),
    });
  }

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: `Gói việc ${shortId(pkg.id)}`,
      sub: pkg.locality,
      actions: [ui.badge(...(PACKAGE_STATUS_BADGE[pkg.status] || [pkg.status, 'outline']))],
    }),
    ui.summaryLine([
      ['Số đơn', `${bookingIds.length} đơn`],
      ['Dịch vụ', svc ? svc.name : shortId(pkg.serviceId)],
      ['Giá mô phỏng', svc ? `${formatVnd(svc.pricePerHaVnd)}/ha` : 'Chưa rõ'],
    ]),
    ui.card({
      title: 'Thông tin gói việc',
      body: ui.kv([
        ['Mã gói', h('span', { class: 'mono small' }, pkg.id)],
        ['Trạng thái', ui.badge(...(PACKAGE_STATUS_BADGE[pkg.status] || [pkg.status, 'outline']))],
        ['Địa phương', pkg.locality],
        ['Dịch vụ', servicePriceNode(svc)],
        ['Khung thời gian', formatWindow(pkg.window?.startAt, pkg.window?.endAt)],
        ['Tạo lúc', formatDateTime(pkg.createdAt)],
        shiftForPkg ? ['Ca máy', ui.link(`Ca ${shortId(shiftForPkg.id)} (${shiftForPkg.status})`, ctx.url('chu-may', 'P-06', { id: shiftForPkg.id }), 'caret-right')] : null,
      ]),
    }),
    bookingIds.length && pkg.accessSummary ? ui.card({
      title: 'Đường vào và đất ruộng',
      subtitle: 'Tổng hợp theo đơn từ khai báo của nông dân. Kiểm tra thực địa trước khi chọn máy và đường vận chuyển.',
      body: h('div', { class: 'stack-sm' },
        pkg.accessSummary.narrowRoad || pkg.accessSummary.lowBridgeLoad
          ? ui.note({ tone: 'warn', text: 'Hạn chế xe fooc. Hỏi HTX về tuyến khác hoặc phương án trung chuyển trước khi nhận gói.' }) : null,
        ui.kv([
          ['Đường dưới 3 m', `${pkg.accessSummary.narrowRoad} đơn`],
          ['Cầu dưới 5 tấn', `${pkg.accessSummary.lowBridgeLoad} đơn`],
          ['Đất sình lầy', `${pkg.accessSummary.boggySoil} đơn`],
          ['Có bến ghe', `${pkg.accessSummary.boatDock} đơn`],
          ['Chưa đủ thông tin', `${pkg.accessSummary.incomplete} đơn`],
        ])),
    }) : null,
    ui.card({
      title: `Các đơn trong gói (${bookingIds.length})`,
      subtitle: 'Thông tin liên hệ chủ ruộng được giữ riêng tư ở bước bảng tin; khi nhận gói bạn xem nghiệm thu và thanh toán theo từng mã đơn.',
      body: bookingIds.length
        ? ui.list(bookingIds.map((bid, idx) => h('div', { class: 'row row--between' },
          h('div', { class: 'stack-sm' },
            h('strong', null, `Đơn #${idx + 1}`),
            h('span', { class: 'small muted mono' }, bid)),
          pkg.status === 'CLAIMED'
            ? ui.button({ label: 'Nghiệm thu & Tiền', size: 'sm', kind: 'secondary', href: ctx.url('chu-may', 'P-07', { id: bid }) })
            : null)))
        : h('p', { class: 'muted' }, 'Gói chưa có đơn.'),
    }),
    pkg.status === 'CLAIMED' && bookingIds.length ? await providerDepositList(ctx, bookingIds) : null,
    buildPostponementSection(),
    buildCancelCard());
}

/* ---------- P-03: Nhận việc (chọn máy và thợ lái) ---------- */

async function claim(ctx) {
  let targetId = ctx.params.id;
  if (!targetId) {
    const all = await loadAllPackages(ctx);
    const openPkg = all.find((p) => p.status === 'OPEN');
    if (!openPkg) {
      return ui.empty({
        icon: 'package',
        title: 'Không có gói việc đang mở để nhận',
        text: 'Quay lại bảng tin gói việc khi HTX mở gói mới.',
        action: ui.button({ label: 'Về bảng tin gói việc', kind: 'primary', href: ctx.url('chu-may', 'P-01') }),
      });
    }
    targetId = openPkg.id;
  }

  if (!isUuid(targetId)) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Không tìm thấy gói việc',
      text: 'Mã gói việc không hợp lệ.',
      action: ui.button({ label: 'Về bảng tin gói việc', href: ctx.url('chu-may', 'P-01') }),
    });
  }
  const pkgId = targetId.toLowerCase();

  let pkgRes;
  try {
    pkgRes = await ctx.api.request('GET', `/api/packages/${pkgId}`, { auth: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return ui.empty({
        icon: 'magnifying-glass',
        title: 'Gói việc không tồn tại',
        action: ui.button({ label: 'Về bảng tin gói việc', href: ctx.url('chu-may', 'P-01') }),
      });
    }
    throw error;
  }

  const pkg = pkgRes.data?.package;
  const [servicesById, machines, operatorRows] = await Promise.all([
    loadServicesMap(ctx),
    loadMachines(ctx),
    loadDispatchOperators(ctx),
  ]);
  const svc = servicesById.get(pkg.serviceId);

  if (pkg.status !== 'OPEN') {
    return h('div', { class: 'stack' },
      ui.banner({
        tone: pkg.status === 'CLAIMED' ? 'success' : 'warn',
        title: pkg.status === 'CLAIMED' ? 'Gói việc đã được nhận' : 'Gói việc đã bị hủy',
        text: `${pkg.locality} · ${formatWindow(pkg.window?.startAt, pkg.window?.endAt)}`,
        action: ui.button({ label: 'Xem chi tiết gói', kind: 'primary', href: ctx.url('chu-may', 'P-02', { id: pkg.id }) }),
      }),
      ui.button({ label: 'Về bảng tin gói việc', kind: 'ghost', href: ctx.url('chu-may', 'P-01') }));
  }

  // Group operator rows by operator id (one operator may have accepted multiple jobs).
  const operatorsMap = new Map();
  for (const row of operatorRows) {
    if (!row || !row.id) continue;
    const existing = operatorsMap.get(row.id) || { id: row.id, name: row.name, windows: [] };
    existing.windows.push({ jobId: row.jobId, startAt: row.startAt, endAt: row.endAt });
    operatorsMap.set(row.id, existing);
  }
  const operators = Array.from(operatorsMap.values());

  const sortedMachines = [...machines].sort((a, b) => Number(machineCompatibility(b, svc?.code).compatible) - Number(machineCompatibility(a, svc?.code).compatible));
  const sortedOperators = [...operators].sort((a, b) => Number(b.windows.some((w) => operatorCoversWindow(w, pkg.window))) - Number(a.windows.some((w) => operatorCoversWindow(w, pkg.window))));

  const firstCompatibleMachine = sortedMachines.find((m) => machineCompatibility(m, svc?.code).compatible) || sortedMachines[0] || null;
  const firstCoveringOperator = sortedOperators.find((op) => op.windows.some((w) => operatorCoversWindow(w, pkg.window))) || sortedOperators[0] || null;

  let pickedMachineId = firstCompatibleMachine?.id || null;
  let pickedOperatorId = firstCoveringOperator?.id || null;

  const machineNodes = h('div', { class: 'stack-sm' });
  const operatorNodes = h('div', { class: 'stack-sm' });
  const summaryNode = h('div', { class: 'stack-sm' });

  function paintSelections() {
    machineNodes.textContent = '';
    if (!machines.length) {
      machineNodes.appendChild(ui.empty({
        icon: 'wrench',
        title: 'Bạn chưa khai báo máy nào',
        text: 'Thêm máy vào Đội máy trước khi nhận gói việc.',
        action: ui.button({ label: 'Tới Đội máy', kind: 'primary', href: ctx.url('chu-may', 'P-04') }),
      }));
    } else {
      for (const m of sortedMachines) {
        const compat = machineCompatibility(m, svc?.code);
        machineNodes.appendChild(ui.pick({
          control: 'radio',
          name: 'machineId',
          value: m.id,
          selected: pickedMachineId === m.id,
          icon: MACHINE_ICON[m.type] || 'wrench',
          title: m.name,
          meta: MACHINE_TYPE_LABEL[m.type] || m.type,
          reasons: [
            compat.compatible
              ? { tone: 'ok', text: 'Phù hợp dịch vụ và sẵn sàng' }
              : { tone: 'warn', text: compat.reason },
          ],
          onSelect(val) {
            pickedMachineId = val;
            paintSummary();
          },
        }));
      }
    }

    operatorNodes.textContent = '';
    if (!operators.length) {
      operatorNodes.appendChild(ui.empty({
        icon: 'users',
        title: 'Chưa có thợ lái nhận đề nghị',
        text: 'Đăng tin tuyển thợ và gửi đề nghị để thợ đồng ý trước khi gán vào gói.',
        action: ui.button({ label: 'Tới Tuyển thợ', kind: 'primary', href: ctx.url('chu-may', 'P-08') }),
      }));
    } else {
      for (const op of sortedOperators) {
        const covers = op.windows.some((w) => operatorCoversWindow(w, pkg.window));
        operatorNodes.appendChild(ui.pick({
          control: 'radio',
          name: 'operatorId',
          value: op.id,
          selected: pickedOperatorId === op.id,
          icon: 'user',
          title: op.name,
          meta: op.windows.map((w) => formatWindow(w.startAt, w.endAt)).join(' · '),
          reasons: [
            covers
              ? { tone: 'ok', text: 'Bao trọn khung giờ của gói' }
              : { tone: 'warn', text: 'Chưa bao trọn khung giờ của gói' },
          ],
          onSelect(val) {
            pickedOperatorId = val;
            paintSummary();
          },
        }));
      }
    }
  }

  function paintSummary() {
    summaryNode.textContent = '';
    const m = machines.find((x) => x.id === pickedMachineId);
    const op = operators.find((x) => x.id === pickedOperatorId);
    summaryNode.appendChild(ui.kv([
      ['Gói việc', `${pkg.locality} (${shortId(pkg.id)})`],
      ['Dịch vụ', svc ? svc.name : shortId(pkg.serviceId)],
      ['Khung giờ', formatWindow(pkg.window?.startAt, pkg.window?.endAt)],
      ['Máy đã chọn', m ? `${m.name} (${MACHINE_TYPE_LABEL[m.type] || m.type})` : 'Chưa chọn'],
      ['Thợ lái đã chọn', op ? op.name : 'Chưa chọn'],
    ]));
  }

  paintSelections();
  paintSummary();

  const claimBtn = pButton({
    label: 'Xác nhận nhận gói việc',
    icon: 'check',
    kind: 'primary',
    size: 'lg',
    block: true,
    confirm: {
      title: 'Xác nhận nhận gói việc này?',
      text: 'Máy và thợ lái được chọn sẽ giữ lịch cho khung giờ của gói việc.',
      confirmLabel: 'Nhận gói việc',
    },
    async run() {
      if (!pickedMachineId) throw new Error('Chọn một máy trước khi nhận gói việc.');
      if (!pickedOperatorId) throw new Error('Chọn một thợ lái trước khi nhận gói việc.');
      return ctx.api.request('POST', `/api/packages/${pkg.id}/claim`, {
        auth: true,
        body: { machineId: pickedMachineId, operatorId: pickedOperatorId },
      });
    },
    okText: 'Đã nhận gói việc và giữ lịch máy cùng thợ',
    onDone() {
      ctx.go(ctx.url('chu-may', 'P-02', { id: pkg.id }));
    },
  });

  ctx.setAction(ui.actionBar({
    info: `${pkg.locality} · ${pkg.bookingCount} đơn`,
    actions: [
      ui.button({ label: 'Chi tiết gói', icon: 'arrow-left', kind: 'ghost', href: ctx.url('chu-may', 'P-02', { id: pkg.id }) }),
    ],
  }));

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Nhận gói việc',
      sub: `${pkg.locality} · ${formatWindow(pkg.window?.startAt, pkg.window?.endAt)}`,
    }),
    h('div', { class: 'split provider-split' },
      h('div', { class: 'stack' },
        ui.card({
          title: '1. Chọn máy thực hiện',
          subtitle: svc ? `Dịch vụ yêu cầu ${MACHINE_TYPE_LABEL[SERVICE_MACHINE_TYPE[svc.code]] || 'máy phù hợp'}.` : null,
          body: machineNodes,
        }),
        ui.card({
          title: '2. Chọn thợ lái',
          subtitle: 'Thợ phải đồng ý đề nghị tuyển dụng có khung giờ bao trọn gói việc.',
          body: operatorNodes,
        })),
      h('aside', { class: 'provider-aside stack' },
        ui.card({
          title: 'Tóm tắt nhận gói',
          body: h('div', { class: 'stack' },
            summaryNode,
            claimBtn),
        }))));
}

/* ---------- P-04: Đội máy ---------- */

async function fleet(ctx) {
  const machines = await loadMachines(ctx);
  let selectedType = 'harvester';

  const typeField = ui.choices({
    name: 'type',
    label: 'Loại máy',
    value: selectedType,
    options: MACHINE_TYPES.map((t) => ({ value: t, label: MACHINE_TYPE_LABEL[t] })),
    onChange(val) { selectedType = val; },
  });
  const nameIn = ui.input({ name: 'name', maxlength: 120 });
  nameIn.placeholder = 'Ví dụ: Kubota DC-70 Plus #1';

  const addForm = apiForm({
    fields: [
      ui.field({ label: 'Loại máy', input: typeField, noId: true, required: true }),
      ui.field({ label: 'Tên gọi máy', hint: 'Từ 1 đến 120 ký tự.', input: nameIn, required: true }),
    ],
    submitLabel: 'Thêm máy vào đội',
    submitKind: 'primary',
    async run(fd) {
      const check = validateMachineForm({
        name: fd.get('name'),
        type: fd.get('type') || selectedType,
      });
      if (!check.payload) {
        throw new Error(Object.values(check.errors)[0]);
      }
      try {
        return await ctx.api.request('POST', '/api/machines', {
          auth: true,
          body: check.payload,
        });
      } catch (error) {
        throw withMappedRefusal(error);
      }
    },
    onDone() {
      ctx.toast('Đã thêm máy mới', 'ok');
      ctx.rerender();
    },
  });

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Đội máy',
      sub: `${machines.length} máy đã khai báo`,
    }),
    ui.summaryLine([
      ['Tổng số máy', machines.length],
      ['Đang sẵn sàng', machines.filter((m) => m.status === 'available').length],
      ['Máy gặt', machines.filter((m) => m.type === 'harvester').length],
    ]),
    h('div', { class: 'split provider-split' },
      ui.card({
        title: 'Danh sách máy',
        body: ui.table({
          caption: 'Đội máy của chủ máy',
          rows: machines,
          emptyTitle: 'Chưa có máy nào',
          emptyText: 'Khai báo máy đầu tiên ở khung bên cạnh để sẵn sàng nhận gói việc.',
          cols: [
            {
              label: 'Tên máy',
              render: (m) => h('div', { class: 'stack-sm' },
                h('span', { class: 'provider-strong' }, m.name),
                h('span', { class: 'small muted mono' }, shortId(m.id))),
            },
            {
              label: 'Loại máy',
              render: (m) => MACHINE_TYPE_LABEL[m.type] || m.type,
            },
            {
              label: 'Trạng thái',
              render: (m) => ui.badge(...(MACHINE_STATUS_BADGE[m.status] || [m.status, 'outline'])),
            },
            {
              label: 'Khai báo lúc',
              render: (m) => h('span', { class: 'small muted' }, formatDateTime(m.createdAt)),
            },
          ],
        }),
      }),
      h('aside', { class: 'provider-aside' },
        ui.card({
          title: 'Khai báo máy mới',
          subtitle: 'Máy thêm mới mặc định ở trạng thái sẵn sàng.',
          body: addForm,
        }))));
}

/* ---------- P-05: Thợ của tôi ---------- */

async function operatorsScreen(ctx) {
  const [operatorRows, jobs, wageRes, shiftRes] = await Promise.all([
    loadDispatchOperators(ctx),
    loadMyJobs(ctx),
    ctx.api.request('GET', '/api/workforce/wages?limit=100&offset=0', { auth: true }),
    ctx.api.request('GET', '/api/shifts?limit=100&offset=0', { auth: true }),
  ]);
  const jobsById = new Map(jobs.map((j) => [j.id, j]));

  const byOperator = new Map();
  for (const row of operatorRows) {
    if (!row || !row.id) continue;
    const entry = byOperator.get(row.id) || { id: row.id, name: row.name, commitments: [] };
    entry.commitments.push({
      jobId: row.jobId,
      job: jobsById.get(row.jobId) || null,
      startAt: row.startAt,
      endAt: row.endAt,
    });
    byOperator.set(row.id, entry);
  }
  const uniqueOps = Array.from(byOperator.values());
  const profiles = await Promise.all(uniqueOps.map(async (op) => {
    try { return [op.id, (await ctx.api.request('GET', `/api/workforce/operators/${op.id}`, { auth: true })).data.profile]; }
    catch { return [op.id, null]; }
  }));
  const profileById = new Map(profiles);
  const reportedShiftIds = new Set(wageRes.data.items.map((w) => w.shiftId));
  const wageForms = (shiftRes.data.shifts || []).filter((s) => s.status === 'COMPLETED' && !reportedShiftIds.has(s.id)).map((shift) => {
    const amount = ui.input({ name: `amount-${shift.id}`, type: 'number', min: 1, step: 1, inputmode: 'numeric' });
    const note = ui.input({ name: `note-${shift.id}`, maxlength: 500 });
    return ui.card({ title: `Ca ${shortId(shift.id)}`, subtitle: 'Ghi nhận thỏa thuận ngoài ứng dụng', body: apiForm({ fields: [ui.field({ label: 'Tiền công, đồng', input: amount, required: true }), ui.field({ label: 'Ghi chú', input: note })], submitLabel: 'Báo đã thanh toán ngoài ứng dụng', async run(fd) { const v=String(fd.get(`amount-${shift.id}`)).trim(); if (!/^[1-9][0-9]{0,14}$/.test(v)) throw new Error('Nhập số tiền dương hợp lệ.'); return ctx.api.request('POST', `/api/shifts/${shift.id}/wage-report`, { auth:true, body:{amountVnd:v,note:String(fd.get(`note-${shift.id}`)).trim() || undefined} }); }, onDone(){ctx.toast('Đã ghi báo cáo. Thợ lái sẽ xác nhận riêng.', 'ok');ctx.rerender();} }) });
  });
  const wageItems = wageRes.data.items.map((w) => h('div', { class:'stack-sm' }, h('strong',null,`Ca ${shortId(w.shiftId)} · ${formatVnd(w.amountVnd)}`), h('span',{class:'small muted'},w.note || 'Không có ghi chú'), w.acknowledged ? ui.badge('Thợ đã xác nhận', 'ok') : ui.badge('Chờ thợ xác nhận', 'warn')));

  return h('div', { class: 'stack' },
    ui.card({ title: 'Tiền công ngoài ứng dụng', body: h('div',{class:'stack'}, ...wageForms, wageItems.length ? ui.list(wageItems) : h('p',{class:'muted'},'Chưa có bản ghi tiền công.')) }),
    ui.screenHead({
      title: 'Thợ của tôi',
      sub: `${uniqueOps.length} thợ đã nhận đề nghị`,
      actions: [
        ui.button({ label: 'Đăng tin tuyển thợ', icon: 'megaphone', kind: 'primary', href: ctx.url('chu-may', 'P-08') }),
      ],
    }),
    ui.note({
      tone: 'info',
      text: 'Danh sách gồm những thợ đã đồng ý đề nghị nhận việc của bạn và đang giữ vai trò thợ lái.',
    }),
    uniqueOps.length
      ? ui.card({
        title: 'Thợ sẵn sàng gán ca',
        body: ui.table({
          caption: 'Danh sách thợ lái đã nhận đề nghị',
          rows: uniqueOps,
          cols: [
            {
              label: 'Thợ lái',
              render: (op) => h('div', { class: 'stack-sm' },
                h('span', { class: 'provider-strong' }, op.name),
                h('span', { class: 'small muted mono' }, shortId(op.id)),
                profileById.get(op.id) ? h('div', { class: 'small' },
                  h('span', null, `Kỹ năng tự khai: ${profileById.get(op.id).skills.join(', ') || 'Chưa khai'}`),
                  ...profileById.get(op.id).certifications.map((cert) => h('span', { class: 'muted' }, `${cert.name}, hạn ${cert.expiresAt}, ${cert.verificationStatus === 'VERIFIED' ? 'đã được quản trị viên xác minh' : cert.verificationStatus === 'REJECTED' ? 'không được xác minh' : 'chưa xác minh'}`)))
                  : h('span', { class: 'small muted' }, 'Chưa có hồ sơ tự khai.')),
            },
            {
              label: 'Số đợt nhận việc',
              align: 'r',
              render: (op) => String(op.commitments.length),
            },
            {
              label: 'Khung thời gian đã nhận',
              render: (op) => h('div', { class: 'stack-sm' }, op.commitments.map((c) => h('div', { class: 'row row--between' },
                h('span', { class: 'small' }, `${c.job ? c.job.title : `Tin ${shortId(c.jobId)}`} · ${formatWindow(c.startAt, c.endAt)}`),
                ui.link('Xem tin', ctx.url('chu-may', 'P-09', { id: c.jobId }), 'caret-right')))),
            },
          ],
        }),
      })
      : ui.empty({
        icon: 'users',
        title: 'Chưa có thợ nào nhận đề nghị',
        text: 'Đăng tin tuyển thợ, xem ứng viên và gửi đề nghị để thợ đồng ý nhận việc.',
        action: ui.button({ label: 'Tới Tuyển thợ', icon: 'megaphone', kind: 'primary', href: ctx.url('chu-may', 'P-08') }),
      }));
}

/* ---------- P-06: Ca máy ---------- */

async function shiftsScreen(ctx) {
  if (ctx.params.id && !isUuid(ctx.params.id)) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Không tìm thấy ca máy',
      text: 'Mã ca máy không hợp lệ.',
      action: ui.button({ label: 'Về danh sách ca máy', href: ctx.url('chu-may', 'P-06') }),
    });
  }

  const [shifts, packages, servicesById] = await Promise.all([
    loadShifts(ctx),
    loadAllPackages(ctx),
    loadServicesMap(ctx),
  ]);
  const pkgById = new Map(packages.map((p) => [p.id, p]));

  if (!shifts.length) {
    return h('div', { class: 'stack' },
      ui.screenHead({ title: 'Ca máy', sub: 'Chưa có ca nào' }),
      ui.empty({
        icon: 'tractor',
        title: 'Chưa có ca máy nào chạy',
        text: 'Sau khi bạn nhận gói việc và chủ ruộng xác nhận đủ 3 điều kiện sẵn sàng, thợ lái mới bắt đầu ca.',
        action: ui.button({ label: 'Xem bảng tin gói việc', kind: 'primary', href: ctx.url('chu-may', 'P-01') }),
      }));
  }

  const requestedId = ctx.params.id ? ctx.params.id.toLowerCase() : null;
  const currentSummary = (requestedId ? shifts.find((s) => s.id === requestedId) : null) || shifts[0];
  let detail = null;
  if (currentSummary) {
    const { data } = await ctx.api.request('GET', `/api/shifts/${currentSummary.id}`, { auth: true });
    detail = data?.shift || currentSummary;
  }

  const pkgForDetail = detail ? pkgById.get(detail.packageId) : null;
  const svcForDetail = pkgForDetail ? servicesById.get(pkgForDetail.serviceId) : null;
  const events = Array.isArray(detail?.events) ? detail.events : [];

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Ca máy',
      sub: `${shifts.length} ca đã ghi nhận`,
    }),
    ui.summaryLine([
      ['Đang chạy', shifts.filter((s) => s.status === 'RUNNING').length],
      ['Tạm dừng', shifts.filter((s) => s.status === 'PAUSED').length],
      ['Đã xong', shifts.filter((s) => s.status === 'COMPLETED').length],
    ]),
    ui.note({
      tone: 'info',
      text: 'Chủ máy theo dõi tiến độ và nhật ký ca tại đây. Thợ lái là người thực hiện bắt đầu, tạm dừng và kết thúc ca.',
    }),
    h('div', { class: 'split provider-split' },
      ui.card({
        title: 'Danh sách ca máy',
        body: ui.table({
          caption: 'Danh sách ca máy của chủ máy',
          rows: shifts,
          cols: [
            {
              label: 'Trạng thái',
              render: (s) => ui.shiftBadge(s.status),
            },
            {
              label: 'Gói việc',
              render: (s) => {
                const p = pkgById.get(s.packageId);
                return h('div', { class: 'stack-sm' },
                  h('span', { class: s.id === detail?.id ? 'provider-strong provider-cur' : 'provider-strong' }, p ? p.locality : `Gói ${shortId(s.packageId)}`),
                  h('span', { class: 'small muted mono' }, shortId(s.id)));
              },
            },
            {
              label: 'Bắt đầu',
              render: (s) => h('span', { class: 'small' }, formatDateTime(s.startedAt)),
            },
            {
              label: 'Diện tích báo',
              align: 'r',
              render: (s) => (s.areaM2 ? formatAreaM2(s.areaM2) : 'Chưa chốt'),
            },
            {
              label: 'Thao tác',
              render: (s) => ui.button({
                label: s.id === detail?.id ? 'Đang xem' : 'Chi tiết',
                size: 'sm',
                kind: s.id === detail?.id ? 'primary' : 'secondary',
                href: ctx.url('chu-may', 'P-06', { id: s.id }),
              }),
            },
          ],
        }),
      }),
      detail
        ? h('aside', { class: 'provider-aside stack' },
          ui.card({
            title: `Chi tiết ca ${shortId(detail.id)}`,
            actions: ui.shiftBadge(detail.status),
            body: h('div', { class: 'stack' },
              ui.kv([
                ['Gói việc', ui.link(pkgForDetail ? pkgForDetail.locality : shortId(detail.packageId), ctx.url('chu-may', 'P-02', { id: detail.packageId }), 'caret-right')],
                svcForDetail ? ['Dịch vụ', svcForDetail.name] : null,
                ['Bắt đầu lúc', formatDateTime(detail.startedAt)],
                detail.completedAt ? ['Kết thúc lúc', formatDateTime(detail.completedAt)] : null,
                detail.areaM2 ? ['Diện tích đã làm', formatAreaM2(detail.areaM2)] : null,
                detail.note ? ['Ghi chú sau ca', detail.note] : null,
              ]),
              detail.status === 'COMPLETED' && pkgForDetail?.bookingIds?.length
                ? ui.button({
                  label: 'Tới Nghiệm thu và tiền',
                  icon: 'hand-coins',
                  kind: 'primary',
                  href: ctx.url('chu-may', 'P-07', { id: pkgForDetail.bookingIds[0] }),
                })
                : null),
          }),
          ui.card({
            title: 'Nhật ký ca máy',
            body: events.length
              ? ui.timeline(events.map((ev) => {
                const bits = [];
                if (ev.reason) bits.push(`Lý do: ${ev.reason}`);
                if (ev.areaM2) bits.push(`Diện tích: ${formatAreaM2(ev.areaM2)}`);
                if (ev.note) bits.push(`Ghi chú: ${ev.note}`);
                bits.push(formatDateTime(ev.createdAt));
                return {
                  done: ev.eventType === 'SHIFT_COMPLETED',
                  now: ev.eventType !== 'SHIFT_COMPLETED',
                  title: SHIFT_EVENT_LABEL[ev.eventType] || ev.eventType,
                  meta: bits.filter(Boolean).join(' · '),
                };
              }))
              : h('p', { class: 'muted' }, 'Chưa có sự kiện nào.'),
          }))
        : null));
}

/* ---------- P-07: Nghiệm thu và Tiền ngoài hệ thống ---------- */

function acceptanceStatusLabel(accData) {
  if (!accData) return ['Chưa có dữ liệu', 'muted'];
  if (accData.permissions?.blockedByDispute) return ['Khóa tranh chấp', 'stop'];
  const acc = accData.acceptance;
  if (!acc) return ['Chưa đề nghị', 'outline'];
  if (acc.agreed) return ['Đã đồng ý hai bên', 'ok'];
  if (!acc.consents?.provider) return ['Chờ bạn đồng ý', 'warn'];
  return ['Chờ chủ ruộng đồng ý', 'info'];
}

async function fetchBookingSettlement(ctx, bookingId) {
  const [accRes, payRes] = await Promise.all([
    ctx.api.request('GET', `/api/bookings/${bookingId}/acceptance`, { auth: true }),
    ctx.api.request('GET', `/api/bookings/${bookingId}/payments`, { auth: true }),
  ]);
  return {
    bookingId,
    acceptanceData: accRes.data,
    paymentsData: payRes.data,
  };
}

async function money(ctx) {
  if (ctx.params.id && !isUuid(ctx.params.id)) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Không tìm thấy đơn thanh toán',
      text: 'Mã đơn không hợp lệ.',
      action: ui.button({ label: 'Về danh sách Tiền', href: ctx.url('chu-may', 'P-07') }),
    });
  }

  const allPackages = await loadAllPackages(ctx);
  const ownedPackages = allPackages.filter((p) => p.status !== 'OPEN');
  const pkgDetails = await Promise.all(
    ownedPackages.map((p) => ctx.api.request('GET', `/api/packages/${p.id}`, { auth: true })
      .then((res) => res.data?.package)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      })),
  );

  const bookingMeta = new Map();
  for (const pkg of pkgDetails) {
    if (!pkg || !Array.isArray(pkg.bookingIds)) continue;
    for (const bid of pkg.bookingIds) {
      if (!bookingMeta.has(bid)) {
        bookingMeta.set(bid, pkg);
      }
    }
  }

  const requestedId = ctx.params.id ? ctx.params.id.toLowerCase() : null;
  if (requestedId && !bookingMeta.has(requestedId)) {
    bookingMeta.set(requestedId, null);
  }

  const bookingIds = Array.from(bookingMeta.keys());
  if (!bookingIds.length) {
    return h('div', { class: 'stack' },
      ui.screenHead({ title: 'Nghiệm thu và tiền', sub: 'Chưa có đơn được giao' }),
      ui.note({
        tone: 'info',
        text: 'Nền tảng chỉ ghi nhận chuyển tiền ngoài hệ thống; không giữ, không thu hộ và không chuyển tiền.',
      }),
      ui.empty({
        icon: 'hand-coins',
        title: 'Chưa có đơn nào để nghiệm thu hoặc ghi nhận tiền',
        text: 'Nhận gói việc ở Bảng tin gói việc để theo dõi các đơn trong gói.',
        action: ui.button({ label: 'Tới Bảng tin gói việc', kind: 'primary', href: ctx.url('chu-may', 'P-01') }),
      }));
  }

  const settlements = [];
  for (const bid of bookingIds) {
    try {
      const s = await fetchBookingSettlement(ctx, bid);
      settlements.push(s);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        if (bid === requestedId) {
          return ui.empty({
            icon: 'magnifying-glass',
            title: 'Không tìm thấy đơn hoặc không thuộc gói bạn nhận',
            action: ui.button({ label: 'Về danh sách Tiền', href: ctx.url('chu-may', 'P-07') }),
          });
        }
      } else {
        throw err;
      }
    }
  }

  if (!settlements.length) {
    return ui.empty({
      icon: 'hand-coins',
      title: 'Chưa có đơn nào thuộc phạm vi theo dõi',
      action: ui.button({ label: 'Về bảng tin gói việc', href: ctx.url('chu-may', 'P-01') }),
    });
  }

  const selected = (requestedId ? settlements.find((s) => s.bookingId === requestedId) : null) || settlements[0];

  let totalConfirmed = 0n;
  let totalReportedCount = 0;
  let waitingAcceptanceCount = 0;
  for (const s of settlements) {
    const sum = s.paymentsData?.summary;
    if (sum?.confirmedVnd && /^\d+$/.test(String(sum.confirmedVnd))) {
      totalConfirmed += BigInt(sum.confirmedVnd);
    }
    const pays = Array.isArray(s.paymentsData?.payments) ? s.paymentsData.payments : [];
    totalReportedCount += pays.filter((p) => p.status === 'REPORTED').length;
    if (s.acceptanceData?.acceptance && !s.acceptanceData.acceptance.agreed) {
      waitingAcceptanceCount += 1;
    }
  }

  const accData = selected.acceptanceData;
  const acc = accData?.acceptance || null;
  const perms = accData?.permissions || {};
  const payData = selected.paymentsData || { payments: [], summary: null };
  const payments = Array.isArray(payData.payments) ? payData.payments : [];
  const paySummary = payData.summary;
  const pkgInfo = bookingMeta.get(selected.bookingId);

  const areaIn = ui.input({
    type: 'number',
    name: 'areaM2',
    inputmode: 'numeric',
    min: 1,
    max: MAX_AREA_M2,
    step: 1,
    value: acc?.areaM2 ? String(acc.areaM2) : '',
  });
  const totalVndIn = ui.input({
    type: 'number',
    name: 'totalVnd',
    inputmode: 'numeric',
    min: 0,
    step: 1,
    value: acc?.totalVnd ? String(acc.totalVnd) : '',
  });
  const accNoteIn = ui.textarea({
    name: 'note',
    rows: 2,
    maxlength: MAX_TEXT,
    value: acc?.note || '',
  });

  const proposeForm = perms.canPropose
    ? apiForm({
      fields: [
        ui.note({ tone: 'info', text: 'Gửi đề nghị mới sẽ tạo phiên bản nghiệm thu mới; hai bên cần tự bấm đồng ý.' }),
        ui.field({ label: 'Diện tích thực tế (m²)', hint: 'Số nguyên dương, ví dụ 15000 cho 1,5 ha.', input: areaIn, required: true }),
        ui.field({ label: 'Tổng tiền thỏa thuận (đồng)', hint: 'Số nguyên không âm bằng VNĐ.', input: totalVndIn, required: true }),
        ui.field({ label: 'Ghi chú nghiệm thu', hint: 'Không bắt buộc, tối đa 500 ký tự.', input: accNoteIn }),
      ],
      submitLabel: acc ? 'Gửi đề nghị thay thế' : 'Gửi đề nghị nghiệm thu',
      submitKind: 'secondary',
      async run(fd) {
        const check = validateAcceptanceProposal({
          areaM2: fd.get('areaM2'),
          totalVnd: fd.get('totalVnd'),
          note: fd.get('note'),
        });
        if (!check.payload) throw new Error(Object.values(check.errors)[0]);
        try {
          return await ctx.api.request('POST', `/api/bookings/${selected.bookingId}/acceptance`, {
            auth: true,
            body: check.payload,
          });
        } catch (error) {
          throw withMappedRefusal(error);
        }
      },
      onDone() {
        ctx.toast('Đã gửi đề nghị nghiệm thu', 'ok');
        ctx.rerender();
      },
    })
    : null;

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Nghiệm thu và tiền',
      sub: `${settlements.length} đơn trong các gói đã nhận`,
      actions: [
        ui.button({ label: 'Phản hồi khiếu nại', icon: 'scales', kind: 'secondary', href: ctx.url('chu-may', 'P-10') }),
      ],
    }),
    ui.banner({
      tone: 'info',
      title: 'Chỉ ghi nhận chuyển tiền ngoài hệ thống',
      text: 'Nền tảng không giữ tiền, không thu hộ và không chuyển khoản. Chỉ bấm xác nhận khi bạn đã thực sự nhận đủ tiền ngoài hệ thống.',
    }),
    ui.summaryLine([
      ['Tổng đơn', settlements.length],
      ['Chờ nghiệm thu', waitingAcceptanceCount],
      ['Thanh toán thêm chờ xác nhận', totalReportedCount],
      ['Thanh toán thêm đã xác nhận', formatVnd(totalConfirmed.toString())],
    ]),
    h('div', { class: 'split provider-split' },
      ui.card({
        title: 'Danh sách đơn',
        body: ui.table({
          caption: 'Các đơn trong gói đã nhận',
          rows: settlements,
          cols: [
            {
              label: 'Đơn / Gói',
              render: (s) => {
                const p = bookingMeta.get(s.bookingId);
                return h('div', { class: 'stack-sm' },
                  h('span', { class: s.bookingId === selected.bookingId ? 'provider-strong provider-cur mono' : 'provider-strong mono' }, shortId(s.bookingId)),
                  h('span', { class: 'small muted' }, p ? p.locality : 'Đơn liên quan'));
              },
            },
            {
              label: 'Nghiệm thu',
              render: (s) => ui.badge(...acceptanceStatusLabel(s.acceptanceData)),
            },
            {
              label: 'Thanh toán thêm',
              align: 'r',
              render: (s) => {
                const rep = (s.paymentsData?.payments || []).filter((p) => p.status === 'REPORTED').length;
                return h('div', { class: 'stack-sm' },
                  h('span', null, formatVnd(s.paymentsData?.summary?.confirmedVnd || '0')),
                  rep > 0 ? ui.badge(`${rep} chờ`, 'warn') : null);
              },
            },
            {
              label: 'Thao tác',
              render: (s) => ui.button({
                label: s.bookingId === selected.bookingId ? 'Đang xem' : 'Mở',
                size: 'sm',
                kind: s.bookingId === selected.bookingId ? 'primary' : 'secondary',
                href: ctx.url('chu-may', 'P-07', { id: s.bookingId }),
              }),
            },
          ],
        }),
      }),
      h('aside', { class: 'provider-aside stack' },
        perms.blockedByDispute
          ? ui.banner({
            tone: 'warn',
            title: 'Đơn đang bị khóa bởi tranh chấp',
            text: 'Không thể gửi hoặc đồng ý nghiệm thu hay xác nhận chuyển tiền khi tranh chấp đang mở hoặc đóng chưa giải quyết.',
            action: ui.button({ label: 'Xem khiếu nại', kind: 'secondary', href: ctx.url('chu-may', 'P-10') }),
          })
          : null,
        ui.card({
          title: `Nghiệm thu đơn ${shortId(selected.bookingId)}`,
          subtitle: pkgInfo ? `${pkgInfo.locality} · Gói ${shortId(pkgInfo.id)}` : null,
          actions: ui.badge(...acceptanceStatusLabel(accData)),
          body: h('div', { class: 'stack' },
            acc
              ? ui.kv([
                ['Phiên bản', `v${acc.version}`],
                ['Diện tích nghiệm thu', formatAreaM2(acc.areaM2)],
                ['Tổng tiền đề nghị', formatVnd(acc.totalVnd)],
                acc.note ? ['Ghi chú', acc.note] : null,
                ['Đề nghị lúc', formatDateTime(acc.proposedAt)],
                ['Chủ ruộng đồng ý', acc.consents?.owner ? 'Đã đồng ý' : 'Chưa đồng ý'],
                ['Chủ máy đồng ý', acc.consents?.provider ? 'Đã đồng ý' : 'Chưa đồng ý'],
              ])
              : h('p', { class: 'muted' }, perms.canPropose
                ? 'Chưa có đề nghị nghiệm thu. Bạn có thể gửi đề nghị bên dưới.'
                : 'Chưa có đề nghị nghiệm thu. Cần thợ lái kết thúc ca máy trước khi gửi đề nghị.'),
            acc && !acc.consents?.provider && !perms.blockedByDispute && perms.party === 'provider'
              ? pButton({
                label: `Đồng ý nghiệm thu v${acc.version}`,
                icon: 'check',
                kind: 'primary',
                size: 'lg',
                block: true,
                confirm: {
                  title: `Đồng ý nghiệm thu phiên bản ${acc.version}?`,
                  text: `Diện tích ${formatAreaM2(acc.areaM2)} với tổng tiền ${formatVnd(acc.totalVnd)}.`,
                  confirmLabel: 'Đồng ý nghiệm thu',
                },
                run: () => ctx.api.request('POST', `/api/bookings/${selected.bookingId}/acceptance/${acc.version}/consent`, { auth: true, body: {} }),
                okText: 'Đã đồng ý nghiệm thu',
                onDone: () => ctx.rerender(),
              })
              : null,
            proposeForm),
        }),
        ui.card({
          title: 'Ghi nhận chuyển tiền ngoài hệ thống',
          subtitle: 'Chủ máy chỉ xác nhận sau khi đối chiếu khoản chuyển ngoài ứng dụng.',
          body: h('div', { class: 'stack' },
            BigInt(paySummary?.excessConfirmedVnd ?? '0') > 0n
              ? ui.note({ tone: 'warn', text: `Đã ghi nhận dư ${formatVnd(paySummary.excessConfirmedVnd)}. Hai bên đối chiếu ngoài hệ thống; ứng dụng không tự hoàn tiền.` }) : null,
            paySummary
              ? ui.kv([
                ['Đã thỏa thuận', formatVnd(paySummary.agreedVnd)],
                ['Cọc đã xác nhận', formatVnd(paySummary.confirmedDepositVnd ?? '0')],
                ['Cọc chờ xác nhận', formatVnd(paySummary.reportedDepositVnd ?? '0')],
                ['Thanh toán thêm đã xác nhận', formatVnd(paySummary.confirmedVnd)],
                ['Thanh toán thêm chờ xác nhận', formatVnd(paySummary.reportedVnd)],
                ['Còn lại chưa xác nhận', formatVnd(paySummary.outstandingVnd)],
              ])
              : h('p', { class: 'small muted' }, 'Sau khi hai bên đồng ý nghiệm thu, chủ ruộng có thể báo các khoản đã chuyển ngoài hệ thống tại đây.'),
            payments.length
              ? ui.list(payments.map((p) => h('div', { class: 'stack-sm' },
                h('div', { class: 'row row--between' },
                  h('strong', null, formatVnd(p.amountVnd)),
                  ui.badge(...(PAYMENT_STATUS_BADGE[p.status] || [p.status, 'outline']))),
                h('div', { class: 'small muted' }, `Khai báo lúc ${formatDateTime(p.createdAt)}${p.confirmedAt ? ` · Xác nhận lúc ${formatDateTime(p.confirmedAt)}` : ''}`),
                p.status === 'REPORTED' && !perms.blockedByDispute && perms.party === 'provider'
                  ? pButton({
                    label: 'Xác nhận đã nhận ngoài hệ thống',
                    icon: 'check',
                    kind: 'primary',
                    confirm: {
                      title: 'Xác nhận đã nhận khoản tiền này?',
                      text: `Chỉ xác nhận khi bạn đã thực sự nhận ${formatVnd(p.amountVnd)} bên ngoài hệ thống.`,
                      confirmLabel: 'Đã nhận đủ',
                    },
                    run: () => ctx.api.request('POST', `/api/payments/${p.id}/confirm`, { auth: true, body: {} }),
                    okText: 'Đã xác nhận nhận tiền',
                    onDone: () => ctx.rerender(),
                  })
                  : null)))
              : h('p', { class: 'muted' }, 'Chưa có khoản chuyển tiền nào được khai báo.')),
        }))));
}

/* ---------- P-08: Tuyển thợ ---------- */

async function recruit(ctx) {
  const jobs = await loadMyJobs(ctx);

  const titleIn = ui.input({ name: 'title', maxlength: 120 });
  titleIn.placeholder = 'Ví dụ: Tuyển 2 thợ lái máy gặt vụ Đông Xuân';
  const localityIn = ui.input({ name: 'locality', maxlength: 200 });
  localityIn.placeholder = 'Ví dụ: Thoại Sơn, An Giang';
  const capIn = ui.input({ type: 'number', name: 'capacity', inputmode: 'numeric', min: 1, max: 100, step: 1, value: '1' });
  const startIn = ui.input({ type: 'datetime-local', name: 'startLocal' });
  const endIn = ui.input({ type: 'datetime-local', name: 'endLocal' });
  const wageTypeIn = ui.select({ name: 'wageType', options: [['', 'Chưa nêu'], ['PER_HA', 'Theo ha'], ['PER_SHIFT', 'Theo ca'], ['NEGOTIABLE', 'Thỏa thuận']] });
  const wageAmountIn = ui.input({ type: 'number', name: 'wageAmountVnd', min: 1, step: 1, inputmode: 'numeric' });
  const machineTypeIn = ui.select({ name: 'machineType', options: [['', 'Không nêu'], ['harvester', 'Máy gặt'], ['tractor', 'Máy kéo'], ['drone', 'Drone']] });
  const skillsIn = ui.input({ name: 'requiredSkills', maxlength: 1000, placeholder: 'Ví dụ: vận hành máy gặt, bảo dưỡng' });

  const createForm = apiForm({
    fields: [
      ui.note({ tone: 'info', text: 'Ứng tuyển chưa giữ chỗ. Chỉ khi bạn gửi đề nghị và thợ bấm nhận, một chỗ mới được tính.' }),
      ui.field({ label: 'Tiêu đề tin tuyển', input: titleIn, required: true }),
      ui.field({ label: 'Địa bàn làm việc', input: localityIn, required: true }),
      ui.field({ label: 'Số lượng thợ cần tuyển', input: capIn, required: true }),
      ui.field({ label: 'Bắt đầu dự kiến', input: startIn, required: true }),
      ui.field({ label: 'Kết thúc dự kiến', input: endIn, required: true }),
      ui.field({ label: 'Hình thức tiền công', input: wageTypeIn }),
      ui.field({ label: 'Mức tiền công dự kiến, đồng', hint: 'Để trống nếu chưa thống nhất.', input: wageAmountIn }),
      ui.field({ label: 'Loại máy cần vận hành', input: machineTypeIn }),
      ui.field({ label: 'Kỹ năng cần có', hint: 'Phân cách bằng dấu phẩy.', input: skillsIn }),
      ui.note({ tone: 'info', text: 'Yêu cầu tuyển do chủ máy tự khai, không phải xác nhận chứng chỉ.' }),
    ],
    submitLabel: 'Đăng tin tuyển thợ',
    submitKind: 'primary',
    async run(fd) {
      const check = validateJobForm({
        title: fd.get('title'),
        locality: fd.get('locality'),
        capacity: fd.get('capacity'),
        startLocal: fd.get('startLocal'),
        endLocal: fd.get('endLocal'),
      });
      if (!check.payload) throw new Error(Object.values(check.errors)[0]);
      const wageType = String(fd.get('wageType') || '') || null;
      const wageAmountRaw = String(fd.get('wageAmountVnd') || '').trim();
      const wageAmountVnd = wageAmountRaw ? Number(wageAmountRaw) : null;
      if (wageAmountRaw && (!Number.isSafeInteger(wageAmountVnd) || wageAmountVnd < 1)) throw new Error('Tiền công phải là số nguyên dương.');
      if (wageAmountVnd && !['PER_HA', 'PER_SHIFT'].includes(wageType)) throw new Error('Chọn hình thức tiền công theo ha hoặc theo ca.');
      const machineType = String(fd.get('machineType') || '') || null;
      const requiredSkills = String(fd.get('requiredSkills') || '').split(',').map((s) => s.trim()).filter(Boolean);
      try {
        return await ctx.api.request('POST', '/api/jobs', { auth: true, body: { ...check.payload, wageType, wageAmountVnd, machineType, requiredSkills } });

      } catch (error) {
        throw withMappedRefusal(error);
      }
    },
    onDone() {
      ctx.toast('Đã đăng tin tuyển thợ', 'ok');
      ctx.rerender();
    },
  });

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Tuyển thợ',
      sub: `${jobs.length} tin đã đăng`,
      actions: [
        ui.button({ label: 'Thợ của tôi', icon: 'users', kind: 'secondary', href: ctx.url('chu-may', 'P-05') }),
      ],
    }),
    ui.summaryLine([
      ['Đang tuyển', jobs.filter((j) => j.status === 'OPEN').length],
      ['Tổng ứng viên', jobs.reduce((s, j) => s + (Number(j.applicationCount) || 0), 0)],
      ['Đã nhận việc', jobs.reduce((s, j) => s + (Number(j.acceptedCount) || 0), 0)],
    ]),
    h('div', { class: 'split provider-split' },
      ui.card({
        title: 'Tin tuyển của bạn',
        body: jobs.length
          ? ui.list(jobs.map((j) => h('div', { class: 'stack-sm' },
            h('div', { class: 'row row--between' },
              h('strong', null, j.title),
              ui.badge(...(JOB_STATUS_BADGE[j.status] || [j.status, 'outline']))),
            h('div', { class: 'small muted' }, `${j.locality} · ${formatWindow(j.startAt, j.endAt)}`),
            h('div', { class: 'small muted' }, `${j.wageType ? ({ PER_HA: 'Theo ha', PER_SHIFT: 'Theo ca', NEGOTIABLE: 'Thỏa thuận' }[j.wageType] || '') : 'Chưa nêu tiền công'}${j.wageAmountVnd ? ` · ${formatVnd(j.wageAmountVnd)}` : ''}${j.machineType ? ` · ${MACHINE_TYPE_LABEL[j.machineType] || j.machineType}` : ''}`),
            (j.requiredSkills || []).length ? h('div', { class: 'small muted' }, `Kỹ năng: ${j.requiredSkills.join(', ')}`) : null,
            h('div', { class: 'small' }, `Đã nhận: ${j.acceptedCount}/${j.capacity} · Ứng viên: ${j.applicationCount}`),
            h('div', { class: 'btn-row' },
              ui.button({ label: `Xem ứng viên (${j.applicationCount})`, size: 'sm', kind: 'primary', href: ctx.url('chu-may', 'P-09', { id: j.id }) }),
              j.status === 'OPEN'
                ? pButton({
                  label: 'Đóng tin',
                  size: 'sm',
                  kind: 'secondary',
                  confirm: {
                    title: 'Đóng tin tuyển này?',
                    text: 'Sau khi đóng tin, thợ sẽ không nộp thêm ứng tuyển và các đề nghị đang chờ không thể bấm nhận.',
                    confirmLabel: 'Đóng tin',
                  },
                  run: () => ctx.api.request('POST', `/api/jobs/${j.id}/close`, { auth: true, body: {} }),
                  okText: 'Đã đóng tin tuyển',
                  onDone: () => ctx.rerender(),
                })
                : null))))
          : ui.empty({
            icon: 'megaphone',
            title: 'Chưa có tin tuyển thợ nào',
            text: 'Đăng tin đầu tiên ở khung bên cạnh để tìm thợ lái phù hợp khung giờ gói việc.',
          }),
      }),
      h('aside', { class: 'provider-aside' },
        ui.card({
          title: 'Đăng tin tuyển mới',
          body: createForm,
        }))));
}

/* ---------- P-09: Ứng viên và đề nghị ---------- */

async function applicantsScreen(ctx) {
  if (ctx.params.id && !isUuid(ctx.params.id)) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Không tìm thấy tin tuyển',
      text: 'Mã tin tuyển không hợp lệ.',
      action: ui.button({ label: 'Về Tuyển thợ', href: ctx.url('chu-may', 'P-08') }),
    });
  }

  const [jobs, operatorRows] = await Promise.all([
    loadMyJobs(ctx),
    loadDispatchOperators(ctx),
  ]);
  const opNameById = new Map(operatorRows.map((o) => [o.id, o.name]));

  if (!jobs.length) {
    return ui.empty({
      icon: 'megaphone',
      title: 'Bạn chưa đăng tin tuyển thợ nào',
      text: 'Đăng tin tuyển thợ trước để xem danh sách ứng viên và gửi đề nghị.',
      action: ui.button({ label: 'Tới Tuyển thợ', kind: 'primary', href: ctx.url('chu-may', 'P-08') }),
    });
  }

  const requestedId = ctx.params.id ? ctx.params.id.toLowerCase() : null;
  const selectedJob = (requestedId ? jobs.find((j) => j.id === requestedId) : null)
    || jobs.find((j) => j.applicationCount > 0)
    || jobs[0];

  let applications;
  try {
    applications = await loadAllPages(async (offset, limit) => {
      const { data } = await ctx.api.request('GET', `/api/jobs/${selectedJob.id}/applications?limit=${limit}&offset=${offset}`, { auth: true });
      return data;
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return ui.empty({
        icon: 'magnifying-glass',
        title: 'Tin tuyển không tồn tại hoặc không thuộc tài khoản này',
        action: ui.button({ label: 'Về Tuyển thợ', href: ctx.url('chu-may', 'P-08') }),
      });
    }
    throw err;
  }

  const jobSwitcher = jobs.length > 1
    ? ui.select({
      name: 'jobId',
      value: selectedJob.id,
      options: jobs.map((j) => [j.id, `${j.title} (${j.applicationCount} ứng viên)`]),
      on: { change(e) { ctx.go(ctx.url('chu-may', 'P-09', { id: e.target.value })); } },
    })
    : null;

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Ứng viên và đề nghị',
      sub: selectedJob.title,
      actions: [
        ui.button({ label: 'Về Tuyển thợ', icon: 'arrow-left', kind: 'ghost', href: ctx.url('chu-may', 'P-08') }),
        selectedJob.status === 'OPEN'
          ? pButton({
            label: 'Đóng tin',
            kind: 'secondary',
            confirm: {
              title: 'Đóng tin tuyển này?',
              text: 'Thợ chưa đồng ý đề nghị sẽ không thể nhận việc trên tin này nữa.',
              confirmLabel: 'Đóng tin',
            },
            run: () => ctx.api.request('POST', `/api/jobs/${selectedJob.id}/close`, { auth: true, body: {} }),
            okText: 'Đã đóng tin tuyển',
            onDone: () => ctx.rerender(),
          })
          : null,
      ].filter(Boolean),
    }),
    jobSwitcher ? ui.field({ label: 'Chọn tin tuyển', input: jobSwitcher }) : null,
    ui.summaryLine([
      ['Trạng thái tin', selectedJob.status === 'OPEN' ? 'Đang tuyển' : 'Đã đóng'],
      ['Đã nhận việc', `${selectedJob.acceptedCount}/${selectedJob.capacity}`],
      ['Tổng ứng viên', applications.length],
    ]),
    ui.card({
      title: selectedJob.title,
      subtitle: `${selectedJob.locality} · ${formatWindow(selectedJob.startAt, selectedJob.endAt)}`,
      actions: ui.badge(...(JOB_STATUS_BADGE[selectedJob.status] || [selectedJob.status, 'outline'])),
      body: applications.length
        ? ui.list(applications.map((app) => {
          const statusKey = applicationStatusKey(app);
          const badgeSpec = APP_STATUS_BADGE[statusKey] || [statusKey, 'outline'];
          const offerBadge = app.activeOffer ? (OFFER_STATUS_BADGE[app.activeOffer.status] || [app.activeOffer.status, 'outline']) : null;
          const opName = opNameById.get(app.operatorId);
          const canOffer = applicationCanOffer(selectedJob, app);

          return h('div', { class: 'stack-sm' },
            h('div', { class: 'row row--between' },
              h('div', { class: 'stack-sm' },
                h('strong', null, opName || `Ứng viên ${shortId(app.operatorId)}`),
                h('span', { class: 'small muted mono' }, app.operatorId)),
              h('div', { class: 'row' },
                ui.badge(...badgeSpec),
                offerBadge && statusKey !== 'ACCEPTED' ? ui.badge(...offerBadge) : null)),
            app.note ? h('p', { class: 'small' }, `Lời nhắn: ${app.note}`) : h('p', { class: 'small muted' }, 'Không có lời nhắn kèm theo.'),
            h('div', { class: 'small muted' }, `Ứng tuyển lúc ${formatDateTime(app.createdAt)}`),
            canOffer
              ? pButton({
                label: 'Gửi đề nghị nhận việc',
                icon: 'paper-plane-tilt',
                kind: 'primary',
                confirm: {
                  title: 'Gửi đề nghị cho ứng viên này?',
                  text: 'Lịch của thợ chỉ khóa khi thợ tự bấm chấp nhận đề nghị và tin tuyển còn chỗ.',
                  confirmLabel: 'Gửi đề nghị',
                },
                run: () => ctx.api.request('POST', `/api/applications/${app.id}/offers`, { auth: true, body: {} }),
                okText: 'Đã gửi đề nghị nhận việc',
                onDone: () => ctx.rerender(),
              })
              : null,
            statusKey === 'ACCEPTED'
              ? ui.link('Thợ đã sẵn sàng, xem trong Thợ của tôi', ctx.url('chu-may', 'P-05'), 'caret-right')
              : null);
        }))
        : ui.empty({
          icon: 'users',
          title: 'Chưa có ứng viên nào cho tin này',
          text: 'Khi thợ lái bấm ứng tuyển ở màn Tìm việc, hồ sơ sẽ hiện ở đây.',
        }),
    }));
}

/* ---------- P-10: Phản hồi khiếu nại ---------- */

async function loadEvidenceImageUrl(ctx, evidenceId, kind) {
  const { blob } = await ctx.api.binary(`/api/evidence/${evidenceId}/${kind}`);
  const objectUrl = URL.createObjectURL(blob);
  ui._cleanups.push(() => URL.revokeObjectURL(objectUrl));
  return objectUrl;
}

async function disputeScreen(ctx) {
  if (ctx.params.id && !isUuid(ctx.params.id)) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Không tìm thấy vụ khiếu nại',
      text: 'Mã khiếu nại không hợp lệ.',
      action: ui.button({ label: 'Về danh sách khiếu nại', href: ctx.url('chu-may', 'P-10') }),
    });
  }

  const disputes = await loadAllPages(async (offset, limit) => {
    const { data } = await ctx.api.request('GET', `/api/disputes?limit=${limit}&offset=${offset}`, { auth: true });
    return data;
  });

  if (!disputes.length) {
    return h('div', { class: 'stack' },
      ui.screenHead({ title: 'Phản hồi khiếu nại', sub: 'Chưa có vụ khiếu nại nào' }),
      ui.empty({
        icon: 'scales',
        title: 'Chưa có khiếu nại nào',
        text: 'Khi có khiếu nại liên quan đến đơn bạn nhận, hồ sơ sẽ hiện ở đây để phản hồi và xem phương án hòa giải.',
      }));
  }

  const requestedId = ctx.params.id ? ctx.params.id.toLowerCase() : null;
  const targetId = requestedId || disputes[0].id;

  let detailRes;
  let proposalsRes;
  let evidenceRes;
  try {
    [detailRes, proposalsRes, evidenceRes] = await Promise.all([
      ctx.api.request('GET', `/api/disputes/${targetId}`, { auth: true }),
      ctx.api.request('GET', `/api/disputes/${targetId}/proposals`, { auth: true }),
      ctx.api.request('GET', `/api/disputes/${targetId}/evidence`, { auth: true }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return ui.empty({
        icon: 'magnifying-glass',
        title: 'Không tìm thấy vụ khiếu nại',
        action: ui.button({ label: 'Về danh sách khiếu nại', href: ctx.url('chu-may', 'P-10') }),
      });
    }
    throw err;
  }

  const dispute = detailRes.data?.dispute;
  const events = Array.isArray(detailRes.data?.events) ? detailRes.data.events : [];
  const proposals = Array.isArray(proposalsRes.data?.proposals) ? proposalsRes.data.proposals : [];
  const evidenceItems = Array.isArray(evidenceRes.data?.items) ? evidenceRes.data.items : [];
  const canUploadEvidence = Boolean(evidenceRes.data?.canUpload && evidenceRes.data?.storageAvailable && dispute.status === 'OPEN');
  const storageAvailable = Boolean(evidenceRes.data?.storageAvailable);

  const acts = disputeActions(ctx.user.id, dispute);
  const latestProposal = proposals.length ? proposals[proposals.length - 1] : null;
  const canConsentLatest = disputeCanConsentProposal(ctx.user.id, dispute, latestProposal);

  const responseInput = ui.voiceField({
    name: 'text',
    rows: 3,
    maxlength: MAX_LONG_TEXT,
    label: 'Nội dung phản hồi',
    hint: 'Từ 1 đến 2000 ký tự.',
  });

  const respondForm = acts.respond
    ? apiForm({
      fields: [responseInput],
      submitLabel: 'Gửi phản hồi',
      submitKind: 'primary',
      async run(fd) {
        const text = String(fd.get('text') || '').trim();
        if ([...text].length < 1 || [...text].length > MAX_LONG_TEXT) {
          throw new Error('Nhập nội dung phản hồi từ 1 đến 2000 ký tự.');
        }
        try {
          return await ctx.api.request('POST', `/api/disputes/${dispute.id}/responses`, {
            auth: true,
            body: { text },
          });
        } catch (error) {
          throw withMappedRefusal(error);
        }
      },
      onDone() {
        ctx.toast('Đã gửi phản hồi khiếu nại', 'ok');
        ctx.rerender();
      },
    })
    : null;

  const fileIn = h('input', { class: 'input', type: 'file', name: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const uploadForm = canUploadEvidence
    ? apiForm({
      fields: [
        ui.field({ label: 'Ảnh chứng cứ (JPEG, PNG hoặc WebP)', input: fileIn, required: true }),
      ],
      submitLabel: 'Tải ảnh chứng cứ lên',
      submitKind: 'secondary',
      async run() {
        const file = fileIn.files && fileIn.files[0];
        if (!file) throw new Error('Chọn một tệp ảnh trước khi tải lên.');
        const form = new FormData();
        form.append('file', file);
        try {
          return await ctx.api.upload(`/api/disputes/${dispute.id}/evidence`, form);
        } catch (error) {
          throw withMappedRefusal(error);
        }
      },
      onDone() {
        ctx.toast('Đã tải ảnh chứng cứ lên', 'ok');
        ctx.rerender();
      },
    })
    : null;

  const evidenceBox = h('div', { class: 'stack-sm' });
  if (!evidenceItems.length) {
    evidenceBox.appendChild(h('p', { class: 'muted' }, 'Chưa có ảnh chứng cứ nào được tải lên.'));
  } else {
    for (const ev of evidenceItems) {
      const thumbHolder = h('div', { class: 'row' },
        h('span', { class: 'small muted' }, `${ev.contentType} · ${Math.round((ev.byteSize || 0) / 1024)} KB · ${ev.status}`));
      const loadBtn = ui.button({
        label: 'Xem ảnh',
        icon: 'image',
        size: 'sm',
        kind: 'secondary',
        async onClick() {
          loadBtn.disabled = true;
          try {
            const url = await loadEvidenceImageUrl(ctx, ev.id, ev.status === 'READY' ? 'thumbnail' : 'content');
            const fullUrl = await loadEvidenceImageUrl(ctx, ev.id, 'content');
            thumbHolder.textContent = '';
            thumbHolder.appendChild(h('div', { class: 'stack-sm' },
              h('img', { src: url, alt: `Chứng cứ ${shortId(ev.id)}`, style: 'max-width:220px;border-radius:8px' }),
              h('a', { href: fullUrl, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Mở ảnh gốc')));
          } catch (err) {
            ctx.toast(err.message || 'Không tải được ảnh chứng cứ', 'err');
            loadBtn.disabled = false;
          }
        },
      });
      evidenceBox.appendChild(h('div', { class: 'provider-box stack-sm' },
        h('div', { class: 'row row--between' },
          h('span', { class: 'small mono' }, shortId(ev.id)),
          loadBtn),
        thumbHolder));
    }
  }

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Phản hồi khiếu nại',
      sub: `${disputes.length} vụ liên quan`,
    }),
    h('div', { class: 'split provider-split' },
      ui.card({
        title: 'Danh sách khiếu nại',
        body: ui.table({
          caption: 'Các vụ khiếu nại liên quan',
          rows: disputes,
          cols: [
            {
              label: 'Vụ / Lý do',
              render: (d) => h('div', { class: 'stack-sm' },
                h('span', { class: d.id === dispute.id ? 'provider-strong provider-cur' : 'provider-strong' }, DISPUTE_REASON_LABEL[d.reason] || d.reason),
                h('span', { class: 'small muted mono' }, `Đơn ${shortId(d.bookingId)}`)),
            },
            {
              label: 'Trạng thái',
              render: (d) => ui.badge(...(DISPUTE_STATUS_BADGE[d.status] || [d.status, 'outline'])),
            },
            {
              label: 'Tạo lúc',
              render: (d) => h('span', { class: 'small muted' }, formatDateTime(d.createdAt)),
            },
            {
              label: 'Thao tác',
              render: (d) => ui.button({
                label: d.id === dispute.id ? 'Đang xem' : 'Mở',
                size: 'sm',
                kind: d.id === dispute.id ? 'primary' : 'secondary',
                href: ctx.url('chu-may', 'P-10', { id: d.id }),
              }),
            },
          ],
        }),
      }),
      h('aside', { class: 'provider-aside stack' },
        ui.card({
          title: `Hồ sơ ${DISPUTE_REASON_LABEL[dispute.reason] || dispute.reason}`,
          subtitle: `Đơn ${shortId(dispute.bookingId)}`,
          actions: ui.badge(...(DISPUTE_STATUS_BADGE[dispute.status] || [dispute.status, 'outline'])),
          body: h('div', { class: 'stack' },
            ui.kv([
              ['Mã khiếu nại', h('span', { class: 'small mono' }, dispute.id)],
              ['Đơn liên quan', ui.link(`Đơn ${shortId(dispute.bookingId)}`, ctx.url('chu-may', 'P-07', { id: dispute.bookingId }), 'caret-right')],
              ['Vai trò của bạn', ctx.user.id === dispute.respondentId ? 'Bên bị khiếu nại' : (ctx.user.id === dispute.claimantId ? 'Bên gửi khiếu nại' : 'Bên liên quan')],
              ['Hòa giải viên', dispute.mediatorId ? `Đã chỉ định (${shortId(dispute.mediatorId)})` : 'Chưa chỉ định'],
              dispute.closureReason ? ['Lý do đóng', dispute.closureReason] : null,
            ]),
            dispute.status === 'CLOSED_UNRESOLVED'
              ? ui.note({ tone: 'warn', text: 'Vụ việc đóng chưa giải quyết; nghiệm thu và ghi nhận chuyển tiền của đơn này vẫn đang khóa.' })
              : null,
            ui.section('Diễn biến khiếu nại',
              events.length
                ? ui.timeline(events.map((ev) => ({
                  done: ev.type !== 'DISPUTE_OPENED',
                  now: ev.type === 'DISPUTE_OPENED',
                  title: DISPUTE_EVENT_LABEL[ev.type] || ev.type,
                  meta: [ev.data?.details || ev.data?.text || ev.data?.reason, formatDateTime(ev.createdAt)].filter(Boolean).join(' · '),
                })))
                : h('p', { class: 'muted' }, 'Chưa có diễn biến nào.')),
            respondForm ? ui.section('Phản hồi của chủ máy', respondForm) : null),
        }),
        ui.card({
          title: 'Phương án hòa giải',
          body: h('div', { class: 'stack' },
            proposals.length
              ? proposals.map((p) => h('div', { class: 'provider-box stack-sm' },
                h('div', { class: 'row row--between' },
                  h('strong', null, `Phương án v${p.version}`),
                  h('span', { class: 'small muted' }, `${(p.consents || []).length}/2 bên đồng ý`)),
                h('p', null, p.text),
                h('div', { class: 'small muted' }, `Đưa ra lúc ${formatDateTime(p.createdAt)}`)))
              : h('p', { class: 'muted' }, 'Chưa có phương án hòa giải nào từ hòa giải viên.'),
            canConsentLatest && latestProposal
              ? pButton({
                label: `Đồng ý phương án v${latestProposal.version}`,
                icon: 'check',
                kind: 'primary',
                size: 'lg',
                block: true,
                confirm: {
                  title: `Đồng ý phương án hòa giải v${latestProposal.version}?`,
                  text: 'Khi cả hai bên đồng ý, vụ khiếu nại chuyển sang Đã hòa giải.',
                  confirmLabel: 'Đồng ý phương án',
                },
                run: () => ctx.api.request('POST', `/api/disputes/${dispute.id}/proposals/${latestProposal.version}/consent`, { auth: true, body: {} }),
                okText: 'Đã đồng ý phương án hòa giải',
                onDone: () => ctx.rerender(),
              })
              : null),
        }),
        ui.card({
          title: 'Chứng cứ hình ảnh',
          subtitle: storageAvailable ? null : 'Lưu trữ ảnh chưa cấu hình trên môi trường này.',
          body: h('div', { class: 'stack' }, evidenceBox, uploadForm),
        }))));
}

export const screens = [
  { code: 'P-01', title: 'Bảng tin gói việc', render: feed },
  { code: 'P-02', title: 'Chi tiết gói việc', render: packageDetail },
  { code: 'P-03', title: 'Nhận gói việc', render: claim },
  { code: 'P-04', title: 'Đội máy', render: fleet },
  { code: 'P-05', title: 'Thợ của tôi', render: operatorsScreen },
  { code: 'P-06', title: 'Ca máy', render: shiftsScreen },
  { code: 'P-07', title: 'Nghiệm thu và tiền', render: money },
  { code: 'P-08', title: 'Tuyển thợ', render: recruit },
  { code: 'P-09', title: 'Ứng viên và đề nghị', render: applicantsScreen },
  { code: 'P-10', title: 'Phản hồi khiếu nại', render: disputeScreen },
];
