// Màn nông dân F-01..F-15 dùng API thật. Dữ liệu mô phỏng có nhãn riêng.
import { ApiError, newIdempotencyKey } from '../../api.js';
import { ui } from '../kit/ui.js';
import { labels as R } from '../kit/labels.js';
import { apiButton, apiForm, assumedBadge, errorText } from '../app/actions.js';
import { url } from '../app/routes.js';
import { farmerDepositScreen } from './deposits.js';
import { boundaryEditor } from './field-boundary.js';

const h = ui.h;
const fmt = ui.fmt;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FIELD_AREA_M2 = 10000000;
const MAX_BOOKING_SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const LOCAL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const VND_POSITIVE_RE = /^[1-9][0-9]{0,14}$/;
const REFERENCE_RE = /^[A-Za-z0-9._-]{4,64}$/;
const MAX_TEXT_LEN = 2000;

const BOOKING_EVENT_LABELS = {
  BOOKING_REQUESTED: 'Gửi yêu cầu đặt dịch vụ',
  COORDINATOR_ASSIGNED: 'Ủy quyền HTX điều phối',
  BOOKING_GROUPED: 'Gom đơn vào gói việc',
  BOOKING_ASSIGNED: 'Chủ máy nhận gói việc',
  BOOKING_CANCELLED: 'Hủy đơn',
};

const PACKAGE_STATUS_LABELS = {
  OPEN: 'Đang mở nhận',
  CLAIMED: 'Đã có chủ máy nhận',
  CANCELLED: 'Đã hủy',
};

const DISPUTE_REASONS = {
  AREA_MISMATCH: 'Diện tích không khớp',
  QUALITY: 'Chất lượng công việc',
  NO_SHOW: 'Không có mặt',
  PAYMENT: 'Thanh toán',
  OTHER: 'Lý do khác',
};

const DISPUTE_STATUS_LABELS = {
  OPEN: 'Đang mở',
  RESOLVED: 'Đã giải quyết',
  CLOSED_UNRESOLVED: 'Đóng chưa giải quyết',
  CLOSED: 'Đã đóng',
};

const DISPUTE_FREEZE_NOTES = {
  OPEN: 'Vụ việc đang mở. Nghiệm thu và ghi nhận chuyển tiền tạm dừng cho đến khi giải quyết xong.',
  CLOSED_UNRESOLVED: 'Đóng chưa giải quyết. Nghiệm thu và ghi nhận chuyển tiền vẫn đang chặn. Đây không phải thỏa thuận hay công nợ.',
  RESOLVED: 'Hai bên đã đồng ý phương án. Đồng ý không tự hoàn tiền hay sửa số liệu thanh toán.',
  CLOSED: 'Vụ việc đã đóng. Không thể thao tác thêm.',
};

const DISPUTE_EVENT_LABELS = {
  DISPUTE_OPENED: 'Mở khiếu nại',
  RESPONSE_ADDED: 'Phản hồi',
  MEDIATOR_ASSIGNED: 'Phân công người hòa giải',
  MEDIATION_ESCALATED: 'Chuyển cấp lên Quản trị độc lập',
};

const MEDIATION_LEVEL_LABELS = {
  HTX: 'Cấp HTX (hòa giải sơ cấp)',
  ADMIN: 'Cấp Quản trị độc lập',
};

const MEDIATION_LEVEL_BADGE = {
  HTX: ['Cấp HTX', 'info'],
  ADMIN: ['Cấp Quản trị', 'warn'],
};

const CONFLICT_TYPE_LABELS = {
  PARTY_REQUEST: 'Yêu cầu chuyển cấp từ bên liên quan',
  AFFILIATION_CONFLICT: 'Có quan hệ gia đình, làm ăn hoặc thân quen với HTX',
  PARTY_CONFLICT: 'HTX là bên liên quan trực tiếp trong đơn',
  ROLE_OVERLAP: 'HTX kiêm nhiệm chủ máy hoặc thợ lái',
  MACHINE_CONFLICT: 'HTX có sở hữu máy móc liên quan',
  RECUSAL_REQUEST: 'Người hòa giải tự rút',
};

const FARMER_REFUSALS = {
  ALREADY_ESCALATED: 'Vụ việc đã được chuyển lên Quản trị viên độc lập trước đó. Tải lại để xem trạng thái mới.',
  DISPUTE_NOT_OPEN: 'Vụ việc không còn ở trạng thái đang mở nên không thể thao tác thêm.',
  STALE_VERSION: 'Đã có phiên bản phương án mới hơn. Tải lại để xem phiên bản mới nhất.',
  MEDIATOR_CHANGED: 'Người hòa giải đã thay đổi hoặc vụ việc vừa chuyển cấp. Tải lại để chờ phương án mới.',
  RECUSAL_REQUIRED: 'Người hòa giải không đủ điều kiện độc lập với các bên của đơn.',
  ESCALATION_REQUIRED: 'Vụ việc đang ở cấp HTX, cần chuyển cấp trước khi quản trị viên tiếp nhận.',
  VALIDATION_FAILED: 'Thông tin gửi lên chưa hợp lệ. Kiểm tra lại nội dung và độ dài.',
  NOT_FOUND: 'Không tìm thấy dữ liệu hoặc bạn không có quyền thực hiện.',
  FORBIDDEN: 'Tài khoản này không có quyền thực hiện thao tác này.',
};

const PROPOSAL_EVENT_LABELS = {
  PROPOSED: 'Đề xuất phương án',
  CONSENTED: 'Đồng ý phương án',
  RESOLVED: 'Hai bên đã đồng ý',
  CLOSED_UNRESOLVED: 'Đóng chưa giải quyết',
};

const IMAGE_TYPES = { 'image/jpeg': 'JPEG', 'image/png': 'PNG' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EVIDENCE_PAGE = 20;

// Trang thai trong bo nho phien (khong dung browser storage).
const mem = {
  congM2: R.CONG_CUT_M2,
  bookingDraft: { fieldId: '', serviceId: '', startLocal: '', endLocal: '' },
};
const bookingTracker = createAttemptTracker();
const pendingPayments = new Map();

/* ---------- Ham thuan tuy (de kiem thu don vi) ---------- */

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function farmerRefusalMessage(error) {
  if (error instanceof ApiError && Object.hasOwn(FARMER_REFUSALS, error.code)) {
    return FARMER_REFUSALS[error.code];
  }
  return errorText(error);
}

export function inspectionSummary(readinessData, inspectionsData) {
  const r = readinessData?.readiness || null;
  const confirmed = Boolean(r);
  const allReady = Boolean(r && r.drained && r.mature && r.intakeReady);
  const declarationBadge = !confirmed
    ? ['Chưa khai báo', 'idle']
    : allReady
      ? ['Đã khai báo đủ 3 mục', 'ok']
      : ['Khai báo chưa đủ điều kiện', 'warn'];

  const latest = inspectionsData?.latest || null;
  const passed = Boolean(inspectionsData?.passed || (latest && latest.result === 'PASSED' && !latest.stale));
  let status = 'PENDING';
  let inspectionBadge = ['Chưa kiểm tra thực địa', 'idle'];
  if (passed) {
    status = 'PASSED';
    inspectionBadge = ['HTX đã kiểm tra đạt', 'ok'];
  } else if (latest?.stale) {
    status = 'STALE';
    inspectionBadge = ['Cần HTX kiểm tra lại', 'warn'];
  } else if (latest?.result === 'FAILED') {
    status = 'FAILED';
    inspectionBadge = ['HTX kiểm tra chưa đạt', 'error'];
  }

  return {
    declaration: {
      confirmed,
      allReady,
      badge: declarationBadge,
      confirmedAt: r?.confirmedAt || null,
      flags: {
        drained: Boolean(r?.drained),
        mature: Boolean(r?.mature),
        intakeReady: Boolean(r?.intakeReady),
      },
    },
    inspection: {
      status,
      passed,
      stale: Boolean(latest?.stale),
      result: latest?.result || null,
      badge: inspectionBadge,
      reviewerName: latest?.reviewerName || null,
      createdAt: latest?.createdAt || null,
      reason: latest?.reason || null,
      history: Array.isArray(inspectionsData?.history) ? inspectionsData.history : [],
    },
  };
}

export function canEscalateDispute(user, dispute) {
  if (!user?.id || !dispute) return false;
  if (dispute.status !== 'OPEN' || dispute.mediationLevel !== 'HTX') return false;
  return user.id === dispute.claimantId || user.id === dispute.respondentId;
}

export function escalationInput({ reason, conflictType } = {}) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  const len = [...trimmed].length;
  if (len < 1) return { error: 'Nhập lý do yêu cầu chuyển cấp lên Quản trị.', payload: null };
  if (len > MAX_TEXT_LEN) return { error: 'Lý do tối đa 2.000 ký tự.', payload: null };
  if (conflictType !== undefined && conflictType !== null && conflictType !== '') {
    if (typeof conflictType !== 'string' || !Object.hasOwn(CONFLICT_TYPE_LABELS, conflictType)) {
      return { error: 'Loại lý do chuyển cấp không hợp lệ.', payload: null };
    }
    return { error: null, payload: { reason: trimmed, conflictType } };
  }
  return { error: null, payload: { reason: trimmed } };
}

export function partyConsentRows(dispute, proposal) {
  if (!dispute || !proposal || !Array.isArray(proposal.consents)) return [];
  const byActor = new Map(proposal.consents.map((c) => [c.actorId, c.at]));
  return [
    { role: 'claimant', label: 'Bên khiếu nại', actorId: dispute.claimantId, done: byActor.has(dispute.claimantId), at: byActor.get(dispute.claimantId) || null },
    { role: 'respondent', label: 'Bên bị khiếu nại', actorId: dispute.respondentId, done: byActor.has(dispute.respondentId), at: byActor.get(dispute.respondentId) || null },
  ];
}

export function areaFromM2Input(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const clean = String(raw).trim();
  if (!/^\d+$/.test(clean)) return null;
  const num = Number(clean);
  return Number.isSafeInteger(num) && num > 0 && num <= MAX_FIELD_AREA_M2 ? num : null;
}

export function quoteTotalVnd(pricePerHaVnd, areaM2) {
  return ((BigInt(pricePerHaVnd) * BigInt(areaM2) + 5000n) / 10000n).toString();
}

export function createAttemptTracker() {
  let pending = null;
  return {
    current: () => pending,
    start(payload) {
      pending = { key: newIdempotencyKey(), payload: JSON.stringify(payload), uncertain: false };
      return pending;
    },
    mark(uncertain) {
      if (pending) pending.uncertain = Boolean(uncertain);
    },
    clear() {
      pending = null;
    },
  };
}

export function bookingAttempt(tracker, payload, { newAttempt = false } = {}) {
  const current = tracker.current();
  const encoded = JSON.stringify(payload);
  if (current && !newAttempt) {
    if (current.payload === encoded) return current;
    return { blocked: true, pending: current };
  }
  return tracker.start(payload);
}

export function stepKey(booking, details = {}) {
  if (!booking) return 'REQUESTED';
  if (booking.state === 'CANCELLED') return 'CANCELLED';
  if (booking.state === 'ASSIGNED' && details?.acceptance?.acceptance) return 'acceptance';
  return booking.state;
}

export function nextStep(booking, details = {}) {
  if (!booking || booking.state === 'CANCELLED') return null;
  const id = booking.id;
  const dispute = details?.dispute;
  if (dispute && (dispute.status === 'OPEN' || dispute.status === 'CLOSED_UNRESOLVED')) {
    return {
      mine: true,
      who: 'Cần xử lý',
      title: dispute.status === 'OPEN' ? 'Đơn đang có khiếu nại mở' : 'Đơn đóng chưa giải quyết tranh chấp',
      text: 'Ghi nhận nghiệm thu và chuyển tiền tạm dừng cho đến khi vụ việc được giải quyết.',
      code: 'F-13',
      ctaLabel: 'Xem khiếu nại',
      params: { id: dispute.id },
    };
  }
  if (details?.postponement?.canConsent) {
    return {
      mine: true,
      who: 'Việc của bạn',
      title: 'Có đề xuất dời lịch cần xác nhận',
      text: 'Đơn thuộc gói đang đề xuất đổi khung giờ. Xem khung giờ mới và xác nhận.',
      code: 'F-15',
      ctaLabel: 'Xem đề xuất dời lịch',
      params: { id },
    };
  }
  if (booking.state === 'REQUESTED') {
    const coord = details?.coordinator;
    if (coord?.canAssign && !coord.coordinatorId) {
      return {
        mine: true,
        who: 'Việc của bạn',
        title: 'Ủy quyền HTX gom đơn',
        text: 'Chọn một HTX điều phối để gom thửa ruộng của bạn vào gói việc.',
        code: 'F-07',
        ctaLabel: 'Chọn HTX ủy quyền',
        params: { id },
      };
    }
    return {
      mine: false,
      who: 'Chờ HTX',
      title: coord?.coordinatorId ? 'Đã ủy quyền HTX, chờ gom gói' : 'Đã gửi yêu cầu',
      text: 'HTX sẽ gom các thửa gần nhau thành gói việc trước khi chào chủ máy.',
      code: null,
      ctaLabel: null,
      params: null,
    };
  }
  if (booking.state === 'GROUPED') {
    const rd = details?.readiness;
    const allReady = Boolean(rd?.readiness && rd.readiness.drained && rd.readiness.mature && rd.readiness.intakeReady);
    if (rd?.canConfirm && !allReady) {
      return {
        mine: true,
        who: 'Việc của bạn',
        title: 'Xác nhận ruộng sẵn sàng',
        text: 'Xác nhận tình trạng nước, lúa chín và nơi nhận lúa trước khi thợ lái bắt đầu ca.',
        code: 'F-08',
        ctaLabel: 'Xác nhận ruộng sẵn sàng',
        params: { id },
      };
    }
    const insp = details?.inspections;
    if (allReady && insp) {
      if (insp.latest?.result === 'FAILED' && !insp.latest.stale) {
        return {
          mine: true,
          who: 'Cần xem lại',
          title: 'HTX kiểm tra thực địa chưa đạt',
          text: insp.latest.reason
            ? `Lý do: ${insp.latest.reason}. Khắc phục và cập nhật lại xác nhận ruộng nếu cần.`
            : 'HTX ghi nhận thực địa chưa đạt. Kiểm tra lại và cập nhật xác nhận ruộng nếu đã khắc phục.',
          code: 'F-08',
          ctaLabel: 'Xem kiểm tra & xác nhận ruộng',
          params: { id },
        };
      }
      if (!insp.passed) {
        return {
          mine: false,
          who: 'Chờ HTX',
          title: insp.latest?.stale ? 'Chờ HTX kiểm tra lại thực địa' : 'Đã khai báo ruộng, chờ HTX kiểm tra',
          text: insp.latest?.stale
            ? 'Xác nhận ruộng hoặc lịch gói vừa thay đổi nên kết quả kiểm tra cũ đã hết hiệu lực. Chờ HTX kiểm tra lại.'
            : 'HTX cần kiểm tra thực địa đạt trước khi thợ lái bắt đầu ca máy.',
          code: null,
          ctaLabel: null,
          params: null,
        };
      }
      return {
        mine: false,
        who: 'Chờ chủ máy',
        title: 'Ruộng đã sẵn sàng và HTX kiểm tra đạt',
        text: 'Gói việc đã đủ điều kiện sẵn sàng, đang chờ chủ máy nhận và phân công thợ lái.',
        code: null,
        ctaLabel: null,
        params: null,
      };
    }
    return {
      mine: false,
      who: 'Chờ chủ máy',
      title: 'Đã gom vào gói, chờ chủ máy nhận',
      text: 'Gói việc đang mở để chủ máy nhận máy và thợ lái.',
      code: null,
      ctaLabel: null,
      params: null,
    };
  }
  if (booking.state === 'ASSIGNED') {
    const acc = details?.acceptance?.acceptance;
    if (!acc) {
      const rd = details?.readiness;
      const allReady = Boolean(rd?.readiness && rd.readiness.drained && rd.readiness.mature && rd.readiness.intakeReady);
      if (rd?.canConfirm && !allReady) {
        return {
          mine: true,
          who: 'Việc của bạn',
          title: 'Xác nhận ruộng sẵn sàng cho máy',
          text: 'Chủ máy đã nhận gói. Hoàn tất xác nhận 3 điều kiện ruộng để thợ lái mở ca.',
          code: 'F-08',
          ctaLabel: 'Xác nhận ruộng',
          params: { id },
        };
      }
      const insp = details?.inspections;
      if (allReady && insp) {
        if (insp.latest?.result === 'FAILED' && !insp.latest.stale) {
          return {
            mine: true,
            who: 'Cần xem lại',
            title: 'HTX kiểm tra thực địa chưa đạt',
            text: insp.latest.reason
              ? `Lý do: ${insp.latest.reason}. Thợ lái chưa mở ca được cho đến khi thực địa đạt.`
              : 'HTX kiểm tra thực địa chưa đạt. Xem lý do và cập nhật xác nhận ruộng sau khi khắc phục.',
            code: 'F-08',
            ctaLabel: 'Xem kiểm tra & xác nhận ruộng',
            params: { id },
          };
        }
        if (!insp.passed) {
          return {
            mine: false,
            who: 'Chờ HTX',
            title: insp.latest?.stale ? 'Chờ HTX kiểm tra lại thực địa' : 'Đã khai báo ruộng, chờ HTX kiểm tra',
            text: 'HTX cần kiểm tra thực địa đạt thì thợ lái mới bắt đầu được ca máy.',
            code: null,
            ctaLabel: null,
            params: null,
          };
        }
      }
      return {
        mine: false,
        who: 'Chờ thực hiện',
        title: 'Đã có máy và thợ',
        text: 'Chờ hoàn thành ca gặt và chủ máy gửi đề nghị nghiệm thu.',
        code: null,
        ctaLabel: null,
        params: null,
      };
    }
    if (!acc.agreed) {
      if (!acc.consents?.owner) {
        return {
          mine: true,
          who: 'Việc của bạn',
          title: `Kiểm tra và đồng ý nghiệm thu (phiên bản ${acc.version})`,
          text: 'Chủ máy đã gửi số đo và số tiền nghiệm thu. Kiểm tra rồi đồng ý.',
          code: 'F-11',
          ctaLabel: 'Xem và đồng ý nghiệm thu',
          params: { id },
        };
      }
      return {
        mine: false,
        who: 'Chờ chủ máy',
        title: 'Bạn đã đồng ý nghiệm thu, chờ chủ máy',
        text: 'Hai bên cần đồng ý cùng phiên bản nghiệm thu trước khi ghi nhận thanh toán.',
        code: null,
        ctaLabel: null,
        params: null,
      };
    }
    const summary = details?.payments?.summary;
    const outstanding = summary?.outstandingVnd ? BigInt(summary.outstandingVnd) : 0n;
    if (outstanding > 0n) {
      const hasAvail = summary?.availableToReportVnd !== undefined && summary?.availableToReportVnd !== null;
      const avail = hasAvail ? BigInt(summary.availableToReportVnd) : outstanding;
      if (avail <= 0n) {
        return {
          mine: false,
          who: 'Chờ chủ máy',
          title: 'Đã ghi báo chuyển tiền, chờ chủ máy xác nhận',
          text: 'Khoản bạn báo chuyển ngoài hệ thống đang chờ chủ máy xác nhận đã nhận.',
          code: null,
          ctaLabel: null,
          params: null,
        };
      }
      return {
        mine: true,
        who: 'Việc của bạn',
        title: 'Ghi báo chuyển tiền ngoài hệ thống',
        text: 'Hai bên đã chốt nghiệm thu. Chuyển ngoài hệ thống rồi ghi báo số tiền và mã tham chiếu.',
        code: 'F-12',
        ctaLabel: 'Đi tới quyết toán',
        params: { id },
      };
    }
    return {
      mine: false,
      who: 'Hoàn tất',
      title: 'Đã chốt nghiệm thu và ghi nhận đủ thanh toán',
      text: 'Mọi khoản chuyển ngoài hệ thống đã được chủ máy xác nhận.',
      code: null,
      ctaLabel: null,
      params: null,
    };
  }
  return null;
}

