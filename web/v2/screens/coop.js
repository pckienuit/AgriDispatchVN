// Màn HTX điều phối (H-02, H-03, H-04, H-05, H-06, H-07, H-08) trên API thật. Không dùng dữ liệu mô phỏng hay vị trí GPS giả.
import { apiButton, apiForm, assumedBadge, errorText } from '../app/actions.js';
import { url } from '../app/routes.js';
import { ui } from '../kit/ui.js';
import { coopDepositCallCard } from './deposits.js';
import { telemetryCard } from './local-monitoring.js';

const h = ui.h;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MAX_SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REASON = 500;
const MAX_DISPUTE_TEXT = 2000;
const MAX_GROUP_BOOKINGS = 100;
const DISPUTE_PAGE = 20;

const PACKAGE_STATUS = {
  OPEN: ['Đang mở nhận', 'info'],
  CLAIMED: ['Đã có đơn vị nhận', 'ok'],
  CANCELLED: ['Đã hủy', 'muted'],
};

const SHIFT_EVENT_LABEL = {
  SHIFT_STARTED: 'Bắt đầu ca',
  SHIFT_PAUSED: 'Tạm dừng ca',
  SHIFT_RESUMED: 'Tiếp tục ca',
  SHIFT_COMPLETED: 'Hoàn thành ca',
};

const DISPUTE_REASONS = {
  AREA_MISMATCH: 'Sai lệch diện tích',
  QUALITY: 'Chất lượng làm việc',
  NO_SHOW: 'Không đến hoặc trễ giờ',
  PAYMENT: 'Thanh toán và nghiệm thu',
  OTHER: 'Lý do khác',
};

const DISPUTE_STATUS = {
  OPEN: ['Đang mở', 'warn'],
  RESOLVED: ['Đã hòa giải', 'ok'],
  CLOSED_UNRESOLVED: ['Đóng chưa giải quyết', 'error'],
};

const CASE_EVENTS = {
  DISPUTE_OPENED: 'Mở khiếu nại',
  RESPONSE_ADDED: 'Phản hồi',
  MEDIATOR_ASSIGNED: 'Nhận hòa giải',
};

const PROPOSAL_EVENTS = {
  PROPOSED: 'Đề xuất phương án mới',
  CONSENTED: 'Một bên đồng ý',
  RESOLVED: 'Hai bên đã đồng ý, vụ việc được giải quyết',
  CLOSED_UNRESOLVED: 'Đóng chưa giải quyết',
};

const CONFLICT_TYPES = [
  'PARTY_CONFLICT',
  'ROLE_OVERLAP',
  'MACHINE_CONFLICT',
  'AFFILIATION_CONFLICT',
  'RECUSAL_REQUEST',
  'PARTY_REQUEST',
];

const CONFLICT_LABELS = {
  PARTY_CONFLICT: 'Tài khoản HTX là một bên hoặc trùng vai trò trực tiếp trong đơn',
  ROLE_OVERLAP: 'Tài khoản HTX kiêm vai trò chủ máy, thợ lái hoặc quản trị',
  MACHINE_CONFLICT: 'Tài khoản HTX có sở hữu máy nông nghiệp',
  AFFILIATION_CONFLICT: 'Có quan hệ gia đình, họ hàng hoặc lợi ích liên quan',
  RECUSAL_REQUEST: 'HTX tự từ chối hòa giải để đảm bảo khách quan',
  PARTY_REQUEST: 'Một hoặc hai bên yêu cầu chuyển lên quản trị viên nền tảng',
};

const EVIDENCE_TYPES = { 'image/jpeg': 'JPEG', 'image/png': 'PNG' };

const COOP_ERRORS = {
  PACKAGE_INCOMPATIBLE: 'Các đơn đã chọn không cùng dịch vụ, cùng địa phương hoặc không có khoảng thời gian chung.',
  BOOKING_NOT_REQUESTED: 'Có đơn đã được gom vào gói khác hoặc đã đổi trạng thái. Tải lại danh sách rồi thử lại.',
  PACKAGE_UNAVAILABLE: 'Gói việc không còn ở trạng thái cho phép thực hiện thao tác này.',
  BOOKING_UNAVAILABLE: 'Đơn chưa vào gói đang mở hoặc không còn ở trạng thái cho phép thẩm định.',
  SHIFT_ACTIVE: 'Gói đã có ca làm việc được bắt đầu nên không thể hủy hoặc dời lịch.',
  SHIFT_STARTED: 'Ca máy đã bắt đầu nên không thể ghi nhận thẩm định thực địa mới.',
  READINESS_MISSING: 'Nông dân chưa gửi xác nhận ruộng sẵn sàng nên chưa thể ghi nhận thẩm định.',
  INSPECTION_INCOMPLETE: 'Chưa hoàn tất thẩm định đạt cho các đơn trong gói.',
  STALE_VERSION: 'Đề xuất dời lịch đã có phiên bản mới. Tải lại trang để xem phiên bản mới nhất.',
  DISPUTE_OPEN: 'Gói có khiếu nại đang mở nên chưa thể dời lịch.',
  PARTY_CONFLICT: 'Có xung đột vai trò trực tiếp nên không thể tiếp tục thao tác này.',
  ROLE_OVERLAP: 'Tài khoản có vai trò kiêm nhiệm không đủ điều kiện làm hòa giải viên HTX.',
  MACHINE_CONFLICT: 'Tài khoản có sở hữu máy nên không đủ điều kiện làm hòa giải viên HTX.',
  RECUSAL_REQUIRED: 'Tài khoản HTX có xung đột lợi ích. Cần từ chối và chuyển vụ việc lên quản trị viên.',
  ESCALATED_TO_ADMIN: 'Vụ việc đã được chuyển lên quản trị viên nền tảng.',
  ALREADY_ESCALATED: 'Vụ việc này đã được chuyển lên quản trị viên nền tảng trước đó.',
  ESCALATION_REQUIRED: 'HTX không thể đóng chưa giải quyết; hãy chuyển vụ việc lên quản trị viên.',
  DISPUTE_NOT_OPEN: 'Vụ việc không còn ở trạng thái đang mở.',
  HTX_NOT_RELATED: 'Vụ việc không thuộc phạm vi điều phối của HTX này.',
  INVALID_MEDIATOR: 'Không thể chỉ định người hòa giải không hợp lệ.',
  MEDIATOR_CHANGED: 'Người hòa giải đã thay đổi. Tải lại trang để xem trạng thái mới.',
  STATE_CHANGED: 'Trạng thái dữ liệu vừa thay đổi. Tải lại trang để xem thông tin mới nhất.',
  MACHINE_UNAVAILABLE: 'Máy đã nhận gói không còn sẵn sàng cho khung giờ đề xuất.',
  OPERATOR_NOT_AUTHORIZED: 'Thợ lái không còn đề nghị hợp lệ cho khung giờ đề xuất.',
  SCHEDULE_CONFLICT: 'Máy hoặc thợ lái đã có lịch trùng với khung giờ đề xuất.',
  INVALID_REASON: 'Nhập lý do hợp lệ từ 1 đến 500 ký tự.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Kiểm tra lại các trường rồi thử lại.',
  UNKNOWN_FIELD: 'Yêu cầu chứa trường dữ liệu máy chủ không hỗ trợ.',
  THUMBNAIL_PENDING: 'Ảnh thu nhỏ đang được xử lý. Mở lại sau ít phút hoặc xem ảnh gốc.',
  CONTENT_UNAVAILABLE: 'Chưa thể tải ảnh bằng chứng lúc này.',
  STORAGE_UNAVAILABLE: 'Kho lưu trữ bằng chứng tạm thời chưa sẵn sàng.',
};

const postponeDrafts = new Map();
const inspectFailDrafts = new Map();
const proposalDrafts = new Map();
const escalateDrafts = new Map();

/* ---------- Hàm thuần dùng chung và cho kiểm thử ---------- */
export function validId(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

export function queueFilter(items, filters = {}) {
  const list = Array.isArray(items) ? items : [];
  const serviceId = filters.serviceId ? String(filters.serviceId) : '';
  const locality = filters.locality ? String(filters.locality) : '';
  return list.filter((item) => {
    if (serviceId && item.serviceId !== serviceId) return false;
    if (locality && item.locality !== locality) return false;
    return true;
  });
}

export function groupPreview(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) {
    return { count: 0, areaM2: 0, locality: null, serviceId: null, serviceName: null, window: null, problem: null };
  }
  const first = list[0];
  const areaM2 = list.reduce((sum, item) => sum + (Number(item.areaM2) || 0), 0);
  if (list.length > MAX_GROUP_BOOKINGS) {
    return {
      count: list.length,
      areaM2,
      locality: first.locality || null,
      serviceId: first.serviceId || null,
      serviceName: first.serviceName || null,
      window: null,
      problem: `Chỉ gom tối đa ${MAX_GROUP_BOOKINGS} đơn trong một gói.`,
    };
  }
  if (!list.every((item) => item.serviceId === first.serviceId)) {
    return {
      count: list.length,
      areaM2,
      locality: null,
      serviceId: null,
      serviceName: null,
      window: null,
      problem: 'Các đơn đã chọn không cùng loại dịch vụ.',
    };
  }
  if (!list.every((item) => item.locality === first.locality)) {
    return {
      count: list.length,
      areaM2,
      locality: null,
      serviceId: first.serviceId,
      serviceName: first.serviceName || null,
      window: null,
      problem: 'Các đơn đã chọn không cùng địa phương.',
    };
  }
  const start = Math.max(...list.map((item) => Date.parse(item.startAt)));
  const end = Math.min(...list.map((item) => Date.parse(item.endAt)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    return {
      count: list.length,
      areaM2,
      locality: first.locality || null,
      serviceId: first.serviceId,
      serviceName: first.serviceName || null,
      window: null,
      problem: 'Các đơn đã chọn không có khoảng thời gian chung.',
    };
  }
  return {
    count: list.length,
    areaM2,
    locality: first.locality || null,
    serviceId: first.serviceId,
    serviceName: first.serviceName || null,
    window: { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() },
    problem: null,
  };
}

// H-03 advisory only (D9). Thresholds come from GET /api/platform-parameters; never fill in fallback numbers.
// Hints never change base eligibility, never block manual package creation, and are not spatial claims.
const HA_M2 = 10000;
const ADVICE_TONE = { below_min: 'warn', above_max: 'warn', min_reached: 'info', target_reached: 'success' };

function advisoryThresholds(values) {
  const min = Number(values?.clusterMinHa);
  const target = Number(values?.clusterTargetHa);
  const max = Number(values?.clusterMaxHa);
  const ok = [min, target, max].every((n) => Number.isFinite(n) && n > 0) && min <= target && target <= max;
  return ok ? { min, target, max } : null;
}

function haText(n) {
  return String(n).replace('.', ',');
}

export function groupAreaAdvice(areaM2, values) {
  const t = advisoryThresholds(values);
  if (!t) return null;
  const ha = (Number(areaM2) || 0) / HA_M2;
  if (ha > t.max) return { level: 'above_max', text: `Vượt ngưỡng gợi ý tối đa ${haText(t.max)} ha. Chỉ là gợi ý, HTX tự quyết định gom hay không.` };
  if (ha < t.min) return { level: 'below_min', text: `Dưới ngưỡng gợi ý tối thiểu ${haText(t.min)} ha. HTX vẫn có thể tạo gói thủ công.` };
  if (ha < t.target) return { level: 'min_reached', text: `Đạt ngưỡng tối thiểu ${haText(t.min)} ha, chưa đạt mục tiêu ${haText(t.target)} ha.` };
  return { level: 'target_reached', text: `Đạt mục tiêu gợi ý ${haText(t.target)} ha.` };
}

function overlapWindow(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

function rowWindow(row) {
  return { start: Date.parse(row.startAt), end: Date.parse(row.endAt) };
}

// Smallest single compatible booking that reaches target; otherwise largest-first greedy. Deterministic, id tie-break.
// Returns null when nothing reaches target inside the max cap, so the UI shows no hint.
export function groupCandidateHint(selectedRows, poolRows, values) {
  const t = advisoryThresholds(values);
  const base = Array.isArray(selectedRows) ? selectedRows.filter(Boolean) : [];
  const pool = Array.isArray(poolRows) ? poolRows.filter(Boolean) : [];
  if (!t || !base.length || !pool.length) return null;
  const first = base[0];
  if (!base.every((r) => r.serviceId === first.serviceId && r.locality === first.locality)) return null;
  let win = rowWindow(base[0]);
  for (const r of base.slice(1)) {
    win = overlapWindow(win, rowWindow(r));
    if (!win) return null;
  }
  const baseM2 = base.reduce((sum, r) => sum + (Number(r.areaM2) || 0), 0);
  const targetM2 = t.target * HA_M2;
  const maxM2 = t.max * HA_M2;
  if (baseM2 >= targetM2) return null;
  const baseIds = new Set(base.map((r) => r.id));
  const candidates = pool
    .filter((r) => !baseIds.has(r.id) && r.serviceId === first.serviceId && r.locality === first.locality)
    .map((r) => ({ row: r, area: Number(r.areaM2) || 0 }))
    .sort((a, b) => a.area - b.area || (a.row.id < b.row.id ? -1 : 1));

  const single = candidates.find(({ row, area }) => area + baseM2 >= targetM2 && area + baseM2 <= maxM2
    && overlapWindow(win, rowWindow(row)));
  if (single) return { rows: [single.row], areaM2: baseM2 + single.area, reachesGoal: true };

  let cur = win;
  let sum = baseM2;
  const rows = [];
  for (const { row, area } of [...candidates].sort((a, b) => b.area - a.area || (a.row.id < b.row.id ? -1 : 1))) {
    if (sum >= targetM2) break;
    if (sum + area > maxM2) continue;
    const next = overlapWindow(cur, rowWindow(row));
    if (!next) continue;
    cur = next;
    sum += area;
    rows.push(row);
  }
  return sum >= targetM2 ? { rows, areaM2: sum, reachesGoal: true } : null;
}

export function refusalText(error) {
  if (error?.uncertain || error?.code === 'NETWORK' || error?.code === 'TIMEOUT') return null;
  const code = error?.code;
  if (!code || !Object.hasOwn(COOP_ERRORS, code)) return null;
  return COOP_ERRORS[code];
}

export function localToUtcIso(text) {
  const match = typeof text === 'string' ? LOCAL_TIME.exec(text) : null;
  if (!match) return null;
  const [y, mo, d, hr, mi] = match.slice(1).map(Number);
  if (hr > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, hr, mi);
  const same = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
    && date.getHours() === hr && date.getMinutes() === mi;
  return same ? date.toISOString() : null;
}

export function postponementInput(values, currentStartAt) {
  const v = values || {};
  const errors = {};
  const startAt = localToUtcIso(v.startAt);
  const endAt = localToUtcIso(v.endAt);
  const current = Date.parse(currentStartAt);
  if (!startAt) errors.startAt = 'Nhập thời điểm bắt đầu mới hợp lệ.';
  else if (Number.isFinite(current) && Date.parse(startAt) <= current) errors.startAt = 'Thời điểm bắt đầu mới phải sau khung giờ hiện tại.';
  if (!endAt) errors.endAt = 'Nhập thời điểm kết thúc mới hợp lệ.';
  else if (startAt && Date.parse(endAt) <= Date.parse(startAt)) errors.endAt = 'Thời điểm kết thúc phải sau bắt đầu mới.';
  else if (startAt && Date.parse(endAt) - Date.parse(startAt) > MAX_SPAN_MS) errors.endAt = 'Khung giờ gói việc tối đa là 30 ngày.';
  const reason = typeof v.reason === 'string' ? v.reason.trim() : '';
  if (!reason) errors.reason = 'Nhập lý do dời lịch.';
  else if ([...reason].length > MAX_REASON) errors.reason = 'Lý do dời lịch tối đa 500 ký tự.';
  return Object.keys(errors).length ? { errors, payload: null } : { errors, payload: { startAt, endAt, reason } };
}

export function inspectionStatusOf(dto) {
  if (!dto) return { key: 'unknown', label: 'Không rõ', tone: 'outline' };
  if (dto.passed) return { key: 'passed', label: 'Đạt thẩm định', tone: 'ok' };
  if (dto.latest && dto.latest.stale) return { key: 'stale', label: 'Hết hiệu lực', tone: 'warn' };
  if (dto.latest && dto.latest.result === 'FAILED') return { key: 'failed', label: 'Không đạt', tone: 'error' };
  if (dto.canInspect) return { key: 'pending', label: 'Chờ thẩm định', tone: 'warn' };
  return { key: 'waiting_readiness', label: 'Chờ điều kiện', tone: 'idle' };
}

export function inspectionFailInput(reasonText) {
  const reason = typeof reasonText === 'string' ? reasonText.trim() : '';
  if (!reason) return { error: 'Nhập lý do không đạt thực địa.', payload: null };
  if ([...reason].length > MAX_REASON) return { error: `Lý do không đạt tối đa ${MAX_REASON} ký tự.`, payload: null };
  return { error: null, payload: { result: 'FAILED', reason } };
}

export function htxConflictLabel(code) {
  return CONFLICT_LABELS[code] || (code ? String(code) : 'Không có xung đột');
}

export function canInspectHtxDisputeDetail(item, actorId) {
  if (!item || !actorId) return false;
  if (item.eligible === false || item.conflictCode) return false;
  if (item.mediationLevel && item.mediationLevel !== 'HTX') return false;
  if (item.status && item.status !== 'OPEN') return false;
  return item.mediatorId === actorId;
}

export function escalationInput(reasonText, conflictType) {
  const reason = typeof reasonText === 'string' ? reasonText.trim() : '';
  if (!reason) return { error: 'Nhập lý do chuyển cấp quản trị viên.', payload: null };
  if ([...reason].length > MAX_DISPUTE_TEXT) return { error: `Lý do tối đa ${MAX_DISPUTE_TEXT} ký tự.`, payload: null };
  const payload = { reason };
  if (typeof conflictType === 'string' && conflictType.trim()) {
    const type = conflictType.trim();
    if (!CONFLICT_TYPES.includes(type)) return { error: 'Mã loại xung đột không hợp lệ.', payload: null };
    payload.conflictType = type;
  }
  return { error: null, payload };
}

export function mediationProposalInput(textValue) {
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  if (!text) return { error: 'Nhập nội dung phương án hòa giải.', payload: null };
  if ([...text].length > MAX_DISPUTE_TEXT) return { error: `Nội dung phương án tối đa ${MAX_DISPUTE_TEXT} ký tự.`, payload: null };
  return { error: null, payload: { text } };
}

function shortId(id) {
  return typeof id === 'string' && id.length >= 8 ? id.slice(0, 8) : String(id || '');
}

function parseOffset(value) {
  const n = Number.parseInt(String(value || '0'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function fetchAdvisory(ctx) {
  try {
    const { data } = await ctx.api.request('GET', '/api/platform-parameters', { auth: true });
    const eff = data?.effective;
    return advisoryThresholds(eff?.values) ? { values: eff.values, version: eff.version } : null;
  } catch {
    return null;
  }
}

function advisoryLine(advisory) {
  const v = advisory.version > 0 ? `phiên bản ${advisory.version}` : 'mặc định, chưa có phiên bản được lưu';
  const { clusterMinHa: min, clusterTargetHa: target, clusterMaxHa: max } = advisory.values;
  return `Ngưỡng gợi ý: tối thiểu ${haText(min)} ha, mục tiêu ${haText(target)} ha, tối đa ${haText(max)} ha (${v}). Chỉ là gợi ý, HTX chốt tay.`;
}

function coopErrorText(error) {
  return refusalText(error) || errorText(error);
}

function fmtArea(areaM2) {
  const ha = (Number(areaM2) || 0) / 10000;
  return ui.fmt.area(ha);
}

function fmtRange(startAt, endAt) {
  const a = Date.parse(startAt);
  const b = Date.parse(endAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'Chưa rõ thời gian';
  return `${ui.fmt.dateTime(a)} đến ${ui.fmt.dateTime(b)}`;
}

function packageStatusBadge(status) {
  const entry = PACKAGE_STATUS[status] || [status || 'Không rõ', 'outline'];
  return ui.badge(entry[0], entry[1]);
}

async function fetchServicesMap(ctx) {
  const { data } = await ctx.api.request('GET', '/api/services?limit=100', { auth: true });
  const items = Array.isArray(data?.items) ? data.items : [];
  return new Map(items.map((svc) => [svc.id, svc]));
}

function serviceNameOf(servicesMap, serviceId, fallback) {
  if (fallback) return fallback;
  const svc = servicesMap.get(serviceId);
  return svc ? svc.name : 'Dịch vụ';
}

function invalidIdEmpty(title, text, backLabel, backHash) {
  return ui.empty({
    icon: 'question',
    title,
    text,
    action: ui.button({ label: backLabel, kind: 'primary', href: backHash }),
  });
}

function openCancelModal({ ctx, pkg, onDone }) {
  let modal = null;
  const reasonInput = ui.textarea({ name: 'reason', rows: 3, maxlength: MAX_REASON, value: '' });
  const form = apiForm({
    fields: [
      h('p', { class: 'small muted' }, `Gói tại ${pkg.locality} (${pkg.bookingCount} đơn). Chỉ hủy được khi gói chưa có ca máy bắt đầu.`),
      ui.field({ label: 'Lý do hủy gói', hint: 'Từ 1 đến 500 ký tự.', input: reasonInput, required: true }),
    ],
    submitLabel: 'Xác nhận hủy gói',
    submitKind: 'danger',
    async run(data) {
      const reason = String(data.get('reason') || '').trim();
      if (!reason || [...reason].length > MAX_REASON) throw new Error(COOP_ERRORS.INVALID_REASON);
      try {
        return await ctx.api.request('POST', `/api/packages/${pkg.id}/cancel`, { auth: true, body: { reason } });
      } catch (error) {
        throw new Error(coopErrorText(error), { cause: error });
      }
    },
    onDone() {
      modal?.close();
      ctx.toast('Đã hủy gói việc', 'ok');
      if (onDone) onDone();
      else ctx.rerender();
    },
  });
  modal = ui.modal({
    title: 'Hủy gói việc',
    body: form,
    actions: [ui.button({ label: 'Đóng', kind: 'ghost', onClick: () => modal?.close() })],
  });
}

/* ---------- H-02: Hàng chờ đơn ---------- */
async function queueScreen(ctx) {
  const [bookingsRes, packagesRes, shiftsRes] = await Promise.all([
    ctx.api.request('GET', '/api/dispatch/bookings?limit=100', { auth: true }),
    ctx.api.request('GET', '/api/packages?limit=100', { auth: true }),
    ctx.api.request('GET', '/api/shifts?limit=100', { auth: true }),
  ]);
  if (ctx.stale()) return h('div');
  const items = Array.isArray(bookingsRes.data?.items) ? bookingsRes.data.items : [];
  const packages = Array.isArray(packagesRes.data?.items) ? packagesRes.data.items : [];
  const shifts = Array.isArray(shiftsRes.data?.shifts) ? shiftsRes.data.shifts : [];
  const shiftByPackage = new Map(shifts.map((s) => [s.packageId, s]));
  const activePackages = packages.filter((p) => p.status === 'OPEN' || p.status === 'CLAIMED');
  const unstartedPackages = activePackages.filter((p) => !shiftByPackage.has(p.id));

  const serviceOptions = [['', 'Tất cả dịch vụ']];
  const seenServices = new Set();
  const localityOptions = [['', 'Tất cả địa phương']];
  const seenLocalities = new Set();

  for (const item of items) {
    if (item.serviceId && !seenServices.has(item.serviceId)) {
      seenServices.add(item.serviceId);
      serviceOptions.push([item.serviceId, item.serviceName || item.serviceId]);
    }
    if (item.locality && !seenLocalities.has(item.locality)) {
      seenLocalities.add(item.locality);
      localityOptions.push([item.locality, item.locality]);
    }
  }

  const filters = {
    serviceId: ctx.params.dv || '',
    locality: ctx.params.dp || '',
  };

  const summaryWrap = h('div');
  const tableWrap = h('div');

  function paintFiltered() {
    const filtered = queueFilter(items, filters);
    const totalAreaM2 = filtered.reduce((sum, item) => sum + (Number(item.areaM2) || 0), 0);
    const locs = new Set(filtered.map((item) => item.locality).filter(Boolean));

    ui.clear(summaryWrap);
    summaryWrap.appendChild(ui.summaryLine([
      ['Đơn chờ gom', filtered.length],
      ['Tổng diện tích', fmtArea(totalAreaM2)],
      ['Địa phương', locs.size],
    ]));

    ui.clear(tableWrap);
    if (!items.length) {
      tableWrap.appendChild(ui.empty({
        icon: 'clipboard-text',
        title: 'Chưa có đơn ủy quyền chờ gom',
        text: 'Các đơn nông dân gửi và chọn HTX điều phối ở trạng thái chờ gom sẽ xuất hiện tại đây.',
        action: ui.button({ label: 'Xem gói đã tạo ở Bàn gom cụm', kind: 'secondary', href: url('htx', 'H-03') }),
      }));
      return;
    }
    if (!filtered.length) {
      tableWrap.appendChild(ui.empty({
        icon: 'magnifying-glass',
        title: 'Không có đơn khớp bộ lọc',
        text: 'Thử bỏ bớt điều kiện lọc dịch vụ hoặc địa phương để xem toàn bộ hàng chờ.',
        action: ui.button({
          label: 'Xóa bộ lọc',
          kind: 'secondary',
          onClick() {
            filters.serviceId = '';
            filters.locality = '';
            serviceSelect.value = '';
            localitySelect.value = '';
            paintFiltered();
          },
        }),
      }));
      return;
    }
    tableWrap.appendChild(ui.table({
      caption: 'Danh sách đơn ủy quyền chờ gom',
      cols: [
        {
          label: 'Thửa ruộng',
          render: (b) => h('div', null, h('strong', null, b.fieldName), h('div', { class: 'small muted' }, b.locality)),
        },
        { label: 'Dịch vụ', render: (b) => b.serviceName || 'Dịch vụ' },
        { label: 'Diện tích', align: 'r', render: (b) => h('span', { class: 'num' }, fmtArea(b.areaM2)) },
        { label: 'Khung thời gian', render: (b) => fmtRange(b.startAt, b.endAt) },
        { label: 'Trạng thái', render: () => ui.stateBadge('REQUESTED') },
      ],
      rows: filtered,
    }));
  }

  const serviceSelect = ui.select({
    name: 'serviceId',
    value: filters.serviceId,
    options: serviceOptions,
    on: {
      change(e) {
        filters.serviceId = e.target.value;
        paintFiltered();
      },
    },
  });

  const localitySelect = ui.select({
    name: 'locality',
    value: filters.locality,
    options: localityOptions,
    on: {
      change(e) {
        filters.locality = e.target.value;
        paintFiltered();
      },
    },
  });

  paintFiltered();

  ctx.setAction(null);

  const headActions = [
    ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() }),
  ];
  if (packages.length) {
    const inspectTarget = unstartedPackages[0] || activePackages[0] || packages[0];
    headActions.push(ui.button({
      label: 'Thẩm định thực địa',
      icon: 'binoculars',
      kind: 'secondary',
      href: url('htx', 'H-04', inspectTarget ? { pkg: inspectTarget.id } : undefined),
    }));
  }
  headActions.push(ui.button({ label: 'Mở bàn gom cụm', icon: 'map-trifold', kind: 'primary', href: url('htx', 'H-03') }));

  return h('div', { class: 'stack htx' },
    ui.screenHead({
      title: 'Hàng chờ đơn',
      sub: 'Các đơn đang ở trạng thái chờ gom được ủy quyền cho HTX.',
      actions: headActions,
    }),
    summaryWrap,
    unstartedPackages.length ? ui.note({
      tone: 'info',
      text: `Đang có ${unstartedPackages.length} gói chưa bắt đầu ca máy. Sau khi nông dân xác nhận ruộng sẵn sàng, HTX thực hiện thẩm định thực địa (H-04) tại đây.`,
      action: ui.button({
        label: 'Mở thẩm định thực địa',
        icon: 'binoculars',
        size: 'sm',
        kind: 'secondary',
        href: url('htx', 'H-04', { pkg: unstartedPackages[0].id }),
      }),
    }) : null,
    items.length ? ui.card({
      title: 'Lọc hàng chờ',
      body: h('div', { class: 'cols-2' },
        ui.field({ label: 'Dịch vụ', input: serviceSelect }),
        ui.field({ label: 'Địa phương', input: localitySelect })),
    }) : null,
    ui.card({
      title: 'Đơn chờ gom cụm',
      subtitle: 'Đơn đã được gom vào gói chuyển sang danh sách gói việc tại Bàn gom cụm.',
      body: tableWrap,
    }));
}

/* ---------- H-03: Bàn gom cụm (danh sách, không bản đồ) ---------- */
async function groupScreen(ctx) {
  const [bookingsRes, packagesRes, shiftsRes, servicesMap, advisory] = await Promise.all([
    ctx.api.request('GET', '/api/dispatch/bookings?limit=100', { auth: true }),
    ctx.api.request('GET', '/api/packages?limit=100', { auth: true }),
    ctx.api.request('GET', '/api/shifts?limit=100', { auth: true }),
    fetchServicesMap(ctx),
    fetchAdvisory(ctx),
  ]);

  const bookings = Array.isArray(bookingsRes.data?.items) ? bookingsRes.data.items : [];
  const packages = Array.isArray(packagesRes.data?.items) ? packagesRes.data.items : [];
  const shifts = Array.isArray(shiftsRes.data?.shifts) ? shiftsRes.data.shifts : [];
  const shiftByPackage = new Map(shifts.map((s) => [s.packageId, s]));

  const selectedIds = new Set();
  const previewWrap = h('div', { class: 'stack-sm', tabindex: '-1' });
  const createFeedback = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
  const checkboxes = new Map();

  function selectedRows() {
    return bookings.filter((b) => selectedIds.has(b.id));
  }

  function updateActionBar(preview) {
    const infoText = preview.count
      ? `Đã chọn ${preview.count} đơn · ${fmtArea(preview.areaM2)}`
      : 'Chưa chọn đơn nào';

    const createBtn = apiButton({
      label: 'Tạo gói việc',
      icon: 'stack',
      kind: 'primary',
      disabled: preview.count === 0 || Boolean(preview.problem),
      async run() {
        createFeedback.hidden = true;
        const rows = selectedRows();
        const check = groupPreview(rows);
        if (check.count === 0) {
          ui.clearToasts();
          createFeedback.textContent = 'Chọn ít nhất 1 đơn để tạo gói việc.';
          createFeedback.hidden = false;
          return { ok: false };
        }
        if (check.problem) {
          ui.clearToasts();
          createFeedback.textContent = check.problem;
          createFeedback.hidden = false;
          return { ok: false };
        }
        try {
          const { data } = await ctx.api.request('POST', '/api/packages', {
            auth: true,
            body: { bookingIds: rows.map((r) => r.id) },
          });
          return { ok: true, pkg: data?.package };
        } catch (error) {
          if (!ctx.stale()) ui.clearToasts();
          createFeedback.textContent = coopErrorText(error);
          createFeedback.hidden = false;
          return { ok: false };
        }
      },
      onDone(res) {
        if (!res?.ok) return;
        ctx.toast('Đã tạo gói việc mới', 'ok');
        if (res.pkg?.id) ctx.go(url('htx', 'H-05', { id: res.pkg.id }));
        else ctx.rerender();
      },
    });

    const clearBtn = ui.button({
      label: 'Bỏ chọn',
      kind: 'ghost',
      disabled: preview.count === 0,
      onClick() {
        selectedIds.clear();
        for (const box of checkboxes.values()) box.checked = false;
        createFeedback.hidden = true;
        paintPreview();
      },
    });

    ctx.setAction(ui.actionBar({
      info: infoText,
      actions: [clearBtn, createBtn],
    }));
  }

  function paintPreview() {
    const rows = selectedRows();
    const preview = groupPreview(rows);
    ui.clear(previewWrap);

    if (!preview.count) {
      previewWrap.appendChild(ui.empty({
        icon: 'list-checks',
        title: 'Chưa chọn đơn nào',
        text: 'Đánh dấu một hoặc nhiều đơn ở danh sách bên trái để kiểm tra tổng diện tích và khoảng thời gian chung trước khi tạo gói.',
      }));
      paintAdvice(preview);
    } else {
      previewWrap.appendChild(ui.summaryLine([
        ['Số đơn', preview.count],
        ['Tổng diện tích', fmtArea(preview.areaM2)],
      ]));
      previewWrap.appendChild(ui.kv([
        ['Dịch vụ', preview.serviceName || 'Không đồng nhất'],
        ['Địa phương', preview.locality || 'Không đồng nhất'],
        ['Khoảng thời gian chung', preview.window ? fmtRange(preview.window.startAt, preview.window.endAt) : 'Không có'],
      ]));
      if (preview.problem) {
        ui.clearToasts();
        previewWrap.appendChild(ui.note({ tone: 'error', text: preview.problem }));
      }
      else previewWrap.appendChild(ui.note({ tone: 'success', text: 'Các đơn đã chọn cùng dịch vụ, cùng địa phương và có khung giờ chung.' }));
      paintAdvice(preview);
    }

    updateActionBar(preview);
  }

  function paintAdvice(preview) {
    if (!advisory) {
      previewWrap.appendChild(ui.note({ tone: 'warn', text: 'Chưa tải được ngưỡng gợi ý từ máy chủ. Gợi ý gom tạm ẩn; vẫn chọn và tạo gói thủ công bình thường.' }));
      return;
    }
    previewWrap.appendChild(h('p', { class: 'small muted' }, assumedBadge('Giả định'), ` ${advisoryLine(advisory)}`));
    if (!preview.count) return;
    const advice = groupAreaAdvice(preview.areaM2, advisory.values);
    if (advice) previewWrap.appendChild(ui.note({ tone: ADVICE_TONE[advice.level], text: advice.text }));
    const hint = preview.problem
      ? null
      : groupCandidateHint(selectedRows(), bookings.filter((b) => !selectedIds.has(b.id)), advisory.values);
    if (!hint) return;
    previewWrap.appendChild(h('div', { class: 'stack-sm' },
      assumedBadge('Giả định'),
      h('p', null, `Gợi ý thêm ${hint.rows.length} đơn: ${hint.rows.map((r) => r.fieldName).join(', ')}. Tổng khi đó ${ui.fmt.ha(hint.areaM2 / HA_M2, 2)}.`),
      ui.button({
        label: 'Chọn các đơn gợi ý',
        icon: 'sparkle',
        kind: 'secondary',
        onClick() {
          for (const r of hint.rows) {
            selectedIds.add(r.id);
            const box = checkboxes.get(r.id);
            if (box) box.checked = true;
          }
          createFeedback.hidden = true;
          paintPreview();
          previewWrap.focus();
        },
      })));
    previewWrap.lastChild.appendChild(h('p', { class: 'small muted' }, 'Gợi ý chỉ dựa trên cùng địa phương, cùng dịch vụ và khung giờ chung, không phải kiểm tra vị trí hoặc khoảng cách. HTX tự chọn và tự tạo gói.'));
  }

  const bookingTable = bookings.length
    ? ui.table({
      caption: 'Chọn đơn chờ gom vào gói',
      cols: [
        {
          label: 'Chọn',
          render(b) {
            const box = h('input', {
              type: 'checkbox',
              class: 'htx-check',
              checked: selectedIds.has(b.id),
              'aria-label': `Chọn đơn ${b.fieldName}`,
              on: {
                change(e) {
                  if (e.target.checked) selectedIds.add(b.id);
                  else selectedIds.delete(b.id);
                  createFeedback.hidden = true;
                  paintPreview();
                },
              },
            });
            checkboxes.set(b.id, box);
            return h('label', { class: 'htx-check-wrap' }, box);
          },
        },
        {
          label: 'Thửa và địa phương',
          render: (b) => h('div', null, h('strong', null, b.fieldName), h('div', { class: 'small muted' }, b.locality)),
        },
        { label: 'Dịch vụ', render: (b) => b.serviceName || 'Dịch vụ' },
        { label: 'Diện tích', align: 'r', render: (b) => h('span', { class: 'num' }, fmtArea(b.areaM2)) },
        { label: 'Khung thời gian', render: (b) => fmtRange(b.startAt, b.endAt) },
      ],
      rows: bookings,
    })
    : ui.empty({
      icon: 'clipboard-text',
      title: 'Không còn đơn chờ gom',
      text: 'Mọi đơn ủy quyền đã được gom hoặc chưa có đơn mới từ nông dân.',
      action: ui.button({ label: 'Xem hàng chờ đơn', kind: 'secondary', href: url('htx', 'H-02') }),
    });

  const packagesTable = packages.length
    ? ui.table({
      caption: 'Danh sách gói việc của HTX',
      cols: [
        {
          label: 'Địa phương và dịch vụ',
          render: (p) => h('div', null,
            h('strong', null, p.locality),
            h('div', { class: 'small muted' }, `${serviceNameOf(servicesMap, p.serviceId)} · ${p.bookingCount} đơn`)),
        },
        { label: 'Khung thời gian', render: (p) => fmtRange(p.window.startAt, p.window.endAt) },
        { label: 'Trạng thái', render: (p) => packageStatusBadge(p.status) },
        {
          label: 'Thao tác',
          render(p) {
            const shift = shiftByPackage.get(p.id);
            const canCancel = p.status === 'OPEN' || (p.status === 'CLAIMED' && !shift);
            return h('div', { class: 'btn-row' },
              ui.button({ label: 'Chi tiết', kind: 'secondary', size: 'sm', href: url('htx', 'H-05', { id: p.id }) }),
              p.status === 'CLAIMED' && !shift
                ? ui.button({ label: 'Dời lịch', kind: 'ghost', size: 'sm', href: url('htx', 'H-07', { id: p.id }) })
                : null,
              shift
                ? ui.button({ label: 'Xem ca', kind: 'ghost', size: 'sm', href: url('htx', 'H-06', { id: shift.id }) })
                : null,
              canCancel
                ? ui.button({ label: 'Hủy gói', kind: 'danger', size: 'sm', onClick: () => openCancelModal({ ctx, pkg: p }) })
                : null);
          },
        },
      ],
      rows: packages,
    })
    : ui.empty({
      icon: 'package',
      title: 'Chưa có gói việc nào',
      text: 'Chọn đơn ở bảng trên rồi bấm Tạo gói việc để phát hành gói mở cho chủ máy.',
    });

  paintPreview();

  return h('div', { class: 'stack htx' },
    ui.screenHead({
      title: 'Bàn gom cụm',
      sub: 'Chọn đơn cùng dịch vụ, cùng địa phương và có khoảng thời gian chung để tạo gói việc.',
      actions: [ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() })],
    }),
    ui.summaryLine([
      ['Đơn chờ gom', bookings.length],
      ['Gói đã tạo', packages.length],
      ['Đang mở nhận', packages.filter((p) => p.status === 'OPEN').length],
      ['Đã nhận', packages.filter((p) => p.status === 'CLAIMED').length],
    ]),
    h('div', { class: 'htx-grid' },
      h('div', { class: 'stack' },
        ui.card({
          title: 'Đơn chờ gom theo danh sách',
          subtitle: 'Giai đoạn này gom theo danh sách đơn từ API; chưa dùng bản đồ ranh thửa.',
          body: bookingTable,
        }),
        ui.card({
          title: 'Gói việc đã tạo',
          subtitle: 'Gói đang mở hoặc đã có đơn vị nhận (khi chưa bắt đầu ca máy) có thể hủy kèm lý do.',
          body: packagesTable,
        })),
      h('div', { class: 'stack' },
        ui.card({
          title: 'Gói đang soạn',
          subtitle: 'Tổng diện tích và khung giờ giao nhau được tính trước khi gửi lên máy chủ.',
          body: h('div', { class: 'stack-sm' }, previewWrap, createFeedback),
        }))));
}

/* ---------- H-05: Chào việc / Chi tiết gói ---------- */
async function packageDetailScreen(ctx) {
  const rawId = ctx.params.id;
  if (rawId !== undefined && !validId(rawId)) {
    ctx.setAction(null);
    return h('div', { class: 'stack htx' },
      ui.screenHead({ title: 'Chào việc' }),
      invalidIdEmpty('Mã gói không hợp lệ', 'Đường dẫn chi tiết gói không đúng định dạng.', 'Về bàn gom cụm', url('htx', 'H-03')));
  }

  const requestedId = validId(rawId);
  if (!requestedId) {
    ctx.setAction(null);
    const [packagesRes, servicesMap] = await Promise.all([
      ctx.api.request('GET', '/api/packages?limit=100', { auth: true }),
      fetchServicesMap(ctx),
    ]);
    const packages = Array.isArray(packagesRes.data?.items) ? packagesRes.data.items : [];
    return h('div', { class: 'stack htx' },
      ui.screenHead({
        title: 'Chào việc',
        sub: 'Chọn một gói việc để xem trạng thái nhận gói hoặc thao tác hủy gói.',
        actions: [ui.button({ label: 'Về bàn gom cụm', icon: 'arrow-left', kind: 'ghost', href: url('htx', 'H-03') })],
      }),
      packages.length
        ? ui.card({
          title: 'Chọn gói việc',
          body: ui.list(packages.map((p) => ui.listItem({
            title: `${p.locality} · ${serviceNameOf(servicesMap, p.serviceId)}`,
            meta: `${p.bookingCount} đơn · ${fmtRange(p.window.startAt, p.window.endAt)}`,
            right: packageStatusBadge(p.status),
            href: url('htx', 'H-05', { id: p.id }),
            icon: 'package',
          }))),
        })
        : ui.empty({
          icon: 'package',
          title: 'Chưa có gói việc nào',
          text: 'Hãy gom các đơn chờ ở Bàn gom cụm trước khi theo dõi chào việc.',
          action: ui.button({ label: 'Mở bàn gom cụm', kind: 'primary', href: url('htx', 'H-03') }),
        }));
  }

  const [pkgRes, shiftsRes, servicesMap] = await Promise.all([
    ctx.api.request('GET', `/api/packages/${requestedId}`, { auth: true }),
    ctx.api.request('GET', '/api/shifts?limit=100', { auth: true }),
    fetchServicesMap(ctx),
  ]);
  const pkg = pkgRes.data?.package;
  if (!pkg) {
    ctx.setAction(null);
    return h('div', { class: 'stack htx' },
      ui.screenHead({ title: 'Chào việc' }),
      invalidIdEmpty('Không tìm thấy gói việc', 'Gói không tồn tại hoặc không thuộc quyền quản lý của HTX này.', 'Về bàn gom cụm', url('htx', 'H-03')));
  }

  const shifts = Array.isArray(shiftsRes.data?.shifts) ? shiftsRes.data.shifts : [];
  const shift = shifts.find((s) => s.packageId === pkg.id) || null;
  const serviceName = serviceNameOf(servicesMap, pkg.serviceId);
  const canCancel = pkg.status === 'OPEN' || (pkg.status === 'CLAIMED' && !shift);
  const bookingIds = Array.isArray(pkg.bookingIds) ? pkg.bookingIds : [];

  const inspectionEntries = await Promise.all(
    bookingIds.map(async (id) => {
      try {
        const res = await ctx.api.request('GET', `/api/bookings/${id}/inspections`, { auth: true });
        return [id, res.data || null];
      } catch {
        return [id, null];
      }
    }),
  );
  if (ctx.stale()) return h('div');
  const inspectionsById = new Map(inspectionEntries);

  const statusNote = pkg.status === 'OPEN'
    ? ui.note({ tone: 'info', text: 'Gói đang mở nhận để chủ máy phù hợp nhận việc. Hiện chưa có đơn vị nhận.' })
    : pkg.status === 'CLAIMED'
      ? ui.note({ tone: 'success', text: 'Gói đã có chủ máy nhận việc. API chi tiết gói phía HTX hiện chỉ trả trạng thái đã nhận, chưa trả tên chủ máy, tên máy và tên thợ lái.' })
      : ui.note({ tone: 'warn', text: 'Gói đã hủy. Các đơn trong gói không còn hiệu lực điều phối.' });

  const actionButtons = [];
  if ((pkg.status === 'OPEN' || pkg.status === 'CLAIMED') && !shift && bookingIds.length) {
    actionButtons.push(ui.button({
      label: 'Thẩm định thực địa',
      icon: 'binoculars',
      kind: 'secondary',
      href: url('htx', 'H-04', { pkg: pkg.id, id: bookingIds[0] }),
    }));
  }
  if (pkg.status === 'CLAIMED' && !shift) {
    actionButtons.push(ui.button({ label: 'Dời lịch gói', icon: 'cloud-rain', kind: 'secondary', href: url('htx', 'H-07', { id: pkg.id }) }));
  }
  if (shift) {
    actionButtons.push(ui.button({ label: 'Giám sát ca máy', icon: 'binoculars', kind: 'primary', href: url('htx', 'H-06', { id: shift.id }) }));
  }
  ctx.setAction(actionButtons.length
    ? ui.actionBar({ info: `${pkg.locality} · ${PACKAGE_STATUS[pkg.status]?.[0] || pkg.status}`, actions: actionButtons })
    : null);

  const cancelForm = canCancel ? apiForm({
    fields: [
      ui.field({
        label: 'Lý do hủy gói',
        hint: 'Từ 1 đến 500 ký tự. Không thể hủy nếu ca máy đã bắt đầu.',
        input: ui.textarea({ name: 'reason', rows: 2, maxlength: MAX_REASON, value: '' }),
        required: true,
      }),
    ],
    submitLabel: 'Hủy gói việc',
    submitKind: 'danger',
    async run(data) {
      const reason = String(data.get('reason') || '').trim();
      if (!reason || [...reason].length > MAX_REASON) throw new Error(COOP_ERRORS.INVALID_REASON);
      try {
        return await ctx.api.request('POST', `/api/packages/${pkg.id}/cancel`, { auth: true, body: { reason } });
      } catch (error) {
        throw new Error(coopErrorText(error), { cause: error });
      }
    },
    onDone() {
      ctx.toast('Đã hủy gói việc', 'ok');
      ctx.rerender();
    },
  }) : null;

  return h('div', { class: 'stack htx' },
    ui.screenHead({
      title: 'Chào việc',
      sub: `${serviceName} · ${pkg.locality}`,
      badges: [packageStatusBadge(pkg.status)],
      actions: [
        ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() }),
        bookingIds.length ? ui.button({
          label: 'Thẩm định thực địa',
          icon: 'binoculars',
          kind: 'secondary',
          href: url('htx', 'H-04', { pkg: pkg.id, id: bookingIds[0] }),
        }) : null,
        ui.button({ label: 'Về bàn gom cụm', icon: 'arrow-left', kind: 'ghost', href: url('htx', 'H-03') }),
      ].filter(Boolean),
    }),
    ui.summaryLine([
      ['Trạng thái', PACKAGE_STATUS[pkg.status]?.[0] || pkg.status],
      ['Số đơn', pkg.bookingCount],
      ['Địa phương', pkg.locality],
    ]),
    h('div', { class: 'htx-grid' },
      h('div', { class: 'stack' },
        ui.card({
          title: 'Trạng thái nhận gói',
          body: h('div', { class: 'stack-sm' },
            statusNote,
            shift
              ? h('div', { class: 'row row--between' },
                h('span', null, 'Ca máy đã bắt đầu: ', ui.shiftBadge(shift.status)),
                ui.button({ label: 'Mở giám sát ca', icon: 'binoculars', kind: 'secondary', size: 'sm', href: url('htx', 'H-06', { id: shift.id }) }))
              : null),
        }),
        ui.card({
          title: 'Thông tin gói việc',
          body: ui.kv([
            ['Mã gói', h('span', { class: 'mono' }, pkg.id)],
            ['Dịch vụ', serviceName],
            ['Địa phương', pkg.locality],
            ['Khung thời gian', fmtRange(pkg.window.startAt, pkg.window.endAt)],
            ['Số đơn trong gói', String(pkg.bookingCount)],
            ['Tạo lúc', ui.fmt.dateTime(Date.parse(pkg.createdAt))],
          ]),
        }),
        pkg.status === 'CLAIMED' ? await coopDepositCallCard(ctx, pkg.id) : null,
        ui.card({
          title: 'Danh sách đơn và thẩm định thực địa',
          subtitle: 'Chọn từng đơn để mở màn hình thẩm định thực địa (H-04) hoặc xem lại lịch sử thẩm định.',
          body: bookingIds.length
            ? ui.list(bookingIds.map((id, idx) => {
              const insp = inspectionsById.get(id);
              const st = inspectionStatusOf(insp);
              const metaParts = [h('span', { class: 'mono' }, shortId(id))];
              if (insp?.latest?.stale) metaParts.push(' · Cần thẩm định lại');
              if (insp?.latest?.result === 'FAILED' && insp.latest.reason) metaParts.push(` · Lý do: ${insp.latest.reason}`);
              return ui.listItem({
                title: `Đơn ${idx + 1}`,
                meta: h('span', null, ...metaParts),
                right: ui.badge(st.label, st.tone),
                href: url('htx', 'H-04', { pkg: pkg.id, id }),
                icon: 'clipboard-text',
              });
            }))
            : h('p', { class: 'muted' }, 'Không có mã đơn nào trong gói.'),
        })),
      h('div', { class: 'stack' },
        cancelForm
          ? ui.card({
            title: 'Hủy gói việc',
            subtitle: 'Chỉ thực hiện được trước khi thợ lái bắt đầu ca.',
            body: cancelForm,
          })
          : ui.card({
            title: 'Thao tác khác',
            body: h('p', { class: 'muted' }, shift
              ? 'Gói đã có ca máy bắt đầu nên không thể hủy hoặc dời lịch.'
              : 'Gói đã hủy không thể thao tác thêm.'),
          }))));
}