/* ---------- Dinh dang va tien ich giao dien ---------- */

function wrap(...kids) {
  return h('div', { class: 'stack farmer' }, kids);
}

function fUrl(code, params) {
  return url('nong-dan', code, params);
}

function formatVnd(vndStr) {
  if (typeof vndStr !== 'string' && typeof vndStr !== 'number') return 'Chưa có';
  const clean = String(vndStr).trim();
  if (!/^-?\d+$/.test(clean)) return 'Chưa có';
  const neg = clean.startsWith('-');
  const abs = neg ? clean.slice(1) : clean;
  return `${neg ? '-' : ''}${abs.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;
}

function formatAreaM2(m2, congM2 = mem.congM2) {
  if (!Number.isSafeInteger(m2) || m2 <= 0) return 'Chưa rõ';
  const ha = m2 / 10000;
  return `${fmt.num(m2, 0)} m² (${fmt.area(ha, congM2)})`;
}

function formatIso(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? fmt.dateTime(ms) : String(iso || '');
}

function formatWindow(startAt, endAt) {
  return `${formatIso(startAt)} đến ${formatIso(endAt)}`;
}

// Date-only text stays calendar-exact: no Date parsing, so no timezone shift.
function formatDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : 'Chưa có';
}

// Optional harvest facts from F-05 hash params. Returns the payload fields, or null when a value is malformed.
export function cropFactsFromParams(params = {}) {
  const out = {};
  const crop = String(params.crop || '').trim();
  if (crop) {
    if ([...crop].length > 80) return null;
    out.cropVariety = crop;
  }
  for (const [key, field] of [['sow', 'sowDate'], ['harvest', 'harvestDate']]) {
    const value = params[key];
    if (!value) continue;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    if (date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) return null;
    out[field] = value;
  }
  if (out.sowDate && out.harvestDate && out.harvestDate < out.sowDate) return null;
  return out;
}

function localInputFromMs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToUtcIso(text) {
  const match = typeof text === 'string' ? LOCAL_TIME_RE.exec(text.trim()) : null;
  if (!match) return null;
  const [y, mo, d, hh, mi] = match.slice(1).map(Number);
  if (hh > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, hh, mi);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== hh || dt.getMinutes() !== mi) return null;
  return dt.toISOString();
}

function lines(rows) {
  return h('div', { class: 'farmer-lines' }, rows.filter(Boolean).map((r) => h('div', { class: 'farmer-line' + (r.strong ? ' farmer-line--strong' : '') },
    h('div', { class: 'grow', style: 'min-width:0' }, h('div', null, r.label), r.sub ? h('div', { class: 'small muted' }, r.sub) : null),
    r.text
      ? h('div', { style: 'text-align:right;max-width:58%;overflow-wrap:anywhere' }, r.value)
      : h('div', { class: 'num' }, r.value))));
}

function priceNode(vndStr, dataLabel) {
  const badge = dataLabel === 'synthetic' ? assumedBadge('Giá mô phỏng') : null;
  return h('span', { class: 'row' }, h('span', { class: 'num' }, formatVnd(vndStr)), badge);
}

function invalidIdScreen(title, text, backCode = 'F-07') {
  return wrap(ui.empty({
    icon: 'question',
    title,
    text,
    action: ui.button({ label: 'Quay lại', kind: 'primary', href: fUrl(backCode), icon: 'arrow-left' }),
  }));
}

function orderHead(b) {
  return h('div', { class: 'farmer-order' },
    h('div', { class: 'row row--between' },
      h('span', { class: 'mono small muted' }, `#${b.id.slice(0, 8)}`),
      ui.stateBadge(b.state)),
    h('div', { class: 'farmer-order__name' }, `${b.field?.name || 'Thửa ruộng'}, ${b.service?.name || 'Dịch vụ'}`),
    h('div', { class: 'small muted' }, `${formatAreaM2(b.field?.areaM2)} · ${formatWindow(b.startAt, b.endAt)}`));
}

function nextBlock(ctx, step) {
  if (!step) return null;
  const cta = step.code && step.code !== ctx.code
    ? ui.button({ label: step.ctaLabel, kind: step.mine ? 'primary' : 'secondary', size: 'lg', block: true, href: fUrl(step.code, step.params) })
    : null;
  return h('section', { class: 'farmer-next' + (step.mine ? ' farmer-next--mine' : ''), 'aria-label': 'Việc tiếp theo' },
    ui.badge(step.who, step.mine ? 'turn-mine' : 'turn-wait'),
    h('h2', null, step.title),
    step.text ? h('p', null, step.text) : null,
    cta);
}

async function safeGet(api, path) {
  try {
    const { data } = await api.request('GET', path, { auth: true });
    return data;
  } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status)) return null;
    throw error;
  }
}

async function loadBookingDetails(api, booking, disputesList = []) {
  const id = booking.id;
  const dispute = disputesList.find((d) => d.bookingId === id && (d.status === 'OPEN' || d.status === 'CLOSED_UNRESOLVED'))
    || disputesList.find((d) => d.bookingId === id)
    || null;
  if (booking.state === 'CANCELLED') return { dispute };

  const tasks = {
    coordinator: booking.state === 'REQUESTED' ? safeGet(api, `/api/bookings/${id}/coordinator`) : Promise.resolve(null),
    readiness: (booking.state === 'GROUPED' || booking.state === 'ASSIGNED') ? safeGet(api, `/api/bookings/${id}/readiness`) : Promise.resolve(null),
    inspections: (booking.state === 'GROUPED' || booking.state === 'ASSIGNED') ? safeGet(api, `/api/bookings/${id}/inspections`) : Promise.resolve(null),
    postponementLink: (booking.state === 'GROUPED' || booking.state === 'ASSIGNED') ? safeGet(api, `/api/bookings/${id}/postponement`) : Promise.resolve(null),
    acceptance: booking.state === 'ASSIGNED' ? safeGet(api, `/api/bookings/${id}/acceptance`) : Promise.resolve(null),
    payments: booking.state === 'ASSIGNED' ? safeGet(api, `/api/bookings/${id}/payments`) : Promise.resolve(null),
  };

  const [coordinator, readiness, inspections, postponementLink, acceptance, payments] = await Promise.all([
    tasks.coordinator,
    tasks.readiness,
    tasks.inspections,
    tasks.postponementLink,
    tasks.acceptance,
    tasks.payments,
  ]);

  let postponement = null;
  if (postponementLink?.packageId && isUuid(postponementLink.packageId)) {
    const pView = await safeGet(api, `/api/packages/${postponementLink.packageId}/postponement`);
    if (pView) {
      postponement = {
        packageId: postponementLink.packageId,
        canConsent: Boolean(pView.permissions?.canConsent),
        canPropose: Boolean(pView.permissions?.canPropose),
        view: pView,
      };
    }
  }

  return {
    coordinator,
    readiness,
    inspections,
    postponementLink,
    postponement,
    acceptance,
    payments,
    dispute,
  };
}

/* ---------- F-01 Trang chinh ---------- */

async function homeScreen(ctx) {
  const [fieldsRes, bookingsRes, disputesRes, activityRes] = await Promise.all([
    ctx.api.request('GET', '/api/fields?limit=100&offset=0', { auth: true }),
    ctx.api.request('GET', '/api/bookings?limit=50&offset=0', { auth: true }),
    ctx.api.request('GET', '/api/disputes?limit=50&offset=0', { auth: true }).catch((err) => ({ data: { items: [] }, _error: err })),
    ctx.api.request('GET', '/api/activity?limit=10&offset=0', { auth: true }).catch((err) => ({ data: { items: [] }, _error: err })),
  ]);
  if (ctx.stale()) return h('div');

  const fields = fieldsRes.data.items || [];
  const bookings = bookingsRes.data.items || [];
  const disputes = disputesRes.data.items || [];
  const activity = activityRes.data.items || [];
  const running = bookings.filter((b) => b.state !== 'CANCELLED');
  const cur = running[0] || bookings[0] || null;
  const totalM2 = fields.reduce((sum, f) => sum + (f.areaM2 || 0), 0);

  let curDetails = null;
  if (cur) curDetails = await loadBookingDetails(ctx.api, cur, disputes);
  if (ctx.stale()) return h('div');

  const nodes = [
    h('p', { class: 'muted' }, `Xin chào, ${ctx.user.name}.`),
  ];

  if (!fields.length) {
    nodes.push(ui.empty({
      icon: 'map-trifold',
      title: 'Chưa có thửa ruộng nào',
      text: 'Thêm thửa ruộng đầu tiên bằng diện tích m² để đặt dịch vụ gặt.',
      action: ui.button({ label: 'Thêm thửa đầu tiên', kind: 'primary', size: 'lg', block: true, href: fUrl('F-03'), icon: 'plus-circle' }),
    }));
  } else if (!cur) {
    nodes.push(
      h('p', null, 'Bạn có ', h('strong', null, `${fields.length} thửa`), `, tổng ${formatAreaM2(totalM2)}. Chưa có đơn nào.`),
      ui.empty({
        icon: 'clipboard-text',
        title: 'Chưa có đơn đặt dịch vụ',
        text: 'Chọn thửa ruộng và khung giờ dự kiến để gửi yêu cầu.',
        action: ui.button({ label: 'Đặt dịch vụ gặt', kind: 'primary', size: 'lg', block: true, href: fUrl('F-05'), icon: 'tractor' }),
      }),
    );
  } else {
    const step = nextStep(cur, curDetails);
    if (step) nodes.push(nextBlock(ctx, step));
    nodes.push(h('p', null, 'Bạn có ', h('strong', null, `${fields.length} thửa`), `, tổng ${formatAreaM2(totalM2)}. `, running.length ? `${running.length} đơn đang theo dõi.` : 'Chưa có đơn đang theo dõi.'));
    nodes.push(ui.card({
      title: cur.state === 'CANCELLED' ? 'Đơn gần nhất' : 'Đơn đang theo dõi',
      actions: ui.button({ label: 'Chi tiết', kind: 'ghost', size: 'sm', href: fUrl('F-07', { id: cur.id }) }),
      body: h('div', { class: 'stack' },
        orderHead(cur),
        ui.stepper(stepKey(cur, curDetails)),
        h('div', { class: 'row row--between small' },
          h('span', { class: 'muted' }, 'Tạm tính'),
          priceNode(cur.totalVnd, cur.service?.dataLabel))),
    }));

    const others = bookings.filter((b) => b.id !== cur.id).slice(0, 5);
    if (others.length) nodes.push(ui.section('Đơn khác', bookingRows(others)));
  }

  const quickLinks = ui.section('Làm nhanh', ui.list([
    ui.listItem({ title: 'Thêm thửa ruộng', meta: 'Nhập tên thửa, địa phương và diện tích m²', icon: 'plus-circle', href: fUrl('F-03') }),
    ui.listItem({ title: 'Đặt dịch vụ gặt', meta: 'Chọn thửa, dịch vụ và khung giờ dự kiến', icon: 'tractor', href: fUrl('F-05') }),
    ui.listItem({ title: 'Khiếu nại của tôi', meta: disputes.length ? `${disputes.length} vụ việc` : 'Chưa có vụ việc', icon: 'warning', href: fUrl('F-13') }),
    ui.listItem({ title: 'Hoạt động gần đây', meta: activity.length ? `${activity.length} cập nhật mới` : 'Chưa có cập nhật', icon: 'bell', href: url('nong-dan', 'C-03') }),
  ]));

  return h('div', { class: 'farmer split' }, h('div', { class: 'stack' }, nodes), quickLinks);
}