/* ---------- H-06: Giám sát hiện trường (chỉ xem, không GPS giả) ---------- */
async function shiftsScreen(ctx) {
  ctx.setAction(null);
  const rawId = ctx.params.id;
  if (rawId !== undefined && !validId(rawId)) {
    return h('div', { class: 'stack htx' },
      ui.screenHead({ title: 'Giám sát hiện trường' }),
      invalidIdEmpty('Mã ca máy không hợp lệ', 'Đường dẫn ca máy không đúng định dạng.', 'Về danh sách ca máy', url('htx', 'H-06')));
  }

  const [shiftsRes, packagesRes, servicesMap] = await Promise.all([
    ctx.api.request('GET', '/api/shifts?limit=100', { auth: true }),
    ctx.api.request('GET', '/api/packages?limit=100', { auth: true }),
    fetchServicesMap(ctx),
  ]);

  const shifts = Array.isArray(shiftsRes.data?.shifts) ? shiftsRes.data.shifts : [];
  const packages = Array.isArray(packagesRes.data?.items) ? packagesRes.data.items : [];
  const pkgById = new Map(packages.map((p) => [p.id, p]));

  if (!shifts.length && !rawId) {
    return h('div', { class: 'stack htx' },
      ui.screenHead({
        title: 'Giám sát hiện trường',
        sub: 'Theo dõi trạng thái và nhật ký ca máy thuộc các gói của HTX (chỉ xem).',
      }),
      ui.empty({
        icon: 'binoculars',
        title: 'Chưa có ca máy nào',
        text: 'Ca máy hiện tại đây sau khi gói đã được chủ máy nhận và thợ lái bắt đầu ca. Hệ thống chưa có dữ liệu vị trí GPS trực tiếp.',
        action: ui.button({ label: 'Xem gói việc', kind: 'secondary', href: url('htx', 'H-03') }),
      }));
  }

  const targetId = validId(rawId) || shifts[0]?.id;
  let detailShift = null;
  if (targetId) {
    const detailRes = await ctx.api.request('GET', `/api/shifts/${targetId}`, { auth: true });
    detailShift = detailRes.data?.shift || null;
  }

  const runningCount = shifts.filter((s) => s.status === 'RUNNING').length;
  const pausedCount = shifts.filter((s) => s.status === 'PAUSED').length;
  const completedCount = shifts.filter((s) => s.status === 'COMPLETED').length;

  const shiftPicker = ui.list(shifts.map((s) => {
    const pkg = pkgById.get(s.packageId);
    const svc = pkg ? serviceNameOf(servicesMap, pkg.serviceId) : 'Ca máy';
    const title = pkg ? `${pkg.locality} · ${svc}` : `Ca ${s.id.slice(0, 8)}`;
    return ui.pick({
      title,
      meta: `Bắt đầu ${ui.fmt.dateTime(Date.parse(s.startedAt))}${s.id === targetId ? ' · Đang xem' : ''}`,
      right: ui.shiftBadge(s.status),
      selected: s.id === targetId,
      control: 'none',
      icon: 'tractor',
      onSelect: () => ctx.go(url('htx', 'H-06', { id: s.id })),
    });
  }));

  const detailPkg = detailShift ? pkgById.get(detailShift.packageId) : null;
  const events = Array.isArray(detailShift?.events) ? detailShift.events : [];

  const detailCard = detailShift
    ? h('div', { class: 'stack' },
      ui.card({
        title: 'Chi tiết ca máy (chỉ xem)',
        subtitle: 'Trạng thái và nhật ký lấy từ hồ sơ ca máy.',
        actions: ui.shiftBadge(detailShift.status),
        body: h('div', { class: 'stack-sm' },
          ui.kv([
            ['Mã ca', h('span', { class: 'mono' }, detailShift.id)],
            ['Gói việc', h('div', { class: 'row' },
              h('span', { class: 'mono' }, detailShift.packageId),
              ui.link('Xem gói', url('htx', 'H-05', { id: detailShift.packageId }), 'package'))],
            detailPkg ? ['Địa phương', detailPkg.locality] : null,
            detailPkg ? ['Dịch vụ', serviceNameOf(servicesMap, detailPkg.serviceId)] : null,
            ['Bắt đầu lúc', ui.fmt.dateTime(Date.parse(detailShift.startedAt))],
            detailShift.completedAt ? ['Hoàn thành lúc', ui.fmt.dateTime(Date.parse(detailShift.completedAt))] : null,
            ['Diện tích ghi nhận', detailShift.areaM2 ? fmtArea(detailShift.areaM2) : 'Chưa ghi nhận'],
            ['Ghi chú kết thúc', detailShift.note || 'Không có'],
          ])),
      }),
      await telemetryCard(ctx, 'shift', detailShift.id).catch(() => {
        if (!ctx.stale()) ui.clearToasts();
        return ui.errorState({ title: 'Chưa tải được chỉ số mô phỏng', retry: () => ctx.rerender() });
      }),
      ui.card({
        title: 'Nhật ký sự kiện ca máy',
        body: events.length
          ? ui.timeline(events.map((ev, idx) => {
            const parts = [ui.fmt.dateTime(Date.parse(ev.createdAt))];
            if (ev.reason) parts.push(`Lý do: ${ev.reason}`);
            if (ev.areaM2) parts.push(`Diện tích: ${fmtArea(ev.areaM2)}`);
            if (ev.note) parts.push(`Ghi chú: ${ev.note}`);
            return {
              title: SHIFT_EVENT_LABEL[ev.eventType] || ev.eventType,
              meta: parts.join(' · '),
              done: idx < events.length - 1 || detailShift.status === 'COMPLETED',
              now: idx === events.length - 1 && detailShift.status !== 'COMPLETED',
            };
          }))
          : h('p', { class: 'muted' }, 'Chưa có sự kiện nào được ghi nhận.'),
      }))
    : ui.empty({
      icon: 'binoculars',
      title: 'Không tìm thấy ca máy',
      text: 'Ca không tồn tại hoặc không thuộc các gói của HTX này.',
      action: ui.button({ label: 'Xem tất cả ca', kind: 'primary', href: url('htx', 'H-06') }),
    });

  return h('div', { class: 'stack htx' },
    ui.screenHead({
      title: 'Giám sát hiện trường',
      sub: 'Trạng thái và nhật ký ca máy thuộc các gói của HTX (chỉ xem).',
      actions: [ui.button({ label: 'Ước tính hoa hồng', icon: 'hand-coins', kind: 'secondary', href: url('htx', 'H-09') }), ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() })],
    }),
    ui.summaryLine([
      ['Tổng số ca', shifts.length],
      ['Đang làm', runningCount],
      ['Tạm dừng', pausedCount],
      ['Đã xong', completedCount],
    ]),
    h('div', { class: 'htx-cols' },
      ui.card({ title: 'Danh sách ca máy', body: shiftPicker }),
      detailCard));
}

/* ---------- H-07: Sự cố / Dời lịch cả gói ---------- */
async function postponementScreen(ctx) {
  const rawId = ctx.params.id;
  if (rawId !== undefined && !validId(rawId)) {
    ctx.setAction(null);
    return h('div', { class: 'stack htx' },
      ui.screenHead({ title: 'Sự cố' }),
      invalidIdEmpty('Mã gói không hợp lệ', 'Đường dẫn dời lịch không đúng định dạng.', 'Về danh sách gói', url('htx', 'H-03')));
  }

  const [packagesRes, servicesMap] = await Promise.all([
    ctx.api.request('GET', '/api/packages?limit=100', { auth: true }),
    fetchServicesMap(ctx),
  ]);
  const packages = Array.isArray(packagesRes.data?.items) ? packagesRes.data.items : [];
  const requestedId = validId(rawId);

  if (!packages.length && !requestedId) {
    ctx.setAction(null);
    return h('div', { class: 'stack htx' },
      ui.screenHead({ title: 'Sự cố', sub: 'Đề xuất dời lịch cả gói trước khi ca máy bắt đầu.' }),
      ui.empty({
        icon: 'cloud-rain',
        title: 'Chưa có gói việc nào',
        text: 'Dời lịch được thực hiện trên gói đã tạo và đã có đơn vị nhận trước khi ca máy bắt đầu.',
        action: ui.button({ label: 'Về bàn gom cụm', kind: 'primary', href: url('htx', 'H-03') }),
      }));
  }

  const targetId = requestedId
    || packages.find((p) => p.status === 'CLAIMED')?.id
    || packages[0]?.id;

  const { data } = await ctx.api.request('GET', `/api/packages/${targetId}/postponement`, { auth: true });
  const pkg = data?.package;
  const permissions = data?.permissions || { canPropose: false, canConsent: false };
  const latest = data?.latest || null;
  const history = Array.isArray(data?.history) ? data.history : [];
  const listPkg = packages.find((p) => p.id === targetId);

  const pkgOptions = packages.map((p) => [
    p.id,
    `${p.locality} · ${serviceNameOf(servicesMap, p.serviceId)} · ${PACKAGE_STATUS[p.status]?.[0] || p.status}`,
  ]);

  const draft = postponeDrafts.get(targetId) || { startAt: '', endAt: '', reason: '' };
  postponeDrafts.set(targetId, draft);

  const startInput = ui.input({ type: 'datetime-local', name: 'startAt', value: draft.startAt });
  const endInput = ui.input({ type: 'datetime-local', name: 'endAt', value: draft.endAt });
  const reasonInput = ui.textarea({ name: 'reason', rows: 3, maxlength: MAX_REASON, value: draft.reason });
  startInput.addEventListener('input', () => { draft.startAt = startInput.value; });
  endInput.addEventListener('input', () => { draft.endAt = endInput.value; });
  reasonInput.addEventListener('input', () => { draft.reason = reasonInput.value; });

  const proposeForm = permissions.canPropose ? apiForm({
    fields: [
      ui.field({ label: 'Bắt đầu mới', hint: 'Theo giờ địa phương; phải sau thời điểm bắt đầu hiện tại.', input: startInput, required: true }),
      ui.field({ label: 'Kết thúc mới', hint: 'Sau thời điểm bắt đầu mới, tối đa 30 ngày.', input: endInput, required: true }),
      ui.field({ label: 'Lý do dời lịch', hint: 'Tối đa 500 ký tự.', input: reasonInput, required: true }),
    ],
    submitLabel: 'Gửi đề xuất dời lịch',
    async run() {
      const { errors, payload } = postponementInput(draft, pkg.startAt);
      if (!payload) throw new Error(Object.values(errors).join(' '));
      try {
        return await ctx.api.request('POST', `/api/packages/${targetId}/postponement`, { auth: true, body: payload });
      } catch (error) {
        throw new Error(coopErrorText(error), { cause: error });
      }
    },
    onDone() {
      postponeDrafts.set(targetId, { startAt: '', endAt: '', reason: '' });
      ctx.toast('Đã gửi đề xuất dời lịch. Khung giờ hiện tại giữ nguyên cho tới khi đủ đồng ý.', 'ok');
      ctx.rerender();
    },
  }) : null;

  const consentFeedback = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
  const canConsentLatest = Boolean(permissions.canConsent && latest && !latest.appliedAt && !latest.ownConsented);
  const consentBtn = canConsentLatest ? apiButton({
    label: `Đồng ý phiên bản ${latest.version}`,
    icon: 'check',
    kind: 'primary',
    confirm: {
      title: `Đồng ý đề xuất phiên bản ${latest.version}`,
      text: `Khung giờ mới: ${fmtRange(latest.startAt, latest.endAt)}. Chỉ phiên bản ${latest.version} hiện tại được ghi nhận.`,
      confirmLabel: 'Xác nhận đồng ý',
    },
    async run() {
      consentFeedback.hidden = true;
      try {
        await ctx.api.request('POST', `/api/packages/${targetId}/postponement/${latest.version}/consent`, { auth: true, body: {} });
        return { ok: true };
      } catch (error) {
        if (!ctx.stale()) ui.clearToasts();
        consentFeedback.textContent = coopErrorText(error);
        consentFeedback.hidden = false;
        return { ok: false };
      }
    },
    onDone(res) {
      if (!res?.ok) return;
      ctx.toast(`Đã ghi nhận đồng ý phiên bản ${latest.version}`, 'ok');
      ctx.rerender();
    },
  }) : null;

  ctx.setAction(consentBtn
    ? ui.actionBar({ info: `Đề xuất phiên bản ${latest.version}`, actions: [consentBtn] })
    : null);

  const latestCard = latest
    ? ui.card({
      title: `Đề xuất hiện tại: Phiên bản ${latest.version}`,
      actions: ui.badge(latest.appliedAt ? 'Đã áp dụng' : 'Chờ đủ đồng ý', latest.appliedAt ? 'ok' : 'warn'),
      body: h('div', { class: 'stack-sm' },
        ui.kv([
          ['Khung giờ đề xuất', fmtRange(latest.startAt, latest.endAt)],
          ['Khung giờ trước đó', fmtRange(latest.oldStartAt, latest.oldEndAt)],
          ['Lý do', latest.reason],
          ['Đồng ý độc lập', `${latest.consentedCount} trên ${latest.requiredCount} bên bắt buộc`],
          ['Tài khoản hiện tại', latest.ownConsented ? 'Đã đồng ý' : 'Chưa đồng ý (hoặc không thuộc nhóm bên bắt buộc)'],
          ['Tạo lúc', ui.fmt.dateTime(Date.parse(latest.createdAt))],
          latest.appliedAt ? ['Áp dụng lúc', ui.fmt.dateTime(Date.parse(latest.appliedAt))] : null,
        ]),
        ui.progress(latest.requiredCount ? (latest.consentedCount / latest.requiredCount) * 100 : 0, 'Tỷ lệ đồng ý đề xuất dời lịch'),
        h('p', { class: 'small muted' }, 'Mỗi chủ đơn và chủ máy phải tự xác nhận đồng ý đúng phiên bản này; HTX không xác nhận thay.'),
        consentFeedback),
    })
    : ui.card({
      title: 'Đề xuất hiện tại',
      body: h('p', { class: 'muted' }, 'Chưa có đề xuất dời lịch nào cho gói này.'),
    });

  return h('div', { class: 'stack htx' },
    ui.screenHead({
      title: 'Sự cố',
      sub: 'Đề xuất dời lịch cả gói trước khi ca máy bắt đầu và theo dõi đồng ý độc lập từng bên.',
      actions: [
        ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() }),
        ui.button({ label: 'Chi tiết gói', icon: 'package', kind: 'ghost', href: url('htx', 'H-05', { id: targetId }) }),
      ],
    }),
    ui.note({
      tone: 'info',
      text: 'Dời lịch áp dụng cho cả gói trước khi bắt đầu ca. Khung giờ hiện tại vẫn giữ nguyên cho tới khi tất cả chủ đơn và chủ máy đồng ý cùng một phiên bản và máy chủ kiểm tra xong lịch máy, thợ lái. Dời lịch không làm thay đổi phí hay số liệu thanh toán.',
    }),
    packages.length > 1 ? ui.card({
      title: 'Chọn gói việc',
      body: ui.field({
        label: 'Gói đang xem',
        input: ui.select({
          name: 'packageId',
          value: targetId,
          options: pkgOptions,
          on: { change: (e) => ctx.go(url('htx', 'H-07', { id: e.target.value })) },
        }),
      }),
    }) : null,
    h('div', { class: 'htx-grid' },
      h('div', { class: 'stack' },
        ui.card({
          title: 'Khung giờ hiện tại của gói',
          actions: packageStatusBadge(pkg.status),
          body: ui.kv([
            listPkg ? ['Địa phương', listPkg.locality] : null,
            listPkg ? ['Dịch vụ', serviceNameOf(servicesMap, listPkg.serviceId)] : null,
            ['Bắt đầu', ui.fmt.dateTime(Date.parse(pkg.startAt))],
            ['Kết thúc', ui.fmt.dateTime(Date.parse(pkg.endAt))],
          ]),
        }),
        latestCard,
        ui.card({
          title: 'Lịch sử dời lịch',
          body: history.length
            ? ui.timeline(history.map((item) => ({
              title: `Phiên bản ${item.version}: ${fmtRange(item.startAt, item.endAt)}`,
              meta: `Từ ${fmtRange(item.oldStartAt, item.oldEndAt)} · Lý do: ${item.reason} · ${item.consentedCount}/${item.requiredCount} bên đồng ý · ${item.appliedAt ? `Đã áp dụng lúc ${ui.fmt.dateTime(Date.parse(item.appliedAt))}` : 'Chưa áp dụng'}`,
              done: Boolean(item.appliedAt),
              now: !item.appliedAt && latest?.version === item.version,
            })))
            : h('p', { class: 'muted' }, 'Chưa có lịch sử dời lịch.'),
        })),
      h('div', { class: 'stack' },
        proposeForm
          ? ui.card({
            title: 'Đề xuất dời lịch mới',
            subtitle: 'Gửi đề xuất mới sẽ tạo phiên bản mới; mọi bên cần đồng ý lại trên phiên bản đó.',
            body: proposeForm,
          })
          : ui.card({
            title: 'Đề xuất dời lịch mới',
            body: ui.note({
              tone: 'warn',
              text: 'Không thể gửi đề xuất dời lịch cho gói này ở trạng thái hiện tại. Gói cần đang ở trạng thái Đã có đơn vị nhận, chưa bắt đầu ca máy và không có khiếu nại đang mở.',
            }),
          }))));
}