/* ---------- F-02 Danh sach thua ruong ---------- */

async function fieldsScreen(ctx) {
  const [fieldsRes, bookingsRes] = await Promise.all([
    ctx.api.request('GET', '/api/fields?limit=100&offset=0', { auth: true }),
    ctx.api.request('GET', '/api/bookings?limit=100&offset=0', { auth: true }),
  ]);
  if (ctx.stale()) return h('div');

  const fields = fieldsRes.data.items || [];
  const bookings = bookingsRes.data.items || [];

  if (!fields.length) {
    return wrap(ui.empty({
      icon: 'map-trifold',
      title: 'Chưa có thửa ruộng nào',
      text: 'Thêm thửa bằng diện tích nhập tay. Có thể bổ sung tọa độ ranh sau.',
      action: ui.button({ label: 'Thêm thửa ruộng', kind: 'primary', size: 'lg', block: true, href: fUrl('F-03'), icon: 'plus-circle' }),
    }));
  }

  const totalM2 = fields.reduce((s, f) => s + (f.areaM2 || 0), 0);
  const unitSeg = ui.segmented({
    label: 'Đơn vị công',
    value: mem.congM2,
    items: [
      { value: 1296, label: 'Tầm cắt 1.296 m²' },
      { value: 1000, label: 'Tầm cấy 1.000 m²' },
    ],
    onChange(val) {
      mem.congM2 = val;
      ctx.rerender();
    },
  });

  ctx.setAction(ui.actionBar({
    info: `${fields.length} thửa`,
    actions: [ui.button({ label: 'Thêm thửa ruộng', kind: 'primary', icon: 'plus', href: fUrl('F-03') })],
  }));

  return wrap(
    h('p', null, h('strong', null, `${fields.length} thửa`), `, tổng ${formatAreaM2(totalM2, mem.congM2)}.`),
    h('div', { class: 'stack-sm' },
      h('h2', { class: 'small muted' }, 'Đơn vị công'),
      unitSeg),
    h('div', { class: 'card-grid' }, fields.map((f) => {
      const active = bookings.find((b) => b.fieldId === f.id && b.state !== 'CANCELLED');
      return ui.card({
        title: f.name,
        subtitle: f.locality,
        body: h('div', { class: 'stack-sm' },
          h('div', { class: 'farmer-area num' }, fmt.area(f.areaM2 / 10000, mem.congM2)),
          h('div', { class: 'small muted num' }, `${fmt.num(f.areaM2, 0)} m²`),
          ui.chips([
            active ? ui.stateBadge(active.state) : ui.badge('Chưa có đơn', 'outline'),
          ]),
          h('div', { class: 'btn-row farmer-split' },
            active ? ui.button({ label: 'Xem đơn', kind: 'secondary', href: fUrl('F-07', { id: active.id }) }) : null,
            ui.button({ label: 'Đường vào, đất và ranh', kind: 'secondary', href: fUrl('F-04', { id: f.id }) }),
            ui.button({ label: 'Đặt dịch vụ', kind: 'primary', href: fUrl('F-05', { field: f.id }), icon: 'tractor' })),
        ),
      });
    })),
  );
}

/* ---------- F-03 Them thua ruong ---------- */

function addFieldScreen(ctx) {
  const nameInput = ui.input({ name: 'name', maxlength: 120 });
  const localityInput = ui.input({ name: 'locality', maxlength: 200 });
  const areaInput = ui.input({ name: 'areaM2', inputmode: 'numeric', mono: true });
  const preview = h('p', { class: 'small muted' }, 'Nhập diện tích bằng m² để xem quy đổi sang ha và công.');

  function updatePreview() {
    const m2 = areaFromM2Input(areaInput.value);
    if (!m2) {
      preview.textContent = 'Nhập số nguyên dương từ 1 đến 10.000.000 m².';
      return;
    }
    const ha = m2 / 10000;
    preview.textContent = `Quy đổi: ${fmt.num(ha, 2)} ha · ${fmt.cong(ha, 1296)} (tầm cắt 1.296 m²) · ${fmt.cong(ha, 1000)} (tầm cấy 1.000 m²).`;
  }
  areaInput.addEventListener('input', updatePreview);

  const form = apiForm({
    fields: [
      ui.note({ tone: 'info', text: 'Có thể lưu tên, địa phương và diện tích trước. Ranh GPS là tùy chọn, chỉ nhập sau khi đồng ý lưu vị trí.' }),
      ui.field({ label: 'Tên thửa ruộng', hint: 'Ví dụ: Thửa Bờ Bắc Kênh 5 (tối đa 120 ký tự)', input: nameInput, required: true }),
      ui.field({ label: 'Địa phương', hint: 'Xã, huyện, tỉnh (tối đa 200 ký tự)', input: localityInput, required: true }),
      ui.field({ label: 'Diện tích (m²)', hint: 'Số nguyên dương, ví dụ 12960 cho 10 công tầm cắt', input: areaInput, required: true }),
      preview,
    ],
    submitLabel: 'Lưu thửa ruộng',
    async run(data) {
      const name = String(data.get('name') || '').trim();
      const locality = String(data.get('locality') || '').trim();
      const areaM2 = areaFromM2Input(String(data.get('areaM2') || ''));
      if (!name || [...name].length > 120) throw new Error('Nhập tên thửa ruộng (tối đa 120 ký tự).');
      if (!locality || [...locality].length > 200) throw new Error('Nhập địa phương của thửa (tối đa 200 ký tự).');
      if (!areaM2) throw new Error('Nhập diện tích bằng số nguyên m², từ 1 đến 10.000.000.');
      const res = await ctx.api.request('POST', '/api/fields', {
        auth: true,
        body: { name, locality, areaM2 },
      });
      return res.data;
    },
    onDone(data) {
      if (data?.field?.id) mem.bookingDraft.fieldId = data.field.id;
      ctx.toast('Đã thêm thửa ruộng', 'ok');
      ctx.go(fUrl('F-02'));
    },
  });

  return wrap(form);
}

async function fieldAccessScreen(ctx) {
  const id = ctx.params.id;
  const back = ui.button({ label: 'Về danh sách thửa', kind: 'secondary', href: fUrl('F-02') });
  if (!isUuid(id)) return ui.empty({ title: 'Chưa chọn thửa ruộng', text: 'Mở điều kiện tiếp cận từ danh sách thửa.', action: back });
  const path = `/api/fields/${id}/details`;
  let data;
  try {
    ({ data } = await ctx.api.request('GET', path, { auth: true }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      if (!ctx.stale()) ui.clearToasts();
      return ui.empty({ title: 'Không tìm thấy thửa', text: 'Thửa không tồn tại hoặc không thuộc tài khoản này.', action: back });
    }
    throw error;
  }
  if (ctx.stale()) return h('div');
  const access = data.details.access;
  const fields = [
    ['roadWidthM', 'Bề rộng đường vào', [['2.5', '2,5 m'], ['3.5', '3,5 m'], ['4.5', '4,5 m']], access.roadWidthM],
    ['bridgeLoadT', 'Tải trọng cầu', [['none', 'Không có cầu'], ['4', '4 tấn'], ['8', '8 tấn'], ['12', '12 tấn']], access.bridgeLoadT ?? (access.roadWidthM === null ? '' : 'none')],
    ['soil', 'Loại đất ruộng', [['firm', 'Đất chắc'], ['soft', 'Đất mềm'], ['boggy', 'Đất lún']], access.soil],
    ['hasBoatDock', 'Có bến ghe', [['yes', 'Có'], ['no', 'Không']], access.hasBoatDock === null ? '' : access.hasBoatDock ? 'yes' : 'no'],
  ];
  const form = apiForm({
    fields: fields.map(([name, label, options, value]) => ui.field({ label, required: true, input: ui.select({ name, options: [['', 'Chọn thông tin'], ...options], value: String(value ?? '') }) })),
    submitLabel: 'Lưu điều kiện tiếp cận',
    run(values) {
      if (fields.some(([name, , options]) => !options.some(([value]) => value === values.get(name)))) throw new Error('Chọn đủ bề rộng đường, tải cầu, loại đất và bến ghe.');
      return ctx.api.request('PUT', path, { auth: true, body: { access: {
        roadWidthM: Number(values.get('roadWidthM')),
        bridgeLoadT: values.get('bridgeLoadT') === 'none' ? null : Number(values.get('bridgeLoadT')),
        soil: values.get('soil'),
        hasBoatDock: values.get('hasBoatDock') === 'yes',
      } } });
    },
    onDone() {
      if (ctx.stale()) return;
      ctx.toast('Đã lưu điều kiện tiếp cận', 'ok');
      ctx.rerender();
    },
  });
  return wrap(ui.screenHead({ title: 'Đường vào và đất ruộng', actions: [back] }),
    ui.card({ title: 'Điều kiện tiếp cận', subtitle: 'Thông tin do chủ ruộng khai báo. Không thay đổi diện tích hoặc ranh thửa.', body: form }),
    boundaryEditor(ctx, path, data.details));
}

/* ---------- F-05 Dat dich vu & F-06 Bang gia truoc khi xac nhan ---------- */

function defaultBookingTimes() {
  const now = Date.now();
  const start = new Date(now + 24 * R.HOUR);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 10 * R.HOUR);
  return {
    startLocal: localInputFromMs(start.getTime()),
    endLocal: localInputFromMs(end.getTime()),
  };
}

async function bookServiceScreen(ctx) {
  const [fieldsRes, servicesRes] = await Promise.all([
    ctx.api.request('GET', '/api/fields?limit=100&offset=0', { auth: true }),
    ctx.api.request('GET', '/api/services?limit=100&offset=0', { auth: true }),
  ]);
  if (ctx.stale()) return h('div');

  const fields = fieldsRes.data.items || [];
  const services = servicesRes.data.items || [];

  if (!fields.length) {
    return wrap(ui.empty({
      icon: 'map-trifold',
      title: 'Cần có thửa ruộng trước',
      text: 'Thêm ít nhất một thửa ruộng rồi mới chọn được dịch vụ gặt.',
      action: ui.button({ label: 'Thêm thửa ruộng', kind: 'primary', size: 'lg', block: true, href: fUrl('F-03'), icon: 'plus-circle' }),
    }));
  }
  if (!services.length) {
    return wrap(ui.empty({
      icon: 'tractor',
      title: 'Chưa có dịch vụ khả dụng',
      text: 'Hiện chưa có gói dịch vụ nào được mở.',
      action: ui.button({ label: 'Về trang chính', kind: 'secondary', href: fUrl('F-01') }),
    }));
  }

  const defaults = defaultBookingTimes();
  let selectedFieldId = isUuid(ctx.params.field) && fields.some((f) => f.id === ctx.params.field.toLowerCase())
    ? ctx.params.field.toLowerCase()
    : (isUuid(mem.bookingDraft.fieldId) && fields.some((f) => f.id === mem.bookingDraft.fieldId) ? mem.bookingDraft.fieldId : fields[0].id);
  let selectedServiceId = isUuid(ctx.params.service) && services.some((s) => s.id === ctx.params.service.toLowerCase())
    ? ctx.params.service.toLowerCase()
    : (isUuid(mem.bookingDraft.serviceId) && services.some((s) => s.id === mem.bookingDraft.serviceId) ? mem.bookingDraft.serviceId : services[0].id);

  const startMs = Date.parse(ctx.params.start);
  const endMs = Date.parse(ctx.params.end);
  const startLocalVal = Number.isFinite(startMs) ? localInputFromMs(startMs) : mem.bookingDraft.startLocal || defaults.startLocal;
  const endLocalVal = Number.isFinite(endMs) ? localInputFromMs(endMs) : mem.bookingDraft.endLocal || defaults.endLocal;
  const crop = cropFactsFromParams(ctx.params);
  const varietyInput = ui.input({ name: 'cropVariety', value: crop?.cropVariety ?? mem.bookingDraft.cropVariety ?? '', maxlength: 80 });
  const sowDateInput = ui.input({ name: 'sowDate', value: crop?.sowDate ?? mem.bookingDraft.sowDate ?? '', type: 'date' });
  const harvestDateInput = ui.input({ name: 'harvestDate', value: crop?.harvestDate ?? mem.bookingDraft.harvestDate ?? '', type: 'date' });
  const harvestFields = h('div', { class: 'stack-sm' },
    ui.field({ label: 'Giống lúa (không bắt buộc)', input: varietyInput }),
    ui.field({ label: 'Ngày sạ (không bắt buộc)', input: sowDateInput }),
    ui.field({ label: 'Ngày gặt dự kiến (không bắt buộc)', input: harvestDateInput }));
  const harvestNotice = h('p', { class: 'small muted' }, 'Ngày gặt là thông tin tham khảo, không tự đổi khung giờ dịch vụ.');
  let cropVariety = '';
  let sowDate = '';
  let harvestDate = '';

  const fieldSelect = ui.select({
    name: 'fieldId',
    value: selectedFieldId,
    options: fields.map((f) => [f.id, `${f.name} (${formatAreaM2(f.areaM2)})`]),
    on: { change: (e) => { selectedFieldId = e.target.value; refreshEstimate(); } },
  });
  const serviceChoices = ui.choices({
    name: 'serviceId',
    label: 'Chọn dịch vụ',
    value: selectedServiceId,
    options: services.map((s) => ({
      value: s.id,
      label: `${s.name} (${formatVnd(s.pricePerHaVnd)}/ha${s.dataLabel === 'synthetic' ? ', Giá mô phỏng' : ''})`,
      desc: s.dataLabel === 'synthetic' ? 'Đơn giá giả lập dùng cho bản thử nghiệm.' : null,
    })),
    onChange(val) {
      selectedServiceId = val;
      refreshEstimate();
    },
  });
  const startInput = ui.input({ type: 'datetime-local', name: 'startLocal', value: startLocalVal });
  const endInput = ui.input({ type: 'datetime-local', name: 'endLocal', value: endLocalVal });
  const estimateBox = h('div', { class: 'farmer-surcharge' });
  const errBox = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });

  function refreshEstimate() {
    const f = fields.find((x) => x.id === selectedFieldId);
    const s = services.find((x) => x.id === selectedServiceId);
    ui.clear(estimateBox);
    if (!f || !s) return;
    const total = quoteTotalVnd(s.pricePerHaVnd, f.areaM2);
    estimateBox.append(
      h('div', { class: 'row row--between' },
        h('span', { class: 'muted' }, 'Tạm tính theo diện tích'),
        s.dataLabel === 'synthetic' ? assumedBadge('Giá mô phỏng') : null),
      h('div', { class: 'farmer-area num' }, formatVnd(total)),
      h('p', { class: 'small muted' }, 'Bước tiếp theo xem bảng giá chi tiết trước khi gửi yêu cầu.'),
    );
  }
  refreshEstimate();

  const submitBtn = ui.button({
    label: 'Xem bảng giá và xác nhận',
    kind: 'primary',
    size: 'lg',
    block: true,
    type: 'submit',
    icon: 'arrow-right',
  });

  const form = h('form', {
    class: 'stack',
    novalidate: true,
    on: {
      submit(event) {
        event.preventDefault();
        ui.clearToasts();
        errBox.hidden = true;
        const startAt = localToUtcIso(startInput.value);
        const endAt = localToUtcIso(endInput.value);
        if (!isUuid(selectedFieldId)) {
          errBox.textContent = 'Chọn thửa ruộng.';
          errBox.hidden = false;
          return;
        }
        if (!isUuid(selectedServiceId)) {
          errBox.textContent = 'Chọn dịch vụ.';
          errBox.hidden = false;
          return;
        }
        if (!startAt) {
          errBox.textContent = 'Nhập thời điểm bắt đầu hợp lệ.';
          errBox.hidden = false;
          startInput.focus();
          return;
        }
        if (!endAt) {
          errBox.textContent = 'Nhập thời điểm kết thúc hợp lệ.';
          errBox.hidden = false;
          endInput.focus();
          return;
        }
        const span = Date.parse(endAt) - Date.parse(startAt);
        if (span <= 0) {
          errBox.textContent = 'Thời điểm kết thúc phải sau thời điểm bắt đầu.';
          errBox.hidden = false;
          endInput.focus();
          return;
        }
        if (span > MAX_BOOKING_SPAN_MS) {
          errBox.textContent = 'Khung thời gian tối đa 30 ngày.';
          errBox.hidden = false;
          endInput.focus();
          return;
        }
        cropVariety = String(varietyInput.value || '').trim();
        sowDate = sowDateInput.value;
        harvestDate = harvestDateInput.value;
        if (cropVariety.length > 80) {
          errBox.textContent = 'Giống lúa tối đa 80 ký tự.';
          errBox.hidden = false;
          varietyInput.focus();
          return;
        }
        if (sowDate && harvestDate && harvestDate < sowDate) {
          errBox.textContent = 'Ngày gặt dự kiến không thể trước ngày sạ.';
          errBox.hidden = false;
          harvestDateInput.focus();
          return;
        }
        mem.bookingDraft = {
          fieldId: selectedFieldId,
          serviceId: selectedServiceId,
          startLocal: startInput.value,
          endLocal: endInput.value,
          cropVariety,
          sowDate,
          harvestDate,
        };
        ctx.go(fUrl('F-06', {
          field: selectedFieldId,
          service: selectedServiceId,
          start: startAt,
          end: endAt,
          crop: cropVariety || null,
          sow: sowDate || null,
          harvest: harvestDate || null,
        }));
      },
    },
  },
  ui.field({ label: 'Thửa ruộng', input: fieldSelect, required: true }),
  h('div', { class: 'field' },
    h('div', { class: 'field__label' }, 'Dịch vụ (bắt buộc)'),
    serviceChoices),
  ui.field({ label: 'Bắt đầu dự kiến', hint: 'Theo giờ địa phương của bạn.', input: startInput, required: true }),
  ui.field({ label: 'Kết thúc dự kiến', hint: 'Sau thời điểm bắt đầu, tối đa 30 ngày.', input: endInput, required: true }),
  harvestNotice,
  harvestFields,
  estimateBox,
  errBox,
  submitBtn);

  return wrap(form);
}

async function quoteConfirmScreen(ctx) {
  const fieldId = isUuid(ctx.params.field) ? ctx.params.field.toLowerCase() : null;
  const serviceId = isUuid(ctx.params.service) ? ctx.params.service.toLowerCase() : null;
  const startAt = ctx.params.start || localToUtcIso(mem.bookingDraft.startLocal);
  const endAt = ctx.params.end || localToUtcIso(mem.bookingDraft.endLocal);
  const targetFieldId = fieldId || (isUuid(mem.bookingDraft.fieldId) ? mem.bookingDraft.fieldId : null);
  const targetServiceId = serviceId || (isUuid(mem.bookingDraft.serviceId) ? mem.bookingDraft.serviceId : null);

  if (!targetFieldId || !targetServiceId || !startAt || !endAt || !Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) {
    return wrap(ui.empty({
      icon: 'receipt',
      title: 'Chưa đủ thông tin để tính bảng giá',
      text: 'Chọn thửa ruộng, dịch vụ và khung thời gian trước khi xem bảng giá.',
      action: ui.button({ label: 'Chọn thửa và dịch vụ', kind: 'primary', href: fUrl('F-05'), icon: 'arrow-left' }),
    }));
  }

  const [fieldsRes, serviceRes] = await Promise.all([
    ctx.api.request('GET', '/api/fields?limit=100&offset=0', { auth: true }),
    ctx.api.request('GET', `/api/services/${targetServiceId}`, { auth: true }),
  ]);
  if (ctx.stale()) return h('div');

  const field = (fieldsRes.data.items || []).find((f) => f.id === targetFieldId);
  const service = serviceRes.data.service;
  if (!field || !service) {
    return invalidIdScreen('Không tìm thấy thửa hoặc dịch vụ', 'Thửa ruộng hoặc dịch vụ không còn khả dụng.', 'F-05');
  }

  const crop = cropFactsFromParams(ctx.params);
  if (!crop) {
    return invalidIdScreen('Thông tin giống hoặc ngày vụ không hợp lệ', 'Quay lại bước đặt dịch vụ để nhập lại.', 'F-05');
  }
  const payload = {
    fieldId: field.id,
    serviceId: service.id,
    startAt: new Date(startAt).toISOString(),
    endAt: new Date(endAt).toISOString(),
    ...crop,
  };
  const totalVnd = quoteTotalVnd(service.pricePerHaVnd, field.areaM2);

  const feedbackBox = h('div', { class: 'stack-sm', 'aria-live': 'polite' });
  const submitBtn = ui.button({
    label: 'Xác nhận gửi yêu cầu',
    kind: 'primary',
    size: 'lg',
    block: true,
    icon: 'paper-plane-tilt',
  });
  let busy = false;

  async function doSubmit(newAttempt = false) {
    if (busy) return;
    const attempt = bookingAttempt(bookingTracker, payload, { newAttempt });
    if (attempt.blocked) {
      ui.clear(feedbackBox);
      feedbackBox.append(ui.banner({
        tone: 'warn',
        title: 'Có yêu cầu trước chưa rõ kết quả',
        text: 'Hãy kiểm tra danh sách đơn trước khi gửi nội dung mới, hoặc xác nhận gửi như một yêu cầu mới.',
        action: h('div', { class: 'btn-row' },
          ui.button({ label: 'Xem đơn của tôi', kind: 'secondary', href: fUrl('F-07') }),
          ui.button({ label: 'Gửi như yêu cầu mới', kind: 'primary', onClick: () => doSubmit(true) })),
      }));
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    submitBtn.setAttribute('aria-busy', 'true');
    ui.clear(feedbackBox);

    try {
      const { data } = await ctx.api.request('POST', '/api/bookings', {
        auth: true,
        body: payload,
        headers: { 'Idempotency-Key': attempt.key },
      });
      if (!data?.booking?.id) throw new ApiError(0, 'BAD_RESPONSE');
      bookingTracker.clear();
      ctx.toast('Đã gửi yêu cầu dịch vụ', 'ok');
      ctx.go(fUrl('F-07', { id: data.booking.id }));
    } catch (error) {
      const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401;
      if (definitive) bookingTracker.clear();
      else bookingTracker.mark(true);
      if (!ctx.stale()) ui.clearToasts();
      feedbackBox.append(ui.note({ tone: 'error', text: errorText(error) }));
      if (!definitive) {
        feedbackBox.append(ui.note({
          tone: 'warn',
          text: 'Lần gửi trước với nội dung này chưa rõ kết quả. Bấm lại sẽ gửi kèm đúng khóa chống trùng cũ.',
        }));
      }
    } finally {
      busy = false;
      if (submitBtn.isConnected) {
        submitBtn.disabled = false;
        submitBtn.removeAttribute('aria-busy');
      }
    }
  }

  submitBtn.addEventListener('click', () => doSubmit(false));

  const pendingAttempt = bookingTracker.current();
  const samePending = pendingAttempt && pendingAttempt.payload === JSON.stringify(payload) && pendingAttempt.uncertain;

  return wrap(
    h('div', { class: 'row row--between' },
      h('h2', null, 'Bảng giá tạm tính'),
      service.dataLabel === 'synthetic' ? assumedBadge('Giá mô phỏng') : null),
    lines([
      { label: 'Thửa ruộng', sub: field.locality, value: field.name, text: true },
      { label: 'Diện tích', sub: `${fmt.num(field.areaM2, 0)} m²`, value: fmt.area(field.areaM2 / 10000, mem.congM2) },
      { label: 'Dịch vụ', sub: service.dataLabel === 'synthetic' ? 'Giá mô phỏng' : null, value: service.name, text: true },
      { label: 'Đơn giá mỗi ha', sub: service.dataLabel === 'synthetic' ? 'Giá mô phỏng' : null, value: formatVnd(service.pricePerHaVnd) },
      { label: 'Khung thời gian', value: formatWindow(payload.startAt, payload.endAt), text: true },
      crop.cropVariety ? { label: 'Giống lúa', sub: 'Thông tin tham khảo', value: crop.cropVariety, text: true } : null,
      crop.sowDate ? { label: 'Ngày sạ', value: formatDateOnly(crop.sowDate), text: true } : null,
      crop.harvestDate ? { label: 'Ngày gặt dự kiến', sub: 'Tham khảo, không đổi khung giờ dịch vụ', value: formatDateOnly(crop.harvestDate), text: true } : null,
      { label: 'Tổng tạm tính', sub: 'Chưa gồm phụ phí hoặc đặt cọc', value: formatVnd(totalVnd), strong: true },
    ]),
    ui.note({
      tone: 'info',
      text: 'Đơn gửi ở trạng thái Đã gửi yêu cầu. Hệ thống chưa điều máy và chưa thu tiền. Nền tảng không giữ tiền.',
    }),
    samePending ? ui.note({
      tone: 'warn',
      text: 'Lần gửi trước với nội dung này chưa rõ kết quả. Bấm lại sẽ gửi kèm đúng khóa chống trùng cũ.',
    }) : null,
    feedbackBox,
    h('div', { class: 'stack-sm' },
      submitBtn,
      ui.button({ label: 'Sửa thông tin đặt dịch vụ', kind: 'secondary', block: true, href: fUrl('F-05', {
        field: field.id, service: service.id, start: payload.startAt, end: payload.endAt,
        crop: crop.cropVariety, sow: crop.sowDate, harvest: crop.harvestDate,
      }) })),
  );
}

/* ---------- F-07 Danh sach don va Chi tiet don ---------- */

function bookingRows(items, showPrice = false) {
  const list = ui.list(items.map((b) => ui.listItem({
    title: b.field?.name || 'Thửa',
    meta: h('div', { class: 'farmer-order-list__details' },
      h('div', null, b.service?.name || 'Dịch vụ'),
      h('div', null, `${formatAreaM2(b.field?.areaM2)} · ${formatWindow(b.startAt, b.endAt)}`),
      showPrice ? priceNode(b.totalVnd, b.service?.dataLabel) : null),
    right: ui.stateBadge(b.state),
    href: fUrl('F-07', { id: b.id }),
    icon: 'clipboard-text',
  })));
  list.classList.add('farmer-order-list');
  if (showPrice) list.classList.add('list--grid');
  return list;
}

async function bookingsListScreen(ctx) {
  const { data } = await ctx.api.request('GET', '/api/bookings?limit=50&offset=0', { auth: true });
  if (ctx.stale()) return h('div');
  const items = data.items || [];

  ctx.setAction(ui.actionBar({
    info: `${items.length} đơn`,
    actions: [ui.button({ label: 'Đặt dịch vụ mới', kind: 'primary', icon: 'plus', href: fUrl('F-05') })],
  }));

  if (!items.length) {
    return wrap(ui.empty({
      icon: 'clipboard-text',
      title: 'Bạn chưa có đơn nào',
      text: 'Chọn một thửa ruộng và đặt dịch vụ gặt.',
      action: ui.button({ label: 'Đặt dịch vụ gặt', kind: 'primary', size: 'lg', block: true, href: fUrl('F-05'), icon: 'tractor' }),
    }));
  }

  return wrap(h('p', { class: 'small muted' }, 'Chọn một đơn để xem tiến trình, ủy quyền HTX, xác nhận ruộng hoặc nghiệm thu.'), bookingRows(items, true));
}

async function bookingDetailScreen(ctx) {
  const rawId = ctx.params.id;
  if (!rawId) return bookingsListScreen(ctx);
  if (!isUuid(rawId)) return invalidIdScreen('Mã đơn không hợp lệ', 'Đường dẫn không đúng mã đơn.', 'F-07');
  const id = rawId.toLowerCase();

  const [bookingRes, disputesRes] = await Promise.all([
    ctx.api.request('GET', `/api/bookings/${id}`, { auth: true }),
    ctx.api.request('GET', '/api/disputes?limit=50&offset=0', { auth: true }).catch((err) => ({ data: { items: [] }, _error: err })),
  ]);
  if (ctx.stale()) return h('div');

  const booking = bookingRes.data.booking;
  const events = bookingRes.data.events || [];
  const disputes = disputesRes.data.items || [];
  const details = await loadBookingDetails(ctx.api, booking, disputes);
  if (ctx.stale()) return h('div');

  let coordinators = [];
  if (details.coordinator?.canAssign || details.coordinator?.coordinatorId) {
    const coordRes = await safeGet(ctx.api, '/api/coordinators?limit=100&offset=0');
    if (coordRes?.items) coordinators = coordRes.items;
    if (ctx.stale()) return h('div');
  }

  const step = nextStep(booking, details);
  const coord = details.coordinator;
  const assignedCoordName = coord?.coordinatorId
    ? (coordinators.find((c) => c.id === coord.coordinatorId)?.name || `HTX (${coord.coordinatorId.slice(0, 8)})`)
    : null;

  let coordinatorCard = null;
  if (booking.state !== 'CANCELLED' && coord) {
    if (coord.canAssign) {
      let pickedCoord = coord.coordinatorId || '';
      const select = ui.select({
        name: 'coordinatorId',
        value: pickedCoord,
        options: [['', 'Chọn HTX điều phối'], ...coordinators.map((c) => [c.id, c.name])],
        on: { change: (e) => { pickedCoord = e.target.value; } },
      });
      coordinatorCard = ui.card({
        title: 'Ủy quyền HTX điều phối',
        subtitle: 'HTX chỉ được gom đơn sau khi bạn ủy quyền. HTX không ký nghiệm thu hoặc xác nhận tiền thay bạn.',
        body: h('div', { class: 'stack-sm' },
          coordinators.length
            ? [
              ui.field({ label: 'HTX phụ trách gom đơn', input: select }),
              apiButton({
                label: coord.coordinatorId ? 'Đổi HTX ủy quyền' : 'Ủy quyền HTX gom đơn',
                kind: 'primary',
                block: true,
                icon: 'users-three',
                run: async () => {
                  if (!isUuid(pickedCoord)) throw new Error('Chọn một HTX trước khi ủy quyền.');
                  return ctx.api.request('POST', `/api/bookings/${id}/coordinator`, {
                    auth: true,
                    body: { coordinatorId: pickedCoord },
                  });
                },
                okText: 'Đã lưu ủy quyền HTX',
                onDone: () => ctx.rerender(),
              }),
            ]
            : ui.note({ tone: 'warn', text: 'Chưa có tài khoản HTX nào trong danh mục.' })),
      });
    } else {
      coordinatorCard = ui.card({
        title: 'Ủy quyền HTX điều phối',
        body: h('p', { class: 'muted' }, assignedCoordName
          ? `Đã ủy quyền cho ${assignedCoordName}. Đơn đã gom hoặc phân công nên không đổi HTX ở bước này.`
          : 'Đơn đã qua bước gom gói nên không đổi ủy quyền HTX.'),
      });
    }
  }

  const readinessSummary = (booking.state === 'GROUPED' || booking.state === 'ASSIGNED')
    ? inspectionSummary(details.readiness, details.inspections)
    : null;

  const actionItems = [];
  if (details.readiness?.canConfirm || details.readiness?.readiness || details.inspections) {
    const declText = readinessSummary?.declaration.badge[0] || 'Chưa khai báo';
    const inspText = readinessSummary?.inspection.badge[0] || 'Chưa kiểm tra thực địa';
    actionItems.push(ui.listItem({
      title: 'Xác nhận ruộng & kiểm tra thực địa (F-08)',
      meta: `Khai báo chủ ruộng: ${declText} · Kiểm tra HTX: ${inspText}`,
      right: readinessSummary ? ui.badge(...readinessSummary.inspection.badge) : null,
      icon: 'check-circle',
      href: fUrl('F-08', { id }),
    }));
  }
  if (details.postponement?.packageId) {
    actionItems.push(ui.listItem({
      title: 'Lịch gói và dời lịch (F-15)',
      meta: details.postponement.canConsent
        ? 'Có đề xuất dời lịch đang chờ bạn đồng ý'
        : `Khung giờ gói: ${formatWindow(details.postponement.view.package.startAt, details.postponement.view.package.endAt)}`,
      right: details.postponement.canConsent ? ui.badge('Cần đồng ý', 'turn-mine') : null,
      icon: 'clock',
      href: fUrl('F-15', { id }),
    }));
  }
  if (booking.state === 'ASSIGNED' || details.acceptance?.acceptance) {
    actionItems.push(ui.listItem({ title: 'Cọc ngoài hệ thống', icon: 'hand-coins', href: fUrl('F-09', { id }) }));
    actionItems.push(ui.listItem({ title: 'Theo dõi máy', icon: 'tractor', href: fUrl('F-10', { id }) }));
    actionItems.push(ui.listItem({
      title: 'Nghiệm thu (F-11)',
      meta: details.acceptance?.acceptance
        ? `Phiên bản ${details.acceptance.acceptance.version}: ${details.acceptance.acceptance.agreed ? 'Hai bên đã đồng ý' : 'Chờ đồng ý'}`
        : 'Chưa có đề nghị nghiệm thu từ chủ máy',
      icon: 'signature',
      href: fUrl('F-11', { id }),
    }));
    actionItems.push(ui.listItem({
      title: 'Quyết toán ngoài hệ thống (F-12)',
      meta: details.payments?.summary
        ? `Còn lại chưa xác nhận: ${formatVnd(details.payments.summary.outstandingVnd)}`
        : 'Mở ghi báo chuyển tiền sau khi hai bên đồng ý nghiệm thu',
      icon: 'hand-coins',
      href: fUrl('F-12', { id }),
    }));
  }
  if (details.dispute) {
    const medLevel = MEDIATION_LEVEL_BADGE[details.dispute.mediationLevel] || MEDIATION_LEVEL_BADGE.HTX;
    actionItems.push(ui.listItem({
      title: 'Khiếu nại của đơn (F-13)',
      meta: `${DISPUTE_REASONS[details.dispute.reason] || details.dispute.reason} · ${DISPUTE_STATUS_LABELS[details.dispute.status] || details.dispute.status} · ${medLevel[0]}`,
      right: ui.badge(DISPUTE_STATUS_LABELS[details.dispute.status] || details.dispute.status, details.dispute.status === 'OPEN' ? 'warn' : 'outline'),
      icon: 'warning',
      href: fUrl('F-13', { id: details.dispute.id }),
    }));
    actionItems.push(ui.listItem({
      title: 'Kết quả hòa giải (F-14)',
      meta: details.dispute.mediationLevel === 'ADMIN'
        ? 'Đang ở cấp Quản trị viên độc lập; xem phương án và đồng ý theo phiên bản'
        : 'Đang hòa giải cấp HTX; có thể xem phương án hoặc yêu cầu chuyển lên Quản trị',
      right: ui.badge(...medLevel),
      icon: 'scales',
      href: fUrl('F-14', { id: details.dispute.id }),
    }));
  } else if (booking.state === 'ASSIGNED') {
    actionItems.push(ui.listItem({
      title: 'Mở khiếu nại về đơn này (F-13)',
      meta: 'Ghi nhận bất đồng về diện tích, chất lượng hoặc thanh toán',
      icon: 'warning',
      href: fUrl('F-13', { booking: id }),
    }));
  }

  const readinessOverviewCard = readinessSummary
    ? ui.card({
      title: 'Tình trạng ruộng và kiểm tra thực địa',
      subtitle: 'Tách riêng phần chủ ruộng tự khai báo và kết quả kiểm tra độc lập của HTX.',
      actions: ui.button({ label: 'Mở F-08', size: 'sm', kind: 'secondary', href: fUrl('F-08', { id }) }),
      body: h('div', { class: 'stack-sm' },
        ui.kv([
          ['Khai báo của chủ ruộng', h('span', { class: 'row' },
            ui.badge(...readinessSummary.declaration.badge),
            readinessSummary.declaration.confirmedAt
              ? h('span', { class: 'small muted' }, formatIso(readinessSummary.declaration.confirmedAt))
              : null)],
          readinessSummary.declaration.confirmed
            ? ['Chi tiết khai báo', `Nước: ${readinessSummary.declaration.flags.drained ? 'Đạt' : 'Chưa'} · Lúa: ${readinessSummary.declaration.flags.mature ? 'Đạt' : 'Chưa'} · Bờ/xe: ${readinessSummary.declaration.flags.intakeReady ? 'Đạt' : 'Chưa'}`]
            : null,
          ['Kiểm tra thực địa của HTX', h('span', { class: 'row' },
            ui.badge(...readinessSummary.inspection.badge),
            readinessSummary.inspection.createdAt
              ? h('span', { class: 'small muted' }, formatIso(readinessSummary.inspection.createdAt))
              : null)],
          readinessSummary.inspection.reviewerName
            ? ['Người kiểm tra (HTX)', readinessSummary.inspection.reviewerName]
            : null,
          readinessSummary.inspection.reason
            ? ['Ghi chú kiểm tra HTX', readinessSummary.inspection.reason]
            : null,
        ]),
        readinessSummary.inspection.stale
          ? ui.note({ tone: 'warn', text: 'Khai báo ruộng hoặc lịch gói vừa thay đổi sau lần kiểm tra gần nhất, nên kết quả cũ đã hết hiệu lực và cần HTX kiểm tra lại.' })
          : null),
    })
    : null;

  return wrap(
    orderHead(booking),
    ui.stepper(stepKey(booking, details)),
    step ? nextBlock(ctx, step) : null,
    ui.card({
      title: 'Thông tin đơn',
      body: ui.kv([
        ['Thửa ruộng', `${booking.field?.name || ''} (${formatAreaM2(booking.field?.areaM2)})`],
        ['Dịch vụ', booking.service?.name || ''],
        ['Đơn giá mỗi ha', priceNode(booking.service?.pricePerHaVnd, booking.service?.dataLabel)],
        ['Tổng tạm tính', priceNode(booking.totalVnd, booking.service?.dataLabel)],
        ['Bắt đầu dự kiến', formatIso(booking.startAt)],
        ['Kết thúc dự kiến', formatIso(booking.endAt)],
        booking.cropVariety ? ['Giống lúa', booking.cropVariety] : null,
        booking.sowDate ? ['Ngày sạ', formatDateOnly(booking.sowDate)] : null,
        booking.harvestDate ? ['Ngày gặt dự kiến (tham khảo)', formatDateOnly(booking.harvestDate)] : null,
        ['Tạo đơn lúc', formatIso(booking.createdAt)],
        assignedCoordName ? ['HTX được ủy quyền', assignedCoordName] : null,
      ]),
    }),
    coordinatorCard,
    readinessOverviewCard,
    actionItems.length ? ui.section('Thao tác theo đơn', ui.list(actionItems)) : null,
    ui.section('Lịch sử đơn', events.length
      ? ui.timeline(events.map((ev, idx) => ({
        title: `${BOOKING_EVENT_LABELS[ev.type] || ev.type} (${R.STATE_LABEL[ev.state] || ev.state})`,
        meta: formatIso(ev.createdAt),
        done: idx < events.length - 1,
        now: idx === events.length - 1,
      })))
      : h('p', { class: 'muted' }, 'Chưa có sự kiện.')),
  );
}

/* ---------- F-08 Xac nhan ruong san sang ---------- */

async function readinessScreen(ctx) {
  const rawId = ctx.params.id;
  if (!isUuid(rawId)) return invalidIdScreen('Mã đơn không hợp lệ', 'Mở màn này từ chi tiết một đơn.', 'F-07');
  const id = rawId.toLowerCase();

  const [bookingRes, readyRes, inspData] = await Promise.all([
    ctx.api.request('GET', `/api/bookings/${id}`, { auth: true }),
    ctx.api.request('GET', `/api/bookings/${id}/readiness`, { auth: true }),
    safeGet(ctx.api, `/api/bookings/${id}/inspections`),
  ]);
  if (ctx.stale()) return h('div');

  const booking = bookingRes.data.booking;
  const readyData = readyRes.data;
  const summary = inspectionSummary(readyData, inspData);
  const current = readyData.readiness || { drained: false, mature: false, intakeReady: false };
  const state = {
    drained: Boolean(current.drained),
    mature: Boolean(current.mature),
    intakeReady: Boolean(current.intakeReady),
  };

  const questions = [
    ['drained', 'Đã xử lý nước phù hợp để máy vào', 'Mặt ruộng không ngập sâu hoặc lầy làm sa lầy máy.'],
    ['mature', 'Cây trồng đã sẵn sàng cho công việc', 'Lúa chín đều, đủ điều kiện thu hoạch.'],
    ['intakeReady', 'Đã bố trí nơi nhận hoặc vận chuyển sau công việc', 'Có bao, ghe hoặc xe chờ chở lúa ở bờ.'],
  ];

  const rows = questions.map(([key, title, desc]) => {
    const cb = h('input', {
      type: 'checkbox',
      name: key,
      checked: state[key],
      disabled: !readyData.canConfirm,
      on: { change: (e) => { state[key] = Boolean(e.target.checked); } },
    });
    return h('label', { class: 'choice' },
      cb,
      h('span', null, h('span', { class: 'choice__title' }, title), h('span', { class: 'choice__desc' }, desc)));
  });

  const historyList = summary.inspection.history.length > 1
    ? h('details', { class: 'op-more' },
      h('summary', null, `Lịch sử kiểm tra thực địa (${summary.inspection.history.length})`),
      h('div', { class: 'op-more__body' },
        ui.list(summary.inspection.history.map((item) => ui.listItem({
          title: `${item.result === 'PASSED' ? 'Đạt' : 'Chưa đạt'}${item.stale ? ' (Bản cũ)' : ''}`,
          meta: `${formatIso(item.createdAt)}${item.reviewerName ? ` · ${item.reviewerName}` : ''}${item.reason ? ` · ${item.reason}` : ''}`,
          right: ui.badge(item.stale ? 'Bản cũ' : item.result === 'PASSED' ? 'Đạt' : 'Chưa đạt', item.stale ? 'warn' : item.result === 'PASSED' ? 'ok' : 'error'),
          icon: 'list-checks',
        })))))
    : null;

  const htxCard = ui.card({
    title: 'Kiểm tra thực địa của HTX',
    subtitle: 'Tách biệt với khai báo của chủ ruộng. HTX kiểm tra đạt là điều kiện để thợ lái bắt đầu ca.',
    actions: ui.badge(...summary.inspection.badge),
    body: h('div', { class: 'stack-sm' },
      ui.kv([
        ['Kết quả gần nhất', summary.inspection.result === 'PASSED' ? 'Đạt kiểm tra' : summary.inspection.result === 'FAILED' ? 'Chưa đạt' : 'Chưa có lượt kiểm tra nào'],
        summary.inspection.reviewerName ? ['HTX / người kiểm tra', summary.inspection.reviewerName] : null,
        summary.inspection.createdAt ? ['Kiểm tra lúc', formatIso(summary.inspection.createdAt)] : null,
        summary.inspection.reason ? ['Ghi chú / lý do', summary.inspection.reason] : null,
      ]),
      summary.inspection.stale
        ? ui.note({
          tone: 'warn',
          text: 'Khai báo của chủ ruộng hoặc khung giờ gói đã thay đổi sau lần kiểm tra này. Kết quả cũ đã hết hiệu lực, cần HTX kiểm tra lại trước khi mở ca.',
        })
        : null,
      summary.inspection.status === 'FAILED'
        ? ui.note({
          tone: 'warn',
          text: 'Sau khi khắc phục vấn đề trên ruộng, hãy cập nhật lại khai báo bên dưới để HTX kiểm tra lại.',
        })
        : null,
      historyList),
  });

  return wrap(
    orderHead(booking),
    htxCard,
    ui.card({
      title: 'Khai báo sẵn sàng của chủ ruộng',
      subtitle: 'Thông tin chủ ruộng tự kiểm tra và khai báo, không thay cho kiểm tra thực địa của HTX.',
      actions: ui.badge(...summary.declaration.badge),
      body: h('div', { class: 'stack-sm' },
        readyData.readiness
          ? ui.note({ tone: 'success', text: `Khai báo gần nhất lúc ${formatIso(readyData.readiness.confirmedAt)}.` })
          : ui.note({ tone: 'info', text: 'Chưa có bản khai báo nào cho đơn này.' }),
        readyData.canConfirm && summary.inspection.passed
          ? ui.note({
            tone: 'warn',
            text: 'Lưu ý: Nếu bạn lưu lại khai báo mới, kết quả kiểm tra đạt hiện tại của HTX sẽ thành bản cũ và HTX cần kiểm tra lại.',
          })
          : null,
        !readyData.canConfirm
          ? ui.banner({
            tone: 'warn',
            title: 'Chưa thể cập nhật khai báo',
            text: 'Đơn phải nằm trong gói đang mở hoặc đã nhận và chưa bắt đầu ca máy thì mới cập nhật được.',
          })
          : null,
        h('div', { class: 'stack-sm' }, rows),
        readyData.canConfirm ? apiButton({
          label: 'Lưu khai báo ruộng sẵn sàng',
          kind: 'primary',
          size: 'lg',
          block: true,
          icon: 'check-circle',
          run: () => ctx.api.request('POST', `/api/bookings/${id}/readiness`, { auth: true, body: state }),
          okText: 'Đã lưu khai báo ruộng sẵn sàng',
          onDone: () => ctx.rerender(),
        }) : null),
    }),
    ui.button({ label: 'Quay lại chi tiết đơn', kind: 'secondary', block: true, href: fUrl('F-07', { id }), icon: 'arrow-left' }),
  );
}

/* ---------- F-11 Nghiem thu ---------- */

async function acceptanceScreen(ctx) {
  const rawId = ctx.params.id;
  if (!isUuid(rawId)) return invalidIdScreen('Mã đơn không hợp lệ', 'Mở nghiệm thu từ chi tiết một đơn.', 'F-07');
  const id = rawId.toLowerCase();

  const [bookingRes, accRes] = await Promise.all([
    ctx.api.request('GET', `/api/bookings/${id}`, { auth: true }),
    ctx.api.request('GET', `/api/bookings/${id}/acceptance`, { auth: true }),
  ]);
  if (ctx.stale()) return h('div');

  const booking = bookingRes.data.booking;
  const { acceptance, permissions } = accRes.data;
  const blocked = Boolean(permissions?.blockedByDispute);
  const canConsent = permissions?.party === 'owner' && !blocked && Boolean(acceptance) && !acceptance.agreed && !acceptance.consents?.owner;

  return wrap(
    orderHead(booking),
    blocked ? ui.banner({
      tone: 'warn',
      title: 'Đơn đang có khiếu nại',
      text: 'Bạn chỉ xem được số liệu nghiệm thu, chưa thể đồng ý cho đến khi khiếu nại được giải quyết.',
      action: ui.button({ label: 'Xem khiếu nại', size: 'sm', href: fUrl('F-13') }),
    }) : null,
    acceptance
      ? [
        lines([
          { label: 'Phiên bản đề nghị', value: `v${acceptance.version}` },
          { label: 'Diện tích nghiệm thu', sub: `${fmt.num(acceptance.areaM2, 0)} m²`, value: fmt.area(acceptance.areaM2 / 10000, mem.congM2) },
          {
            label: 'Tổng tiền đề nghị',
            sub: booking.service?.dataLabel === 'synthetic' ? 'Giá mô phỏng' : null,
            value: formatVnd(acceptance.totalVnd),
            strong: true,
          },
          { label: 'Ghi chú', value: acceptance.note || 'Không có', text: true },
          { label: 'Đề nghị lúc', value: formatIso(acceptance.proposedAt), text: true },
          { label: 'Chủ ruộng', value: acceptance.consents?.owner ? 'Đã đồng ý' : 'Chưa đồng ý', text: true },
          { label: 'Chủ máy', value: acceptance.consents?.provider ? 'Đã đồng ý' : 'Chưa đồng ý', text: true },
          { label: 'Trạng thái chung', value: acceptance.agreed ? 'Hai bên đã đồng ý' : 'Chờ đủ hai bên', text: true },
        ]),
        canConsent ? [
          ui.note({ tone: 'info', text: 'Chỉ đồng ý khi số đo và số tiền khớp thực tế. Hệ thống không tự đồng ý thay bạn.' }),
          apiButton({
            label: `Đồng ý nghiệm thu phiên bản ${acceptance.version}`,
            kind: 'primary',
            size: 'lg',
            block: true,
            icon: 'signature',
            run: () => ctx.api.request('POST', `/api/bookings/${id}/acceptance/${acceptance.version}/consent`, { auth: true, body: {} }),
            okText: 'Đã ghi nhận đồng ý nghiệm thu',
            onDone: () => ctx.rerender(),
          }),
        ] : null,
        acceptance.agreed ? ui.button({
          label: 'Đi tới quyết toán (F-12)',
          kind: 'primary',
          size: 'lg',
          block: true,
          icon: 'hand-coins',
          href: fUrl('F-12', { id }),
        }) : null,
      ]
      : ui.empty({
        icon: 'signature',
        title: 'Chưa có đề nghị nghiệm thu',
        text: 'Sau khi thợ lái hoàn thành ca máy, chủ máy sẽ gửi số đo và số tiền để bạn kiểm tra.',
      }),
    h('div', { class: 'btn-row' },
      ui.button({ label: 'Chi tiết đơn', kind: 'secondary', href: fUrl('F-07', { id }), icon: 'arrow-left' }),
      ui.button({ label: 'Mở khiếu nại', kind: 'secondary', href: fUrl('F-13', { booking: id }), icon: 'warning' })),
  );
}

/* ---------- F-12 Quyet toan ---------- */

async function settlementScreen(ctx) {
  const rawId = ctx.params.id;
  if (!isUuid(rawId)) return invalidIdScreen('Mã đơn không hợp lệ', 'Mở quyết toán từ chi tiết một đơn.', 'F-07');
  const id = rawId.toLowerCase();

  const [bookingRes, accRes, payRes] = await Promise.all([
    ctx.api.request('GET', `/api/bookings/${id}`, { auth: true }),
    ctx.api.request('GET', `/api/bookings/${id}/acceptance`, { auth: true }),
    ctx.api.request('GET', `/api/bookings/${id}/payments`, { auth: true }),
  ]);
  if (ctx.stale()) return h('div');

  const booking = bookingRes.data.booking;
  const { acceptance, permissions } = accRes.data;
  const { payments = [], summary } = payRes.data;
  const blocked = Boolean(permissions?.blockedByDispute);
  const pendingKey = `${ctx.user.id}:${id}`;
  const savedPending = pendingPayments.get(pendingKey);
  const canReport = permissions?.party === 'owner' && !blocked && Boolean(summary) && BigInt(summary.availableToReportVnd) > 0n;

  let reportSection = null;
  if (canReport || (savedPending && permissions?.party === 'owner' && !blocked && Boolean(summary))) {
    const amountInput = ui.input({
      name: 'amountVnd',
      inputmode: 'numeric',
      mono: true,
      value: savedPending ? savedPending.amountVnd : (summary.availableToReportVnd !== '0' ? summary.availableToReportVnd : ''),
      readOnly: Boolean(savedPending),
    });
    const refInput = ui.input({
      name: 'reference',
      mono: true,
      maxlength: 64,
      value: savedPending ? savedPending.reference : '',
      readOnly: Boolean(savedPending),
    });

    reportSection = ui.card({
      title: 'Ghi báo đã chuyển tiền ngoài hệ thống',
      subtitle: 'Đây là khai báo của bạn; chỉ được tính là đã nhận sau khi chủ máy xác nhận.',
      body: h('div', { class: 'stack-sm' },
        savedPending ? ui.note({
          tone: 'warn',
          text: 'Lần ghi báo trước chưa rõ kết quả. Gửi lại đúng số tiền và mã tham chiếu đó.',
        }) : null,
        apiForm({
          fields: [
            ui.field({ label: 'Số tiền đã chuyển ngoài hệ thống (VND)', hint: 'Số nguyên dương, không dùng dấu chấm hay phẩy.', input: amountInput, required: true }),
            ui.field({ label: 'Mã tham chiếu giao dịch', hint: 'Từ 4 đến 64 ký tự (chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang).', input: refInput, required: true }),
          ],
          submitLabel: savedPending ? 'Gửi lại đúng ghi báo trước' : 'Ghi báo đã chuyển tiền',
          async run() {
            let payload = pendingPayments.get(pendingKey);
            if (!payload) {
              const amount = amountInput.value.trim();
              const reference = refInput.value.trim();
              if (!VND_POSITIVE_RE.test(amount)) throw new Error('Nhập số tiền nguyên dương, không dùng dấu chấm hay phẩy.');
              if (summary && BigInt(amount) > BigInt(summary.availableToReportVnd)) throw new Error('Số tiền vượt phần còn có thể ghi báo.');
              if (!REFERENCE_RE.test(reference)) throw new Error('Mã tham chiếu dài 4 đến 64 ký tự: chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.');
              payload = { amountVnd: amount, reference };
              pendingPayments.set(pendingKey, payload);
            }
            try {
              const res = await ctx.api.request('POST', `/api/bookings/${id}/payments`, { auth: true, body: payload });
              pendingPayments.delete(pendingKey);
              return res.data;
            } catch (error) {
              const uncertain = error instanceof ApiError && (error.uncertain || error.status === 401 || error.status === 0 || error.status >= 500);
              if (!uncertain) {
                pendingPayments.delete(pendingKey);
              } else {
                amountInput.readOnly = true;
                refInput.readOnly = true;
                // Re-render so the saved-attempt note and retry label show; the screen is otherwise stale.
                setTimeout(() => ctx.rerender(), 0);
              }
              throw error;
            }
          },
          onDone() {
            ctx.toast('Đã ghi báo khoản chuyển ngoài hệ thống', 'ok');
            ctx.rerender();
          },
        })),
    });
  }

  return wrap(
    orderHead(booking),
    ui.note({
      tone: 'info',
      text: 'Ghi nhận chuyển tiền ngoài hệ thống, nền tảng không giữ tiền và không kiểm tra ngân hàng.',
    }),
    BigInt(summary?.excessConfirmedVnd ?? '0') > 0n
      ? ui.note({ tone: 'warn', text: `Đã ghi nhận dư ${formatVnd(summary.excessConfirmedVnd)}. Hai bên đối chiếu ngoài hệ thống; ứng dụng không tự hoàn tiền.` }) : null,
    blocked ? ui.banner({
      tone: 'warn',
      title: 'Đơn đang bị chặn ghi nhận tiền vì có khiếu nại',
      text: 'Chưa thể ghi báo thanh toán mới cho đến khi khiếu nại được giải quyết.',
      action: ui.button({ label: 'Xem khiếu nại', size: 'sm', href: fUrl('F-13') }),
    }) : null,
    summary
      ? lines([
        { label: 'Đã thỏa thuận nghiệm thu', sub: booking.service?.dataLabel === 'synthetic' ? 'Giá mô phỏng' : null, value: formatVnd(summary.agreedVnd) },
        { label: 'Cọc đã xác nhận', value: formatVnd(summary.confirmedDepositVnd ?? '0') },
        { label: 'Cọc chờ xác nhận', value: formatVnd(summary.reportedDepositVnd ?? '0') },
        { label: 'Thanh toán thêm đã xác nhận', value: formatVnd(summary.confirmedVnd) },
        { label: 'Thanh toán thêm chờ xác nhận', value: formatVnd(summary.reportedVnd) },
        { label: 'Còn lại chưa xác nhận', value: formatVnd(summary.outstandingVnd), strong: true },
        { label: 'Có thể ghi báo thêm', value: formatVnd(summary.availableToReportVnd) },
      ])
      : ui.empty({
        icon: 'hand-coins',
        title: 'Chưa có số liệu quyết toán',
        text: acceptance ? 'Hai bên cần đồng ý cùng phiên bản nghiệm thu trước khi ghi báo thanh toán.' : 'Chờ nghiệm thu trước khi ghi báo thanh toán.',
        action: ui.button({ label: 'Xem nghiệm thu', kind: 'primary', href: fUrl('F-11', { id }) }),
      }),
    reportSection,
    ui.section('Lịch sử ghi báo thanh toán', payments.length
      ? ui.list(payments.map((p) => ui.listItem({
        title: formatVnd(p.amountVnd),
        meta: p.status === 'CONFIRMED'
          ? `Chủ máy đã xác nhận nhận ngoài hệ thống lúc ${formatIso(p.confirmedAt)}`
          : `Đã ghi báo lúc ${formatIso(p.createdAt)} · Chờ chủ máy xác nhận`,
        right: ui.badge(p.status === 'CONFIRMED' ? 'Đã xác nhận' : 'Chờ xác nhận', p.status === 'CONFIRMED' ? 'ok' : 'idle'),
        icon: 'receipt',
      })))
      : h('p', { class: 'muted' }, 'Chưa có khoản ghi báo nào.')),
    h('div', { class: 'btn-row' },
      ui.button({ label: 'Xem nghiệm thu', kind: 'secondary', href: fUrl('F-11', { id }), icon: 'signature' }),
      ui.button({ label: 'Chi tiết đơn', kind: 'secondary', href: fUrl('F-07', { id }), icon: 'arrow-left' })),
  );
}

/* ---------- F-13 Khieu nai ---------- */

function validateImageFile(file) {
  if (!file) return 'Chọn ảnh trước khi tải lên.';
  if (!Object.hasOwn(IMAGE_TYPES, file.type)) return 'Chỉ nhận ảnh JPEG hoặc PNG.';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'Tệp ảnh trống hoặc không đọc được dung lượng.';
  if (file.size > MAX_IMAGE_BYTES) return 'Ảnh vượt quá 5 MB.';
  return null;
}

function evidenceSection(ctx, disputeId) {
  const box = h('div', { class: 'stack-sm' });
  const thumbs = new Map();
  const downloads = new Map();
  let cleanupRegistered = false;

  function cleanupUrls() {
    for (const u of thumbs.values()) globalThis.URL.revokeObjectURL(u);
    thumbs.clear();
    for (const [u, tm] of downloads.entries()) {
      globalThis.clearTimeout(tm);
      globalThis.URL.revokeObjectURL(u);
    }
    downloads.clear();
  }

  async function loadPage(offset = 0) {
    ui.clear(box);
    box.append(ui.loading('Đang tải bằng chứng ảnh'));
    try {
      const { data } = await ctx.api.request('GET', `/api/disputes/${disputeId}/evidence?limit=${EVIDENCE_PAGE}&offset=${offset}`, { auth: true });
      if (ctx.stale() || !box.isConnected) return;
      draw(data);
    } catch (error) {
      if (ctx.stale() || !box.isConnected) return;
      ui.clearToasts();
      ui.clear(box);
      box.append(ui.errorState({ text: errorText(error), retry: () => loadPage(offset) }));
    }
  }

  function draw(page) {
    if (!cleanupRegistered) {
      cleanupRegistered = true;
      ui._cleanups.push(cleanupUrls);
    }
    cleanupUrls();
    ui.clear(box);

    box.append(ui.note({
      tone: 'info',
      text: 'Chỉ nhận ảnh JPEG hoặc PNG tối đa 5 MB. Hãy xóa thông tin nhạy cảm trước khi tải lên.',
    }));

    if (!page.storageAvailable) {
      box.append(ui.note({ tone: 'warn', text: 'Kho lưu trữ ảnh chưa được cấu hình trên máy chủ.' }));
    } else if (page.canUpload) {
      let chosenFile = null;
      const statusEl = h('p', { class: 'small muted' }, 'Chưa chọn ảnh.');
      const uploadFeedback = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
      const fileIn = h('input', {
        type: 'file',
        accept: 'image/jpeg,image/png',
        class: 'farmer-file__in',
        'aria-label': 'Chọn ảnh bằng chứng (JPEG hoặc PNG)',
      });
      const uploadBtn = ui.button({ label: 'Tải ảnh bằng chứng lên', kind: 'secondary', block: true, disabled: true, icon: 'camera' });
      let uploading = false;

      fileIn.addEventListener('change', () => {
        const f = fileIn.files?.[0] || null;
        const err = validateImageFile(f);
        uploadFeedback.hidden = true;
        if (err) {
          ui.clearToasts();
          chosenFile = null;
          uploadBtn.disabled = true;
          uploadFeedback.textContent = err;
          uploadFeedback.hidden = false;
          statusEl.textContent = 'Ảnh chưa hợp lệ.';
          return;
        }
        chosenFile = f;
        uploadBtn.disabled = uploading;
        statusEl.textContent = `Đã chọn ${IMAGE_TYPES[f.type]} (${Math.max(1, Math.round(f.size / 1024))} KB).`;
      });

      uploadBtn.addEventListener('click', async () => {
        if (uploading || !chosenFile) return;
        uploading = true;
        uploadBtn.disabled = true;
        uploadFeedback.hidden = true;
        try {
          await ctx.api.upload(`/api/disputes/${disputeId}/evidence`, chosenFile);
          ctx.toast('Đã tải ảnh bằng chứng lên', 'ok');
          await loadPage(0);
        } catch (error) {
          if (!ctx.stale() && uploadFeedback.isConnected) ui.clearToasts();
          uploadFeedback.textContent = errorText(error);
          uploadFeedback.hidden = false;
          uploading = false;
          uploadBtn.disabled = !chosenFile;
        }
      });

      box.append(
        h('div', { class: 'farmer-file' },
          ui.button({ label: 'Chọn ảnh bằng chứng', icon: 'image', kind: 'secondary', block: true }),
          fileIn),
        statusEl,
        uploadBtn,
        uploadFeedback,
      );
    } else {
      box.append(ui.note({ tone: 'info', text: 'Vụ việc đã đóng hoặc tài khoản hiện tại không có quyền thêm ảnh mới.' }));
    }

    const items = page.items || [];
    if (!items.length) {
      box.append(h('p', { class: 'muted small' }, 'Chưa có ảnh bằng chứng nào.'));
      return;
    }

    items.forEach((item, idx) => {
      const thumbSlot = h('div');
      const cardMsg = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
      const viewThumbBtn = ui.button({
        label: 'Xem ảnh thu nhỏ',
        kind: 'secondary',
        size: 'sm',
        icon: 'image',
        onClick: async () => {
          cardMsg.hidden = true;
          viewThumbBtn.disabled = true;
          try {
            const blob = await ctx.api.binary(`/api/evidence/${item.id}/thumbnail`);
            if (!thumbSlot.isConnected) return;
            const objUrl = globalThis.URL.createObjectURL(blob);
            if (thumbs.has(item.id)) globalThis.URL.revokeObjectURL(thumbs.get(item.id));
            thumbs.set(item.id, objUrl);
            const w = Math.min(240, item.width);
            ui.clear(thumbSlot);
            thumbSlot.append(h('img', {
              src: objUrl,
              alt: `Ảnh bằng chứng ${page.offset + idx + 1}`,
              width: w,
              height: Math.round((item.height * w) / item.width),
            }));
          } catch (error) {
            if (!ctx.stale() && cardMsg.isConnected) ui.clearToasts();
            cardMsg.textContent = error?.code === 'THUMBNAIL_PENDING' ? 'Ảnh thu nhỏ đang được tạo, thử lại sau.' : errorText(error);
            cardMsg.hidden = false;
          } finally {
            if (viewThumbBtn.isConnected) viewThumbBtn.disabled = false;
          }
        },
      });
      const downloadBtn = ui.button({
        label: 'Tải ảnh gốc',
        kind: 'secondary',
        size: 'sm',
        icon: 'arrow-line-down',
        onClick: async () => {
          cardMsg.hidden = true;
          downloadBtn.disabled = true;
          try {
            const blob = await ctx.api.binary(`/api/evidence/${item.id}/content`);
            if (!box.isConnected) return;
            const objUrl = globalThis.URL.createObjectURL(blob);
            const a = h('a', { href: objUrl, download: `bang-chung-${item.id}.${item.contentType === 'image/png' ? 'png' : 'jpg'}` });
            box.append(a);
            a.click();
            a.remove();
            downloads.set(objUrl, globalThis.setTimeout(() => {
              globalThis.URL.revokeObjectURL(objUrl);
              downloads.delete(objUrl);
            }, 1000));
          } catch (error) {
            if (!ctx.stale() && cardMsg.isConnected) ui.clearToasts();
            cardMsg.textContent = errorText(error);
            cardMsg.hidden = false;
          } finally {
            if (downloadBtn.isConnected) downloadBtn.disabled = false;
          }
        },
      });

      box.append(ui.card({
        title: `Ảnh ${page.offset + idx + 1}`,
        subtitle: `${IMAGE_TYPES[item.contentType] || item.contentType} · ${item.width} x ${item.height} px · ${formatIso(item.createdAt)}`,
        body: h('div', { class: 'stack-sm' },
          h('div', { class: 'btn-row' }, viewThumbBtn, downloadBtn),
          cardMsg,
          thumbSlot),
      }));
    });
  }

  loadPage(0);
  return ui.section('Bằng chứng ảnh', box);
}

function mediationStatusCard(dispute, escalations = []) {
  const level = dispute.mediationLevel === 'ADMIN' ? 'ADMIN' : 'HTX';
  const badge = MEDIATION_LEVEL_BADGE[level] || MEDIATION_LEVEL_BADGE.HTX;
  const rows = [
    ['Cấp hòa giải', MEDIATION_LEVEL_LABELS[level] || level],
    ['Người hòa giải', dispute.mediatorId
      ? (level === 'ADMIN' ? 'Đã gán Quản trị viên độc lập' : 'Đã gán hòa giải viên cấp HTX')
      : 'Chưa gán người hòa giải'],
  ];
  if (dispute.escalatedAt) {
    rows.push(['Chuyển cấp lúc', formatIso(dispute.escalatedAt)]);
    if (dispute.escalationConflictType) {
      rows.push(['Căn cứ chuyển cấp', CONFLICT_TYPE_LABELS[dispute.escalationConflictType] || dispute.escalationConflictType]);
    }
    if (dispute.escalationReason) {
      rows.push(['Lý do chuyển cấp', dispute.escalationReason]);
    }
  } else if (escalations.length) {
    const lastEsc = escalations[escalations.length - 1];
    rows.push(['Chuyển cấp lúc', formatIso(lastEsc.createdAt)]);
    if (lastEsc.conflictType) {
      rows.push(['Căn cứ chuyển cấp', CONFLICT_TYPE_LABELS[lastEsc.conflictType] || lastEsc.conflictType]);
    }
    if (lastEsc.reason) {
      rows.push(['Lý do chuyển cấp', lastEsc.reason]);
    }
  }
  return ui.card({
    title: 'Cấp hòa giải và chuyển cấp',
    actions: ui.badge(...badge),
    body: ui.kv(rows),
  });
}

function escalationRequestCard(ctx, dispute) {
  if (!canEscalateDispute(ctx.user, dispute)) return null;
  const conflictSel = ui.select({
    name: 'conflictType',
    value: 'PARTY_REQUEST',
    options: [
      ['PARTY_REQUEST', CONFLICT_TYPE_LABELS.PARTY_REQUEST],
      ['AFFILIATION_CONFLICT', CONFLICT_TYPE_LABELS.AFFILIATION_CONFLICT],
      ['PARTY_CONFLICT', CONFLICT_TYPE_LABELS.PARTY_CONFLICT],
      ['ROLE_OVERLAP', CONFLICT_TYPE_LABELS.ROLE_OVERLAP],
      ['MACHINE_CONFLICT', CONFLICT_TYPE_LABELS.MACHINE_CONFLICT],
    ],
  });
  const reasonTa = ui.textarea({ name: 'reason', rows: 3, maxlength: MAX_TEXT_LEN });
  const form = apiForm({
    fields: [
      ui.field({
        label: 'Căn cứ yêu cầu chuyển cấp',
        hint: 'Chọn lý do phù hợp nếu thấy HTX có liên quan lợi ích hoặc muốn Quản trị viên độc lập xem xét.',
        input: conflictSel,
      }),
      ui.field({
        label: 'Mô tả lý do chuyển cấp',
        hint: 'Tối đa 2.000 ký tự. Sau khi chuyển cấp, hòa giải viên HTX hiện tại sẽ dừng xử lý và các phương án HTX cũ không còn hiệu lực.',
        input: reasonTa,
        required: true,
      }),
    ],
    submitLabel: 'Yêu cầu chuyển lên Quản trị độc lập',
    submitKind: 'secondary',
    async run(fd) {
      const { error, payload } = escalationInput({
        conflictType: String(fd.get('conflictType') || ''),
        reason: String(fd.get('reason') || ''),
      });
      if (error) {
        reasonTa.focus();
        throw new Error(error);
      }
      try {
        await ctx.api.request('POST', `/api/disputes/${dispute.id}/escalate`, { auth: true, body: payload });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          ctx.toast(farmerRefusalMessage(err), 'warn');
          ctx.rerender();
        }
        throw new Error(farmerRefusalMessage(err), { cause: err });
      }
    },
    onDone() {
      if (ctx.stale()) return;
      ctx.toast('Đã chuyển vụ việc lên Quản trị viên độc lập', 'ok');
      ctx.rerender();
    },
  });

  return ui.card({
    title: 'Chuyển vụ việc lên Quản trị viên độc lập',
    subtitle: 'Nếu bạn thấy HTX có xung đột lợi ích hoặc muốn hòa giải cấp trên, bạn có thể yêu cầu chuyển cấp.',
    body: form,
  });
}