/* ---------- H-04: Thẩm định thực địa ---------- */
async function inspectionScreen(ctx) {
  ctx.setAction(null);
  const rawBookingId = ctx.params.id;
  const rawPkgId = ctx.params.pkg;
  if (rawBookingId !== undefined && !validId(rawBookingId)) {
    return h('div', { class: 'stack htx' },
      ui.screenHead({ title: 'Thẩm định thực địa' }),
      invalidIdEmpty('Mã đơn không hợp lệ', 'Đường dẫn thẩm định thực địa không đúng định dạng.', 'Về hàng chờ đơn', url('htx', 'H-02')));
  }
  if (rawPkgId !== undefined && !validId(rawPkgId)) {
    return h('div', { class: 'stack htx' },
      ui.screenHead({ title: 'Thẩm định thực địa' }),
      invalidIdEmpty('Mã gói không hợp lệ', 'Đường dẫn gói việc không đúng định dạng.', 'Về hàng chờ đơn', url('htx', 'H-02')));
  }

  const requestedBookingId = validId(rawBookingId);
  const requestedPkgId = validId(rawPkgId);

  const [packagesRes, shiftsRes, servicesMap] = await Promise.all([
    ctx.api.request('GET', '/api/packages?limit=100', { auth: true }),
    ctx.api.request('GET', '/api/shifts?limit=100', { auth: true }),
    fetchServicesMap(ctx),
  ]);
  if (ctx.stale()) return h('div');

  const packages = Array.isArray(packagesRes.data?.items) ? packagesRes.data.items : [];
  const shifts = Array.isArray(shiftsRes.data?.shifts) ? shiftsRes.data.shifts : [];
  const shiftByPackage = new Map(shifts.map((s) => [s.packageId, s]));

  let directInspection = null;
  if (requestedBookingId) {
    try {
      const res = await ctx.api.request('GET', `/api/bookings/${requestedBookingId}/inspections`, { auth: true });
      directInspection = res.data || null;
    } catch (error) {
      if (ctx.stale()) return h('div');
      if (error?.status === 403 || error?.status === 404) {
        ui.clearToasts();
        return h('div', { class: 'stack htx' },
          ui.screenHead({
            title: 'Thẩm định thực địa',
            actions: [ui.button({ label: 'Về danh sách thẩm định', icon: 'arrow-left', kind: 'ghost', href: url('htx', 'H-04') })],
          }),
          ui.empty({
            icon: 'prohibit',
            title: 'Không thể truy cập thẩm định đơn này',
            text: 'Đơn không tồn tại hoặc không thuộc phạm vi điều phối của HTX này.',
            action: ui.button({ label: 'Về hàng chờ đơn', kind: 'primary', href: url('htx', 'H-02') }),
          }));
      }
      throw error;
    }
    if (ctx.stale()) return h('div');
  }

  let selectedPkg = null;
  let pkgIdToLoad = requestedPkgId || directInspection?.latest?.packageId || null;
  if (!pkgIdToLoad && !requestedBookingId && packages.length) {
    const picked = packages.find((p) => (p.status === 'OPEN' || p.status === 'CLAIMED') && !shiftByPackage.has(p.id))
      || packages.find((p) => p.status === 'OPEN' || p.status === 'CLAIMED')
      || packages[0];
    pkgIdToLoad = picked.id;
  }

  if (pkgIdToLoad) {
    try {
      const pkgRes = await ctx.api.request('GET', `/api/packages/${pkgIdToLoad}`, { auth: true });
      selectedPkg = pkgRes.data?.package || null;
    } catch (error) {
      if (ctx.stale()) return h('div');
      if (requestedPkgId && (error?.status === 403 || error?.status === 404)) {
        ui.clearToasts();
        return h('div', { class: 'stack htx' },
          ui.screenHead({ title: 'Thẩm định thực địa' }),
          invalidIdEmpty('Không tìm thấy gói việc', 'Gói việc không tồn tại hoặc không thuộc quyền quản lý của HTX này.', 'Về thẩm định thực địa', url('htx', 'H-04')));
      }
      if (error?.status !== 403 && error?.status !== 404) throw error;
    }
    if (ctx.stale()) return h('div');
  } else if (requestedBookingId && packages.length) {
    const candidates = packages
      .filter((p) => p.status === 'OPEN' || p.status === 'CLAIMED')
      .concat(packages.filter((p) => p.status !== 'OPEN' && p.status !== 'CLAIMED'))
      .slice(0, 12);
    for (const candidate of candidates) {
      try {
        const res = await ctx.api.request('GET', `/api/packages/${candidate.id}`, { auth: true });
        if (ctx.stale()) return h('div');
        const pkg = res.data?.package;
        if (pkg && Array.isArray(pkg.bookingIds) && pkg.bookingIds.includes(requestedBookingId)) {
          selectedPkg = pkg;
          break;
        }
      } catch {
        // Bỏ qua nếu gói không tải được khi tìm gói chứa đơn
      }
    }
  }

  if (!selectedPkg && !requestedBookingId) {
    return h('div', { class: 'stack htx' },
      ui.screenHead({
        title: 'Thẩm định thực địa',
        sub: 'Kiểm tra và ghi nhận kết quả thực địa cho các đơn đã gom vào gói.',
        actions: [
          ui.button({ label: 'Về hàng chờ', icon: 'arrow-left', kind: 'ghost', href: url('htx', 'H-02') }),
        ],
      }),
      ui.empty({
        icon: 'binoculars',
        title: 'Chưa có gói việc để thẩm định',
        text: 'Các đơn cần được gom vào gói việc tại Bàn gom cụm và nông dân gửi xác nhận sẵn sàng trước khi HTX thẩm định thực địa.',
        action: ui.button({ label: 'Mở bàn gom cụm', kind: 'primary', href: url('htx', 'H-03') }),
      }));
  }

  const bookingIds = Array.isArray(selectedPkg?.bookingIds) ? selectedPkg.bookingIds : [];
  const inspectionEntries = await Promise.all(
    bookingIds.map(async (id) => {
      if (id === requestedBookingId && directInspection) return [id, directInspection];
      try {
        const res = await ctx.api.request('GET', `/api/bookings/${id}/inspections`, { auth: true });
        return [id, res.data || null];
      } catch {
        return [id, null];
      }
    }),
  );
  if (ctx.stale()) return h('div');

  const inspectionsById = new Map(inspectionEntries);
  if (requestedBookingId && directInspection && !inspectionsById.has(requestedBookingId)) {
    inspectionsById.set(requestedBookingId, directInspection);
  }

  let selectedBookingId = requestedBookingId;
  if (!selectedBookingId && bookingIds.length) {
    selectedBookingId = bookingIds.find((id) => {
      const st = inspectionStatusOf(inspectionsById.get(id)).key;
      return st === 'stale' || st === 'pending' || st === 'failed';
    }) || bookingIds[0];
  }
  const activeInspection = selectedBookingId ? (inspectionsById.get(selectedBookingId) || directInspection) : null;
  const activeStatus = inspectionStatusOf(activeInspection);
  const pkgShift = selectedPkg ? shiftByPackage.get(selectedPkg.id) : null;

  const counts = { total: bookingIds.length, pending: 0, stale: 0, passed: 0, failed: 0, waiting: 0 };
  for (const id of bookingIds) {
    const st = inspectionStatusOf(inspectionsById.get(id)).key;
    if (st === 'passed') counts.passed += 1;
    else if (st === 'stale') counts.stale += 1;
    else if (st === 'failed') counts.failed += 1;
    else if (st === 'pending') counts.pending += 1;
    else counts.waiting += 1;
  }

  const pkgOptions = packages.map((p) => {
    const svc = serviceNameOf(servicesMap, p.serviceId);
    const st = PACKAGE_STATUS[p.status]?.[0] || p.status;
    return [p.id, `${p.locality} · ${svc} (${p.bookingCount} đơn · ${st})`];
  });

  function cannotInspectReasonText() {
    if (pkgShift) return 'Gói đã có ca máy bắt đầu nên máy chủ khóa ghi nhận thẩm định mới.';
    if (selectedPkg && selectedPkg.status === 'CANCELLED') return 'Gói việc đã hủy nên không thể thẩm định.';
    if (!selectedPkg) return 'Đơn chưa thuộc gói việc đang mở hoặc đã nhận; gom đơn ở Bàn gom cụm trước khi thẩm định.';
    return 'Nông dân chưa gửi xác nhận ruộng sẵn sàng (F-08) nên máy chủ chưa cho phép ghi nhận thẩm định.';
  }

  function renderDetailPanel() {
    if (!selectedBookingId || !activeInspection) {
      return ui.empty({
        icon: 'clipboard-text',
        title: 'Chưa chọn đơn thẩm định',
        text: 'Chọn một đơn trong danh sách bên cạnh để xem trạng thái và ghi nhận thẩm định thực địa.',
      });
    }

    const latest = activeInspection.latest || null;
    const history = Array.isArray(activeInspection.history) ? activeInspection.history : [];
    const canInspect = activeInspection.canInspect === true;

    let stateNote;
    if (activeInspection.passed) {
      stateNote = ui.note({
        tone: 'success',
        text: `Đơn đã đạt thẩm định thực địa (lần #${latest?.sequence || 1}). Kết quả vẫn giữ hiệu lực cho tới khi nông dân cập nhật lại trạng thái sẵn sàng hoặc khung giờ gói thay đổi.`,
      });
    } else if (latest && latest.stale) {
      stateNote = ui.note({
        tone: 'warn',
        text: `Kết quả thẩm định gần nhất (#${latest.sequence} · ${latest.result === 'PASSED' ? 'Đạt' : 'Không đạt'}) đã hết hiệu lực do nông dân cập nhật lại xác nhận sẵn sàng hoặc khung giờ gói đã dời. Cần kiểm tra và ghi nhận thẩm định mới.`,
      });
    } else if (latest && latest.result === 'FAILED') {
      stateNote = ui.note({
        tone: 'error',
        text: `Đơn chưa đạt thẩm định thực địa. Lý do gần nhất: ${latest.reason || 'Không có ghi chú'}`,
      });
    } else if (canInspect) {
      stateNote = ui.note({
        tone: 'warn',
        text: 'Nông dân đã gửi xác nhận sẵn sàng. HTX kiểm tra thực địa rồi ghi nhận Đạt hoặc Không đạt kèm lý do.',
      });
    } else {
      stateNote = ui.note({
        tone: 'info',
        text: cannotInspectReasonText(),
      });
    }

    let actionCard;
    if (canInspect) {
      const passFeedback = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
      let passBusy = false;
      const passBtn = ui.button({
        label: 'Xác nhận Đạt thực địa',
        icon: 'check-circle',
        kind: 'primary',
        block: true,
        async onClick() {
          if (passBusy) return;
          passBusy = true;
          passBtn.disabled = true;
          passBtn.setAttribute('aria-busy', 'true');
          passFeedback.hidden = true;
          passFeedback.textContent = '';
          try {
            await ctx.api.request('POST', `/api/bookings/${selectedBookingId}/inspections`, {
              auth: true,
              body: { result: 'PASSED' },
            });
            inspectFailDrafts.delete(selectedBookingId);
            ctx.toast('Đã ghi nhận Đạt thẩm định thực địa', 'ok');
            ctx.rerender();
          } catch (error) {
            if (!ctx.stale()) ui.clearToasts();
            passFeedback.textContent = coopErrorText(error);
            passFeedback.hidden = false;
          } finally {
            passBusy = false;
            passBtn.disabled = false;
            passBtn.removeAttribute('aria-busy');
          }
        },
      });

      const failTextarea = ui.textarea({
        name: 'reason',
        rows: 3,
        maxlength: MAX_REASON,
        value: inspectFailDrafts.get(selectedBookingId) || '',
        on: {
          input(e) {
            inspectFailDrafts.set(selectedBookingId, e.target.value);
          },
        },
      });

      const failForm = apiForm({
        fields: [
          ui.field({
            label: 'Lý do không đạt',
            hint: 'Bắt buộc khi ghi nhận Không đạt (1 đến 500 ký tự).',
            input: failTextarea,
            required: true,
          }),
        ],
        submitLabel: 'Ghi nhận Không đạt',
        submitKind: 'danger',
        async run(formData) {
          const check = inspectionFailInput(formData.get('reason'));
          if (check.error) throw new Error(check.error);
          try {
            return await ctx.api.request('POST', `/api/bookings/${selectedBookingId}/inspections`, {
              auth: true,
              body: check.payload,
            });
          } catch (error) {
            throw new Error(coopErrorText(error), { cause: error });
          }
        },
        onDone() {
          inspectFailDrafts.delete(selectedBookingId);
          ctx.toast('Đã ghi nhận Không đạt thẩm định thực địa', 'ok');
          ctx.rerender();
        },
      });

      actionCard = ui.card({
        title: 'Ghi nhận kết quả thẩm định',
        subtitle: 'Máy chủ đã xác nhận đủ điều kiện ghi nhận. Chọn Đạt nếu ruộng đủ điều kiện vận hành, hoặc ghi rõ lý do nếu Không đạt.',
        body: h('div', { class: 'stack-sm' },
          passBtn,
          passFeedback,
          h('hr', { class: 'divider' }),
          failForm),
      });
    } else {
      actionCard = ui.card({
        title: 'Ghi nhận kết quả thẩm định',
        body: ui.note({
          tone: 'warn',
          text: `Đang khóa ghi nhận: ${cannotInspectReasonText()}`,
        }),
      });
    }

    return h('div', { class: 'stack' },
      ui.card({
        title: `Chi tiết thẩm định đơn ${shortId(selectedBookingId)}`,
        actions: ui.badge(activeStatus.label, activeStatus.tone),
        body: h('div', { class: 'stack-sm' },
          stateNote,
          ui.kv([
            ['Mã đơn', h('span', { class: 'mono' }, selectedBookingId)],
            selectedPkg ? ['Gói việc', h('div', { class: 'row' },
              h('span', { class: 'mono' }, shortId(selectedPkg.id)),
              ui.link('Xem chào việc (H-05)', url('htx', 'H-05', { id: selectedPkg.id }), 'package'))] : null,
            selectedPkg ? ['Địa phương', selectedPkg.locality] : null,
            selectedPkg ? ['Dịch vụ', serviceNameOf(servicesMap, selectedPkg.serviceId)] : null,
            ['Kết quả hiện tại', activeInspection.passed ? 'Đạt (còn hiệu lực)' : 'Chưa đạt hoặc cần thẩm định lại'],
            ['Quyền ghi nhận', canInspect ? 'Đang mở cho phép ghi nhận' : 'Đang khóa'],
            latest ? ['Lần gần nhất', `#${latest.sequence} · ${latest.result === 'PASSED' ? 'Đạt' : 'Không đạt'}${latest.stale ? ' (Hết hiệu lực)' : ''}`] : null,
            latest?.reason ? ['Lý do không đạt', latest.reason] : null,
            latest ? ['Người ghi nhận', latest.reviewerName || 'HTX điều phối'] : null,
            latest ? ['Thời điểm', ui.fmt.dateTime(Date.parse(latest.createdAt))] : null,
          ])),
      }),
      actionCard,
      ui.card({
        title: 'Lịch sử thẩm định thực địa',
        subtitle: `Tối đa 20 lần gần nhất (${history.length} bản ghi).`,
        body: history.length
          ? ui.timeline(history.map((item, idx) => {
            const verdict = item.result === 'PASSED' ? 'Đạt' : 'Không đạt';
            const parts = [ui.fmt.dateTime(Date.parse(item.createdAt))];
            if (item.reviewerName) parts.push(item.reviewerName);
            if (item.reason) parts.push(`Lý do: ${item.reason}`);
            if (item.stale) parts.push('Hết hiệu lực do cập nhật sẵn sàng hoặc dời lịch');
            return {
              title: `Lần #${item.sequence}: ${verdict}${item.stale ? ' (Hết hiệu lực)' : ''}`,
              meta: parts.join(' · '),
              done: item.result === 'PASSED' && !item.stale,
              now: idx === 0 && !item.stale,
            };
          }))
          : h('p', { class: 'muted' }, 'Chưa có lần thẩm định nào cho đơn này.'),
      }));
  }

  return h('div', { class: 'stack htx' },
    ui.screenHead({
      title: 'Thẩm định thực địa',
      sub: 'Xác nhận điều kiện thực địa từng đơn trong gói trước khi bắt đầu ca máy.',
      actions: [
        ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() }),
        selectedPkg ? ui.button({ label: 'Chi tiết gói', icon: 'package', kind: 'secondary', href: url('htx', 'H-05', { id: selectedPkg.id }) }) : null,
        ui.button({ label: 'Về hàng chờ', icon: 'arrow-left', kind: 'ghost', href: url('htx', 'H-02') }),
      ].filter(Boolean),
    }),
    selectedPkg ? ui.summaryLine([
      ['Đơn trong gói', counts.total],
      ['Chờ thẩm định', counts.pending],
      ['Hết hiệu lực', counts.stale],
      ['Đã đạt', counts.passed],
      ['Không đạt', counts.failed],
    ]) : null,
    packages.length > 1 && selectedPkg ? ui.card({
      title: 'Chọn gói việc để thẩm định',
      body: ui.field({
        label: 'Gói việc',
        input: ui.select({
          name: 'packageId',
          value: selectedPkg.id,
          options: pkgOptions,
          on: { change: (e) => ctx.go(url('htx', 'H-04', { pkg: e.target.value })) },
        }),
      }),
    }) : null,
    selectedPkg && bookingIds.length
      ? h('div', { class: 'htx-cols' },
        ui.card({
          title: 'Đơn trong gói',
          subtitle: `${selectedPkg.locality} · ${serviceNameOf(servicesMap, selectedPkg.serviceId)}`,
          body: ui.list(bookingIds.map((bid, idx) => {
            const insp = inspectionsById.get(bid);
            const st = inspectionStatusOf(insp);
            const metaText = [`Mã đơn ${shortId(bid)}`];
            if (insp?.latest?.stale) metaText.push('Cần thẩm định lại');
            return ui.pick({
              title: `Đơn ${idx + 1}`,
              meta: metaText.join(' · '),
              right: ui.badge(st.label, st.tone),
              selected: bid === selectedBookingId,
              control: 'none',
              icon: 'clipboard-text',
              onSelect: () => ctx.go(url('htx', 'H-04', { pkg: selectedPkg.id, id: bid })),
            });
          })),
        }),
        renderDetailPanel())
      : renderDetailPanel());
}