function consentActionButton(ctx, disputeId, version) {
  const msg = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
  let busy = false;
  const btn = ui.button({
    label: `Đồng ý phương án phiên bản ${version}`,
    kind: 'primary',
    size: 'lg',
    block: true,
    icon: 'seal-check',
    onClick: () => {
      ui.confirm({
        title: `Xác nhận đồng ý phương án phiên bản ${version}`,
        text: 'Chỉ đồng ý khi bạn chấp nhận nội dung phương án này. Nền tảng không tự hoàn tiền hay sửa số liệu thanh toán.',
        confirmLabel: 'Đồng ý phương án',
        onConfirm: async () => {
          if (busy) return;
          busy = true;
          btn.disabled = true;
          btn.setAttribute('aria-busy', 'true');
          msg.hidden = true;
          try {
            await ctx.api.request('POST', `/api/disputes/${disputeId}/proposals/${version}/consent`, { auth: true, body: {} });
            if (ctx.stale()) return;
            ctx.toast('Đã ghi nhận đồng ý phương án', 'ok');
            ctx.rerender();
          } catch (error) {
            if (ctx.stale()) return;
            ui.clearToasts();
            const text = farmerRefusalMessage(error);
            if (error instanceof ApiError && error.status === 409) {
              ctx.toast(text, 'warn');
              ctx.rerender();
              return;
            }
            msg.textContent = text;
            msg.hidden = false;
          } finally {
            busy = false;
            if (btn.isConnected) {
              btn.disabled = false;
              btn.removeAttribute('aria-busy');
            }
          }
        },
      });
    },
  });
  return h('div', { class: 'action action--block' }, btn, msg);
}

async function disputesScreen(ctx) {
  if (ctx.params.booking) {
    if (!isUuid(ctx.params.booking)) return invalidIdScreen('Mã đơn không hợp lệ', 'Không mở được mẫu khiếu nại.', 'F-07');
    const bookingId = ctx.params.booking.toLowerCase();
    const { data } = await ctx.api.request('GET', `/api/bookings/${bookingId}`, { auth: true });
    if (ctx.stale()) return h('div');

    const reasonSel = ui.select({
      name: 'reason',
      value: '',
      options: [['', 'Chọn lý do khiếu nại'], ...Object.entries(DISPUTE_REASONS)],
    });
    const detailsTa = ui.textarea({ name: 'details', rows: 5, maxlength: MAX_TEXT_LEN });
    const form = apiForm({
      fields: [
        ui.field({ label: 'Lý do khiếu nại', input: reasonSel, required: true }),
        ui.field({ label: 'Mô tả vụ việc', hint: 'Nêu rõ sự việc đã xảy ra (tối đa 2.000 ký tự).', input: detailsTa, required: true }),
      ],
      submitLabel: 'Gửi khiếu nại',
      async run(fd) {
        const reason = String(fd.get('reason') || '');
        const details = String(fd.get('details') || '').trim();
        if (!Object.hasOwn(DISPUTE_REASONS, reason)) throw new Error('Chọn lý do khiếu nại.');
        if (!details || [...details].length > MAX_TEXT_LEN) throw new Error('Nhập mô tả vụ việc (tối đa 2.000 ký tự).');
        const res = await ctx.api.request('POST', `/api/bookings/${bookingId}/disputes`, {
          auth: true,
          body: { reason, details },
        });
        return res.data;
      },
      onDone(res) {
        ctx.toast('Đã mở khiếu nại', 'ok');
        ctx.go(fUrl('F-13', { id: res.dispute.id }));
      },
    });

    return wrap(
      orderHead(data.booking),
      ui.note({
        tone: 'warn',
        text: 'Khi khiếu nại đang mở, các thao tác nghiệm thu và ghi báo thanh toán của đơn sẽ tạm dừng cho đến khi giải quyết.',
      }),
      form,
      ui.button({ label: 'Quay lại chi tiết đơn', kind: 'secondary', block: true, href: fUrl('F-07', { id: bookingId }), icon: 'arrow-left' }),
    );
  }

  if (ctx.params.id) {
    if (!isUuid(ctx.params.id)) return invalidIdScreen('Mã khiếu nại không hợp lệ', 'Không tìm thấy vụ việc này.', 'F-13');
    const id = ctx.params.id.toLowerCase();
    const { data } = await ctx.api.request('GET', `/api/disputes/${id}`, { auth: true });
    if (ctx.stale()) return h('div');

    const { dispute, events = [], escalations = [] } = data;
    const isRespondent = ctx.user.id === dispute.respondentId;
    const roleText = ctx.user.id === dispute.claimantId
      ? 'Bên khiếu nại'
      : isRespondent
        ? 'Bên bị khiếu nại'
        : 'Người liên quan';

    const whoLabel = (actorId) => (actorId === dispute.claimantId
      ? 'Bên khiếu nại'
      : actorId === dispute.respondentId
        ? 'Bên bị khiếu nại'
        : dispute.mediationLevel === 'ADMIN'
          ? 'Quản trị viên'
          : 'HTX điều phối');

    const mergedEvents = [
      ...events.map((ev) => ({
        sequence: Number(ev.sequence) || 0,
        type: ev.type,
        actorId: ev.actorId,
        createdAt: ev.createdAt,
        extra: ev.data?.details || ev.data?.text || '',
      })),
      ...escalations.map((esc) => ({
        sequence: Number(esc.sequence) || 0,
        type: 'MEDIATION_ESCALATED',
        actorId: esc.actorId,
        createdAt: esc.createdAt,
        extra: [
          esc.conflictType ? (CONFLICT_TYPE_LABELS[esc.conflictType] || esc.conflictType) : null,
          esc.reason || null,
        ].filter(Boolean).join(' · '),
      })),
    ].sort((a, b) => a.sequence - b.sequence);

    let respondCard = null;
    if (dispute.status === 'OPEN' && isRespondent) {
      const respTa = ui.textarea({ name: 'text', rows: 4, maxlength: MAX_TEXT_LEN });
      respondCard = ui.card({
        title: 'Phản hồi của bạn',
        subtitle: 'Phản hồi được lưu nối tiếp, không sửa hay xóa được sau khi gửi.',
        body: apiForm({
          fields: [ui.field({ label: 'Nội dung phản hồi', hint: 'Tối đa 2.000 ký tự.', input: respTa, required: true })],
          submitLabel: 'Gửi phản hồi',
          async run(fd) {
            const text = String(fd.get('text') || '').trim();
            if (!text || [...text].length > MAX_TEXT_LEN) throw new Error('Nhập nội dung phản hồi (tối đa 2.000 ký tự).');
            try {
              return await ctx.api.request('POST', `/api/disputes/${id}/responses`, { auth: true, body: { text } });
            } catch (err) {
              throw new Error(farmerRefusalMessage(err), { cause: err });
            }
          },
          onDone() {
            ctx.toast('Đã gửi phản hồi', 'ok');
            ctx.rerender();
          },
        }),
      });
    }

    return wrap(
      ui.banner({
        tone: dispute.status === 'RESOLVED' ? 'success' : 'warn',
        title: DISPUTE_STATUS_LABELS[dispute.status] || dispute.status,
        text: DISPUTE_FREEZE_NOTES[dispute.status] || '',
      }),
      ui.card({
        title: DISPUTE_REASONS[dispute.reason] || dispute.reason,
        actions: ui.badge(...(MEDIATION_LEVEL_BADGE[dispute.mediationLevel] || MEDIATION_LEVEL_BADGE.HTX)),
        body: ui.kv([
          ['Trạng thái', DISPUTE_STATUS_LABELS[dispute.status] || dispute.status],
          ['Vai trò của bạn', roleText],
          ['Mở lúc', formatIso(dispute.createdAt)],
          ['Đơn liên quan', ui.link('Mở chi tiết đơn', fUrl('F-07', { id: dispute.bookingId }))],
        ]),
      }),
      mediationStatusCard(dispute, escalations),
      ui.button({
        label: 'Xem phương án và kết quả hòa giải (F-14)',
        kind: 'primary',
        size: 'lg',
        block: true,
        icon: 'scales',
        href: fUrl('F-14', { id }),
      }),
      escalationRequestCard(ctx, dispute),
      respondCard,
      ui.section('Diễn biến vụ việc', mergedEvents.length
        ? ui.timeline(mergedEvents.map((ev, idx) => ({
          title: `${DISPUTE_EVENT_LABELS[ev.type] || ev.type} (${whoLabel(ev.actorId)})`,
          meta: `${formatIso(ev.createdAt)}${ev.extra ? ` · ${ev.extra}` : ''}`,
          done: idx < mergedEvents.length - 1,
          now: idx === mergedEvents.length - 1,
        })))
        : h('p', { class: 'muted' }, 'Chưa có diễn biến.')),
      evidenceSection(ctx, id),
      ui.button({ label: 'Danh sách khiếu nại', kind: 'secondary', block: true, href: fUrl('F-13'), icon: 'arrow-left' }),
    );
  }

  const { data } = await ctx.api.request('GET', '/api/disputes?limit=50&offset=0', { auth: true });
  if (ctx.stale()) return h('div');
  const items = data.items || [];

  if (!items.length) {
    return wrap(ui.empty({
      icon: 'scales',
      title: 'Chưa có khiếu nại nào',
      text: 'Bạn có thể mở khiếu nại từ chi tiết một đơn đã có máy nhận.',
      action: ui.button({ label: 'Xem danh sách đơn', kind: 'primary', href: fUrl('F-07'), icon: 'clipboard-text' }),
    }));
  }

  return wrap(
    h('p', { class: 'small muted' }, 'Danh sách các vụ việc bạn là bên khiếu nại hoặc bên bị khiếu nại.'),
    ui.list(items.map((d) => {
      const level = MEDIATION_LEVEL_BADGE[d.mediationLevel] || MEDIATION_LEVEL_BADGE.HTX;
      return ui.listItem({
        title: DISPUTE_REASONS[d.reason] || d.reason,
        meta: `Mở lúc ${formatIso(d.createdAt)} · ${MEDIATION_LEVEL_LABELS[d.mediationLevel] || level[0]}`,
        right: ui.badge(DISPUTE_STATUS_LABELS[d.status] || d.status, d.status === 'OPEN' ? 'warn' : 'outline'),
        href: fUrl('F-13', { id: d.id }),
        icon: 'warning',
      });
    })),
  );
}