/* ---------- H-08: Hòa giải cấp HTX ---------- */
function registerObjectUrlCleanup(urlValue) {
  if (!urlValue) return;
  if (Array.isArray(ui._cleanups)) {
    ui._cleanups.push(() => {
      try {
        URL.revokeObjectURL(urlValue);
      } catch {
        // Bỏ qua lỗi giải phóng blob URL
      }
    });
  }
}

function buildEscalationForm({ ctx, disputeId, defaultConflictType, noteText }) {
  const draftKey = disputeId;
  const draft = escalateDrafts.get(draftKey) || {};
  const initialConflict = draft.conflictType !== undefined
    ? draft.conflictType
    : (defaultConflictType && CONFLICT_TYPES.includes(defaultConflictType) ? defaultConflictType : '');

  const conflictSelect = ui.select({
    name: 'conflictType',
    value: initialConflict,
    options: [
      ['', 'Chọn loại xung đột hoặc lý do (tùy chọn)'],
      ...CONFLICT_TYPES.map((code) => [code, CONFLICT_LABELS[code] || code]),
    ],
    on: {
      change(e) {
        const cur = escalateDrafts.get(draftKey) || {};
        escalateDrafts.set(draftKey, { ...cur, conflictType: e.target.value });
      },
    },
  });

  const reasonArea = ui.textarea({
    name: 'reason',
    rows: 3,
    maxlength: MAX_DISPUTE_TEXT,
    value: draft.reason ?? '',
    on: {
      input(e) {
        const cur = escalateDrafts.get(draftKey) || {};
        escalateDrafts.set(draftKey, { ...cur, reason: e.target.value });
      },
    },
  });

  return apiForm({
    fields: [
      noteText ? ui.note({ tone: 'warn', text: noteText }) : null,
      ui.field({
        label: 'Loại xung đột hoặc căn cứ chuyển cấp',
        hint: 'Nếu không thuộc nhóm cụ thể có thể để trống và nêu rõ trong phần lý do.',
        input: conflictSelect,
      }),
      ui.field({
        label: 'Lý do từ chối hòa giải / chuyển quản trị viên',
        hint: `Từ 1 đến ${MAX_DISPUTE_TEXT} ký tự.`,
        input: reasonArea,
        required: true,
      }),
    ].filter(Boolean),
    submitLabel: 'Chuyển lên quản trị viên nền tảng',
    submitKind: 'danger',
    async run(formData) {
      const check = escalationInput(formData.get('reason'), formData.get('conflictType'));
      if (check.error) throw new Error(check.error);
      try {
        return await ctx.api.request('POST', `/api/disputes/${disputeId}/escalate`, {
          auth: true,
          body: check.payload,
        });
      } catch (error) {
        throw new Error(coopErrorText(error), { cause: error });
      }
    },
    onDone() {
      escalateDrafts.delete(draftKey);
      ctx.toast('Đã chuyển vụ việc lên quản trị viên nền tảng', 'ok');
      ctx.go(url('htx', 'H-08'));
    },
  });
}