/* ---------- F-14 Ket qua hoa giai ---------- */

async function mediationResultScreen(ctx) {
  if (!ctx.params.id) {
    const { data } = await ctx.api.request('GET', '/api/disputes?limit=50&offset=0', { auth: true });
    if (ctx.stale()) return h('div');
    const items = data.items || [];
    if (!items.length) {
      return wrap(ui.empty({
        icon: 'scales',
        title: 'Chưa có vụ hòa giải nào',
        text: 'Các vụ khiếu nại và phương án hòa giải sẽ hiện tại đây.',
        action: ui.button({ label: 'Xem danh sách đơn', kind: 'primary', href: fUrl('F-07') }),
      }));
    }
    return wrap(ui.list(items.map((d) => {
      const level = MEDIATION_LEVEL_BADGE[d.mediationLevel] || MEDIATION_LEVEL_BADGE.HTX;
      return ui.listItem({
        title: DISPUTE_REASONS[d.reason] || d.reason,
        meta: `Mở lúc ${formatIso(d.createdAt)} · ${MEDIATION_LEVEL_LABELS[d.mediationLevel] || level[0]}`,
        right: ui.badge(DISPUTE_STATUS_LABELS[d.status] || d.status, d.status === 'OPEN' ? 'warn' : 'outline'),
        href: fUrl('F-14', { id: d.id }),
        icon: 'scales',
      });
    })));
  }

  if (!isUuid(ctx.params.id)) return invalidIdScreen('Mã vụ việc không hợp lệ', 'Không tìm thấy hồ sơ hòa giải này.', 'F-13');
  const id = ctx.params.id.toLowerCase();

  const [detailRes, propRes] = await Promise.all([
    ctx.api.request('GET', `/api/disputes/${id}`, { auth: true }),
    ctx.api.request('GET', `/api/disputes/${id}/proposals`, { auth: true }),
  ]);
  if (ctx.stale()) return h('div');

  const dispute = detailRes.data.dispute;
  const escalations = detailRes.data.escalations || [];
  const closure = propRes.data.dispute;
  const proposals = propRes.data.proposals || [];
  const remedyEvents = propRes.data.events || [];
  const latest = proposals.reduce((top, p) => (!top || p.version > top.version ? p : top), null);
  const isParty = ctx.user.id === dispute.claimantId || ctx.user.id === dispute.respondentId;

  const whoLabel = (actorId) => (actorId === dispute.claimantId
    ? 'Bên khiếu nại'
    : actorId === dispute.respondentId
      ? 'Bên bị khiếu nại'
      : dispute.mediationLevel === 'ADMIN'
        ? 'Quản trị viên hòa giải'
        : 'Hòa giải viên HTX');

  return wrap(
    ui.banner({
      tone: dispute.status === 'RESOLVED' ? 'success' : 'warn',
      title: DISPUTE_STATUS_LABELS[dispute.status] || dispute.status,
      text: DISPUTE_FREEZE_NOTES[dispute.status] || '',
    }),
    mediationStatusCard(dispute, escalations),
    closure.closedAt ? ui.card({
      title: 'Kết thúc vụ việc',
      body: ui.kv([
        ['Đóng lúc', formatIso(closure.closedAt)],
        ['Lý do đóng', closure.closureReason || 'Không ghi nhận'],
      ]),
    }) : null,
    ui.note({
      tone: 'info',
      text: dispute.mediationLevel === 'ADMIN'
        ? 'Vụ việc đang ở cấp Quản trị viên độc lập. Quản trị viên không liên quan đơn đề xuất phương án; vụ việc chỉ giải quyết khi cả hai bên tự đồng ý trên cùng một phiên bản mới nhất.'
        : 'Vụ việc đang hòa giải ở cấp HTX. HTX đủ điều kiện độc lập đề xuất phương án; vụ việc chỉ giải quyết khi cả hai bên tự đồng ý trên cùng một phiên bản mới nhất.',
    }),
    escalationRequestCard(ctx, dispute),
    ui.section('Phương án hòa giải và đồng ý từng bên', proposals.length
      ? proposals.map((p) => {
        const isLatest = latest && p.version === latest.version;
        const staleMediator = isLatest && p.mediatorId !== dispute.mediatorId;
        const signed = (p.consents || []).some((c) => c.actorId === ctx.user.id);
        const canConsent = isLatest && dispute.status === 'OPEN' && isParty && !staleMediator && !signed;
        const consentRows = partyConsentRows(dispute, p);

        return ui.card({
          title: `Phiên bản ${p.version}`,
          subtitle: `Đề xuất lúc ${formatIso(p.createdAt)}`,
          actions: ui.badge(isLatest ? 'Mới nhất' : 'Đã thay thế', isLatest ? 'info' : 'outline'),
          body: h('div', { class: 'stack-sm' },
            h('p', null, p.text),
            ui.kv(consentRows.map((row) => [
              row.actorId === ctx.user.id ? `${row.label} (Bạn)` : row.label,
              row.done
                ? ui.badge(`Đã đồng ý lúc ${formatIso(row.at)}`, 'ok', 'check-circle')
                : ui.badge('Chưa đồng ý', 'idle', 'clock'),
            ])),
            staleMediator
              ? ui.note({
                tone: 'warn',
                text: dispute.mediationLevel === 'ADMIN'
                  ? 'Vụ việc đã chuyển cấp hoặc thay đổi người hòa giải. Phiên bản này không còn hiệu lực, hai bên cần chờ Quản trị viên độc lập đề xuất phiên bản mới.'
                  : 'Người hòa giải đã thay đổi sau phiên bản này. Hai bên cần chờ phương án mới để đồng ý.',
              })
              : null,
            isLatest && signed && !staleMediator
              ? ui.note({ tone: 'success', text: `Bạn đã đồng ý đúng phiên bản ${p.version}.` })
              : null,
            canConsent ? consentActionButton(ctx, id, p.version) : null),
        });
      })
      : h('p', { class: 'muted' }, 'Chưa có phương án hòa giải nào.')),
    remedyEvents.length ? ui.section('Nhật ký hòa giải', ui.timeline(remedyEvents.map((ev, idx) => ({
      title: `${PROPOSAL_EVENT_LABELS[ev.event_type] || ev.event_type}${ev.version ? ` (phiên bản ${ev.version})` : ''}`,
      meta: `${whoLabel(ev.actor_id)} · ${formatIso(ev.created_at)}${ev.details ? ` · ${ev.details}` : ''}`,
      done: idx < remedyEvents.length - 1,
      now: idx === remedyEvents.length - 1,
    })))) : null,
    h('div', { class: 'btn-row' },
      ui.button({ label: 'Xem chi tiết khiếu nại', kind: 'secondary', href: fUrl('F-13', { id }), icon: 'arrow-left' }),
      ui.button({ label: 'Mở đơn liên quan', kind: 'secondary', href: fUrl('F-07', { id: dispute.bookingId }) })),
  );
}

/* ---------- F-15 Hoan lich ---------- */

async function postponementScreen(ctx) {
  let packageId = isUuid(ctx.params.package) ? ctx.params.package.toLowerCase() : null;
  let bookingId = isUuid(ctx.params.id) ? ctx.params.id.toLowerCase() : null;

  if (!packageId && !bookingId) {
    const { data } = await ctx.api.request('GET', '/api/bookings?limit=50&offset=0', { auth: true });
    if (ctx.stale()) return h('div');
    const grouped = (data.items || []).filter((b) => b.state === 'GROUPED' || b.state === 'ASSIGNED');
    if (!grouped.length) {
      return wrap(ui.empty({
        icon: 'clock',
        title: 'Chưa có đơn thuộc gói việc',
        text: 'Chỉ các đơn đã vào gói việc mới có lịch gói và đề xuất dời lịch.',
        action: ui.button({ label: 'Xem đơn của tôi', kind: 'primary', href: fUrl('F-07') }),
      }));
    }
    return wrap(
      h('p', { class: 'small muted' }, 'Chọn đơn đã vào gói để xem đề xuất dời lịch.'),
      ui.list(grouped.map((b) => ui.listItem({
        title: `${b.field?.name || 'Thửa'}, ${b.service?.name || 'Dịch vụ'}`,
        meta: formatWindow(b.startAt, b.endAt),
        right: ui.stateBadge(b.state),
        href: fUrl('F-15', { id: b.id }),
        icon: 'clock',
      }))),
    );
  }

  if (ctx.params.id && !bookingId) return invalidIdScreen('Mã đơn không hợp lệ', 'Không mở được lịch dời cho mã này.', 'F-07');
  if (ctx.params.package && !packageId) return invalidIdScreen('Mã gói không hợp lệ', 'Không mở được lịch dời cho mã này.', 'F-07');

  if (!packageId && bookingId) {
    const { data } = await ctx.api.request('GET', `/api/bookings/${bookingId}/postponement`, { auth: true });
    if (ctx.stale()) return h('div');
    if (!data?.packageId) {
      return wrap(ui.empty({
        icon: 'clock',
        title: 'Đơn chưa được gom vào gói',
        text: 'Khi HTX gom đơn vào gói việc, bạn sẽ xem và xác nhận đề xuất dời lịch tại đây.',
        action: ui.button({ label: 'Quay lại chi tiết đơn', kind: 'primary', href: fUrl('F-07', { id: bookingId }), icon: 'arrow-left' }),
      }));
    }
    packageId = data.packageId;
  }

  const { data: view } = await ctx.api.request('GET', `/api/packages/${packageId}/postponement`, { auth: true });
  if (ctx.stale()) return h('div');

  const pkg = view.package;
  const latest = view.latest;
  const history = view.history || [];
  const perms = view.permissions || {};
  const consentAction = latest && perms.canConsent ? apiButton({
    label: `Đồng ý dời lịch phiên bản ${latest.version}`,
    kind: 'primary',
    size: 'lg',
    block: true,
    icon: 'check-circle',
    async run() {
      try {
        await ctx.api.request('POST', `/api/packages/${packageId}/postponement/${latest.version}/consent`, { auth: true, body: {} });
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'STALE_VERSION') throw error;
        if (ctx.stale()) return;
        ui.clearToasts();
        const reload = ui.button({ label: 'Tải lại đề xuất', kind: 'secondary', onClick: () => ctx.rerender() });
        consentAction.replaceWith(ui.note({ tone: 'error', text: 'Đã có đề xuất dời lịch mới. Tải lại để xem đúng phiên bản.', action: reload }));
        reload.focus();
        return;
      }
      if (ctx.stale()) return;
      ctx.toast('Đã ghi nhận đồng ý dời lịch', 'ok');
      ctx.rerender();
    },
  }) : null;

  return wrap(
    ui.card({
      title: 'Khung giờ gói việc hiện tại',
      subtitle: PACKAGE_STATUS_LABELS[pkg.status] || pkg.status,
      body: ui.kv([
        ['Bắt đầu hiện tại', formatIso(pkg.startAt)],
        ['Kết thúc hiện tại', formatIso(pkg.endAt)],
      ]),
    }),
    ui.note({
      tone: 'info',
      text: 'Dời lịch áp dụng cho toàn bộ gói việc trước khi ca máy bắt đầu. Lịch mới chỉ có hiệu lực khi tất cả chủ ruộng trong gói và chủ máy cùng đồng ý đúng phiên bản.',
    }),
    latest
      ? ui.card({
        title: `Đề xuất phiên bản ${latest.version}`,
        subtitle: latest.appliedAt ? `Đã áp dụng lúc ${formatIso(latest.appliedAt)}` : `Đã đồng ý: ${latest.consentedCount}/${latest.requiredCount} bên`,
        body: h('div', { class: 'stack-sm' },
          ui.kv([
            ['Khung giờ cũ', formatWindow(latest.oldStartAt, latest.oldEndAt)],
            ['Khung giờ đề xuất', formatWindow(latest.startAt, latest.endAt)],
            ['Lý do', latest.reason],
            ['Trạng thái của bạn', latest.ownConsented ? 'Đã đồng ý' : 'Chưa đồng ý'],
          ]),
          consentAction),
      })
      : ui.empty({
        icon: 'calendar-plus',
        title: 'Chưa có đề xuất dời lịch',
        text: 'Khung giờ hiện tại của gói vẫn giữ nguyên.',
      }),
    history.length > 1 ? ui.section('Các phiên bản trước', ui.list(history.slice(1).map((item) => ui.listItem({
      title: `Phiên bản ${item.version}: ${formatWindow(item.startAt, item.endAt)}`,
      meta: `${item.reason} · ${item.consentedCount}/${item.requiredCount} bên đồng ý`,
      icon: 'clock',
    })))) : null,
    bookingId ? ui.button({ label: 'Quay lại chi tiết đơn', kind: 'secondary', block: true, href: fUrl('F-07', { id: bookingId }), icon: 'arrow-left' }) : null,
  );
}

export const screens = [
  { code: 'F-01', title: 'Trang chính', render: homeScreen },
  { code: 'F-02', title: 'Thửa ruộng', render: fieldsScreen },
  { code: 'F-03', title: 'Thêm thửa ruộng', render: addFieldScreen },
  { code: 'F-04', title: 'Đường vào và đất ruộng', render: fieldAccessScreen },
  { code: 'F-05', title: 'Đặt dịch vụ gặt', render: bookServiceScreen },
  { code: 'F-06', title: 'Bảng giá và xác nhận', render: quoteConfirmScreen },
  { code: 'F-07', title: 'Đơn dịch vụ', render: bookingDetailScreen },
  { code: 'F-08', title: 'Ruộng sẵn sàng', render: readinessScreen },
  { code: 'F-09', title: 'Cọc ngoài hệ thống', render: farmerDepositScreen },
  { code: 'F-11', title: 'Nghiệm thu', render: acceptanceScreen },
  { code: 'F-12', title: 'Quyết toán', render: settlementScreen },
  { code: 'F-13', title: 'Khiếu nại', render: disputesScreen },
  { code: 'F-14', title: 'Kết quả hòa giải', render: mediationResultScreen },
  { code: 'F-15', title: 'Hoãn lịch', render: postponementScreen },
];