function htxEvidenceViewer({ ctx, items, total }) {
  if (!items.length) {
    return h('p', { class: 'muted' }, 'Chưa có ảnh bằng chứng nào được các bên gửi lên.');
  }
  return h('div', { class: 'stack-sm' },
    total > items.length ? h('p', { class: 'small muted' }, `Hiển thị ${items.length}/${total} tệp bằng chứng.`) : null,
    h('div', { class: 'stack-sm' }, items.map((ev) => {
      const thumbHolder = h('div', { class: 'row' });
      const msg = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
      let thumbLoaded = false;

      const thumbBtn = ui.button({
        label: 'Xem ảnh thu nhỏ',
        icon: 'image',
        kind: 'secondary',
        size: 'sm',
        async onClick() {
          if (thumbLoaded) return;
          thumbBtn.disabled = true;
          msg.hidden = true;
          try {
            const blob = await ctx.api.binary(`/api/evidence/${ev.id}/thumbnail`);
            const objUrl = URL.createObjectURL(blob);
            registerObjectUrlCleanup(objUrl);
            thumbLoaded = true;
            ui.clear(thumbHolder);
            thumbHolder.appendChild(h('img', {
              src: objUrl,
              alt: `Bằng chứng ${ev.id}`,
              style: 'max-width: 180px; border-radius: 8px; border: 1px solid var(--line);',
            }));
          } catch (error) {
            if (!ctx.stale() && msg.isConnected) ui.clearToasts();
            msg.textContent = coopErrorText(error);
            msg.hidden = false;
            thumbBtn.disabled = false;
          }
        },
      });

      const fullBtn = ui.button({
        label: 'Xem ảnh gốc',
        icon: 'arrows-out',
        kind: 'ghost',
        size: 'sm',
        async onClick() {
          msg.hidden = true;
          fullBtn.disabled = true;
          try {
            const blob = await ctx.api.binary(`/api/evidence/${ev.id}/content`);
            const objUrl = URL.createObjectURL(blob);
            let modal = null;
            modal = ui.modal({
              title: `Ảnh bằng chứng (${EVIDENCE_TYPES[ev.contentType] || ev.contentType || 'Ảnh'})`,
              body: h('img', {
                src: objUrl,
                alt: `Ảnh gốc ${ev.id}`,
                style: 'max-width: 100%; max-height: 70vh; object-fit: contain;',
              }),
              actions: [ui.button({ label: 'Đóng', kind: 'ghost', onClick: () => modal?.close() })],
              onClose() {
                try {
                  URL.revokeObjectURL(objUrl);
                } catch {
                  // Bỏ qua lỗi giải phóng blob URL
                }
              },
            });
          } catch (error) {
            if (!ctx.stale() && msg.isConnected) ui.clearToasts();
            msg.textContent = coopErrorText(error);
            msg.hidden = false;
          } finally {
            fullBtn.disabled = false;
          }
        },
      });

      const dim = (ev.width && ev.height) ? `${ev.width}x${ev.height}px · ` : '';
      return h('div', { class: 'card card--flat stack-sm' },
        h('div', { class: 'row row--between' },
          h('div', null,
            h('strong', null, EVIDENCE_TYPES[ev.contentType] || ev.contentType || 'Ảnh'),
            h('div', { class: 'small muted' }, `${dim}${Math.max(1, Math.round((Number(ev.byteSize) || 0) / 1024))} KB · ${ui.fmt.dateTime(Date.parse(ev.createdAt))}`)),
          ui.badge(ev.status === 'UPLOADED' ? 'Đã tải lên' : (ev.status || 'Chờ xử lý'), ev.status === 'UPLOADED' ? 'ok' : 'warn')),
        h('div', { class: 'btn-row' }, thumbBtn, fullBtn),
        thumbHolder,
        msg);
    })));
}

async function mediationScreen(ctx) {
  ctx.setAction(null);
  const rawId = ctx.params.id;
  if (rawId !== undefined && !validId(rawId)) {
    return h('div', { class: 'stack htx' },
      ui.screenHead({ title: 'Hòa giải cấp HTX' }),
      invalidIdEmpty('Mã vụ việc không hợp lệ', 'Đường dẫn hòa giải không đúng định dạng.', 'Về danh sách hòa giải', url('htx', 'H-08')));
  }

  const tab = ctx.params.hang === 'cua-toi' ? 'mine' : 'cho';
  const offset = parseOffset(ctx.params.tu);
  const requestedId = validId(rawId);

  const [htxRes, mineRes] = await Promise.all([
    ctx.api.request('GET', `/api/htx/disputes?limit=${DISPUTE_PAGE}&offset=${tab === 'cho' ? offset : 0}`, { auth: true }),
    ctx.api.request('GET', `/api/disputes?limit=${DISPUTE_PAGE}&offset=${tab === 'mine' ? offset : 0}`, { auth: true }),
  ]);
  if (ctx.stale()) return h('div');

  const htxItems = Array.isArray(htxRes.data?.items) ? htxRes.data.items : [];
  const htxTotal = Number(htxRes.data?.total ?? htxItems.length);
  const mineItems = Array.isArray(mineRes.data?.items) ? mineRes.data.items : [];
  const mineTotal = Number(mineRes.data?.total ?? mineItems.length);

  const activeItems = tab === 'mine' ? mineItems : htxItems;
  const activeTotal = tab === 'mine' ? mineTotal : htxTotal;
  const selectedId = requestedId || activeItems[0]?.id || null;
  const queueItem = selectedId ? (htxItems.find((x) => x.id === selectedId) || null) : null;

  const myUserId = ctx.user?.id || null;
  const conflictCount = htxItems.filter((x) => !x.eligible).length;
  const claimedOpenCount = htxItems.filter((x) => x.mediatorId && x.mediatorId === myUserId).length;
  const unclaimedCount = htxItems.filter((x) => !x.mediatorId && x.eligible).length;

  function renderQueueBadge(item) {
    if (tab === 'mine') {
      const st = DISPUTE_STATUS[item.status] || [item.status, 'outline'];
      return ui.badge(st[0], st[1]);
    }
    if (!item.eligible) return ui.badge('Có xung đột', 'error');
    if (item.mediatorId && item.mediatorId === myUserId) return ui.badge('Đang hòa giải', 'info');
    return ui.badge('Chờ nhận', 'warn');
  }

  const listCard = ui.card({
    title: 'Hàng chờ hòa giải',
    actions: ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', size: 'sm', onClick: () => ctx.rerender() }),
    body: h('div', { class: 'stack-sm' },
      ui.tabs({
        items: [
          { value: 'cho', label: `Cần xử lý (${htxTotal})` },
          { value: 'cua-toi', label: `Tôi xử lý (${mineTotal})` },
        ],
        active: tab === 'mine' ? 'cua-toi' : 'cho',
        onChange(val) {
          ctx.go(url('htx', 'H-08', { hang: val === 'cua-toi' ? 'cua-toi' : null, tu: null, id: null }));
        },
      }),
      activeItems.length
        ? ui.list(activeItems.map((item) => {
          const reasonLabel = DISPUTE_REASONS[item.reason] || item.reason;
          const levelNote = item.mediationLevel === 'ADMIN' ? ' · Quản trị viên' : '';
          return ui.pick({
            title: h('span', { class: 'row row--between' },
              h('span', null, reasonLabel),
              renderQueueBadge(item)),
            meta: `Đơn ${shortId(item.bookingId)} · ${ui.fmt.dateTime(Date.parse(item.createdAt))}${levelNote}`,
            selected: item.id === selectedId,
            control: 'none',
            icon: 'scales',
            onSelect: () => ctx.go(url('htx', 'H-08', { hang: tab === 'mine' ? 'cua-toi' : null, tu: offset || null, id: item.id })),
          });
        }))
        : ui.empty({
          icon: 'scales',
          title: tab === 'mine' ? 'Chưa có vụ việc bạn xử lý' : 'Không có vụ việc chờ HTX hòa giải',
          text: tab === 'mine'
            ? 'Vụ việc bạn đã nhận hòa giải hoặc đang xử lý sẽ hiện tại đây.'
            : 'Khi nông dân hoặc chủ máy mở khiếu nại thuộc đơn của HTX ở cấp hòa giải đầu tiên, vụ việc sẽ xuất hiện trong hàng chờ.',
        }),
      (offset > 0 || offset + activeItems.length < activeTotal)
        ? h('div', { class: 'row row--between' },
          offset > 0
            ? ui.button({
              label: 'Trang trước',
              icon: 'arrow-left',
              kind: 'ghost',
              size: 'sm',
              href: url('htx', 'H-08', { hang: tab === 'mine' ? 'cua-toi' : null, tu: Math.max(0, offset - DISPUTE_PAGE) || null }),
            })
            : h('span'),
          offset + activeItems.length < activeTotal
            ? ui.button({
              label: 'Trang sau',
              icon: 'arrow-right',
              kind: 'ghost',
              size: 'sm',
              href: url('htx', 'H-08', { hang: tab === 'mine' ? 'cua-toi' : null, tu: offset + DISPUTE_PAGE }),
            })
            : h('span'))
        : null),
  });

  async function renderDetailColumn() {
    if (!selectedId) {
      return ui.empty({
        icon: 'scales',
        title: 'Chưa chọn vụ việc',
        text: 'Chọn một vụ việc ở danh sách bên cạnh để kiểm tra điều kiện, nhận hòa giải hoặc chuyển cấp quản trị.',
      });
    }

    if (queueItem && !canInspectHtxDisputeDetail(queueItem, myUserId)) {
      if (!queueItem.eligible || queueItem.conflictCode) {
        const conflictText = htxConflictLabel(queueItem.conflictCode);
        return h('div', { class: 'stack' },
          ui.card({
            title: `Vụ việc ${shortId(queueItem.id)}`,
            actions: ui.badge('Không đủ điều kiện', 'error'),
            body: h('div', { class: 'stack-sm' },
              ui.banner({
                tone: 'error',
                title: 'Phải từ chối và chuyển lên quản trị viên',
                text: `${conflictText}. Hệ thống khóa xem chi tiết, bằng chứng và phương án đối với HTX có xung đột lợi ích.`,
              }),
              ui.kv([
                ['Mã vụ việc', h('span', { class: 'mono' }, queueItem.id)],
                ['Mã đơn', h('span', { class: 'mono' }, queueItem.bookingId)],
                ['Lý do khiếu nại', DISPUTE_REASONS[queueItem.reason] || queueItem.reason],
                ['Cấp hòa giải', 'HTX (cần chuyển quản trị viên)'],
                ['Xung đột ghi nhận', conflictText],
                ['Mở lúc', ui.fmt.dateTime(Date.parse(queueItem.createdAt))],
              ])),
          }),
          ui.card({
            title: 'Từ chối và chuyển cấp quản trị viên',
            subtitle: 'Không thể nhận hòa giải cho chính mình hoặc HTX khác khi có xung đột.',
            body: buildEscalationForm({
              ctx,
              disputeId: queueItem.id,
              defaultConflictType: queueItem.conflictCode,
              noteText: 'Sau khi chuyển cấp, vụ việc sẽ được giao cho quản trị viên nền tảng xử lý độc lập.',
            }),
          }));
      }

      const claimFeedback = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
      let claimBusy = false;
      const claimBtn = ui.button({
        label: 'Nhận hòa giải vụ việc này',
        icon: 'scales',
        kind: 'primary',
        block: true,
        async onClick() {
          if (claimBusy) return;
          claimBusy = true;
          claimBtn.disabled = true;
          claimBtn.setAttribute('aria-busy', 'true');
          claimFeedback.hidden = true;
          claimFeedback.textContent = '';
          try {
            await ctx.api.request('POST', `/api/disputes/${queueItem.id}/htx-mediator`, {
              auth: true,
              body: {},
            });
            ctx.toast('Đã nhận hòa giải cấp HTX', 'ok');
            ctx.rerender();
          } catch (error) {
            if (!ctx.stale()) ui.clearToasts();
            claimFeedback.textContent = coopErrorText(error);
            claimFeedback.hidden = false;
          } finally {
            claimBusy = false;
            claimBtn.disabled = false;
            claimBtn.removeAttribute('aria-busy');
          }
        },
      });

      return h('div', { class: 'stack' },
        ui.card({
          title: `Vụ việc ${shortId(queueItem.id)}`,
          actions: ui.badge('Đủ điều kiện HTX', 'info'),
          body: h('div', { class: 'stack-sm' },
            ui.note({
              tone: 'info',
              text: 'Chỉ sau khi nhận hòa giải, HTX mới được xem diễn biến chi tiết, ảnh bằng chứng và gửi phương án theo phiên bản. Nếu có quan hệ gia đình, lợi ích hoặc lý do khách quan, hãy từ chối và chuyển lên quản trị viên.',
            }),
            ui.kv([
              ['Mã vụ việc', h('span', { class: 'mono' }, queueItem.id)],
              ['Mã đơn', h('span', { class: 'mono' }, queueItem.bookingId)],
              ['Lý do khiếu nại', DISPUTE_REASONS[queueItem.reason] || queueItem.reason],
              ['Trạng thái', 'Chờ HTX nhận hòa giải'],
              ['Mở lúc', ui.fmt.dateTime(Date.parse(queueItem.createdAt))],
            ])),
        }),
        ui.card({
          title: 'Nhận hòa giải cấp HTX',
          subtitle: 'Tự nhận hòa giải cho tài khoản HTX hiện tại; không thể nhận thay cho HTX khác.',
          body: h('div', { class: 'stack-sm' }, claimBtn, claimFeedback),
        }),
        ui.card({
          title: 'Từ chối và chuyển quản trị viên',
          subtitle: 'Dùng khi HTX có quan hệ liên quan, xung đột thực tế hoặc các bên yêu cầu chuyển cấp.',
          body: buildEscalationForm({
            ctx,
            disputeId: queueItem.id,
            defaultConflictType: 'AFFILIATION_CONFLICT',
          }),
        }));
    }

    let detailRes;
    let propRes;
    let evRes;
    try {
      [detailRes, propRes, evRes] = await Promise.all([
        ctx.api.request('GET', `/api/disputes/${selectedId}`, { auth: true }),
        ctx.api.request('GET', `/api/disputes/${selectedId}/proposals`, { auth: true }),
        ctx.api.request('GET', `/api/disputes/${selectedId}/evidence?limit=20&offset=0`, { auth: true }),
      ]);
    } catch (error) {
      if (ctx.stale()) return h('div');
      if (error?.status === 403 || error?.status === 404) {
        ui.clearToasts();
        return ui.empty({
          icon: 'prohibit',
          title: 'Không có quyền xem chi tiết vụ việc',
          text: 'Chỉ hòa giải viên HTX đang phụ trách hợp lệ (hoặc các bên liên quan) mới được xem chi tiết, bằng chứng và phương án. Vụ việc chưa nhận, đã chuyển lên quản trị viên hoặc thuộc HTX khác sẽ bị khóa.',
          action: ui.button({ label: 'Về hàng chờ hòa giải', kind: 'primary', href: url('htx', 'H-08') }),
        });
      }
      throw error;
    }
    if (ctx.stale()) return h('div');

    const dispute = detailRes.data?.dispute;
    if (!dispute) {
      return invalidIdEmpty('Không tìm thấy vụ việc', 'Vụ việc không tồn tại hoặc bạn không có quyền xem.', 'Về hàng chờ hòa giải', url('htx', 'H-08'));
    }

    const events = Array.isArray(detailRes.data?.events) ? detailRes.data.events : [];
    const escalations = Array.isArray(detailRes.data?.escalations) ? detailRes.data.escalations : [];
    const remedyDispute = propRes.data?.dispute || null;
    const proposals = Array.isArray(propRes.data?.proposals) ? propRes.data.proposals : [];
    const remedyEvents = Array.isArray(propRes.data?.events) ? propRes.data.events : [];
    const evidenceItems = Array.isArray(evRes.data?.items) ? evRes.data.items : [];
    const evidenceTotal = Number(evRes.data?.total ?? evidenceItems.length);

    const latestVersion = proposals.length ? proposals[proposals.length - 1].version : 0;
    const isActiveMediator = dispute.status === 'OPEN'
      && dispute.mediationLevel === 'HTX'
      && dispute.mediatorId === myUserId;

    const statusMeta = DISPUTE_STATUS[dispute.status] || [dispute.status, 'outline'];
    const levelLabel = dispute.mediationLevel === 'ADMIN' ? 'Quản trị viên nền tảng' : 'Hòa giải cấp HTX';

    function actorName(id) {
      if (!id) return 'Hệ thống';
      if (id === myUserId) return 'Bạn, HTX hòa giải';
      if (id === dispute.claimantId) return 'Bên khiếu nại';
      if (id === dispute.respondentId) return 'Bên bị khiếu nại';
      return `Người dùng ${shortId(id)}`;
    }

    let freezeBanner;
    if (dispute.status === 'OPEN') {
      freezeBanner = ui.banner({
        tone: 'warn',
        title: 'Vụ việc đang mở',
        text: 'Các thao tác nghiệm thu và báo thanh toán của đơn tạm khóa. Hai bên tự đồng ý độc lập trên phiên bản mới nhất; HTX không đồng ý thay, không tự đóng chưa giải quyết và nền tảng không giữ hay chuyển tiền.',
      });
    } else if (dispute.status === 'RESOLVED') {
      freezeBanner = ui.banner({
        tone: 'success',
        title: 'Hai bên đã đồng ý hòa giải',
        text: 'Phương án hòa giải đã được cả hai bên tự đồng ý độc lập. Nền tảng không tự động trừ hay chuyển tiền.',
      });
    } else {
      const closeReason = remedyDispute?.closureReason || dispute.closureReason;
      freezeBanner = ui.banner({
        tone: 'error',
        title: 'Đã đóng chưa giải quyết',
        text: closeReason
          ? `Quản trị viên đã đóng chưa giải quyết: ${closeReason}`
          : 'Quản trị viên đã đóng vụ việc ở trạng thái chưa giải quyết.',
      });
    }

    const timelineRows = [
      ...events.map((ev) => {
        const evType = ev.type || ev.eventType;
        return {
          at: Date.parse(ev.createdAt),
          title: `${CASE_EVENTS[evType] || evType} (${actorName(ev.actorId)})`,
          meta: [ui.fmt.dateTime(Date.parse(ev.createdAt)), ev.data?.details || ev.data?.text || ''].filter(Boolean).join(' · '),
          done: true,
        };
      }),
      ...escalations.map((esc) => ({
        at: Date.parse(esc.createdAt),
        title: 'Chuyển cấp lên quản trị viên nền tảng',
        meta: [
          ui.fmt.dateTime(Date.parse(esc.createdAt)),
          esc.conflictType ? htxConflictLabel(esc.conflictType) : null,
          esc.reason,
        ].filter(Boolean).join(' · '),
        done: true,
      })),
    ].sort((a, b) => a.at - b.at);

    const proposalBlocks = proposals.length
      ? proposals.map((p) => {
        const isLatest = p.version === latestVersion;
        const staleMediator = Boolean(dispute.mediatorId && p.mediatorId && p.mediatorId !== dispute.mediatorId);
        const consents = Array.isArray(p.consents) ? p.consents : [];
        const claimantConsent = consents.find((c) => c.actorId === dispute.claimantId) || (p.claimantConsentedAt ? { at: p.claimantConsentedAt } : null);
        const respondentConsent = consents.find((c) => c.actorId === dispute.respondentId) || (p.respondentConsentedAt ? { at: p.respondentConsentedAt } : null);
        return h('div', { class: 'card card--flat stack-sm' },
          h('div', { class: 'row row--between' },
            h('strong', null, `Phương án v${p.version}`),
            h('div', { class: 'htx-tags' },
              isLatest ? ui.badge('Mới nhất', 'info') : ui.badge('Đã thay thế', 'muted'),
              staleMediator ? ui.badge('Từ hòa giải viên cũ', 'warn') : null)),
          h('p', null, p.text),
          h('p', { class: 'small muted' }, `Đề xuất lúc ${ui.fmt.dateTime(Date.parse(p.createdAt))}`),
          h('div', { class: 'htx-tags' },
            ui.badge(
              claimantConsent ? 'Bên khiếu nại đã đồng ý' : 'Chờ bên khiếu nại',
              claimantConsent ? 'ok' : 'warn',
            ),
            ui.badge(
              respondentConsent ? 'Bên bị khiếu nại đã đồng ý' : 'Chờ bên bị khiếu nại',
              respondentConsent ? 'ok' : 'warn',
            )));
      })
      : [h('p', { class: 'muted' }, 'Chưa có phương án hòa giải nào được gửi.')];

    const proposalForm = isActiveMediator ? apiForm({
      fields: [
        ui.field({
          label: 'Nội dung phương án hòa giải',
          hint: `Gửi đề xuất mới sẽ tạo phiên bản v${latestVersion + 1}. Hai bên tự đọc và đồng ý độc lập; HTX không đồng ý thay.`,
          input: ui.textarea({
            name: 'text',
            rows: 3,
            maxlength: MAX_DISPUTE_TEXT,
            value: proposalDrafts.get(dispute.id) || '',
            on: {
              input(e) {
                proposalDrafts.set(dispute.id, e.target.value);
              },
            },
          }),
          required: true,
        }),
      ],
      submitLabel: `Gửi phương án v${latestVersion + 1}`,
      submitKind: 'primary',
      async run(formData) {
        const check = mediationProposalInput(formData.get('text'));
        if (check.error) throw new Error(check.error);
        try {
          return await ctx.api.request('POST', `/api/disputes/${dispute.id}/proposals`, {
            auth: true,
            body: check.payload,
          });
        } catch (error) {
          throw new Error(coopErrorText(error), { cause: error });
        }
      },
      onDone() {
        proposalDrafts.delete(dispute.id);
        ctx.toast(`Đã gửi phương án v${latestVersion + 1}`, 'ok');
        ctx.rerender();
      },
    }) : null;

    return h('div', { class: 'stack' },
      ui.card({
        title: `Chi tiết vụ việc ${shortId(dispute.id)}`,
        actions: h('div', { class: 'htx-tags' },
          ui.badge(levelLabel, dispute.mediationLevel === 'ADMIN' ? 'info' : 'outline'),
          ui.badge(statusMeta[0], statusMeta[1])),
        body: h('div', { class: 'stack-sm' },
          freezeBanner,
          ui.kv([
            ['Mã vụ việc', h('span', { class: 'mono' }, dispute.id)],
            ['Mã đơn', h('span', { class: 'mono' }, dispute.bookingId)],
            ['Lý do khiếu nại', DISPUTE_REASONS[dispute.reason] || dispute.reason],
            ['Cấp hòa giải', levelLabel],
            ['Hòa giải viên', dispute.mediatorId ? actorName(dispute.mediatorId) : 'Chưa chỉ định'],
            ['Mở lúc', ui.fmt.dateTime(Date.parse(dispute.createdAt))],
            dispute.escalatedAt ? ['Chuyển cấp lúc', ui.fmt.dateTime(Date.parse(dispute.escalatedAt))] : null,
            dispute.escalationConflictType ? ['Lý do chuyển cấp', htxConflictLabel(dispute.escalationConflictType)] : null,
            dispute.escalationReason ? ['Ghi chú chuyển cấp', dispute.escalationReason] : null,
          ])),
      }),
      ui.card({
        title: 'Diễn biến vụ việc',
        body: timelineRows.length
          ? ui.timeline(timelineRows)
          : h('p', { class: 'muted' }, 'Chưa có sự kiện nào.'),
      }),
      ui.card({
        title: 'Bằng chứng ảnh (chỉ xem)',
        subtitle: 'HTX hòa giải chỉ xem bằng chứng từ các bên, không tải lên hoặc xóa ảnh.',
        body: htxEvidenceViewer({ ctx, items: evidenceItems, total: evidenceTotal }),
      }),
      ui.card({
        title: 'Phương án hòa giải theo phiên bản',
        subtitle: 'Chỉ hai bên tranh chấp tự đồng ý độc lập; không phát sinh chuyển tiền tự động.',
        body: h('div', { class: 'stack-sm' },
          ...proposalBlocks,
          remedyEvents.length ? h('details', null,
            h('summary', { class: 'small muted' }, `Nhật ký phương án (${remedyEvents.length} sự kiện)`),
            ui.timeline(remedyEvents.map((ev) => {
              const evType = ev.event_type || ev.eventType;
              const actorId = ev.actor_id || ev.actorId;
              const version = ev.version ?? ev.proposalVersion;
              const createdAt = ev.created_at || ev.createdAt;
              return {
                title: `${PROPOSAL_EVENTS[evType] || evType} (${actorName(actorId)})`,
                meta: [version !== null && version !== undefined ? `Phiên bản v${version}` : null, ui.fmt.dateTime(Date.parse(createdAt))].filter(Boolean).join(' · '),
                done: true,
              };
            }))) : null),
      }),
      isActiveMediator ? ui.card({
        title: 'Đề xuất phương án mới',
        body: h('div', { class: 'stack-sm' },
          proposalForm,
          h('details', null,
            h('summary', { class: 'small muted' }, 'Không thể tiếp tục hòa giải? Chuyển lên quản trị viên nền tảng'),
            h('div', { class: 'stack-sm' },
              buildEscalationForm({
                ctx,
                disputeId: dispute.id,
                defaultConflictType: 'RECUSAL_REQUEST',
                noteText: 'Khi chuyển lên quản trị viên, quyền xem chi tiết và gửi phương án của HTX trên vụ việc này sẽ kết thúc ngay.',
              })))),
      }) : ui.card({
        title: 'Trạng thái thao tác hòa giải',
        body: ui.note({
          tone: 'info',
          text: dispute.status !== 'OPEN'
            ? 'Vụ việc đã kết thúc nên không thể gửi thêm phương án.'
            : dispute.mediationLevel === 'ADMIN'
              ? 'Vụ việc đã được chuyển lên quản trị viên nền tảng xử lý.'
              : 'Bạn chỉ xem được chi tiết ở chế độ chỉ đọc hoặc vụ việc không còn do bạn trực tiếp hòa giải.',
        }),
      }));
  }

  const detailPanel = await renderDetailColumn();
  if (ctx.stale()) return h('div');

  return h('div', { class: 'stack htx' },
    ui.screenHead({
      title: 'Hòa giải cấp HTX',
      sub: 'Kiểm tra xung đột lợi ích, tự nhận hòa giải vụ việc đủ điều kiện, xem bằng chứng và đề xuất phương án theo phiên bản.',
      actions: [
        ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() }),
      ],
    }),
    ui.summaryLine([
      ['Chờ nhận HTX', unclaimedCount],
      ['Bạn đang hòa giải', claimedOpenCount],
      ['Có xung đột', conflictCount],
      ['Tổng đã xử lý / đang giữ', mineTotal],
    ]),
    ui.note({
      tone: 'info',
      text: 'Nguyên tắc hòa giải cấp HTX: không nhận thay HTX khác, từ chối và chuyển cấp ngay khi có xung đột lợi ích, không đồng ý thay các bên, không tự đóng chưa giải quyết và không giữ hay chuyển tiền.',
    }),
    h('div', { class: 'htx-cols' }, listCard, detailPanel));
}

export const screens = [
  { code: 'H-02', title: 'Hàng chờ đơn', render: queueScreen },
  { code: 'H-03', title: 'Bàn gom cụm', render: groupScreen },
  { code: 'H-04', title: 'Thẩm định thực địa', render: inspectionScreen },
  { code: 'H-05', title: 'Chào việc', render: packageDetailScreen },
  { code: 'H-06', title: 'Giám sát hiện trường', render: shiftsScreen },
  { code: 'H-07', title: 'Sự cố', render: postponementScreen },
  { code: 'H-08', title: 'Hòa giải', render: mediationScreen },
];
