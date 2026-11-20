// Màn quản trị nền tảng A-01 (Duyệt hồ sơ) và A-03 (Trọng tài) trên API thật.
// Chỉ hiển thị dữ liệu và quyền từ máy chủ; nền tảng không giữ hay chuyển tiền.
import { ApiError } from '../../api.js';
import { ui } from '../kit/ui.js';
import { apiButton, apiForm, errorText } from '../app/actions.js';
import { url } from '../app/routes.js';

const h = ui.h;
const PAGE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const ROLE_LABEL = {
  farmer: 'Nông dân',
  provider: 'Chủ máy',
  operator: 'Thợ lái',
  coop: 'HTX điều phối',
  admin: 'Quản trị nền tảng',
};
const ROLE_ICON = {
  farmer: 'plant',
  provider: 'tractor',
  operator: 'identification-card',
  coop: 'buildings',
  admin: 'shield-check',
};
const REQUEST_STATUS = {
  PENDING: ['Chờ duyệt', 'idle'],
  APPROVED: ['Đã duyệt', 'ok'],
  REJECTED: ['Từ chối', 'error'],
};
const DISPUTE_REASONS = {
  AREA_MISMATCH: 'Diện tích không khớp',
  QUALITY: 'Chất lượng công việc',
  NO_SHOW: 'Không có mặt',
  PAYMENT: 'Thanh toán',
  OTHER: 'Lý do khác',
};
const DISPUTE_STATUS = {
  OPEN: ['Đang mở', 'warn'],
  RESOLVED: ['Đã giải quyết', 'ok'],
  CLOSED_UNRESOLVED: ['Đóng chưa giải quyết', 'error'],
  CLOSED: ['Đã đóng', 'muted'],
};
const CASE_EVENTS = {
  DISPUTE_OPENED: 'Mở khiếu nại',
  RESPONSE_ADDED: 'Phản hồi',
  MEDIATOR_ASSIGNED: 'Gán người hòa giải',
  MEDIATION_ESCALATED: 'Chuyển cấp lên Quản trị độc lập',
};
const PROPOSAL_EVENTS = {
  PROPOSED: 'Đề xuất phương án',
  CONSENTED: 'Đồng ý phương án',
  RESOLVED: 'Hai bên đồng ý phương án',
  CLOSED_UNRESOLVED: 'Đóng chưa giải quyết',
};
const EVIDENCE_TYPES = { 'image/jpeg': 'JPEG', 'image/png': 'PNG' };

const MEDIATION_LEVEL_LABELS = {
  HTX: 'Cấp HTX (sơ cấp)',
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

const REFUSALS = {
  SELF_APPROVAL_FORBIDDEN: 'Bạn không thể tự duyệt hoặc tự từ chối yêu cầu của chính mình.',
  REQUEST_DECIDED: 'Yêu cầu này đã được quyết định trước đó. Tải lại danh sách để xem trạng thái mới.',
  RECUSAL_REQUIRED: 'Bạn có liên quan đến vụ việc nên không thể hòa giải hoặc gán người hòa giải.',
  PARTY_CONFLICT: 'Không thể chọn người này làm người hòa giải vì có liên quan đến vụ việc.',
  INVALID_MEDIATOR: 'Người được chọn không đủ điều kiện làm người hòa giải.',
  DISPUTE_NOT_OPEN: 'Vụ việc đã đóng. Tải lại để xem trạng thái mới.',
  STATE_CHANGED: 'Dữ liệu vừa thay đổi do thao tác khác. Tải lại trước khi thử lại.',
  STALE_VERSION: 'Phương án đã có phiên bản mới. Tải lại để xem phiên bản mới nhất.',
  MEDIATOR_CHANGED: 'Người hòa giải đã thay đổi. Tải lại trước khi thao tác.',
  VALIDATION_FAILED: 'Nội dung chưa hợp lệ. Kiểm tra độ dài và thông tin rồi thử lại.',
  INVALID_REQUEST: 'Lý do hoặc dữ liệu chưa hợp lệ (tối đa 500 ký tự, không chứa ký tự điều khiển).',
  INVALID_ID: 'Mã hồ sơ hoặc vụ việc không hợp lệ.',
  NOT_FOUND: 'Không tìm thấy mục này hoặc bạn không có quyền xem.',
  THUMBNAIL_PENDING: 'Ảnh thu nhỏ đang được chuẩn bị. Thử lại sau.',
  CONTENT_UNAVAILABLE: 'Không tải được ảnh gốc lúc này. Thử lại sau.',
  STORAGE_UNAVAILABLE: 'Kho lưu trữ ảnh chưa sẵn sàng. Thử lại sau.',
  ESCALATION_REQUIRED: 'Vụ việc đang ở cấp hòa giải HTX. Cần lập biên bản chuyển cấp lên Quản trị trước khi gán người hòa giải độc lập.',
  ALREADY_ESCALATED: 'Vụ việc đã được chuyển cấp lên Quản trị trước đó. Tải lại để xem trạng thái mới.',
  ESCALATED_TO_ADMIN: 'Vụ việc đã chuyển lên cấp Quản trị, không thể thao tác ở cấp HTX.',
  ROLE_OVERLAP: 'Tài khoản có vai trò kiêm nhiệm xung đột lợi ích với vụ việc này.',
  MACHINE_CONFLICT: 'Tài khoản có sở hữu máy móc liên quan đến đơn này.',
  HTX_NOT_RELATED: 'HTX không phụ trách đơn này.',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const isInstant = (v) => typeof v === 'string' && INSTANT.test(v) && Number.isFinite(Date.parse(v));
const nullable = (v, fn) => v === null || fn(v);
const shortId = (id) => (typeof id === 'string' ? id.slice(0, 8) : '');
const fmtTime = (iso) => ui.fmt.dateTime(Date.parse(iso));
const badResponse = () => new ApiError(502, 'BAD_RESPONSE');

function parseOffset(value) {
  const n = Number.parseInt(value || '0', 10);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return Math.min(10000, n);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;
}

// ---- Pure helpers (exported for unit checks) ----

export function refusalText(code) {
  return typeof code === 'string' && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : null;
}

function apiRefusalMessage(error) {
  if (error instanceof ApiError) {
    const known = refusalText(error.code);
    if (known) return known;
  }
  return errorText(error);
}

export function reasonInput(value) {
  if (typeof value !== 'string') return { error: 'Nhập lý do từ chối.', payload: null };
  const reason = value.trim();
  const len = [...reason].length;
  if (len < 1) return { error: 'Nhập lý do từ chối.', payload: null };
  if (len > 500) return { error: 'Lý do từ chối tối đa 500 ký tự.', payload: null };
  if (/\p{Cc}/u.test(reason)) return { error: 'Lý do không được chứa ký tự điều khiển.', payload: null };
  return { error: null, payload: { reason } };
}

function bounded2000(value, emptyMsg) {
  if (typeof value !== 'string') return { error: emptyMsg, text: null };
  const text = value.trim();
  const len = [...text].length;
  if (len < 1) return { error: emptyMsg, text: null };
  if (len > 2000) return { error: 'Nội dung tối đa 2000 ký tự.', text: null };
  return { error: null, text };
}

export function proposalInput(value) {
  const { error, text } = bounded2000(value, 'Nhập nội dung phương án trước khi gửi.');
  return { error, payload: text === null ? null : { text } };
}

export function closeInput(value) {
  const { error, text } = bounded2000(value, 'Nhập lý do đóng chưa giải quyết.');
  return { error, payload: text === null ? null : { reason: text } };
}

export function escalationInput({ reason, conflictType } = {}) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  const len = [...trimmed].length;
  if (len < 1) return { error: 'Nhập lý do chuyển cấp lên Quản trị.', payload: null };
  if (len > 2000) return { error: 'Lý do chuyển cấp tối đa 2000 ký tự.', payload: null };
  if (conflictType !== undefined && conflictType !== null && conflictType !== '') {
    if (typeof conflictType !== 'string' || !Object.hasOwn(CONFLICT_TYPE_LABELS, conflictType)) {
      return { error: 'Loại lý do chuyển cấp không hợp lệ.', payload: null };
    }
    return { error: null, payload: { reason: trimmed, conflictType } };
  }
  return { error: null, payload: { reason: trimmed } };
}

export function canAssignMediator(actor, dispute) {
  if (!isObj(actor) || !isObj(dispute) || dispute.status !== 'OPEN') return false;
  if (!Array.isArray(actor.roles) || !actor.roles.includes('admin')) return false;
  return actor.id !== dispute.claimantId && actor.id !== dispute.respondentId;
}

export function canMediate(actor, dispute) {
  if (!isObj(actor) || !isObj(dispute) || dispute.status !== 'OPEN') return false;
  if (!Array.isArray(actor.roles) || !actor.roles.includes('admin')) return false;
  return actor.id === dispute.mediatorId;
}

export function disputeRoleOf(actor, dispute) {
  if (actor?.id === dispute?.claimantId) return 'claimant';
  if (actor?.id === dispute?.respondentId) return 'respondent';
  if (actor?.id === dispute?.mediatorId) return 'mediator';
  return 'reviewer';
}

export function consentLines(dispute, latestProposal) {
  if (!isObj(dispute) || !isObj(latestProposal) || !Array.isArray(latestProposal.consents)) return null;
  const byActor = new Map(latestProposal.consents.map((c) => [c.actorId, c.at]));
  return [
    { label: 'Bên khiếu nại', actorId: dispute.claimantId, done: byActor.has(dispute.claimantId), at: byActor.get(dispute.claimantId) || null },
    { label: 'Bên bị khiếu nại', actorId: dispute.respondentId, done: byActor.has(dispute.respondentId), at: byActor.get(dispute.respondentId) || null },
  ];
}

const validRoleRequest = (r) => isObj(r) && isUuid(r.id) && isUuid(r.userId)
  && typeof r.userName === 'string' && r.userName.trim() !== ''
  && typeof r.role === 'string' && Object.hasOwn(REQUEST_STATUS, r.status)
  && isInstant(r.createdAt) && nullable(r.decidedAt, isInstant)
  && nullable(r.decisionReason, (v) => typeof v === 'string') && typeof r.canDecide === 'boolean';

export function queuePage(data, expectedOffset) {
  if (!isObj(data) || !Array.isArray(data.items) || data.limit !== PAGE || data.offset !== expectedOffset) return null;
  if (!data.items.every(validRoleRequest)) return null;
  return { items: data.items, limit: data.limit, offset: data.offset };
}

const validReviewItem = (r) => isObj(r) && isUuid(r.id) && isUuid(r.bookingId)
  && Object.hasOwn(DISPUTE_REASONS, r.reason) && Object.hasOwn(DISPUTE_STATUS, r.status);

export function reviewPage(data, expectedOffset) {
  if (!isObj(data) || !Array.isArray(data.items) || data.limit !== PAGE || data.offset !== expectedOffset) return null;
  if (!data.items.every(validReviewItem)) return null;
  return { items: data.items, limit: data.limit, offset: data.offset };
}

const validDispute = (d) => isObj(d) && isUuid(d.id) && isUuid(d.bookingId)
  && isUuid(d.claimantId) && isUuid(d.respondentId)
  && Object.hasOwn(DISPUTE_REASONS, d.reason) && Object.hasOwn(DISPUTE_STATUS, d.status)
  && nullable(d.mediatorId, isUuid) && isInstant(d.createdAt);

export function disputeListPage(data, expectedOffset) {
  if (!isObj(data) || !Array.isArray(data.items) || data.limit !== PAGE || data.offset !== expectedOffset) return null;
  if (!data.items.every(validDispute)) return null;
  return { items: data.items, limit: data.limit, offset: data.offset };
}

const validCaseEvent = (e) => isObj(e) && Number.isSafeInteger(e.sequence)
  && Object.hasOwn(CASE_EVENTS, e.type) && isUuid(e.actorId) && isObj(e.data) && isInstant(e.createdAt);

function parseDetail(data, expectedId) {
  if (!isObj(data) || !validDispute(data.dispute) || data.dispute.id !== expectedId) return null;
  if (!Array.isArray(data.events) || !data.events.every(validCaseEvent)) return null;
  const escalations = Array.isArray(data.escalations) ? data.escalations : [];
  return { dispute: data.dispute, events: data.events, escalations };
}

const validConsent = (c) => isObj(c) && isUuid(c.actorId) && isInstant(c.at);
const validProposal = (p) => isObj(p) && Number.isSafeInteger(p.version) && p.version >= 1
  && typeof p.text === 'string' && p.text.trim() !== ''
  && isUuid(p.mediatorId) && isInstant(p.createdAt)
  && Array.isArray(p.consents) && p.consents.every(validConsent);
const validProposalEvent = (e) => isObj(e) && Object.hasOwn(PROPOSAL_EVENTS, e.event_type)
  && nullable(e.version, (v) => Number.isSafeInteger(v) && v >= 1)
  && isUuid(e.actor_id) && nullable(e.details, (v) => typeof v === 'string') && isInstant(e.created_at);

function parseProposals(data, expectedId) {
  const d = data?.dispute;
  if (!isObj(data) || !isObj(d) || d.id !== expectedId || !isUuid(d.bookingId) || !Object.hasOwn(DISPUTE_STATUS, d.status)) return null;
  if (typeof d.obligationsDisputed !== 'boolean' || !nullable(d.closedAt, isInstant) || !nullable(d.closureReason, (v) => typeof v === 'string')) return null;
  if (!Array.isArray(data.proposals) || !data.proposals.every(validProposal)) return null;
  if (!Array.isArray(data.events) || !data.events.every(validProposalEvent)) return null;
  return { closure: d, proposals: data.proposals, remedyEvents: data.events };
}

function parseMediators(data) {
  if (!isObj(data) || !Array.isArray(data.items)) return null;
  const ok = data.items.every((m) => isObj(m) && isUuid(m.id) && typeof m.name === 'string' && m.name.trim() !== '');
  return ok ? data.items : null;
}

function parseEvidencePage(data) {
  if (!isObj(data) || !Array.isArray(data.items)) return null;
  if (typeof data.canUpload !== 'boolean' || typeof data.storageAvailable !== 'boolean') return null;
  const ok = data.items.every((it) => isObj(it) && isUuid(it.id) && it.status === 'UPLOADED'
    && Object.hasOwn(EVIDENCE_TYPES, it.contentType)
    && Number.isSafeInteger(it.byteSize) && it.byteSize >= 0
    && Number.isSafeInteger(it.width) && it.width > 0
    && Number.isSafeInteger(it.height) && it.height > 0 && isInstant(it.createdAt));
  return ok ? data : null;
}

function registerCleanup(fn) {
  if (Array.isArray(ui._cleanups)) ui._cleanups.push(fn);
}

// ---- A-01: Duyệt hồ sơ (hàng chờ xin vai trò) ----

function roleRequestDecisionCard(ctx, item) {
  const statusInfo = REQUEST_STATUS[item.status] || [item.status, 'outline'];
  const kv = ui.kv([
    ['Người nộp', item.userName],
    ['Mã tài khoản', h('span', { class: 'mono', title: item.userId }, shortId(item.userId))],
    ['Vai trò xin cấp', ROLE_LABEL[item.role] || item.role],
    ['Gửi lúc', fmtTime(item.createdAt)],
    item.decidedAt ? ['Quyết định lúc', fmtTime(item.decidedAt)] : null,
    item.decisionReason ? ['Lý do từ chối', item.decisionReason] : null,
  ]);

  let decisionNode;
  if (item.canDecide) {
    const approveAlert = h('p', { class: 'msg msg--error', role: 'alert', hidden: true });
    const approveBtn = apiButton({
      label: 'Duyệt vai trò',
      icon: 'seal-check',
      kind: 'primary',
      confirm: {
        title: 'Xác nhận duyệt vai trò',
        text: `Cấp vai trò ${ROLE_LABEL[item.role] || item.role} cho ${item.userName}? Sau khi duyệt, màn hình này chưa có thao tác thu hồi.`,
        confirmLabel: 'Duyệt',
      },
      async run() {
        approveAlert.hidden = true;
        try {
          await ctx.api.request('POST', `/api/admin/role-requests/${item.id}/approve`, { auth: true, body: {} });
          if (ctx.stale()) return;
          ctx.toast(`Đã duyệt vai trò cho ${item.userName}.`, 'ok');
          ctx.rerender();
        } catch (error) {
          if (ctx.stale()) return;
          if (error instanceof ApiError && refusalText(error.code)) {
            approveAlert.textContent = refusalText(error.code);
            approveAlert.hidden = false;
            return;
          }
          throw error;
        }
      },
    });

    const rejectBox = h('div', { class: 'admin-reject stack-sm', hidden: true });
    const showRejectBtn = ui.button({
      label: 'Từ chối kèm lý do',
      icon: 'x-circle',
      kind: 'secondary',
      onClick() {
        rejectBox.hidden = false;
        showRejectBtn.hidden = true;
        rejectBox.querySelector('textarea')?.focus();
      },
    });

    const reasonArea = ui.textarea({ name: 'reason', rows: 3, maxlength: 500 });
    const rejectForm = apiForm({
      submitLabel: 'Xác nhận từ chối',
      submitKind: 'danger',
      fields: [
        ui.field({
          label: 'Lý do từ chối',
          hint: 'Bắt buộc, từ 1 đến 500 ký tự. Người nộp sẽ đọc được lý do này.',
          required: true,
          input: reasonArea,
        }),
      ],
      async run(formData) {
        const { error, payload } = reasonInput(String(formData.get('reason') ?? ''));
        if (error) {
          reasonArea.focus();
          throw new Error(error);
        }
        try {
          await ctx.api.request('POST', `/api/admin/role-requests/${item.id}/reject`, { auth: true, body: payload });
        } catch (err) {
          throw new Error(apiRefusalMessage(err), { cause: err });
        }
      },
      onDone() {
        if (ctx.stale()) return;
        ctx.toast(`Đã từ chối yêu cầu của ${item.userName}.`, 'ok');
        ctx.rerender();
      },
    });
    const cancelReject = ui.button({
      label: 'Hủy',
      kind: 'ghost',
      onClick() {
        rejectBox.hidden = true;
        showRejectBtn.hidden = false;
        showRejectBtn.focus();
      },
    });
    rejectBox.append(rejectForm, cancelReject);

    decisionNode = h('div', { class: 'stack-sm' },
      ui.note({ tone: 'info', text: 'Duyệt xong, vai trò có hiệu lực ngay. Kiểm tra thông tin người nộp trước khi quyết định.' }),
      h('div', { class: 'btn-row' }, approveBtn, showRejectBtn),
      approveAlert,
      rejectBox);
  } else if (item.status === 'PENDING' && item.userId === ctx.user.id) {
    decisionNode = ui.banner({
      tone: 'warn',
      icon: 'lock',
      title: 'Không thể tự quyết định',
      text: 'Bạn không thể tự duyệt hoặc tự từ chối yêu cầu của chính mình. Một quản trị viên khác cần xử lý yêu cầu này.',
    });
  } else {
    decisionNode = ui.note({
      tone: item.status === 'APPROVED' ? 'success' : 'info',
      text: item.status === 'APPROVED' ? 'Yêu cầu đã được duyệt.' : 'Yêu cầu đã được từ chối.',
    });
  }

  return ui.card({
    title: item.userName,
    subtitle: `Xin vai trò ${ROLE_LABEL[item.role] || item.role}`,
    actions: ui.badge(...statusInfo),
    body: h('div', { class: 'stack' }, kv, h('hr', { class: 'divider' }), decisionNode),
  });
}

// Chứng chỉ tự khai của thợ lái: quản trị viên xác minh nội bộ, không phải chứng nhận pháp lý.
const CERT_STATUS = {
  UNVERIFIED: ['Chưa xác minh', 'warn'],
  VERIFIED: ['Đã xác minh nội bộ', 'ok'],
  REJECTED: ['Không xác minh', 'error'],
};
const CERT_PAGE = 20;

const validCertificate = (c) => isObj(c) && isUuid(c.id) && isUuid(c.operatorId)
  && typeof c.name === 'string' && c.name.trim() !== ''
  && typeof c.expiresAt === 'string' && Object.hasOwn(CERT_STATUS, c.verificationStatus)
  && nullable(c.reviewedAt, isInstant) && Array.isArray(c.skills);

// Trang chứng chỉ không khớp đúng limit/offset đã gửi thì coi là lỗi, không lẫn vào hàng chờ vai trò.
function certificatePage(data, expectedOffset) {
  if (!isObj(data) || !Array.isArray(data.items) || data.limit !== CERT_PAGE || data.offset !== expectedOffset) return null;
  if (!data.items.every(validCertificate)) return null;
  return { items: data.items, limit: data.limit, offset: data.offset };
}

function certificateReviewCard(ctx, cert) {
  const [label, tone] = CERT_STATUS[cert.verificationStatus] || [cert.verificationStatus, 'outline'];
  const actions = cert.verificationStatus === 'UNVERIFIED'
    ? h('div', { class: 'btn-row' },
      apiButton({
        label: 'Xác minh chứng chỉ',
        icon: 'seal-check',
        kind: 'primary',
        size: 'sm',
        confirm: { title: 'Xác nhận xác minh chứng chỉ', text: `Đánh dấu "${cert.name}" là đã xác minh nội bộ? Việc này không phải chứng nhận pháp lý.`, confirmLabel: 'Xác minh' },
        run: () => ctx.api.request('POST', `/api/admin/workforce/certifications/${cert.id}/review`, { auth: true, body: { status: 'VERIFIED' } }),
        onDone: () => ctx.rerender(),
      }),
      apiButton({
        label: 'Không xác minh',
        icon: 'x-circle',
        kind: 'danger',
        size: 'sm',
        confirm: { title: 'Xác nhận không xác minh', text: `Ghi nhận "${cert.name}" không đủ bằng chứng để xác minh? Thợ lái vẫn thấy trạng thái này.`, confirmLabel: 'Không xác minh' },
        run: () => ctx.api.request('POST', `/api/admin/workforce/certifications/${cert.id}/review`, { auth: true, body: { status: 'REJECTED' } }),
        onDone: () => ctx.rerender(),
      }))
    : ui.note({ tone: cert.verificationStatus === 'VERIFIED' ? 'success' : 'info', text: cert.reviewedAt ? `Đã quyết định lúc ${fmtTime(cert.reviewedAt)}.` : 'Đã có quyết định.' });
  return h('li', { class: 'stack-sm' },
    h('div', { class: 'row row--between row--top row--nowrap' },
      h('strong', null, cert.name),
      ui.badge(label, tone)),
    ui.kv([
      ['Thợ lái', h('span', { class: 'mono', title: cert.operatorId }, shortId(cert.operatorId))],
      ['Hết hạn', cert.expiresAt],
      ['Kỹ năng tự khai', cert.skills.length ? cert.skills.join(', ') : 'Chưa khai'],
    ]),
    actions);
}

function certificateQueueSection(ctx, certResult, certOffset, base) {
  if (certResult.error) {
    return ui.card({
      title: 'Chứng chỉ tự khai chờ xem xét',
      body: ui.errorState({ title: 'Chưa tải được hàng chờ chứng chỉ', text: apiRefusalMessage(certResult.error), retry: () => ctx.rerender() }),
    });
  }
  const items = certResult.items;
  const pending = items.filter((c) => c.verificationStatus === 'UNVERIFIED').length;
  const pageNum = Math.floor(certOffset / CERT_PAGE) + 1;
  const pager = h('div', { class: 'btn-row' },
    certOffset > 0 ? ui.button({ label: 'Trang trước', icon: 'arrow-left', ariaLabel: 'Trang trước chứng chỉ', href: url('quan-tri', 'A-01', { ...base, ct: Math.max(0, certOffset - CERT_PAGE) || null }) }) : null,
    items.length === CERT_PAGE ? ui.button({ label: 'Trang sau', icon: 'arrow-right', ariaLabel: 'Trang sau chứng chỉ', href: url('quan-tri', 'A-01', { ...base, ct: certOffset + CERT_PAGE }) }) : null);
  return ui.card({
    title: 'Chứng chỉ tự khai chờ xem xét',
    subtitle: 'Thợ lái tự khai. Xác minh ở đây là kiểm tra nội bộ của nền tảng, không thay thế chứng nhận của cơ quan có thẩm quyền.',
    body: h('div', { class: 'stack' },
      ui.summaryLine([['Trang chứng chỉ', pageNum], ['Hiển thị', items.length], ['Chưa xác minh trên trang này', pending]]),
      items.length
        ? h('ul', { class: 'list' }, items.map((c) => certificateReviewCard(ctx, c)))
        : ui.empty({ icon: 'seal-check', title: certOffset ? 'Không còn chứng chỉ ở trang này' : 'Chưa có chứng chỉ tự khai', text: certOffset ? 'Quay lại trang trước để xem chứng chỉ khác.' : 'Khi thợ lái khai chứng chỉ ở hồ sơ, mục này sẽ hiện ra.' }),
      pager),
  });
}

async function roleRequestsScreen(ctx) {
  ctx.setAction(null);
  const offset = parseOffset(ctx.params.tu);
  const certOffset = parseOffset(ctx.params.ct);
  const [{ data }, certResult] = await Promise.all([
    ctx.api.request('GET', `/api/admin/role-requests?limit=${PAGE}&offset=${offset}`, { auth: true }),
    ctx.api.request('GET', `/api/admin/workforce/certifications?limit=${CERT_PAGE}&offset=${certOffset}`, { auth: true }).then(
      (res) => {
        const page = certificatePage(res.data, certOffset);
        return page ? { items: page.items } : { error: badResponse() };
      },
      (error) => ({ error }),
    ),
  ]);
  const page = queuePage(data, offset);
  if (!page) throw badResponse();

  const items = page.items;
  const rawSel = ctx.params.id;
  if (rawSel && !isUuid(rawSel)) {
    return ui.empty({
      icon: 'seal-check',
      title: 'Mã yêu cầu không hợp lệ',
      text: 'Đường dẫn không đúng định dạng.',
      action: ui.button({ label: 'Về hàng chờ duyệt', kind: 'primary', href: url('quan-tri', 'A-01') }),
    });
  }

  const selected = (rawSel && items.find((r) => r.id.toLowerCase() === rawSel.toLowerCase())) || items[0] || null;
  const pendingCount = items.filter((r) => r.status === 'PENDING').length;
  const decidedCount = items.length - pendingCount;
  const pageNum = Math.floor(offset / PAGE) + 1;
  // Mỗi bộ phân trang giữ offset của bộ còn lại, để đổi trang vai trò không làm mất trang chứng chỉ và ngược lại.
  const keepRole = { tu: offset || null };
  const keepCert = { ct: certOffset || null };

  const listNodes = items.map((r) => {
    const statusInfo = REQUEST_STATUS[r.status] || [r.status, 'outline'];
    const isSelfPending = r.status === 'PENDING' && r.userId === ctx.user.id;
    return ui.pick({
      title: r.userName,
      meta: `${ROLE_LABEL[r.role] || r.role} · ${fmtTime(r.createdAt)}${isSelfPending ? ' · Yêu cầu của bạn' : ''}`,
      icon: ROLE_ICON[r.role] || 'user',
      right: ui.badge(...statusInfo),
      selected: Boolean(selected && selected.id === r.id),
      control: 'none',
      onSelect() {
        ctx.go(url('quan-tri', 'A-01', { tu: offset || null, ct: certOffset || null, id: r.id }));
      },
    });
  });

  const pager = h('div', { class: 'btn-row' },
    offset > 0 ? ui.button({ label: 'Trang trước', icon: 'arrow-left', href: url('quan-tri', 'A-01', { ...keepCert, tu: Math.max(0, offset - PAGE) || null }) }) : null,
    items.length === PAGE ? ui.button({ label: 'Trang sau', icon: 'arrow-right', href: url('quan-tri', 'A-01', { ...keepCert, tu: offset + PAGE }) }) : null,
    ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() }),
  );

  const leftCard = ui.card({
    title: 'Danh sách yêu cầu',
    subtitle: 'Yêu cầu đang chờ được xếp lên đầu danh sách.',
    body: h('div', { class: 'stack-sm' },
      items.length
        ? h('div', { class: 'stack-sm', role: 'group', 'aria-label': 'Yêu cầu vai trò' }, listNodes)
        : ui.empty({ icon: 'seal-check', title: offset ? 'Không còn yêu cầu ở trang này' : 'Chưa có yêu cầu vai trò nào', text: 'Khi người dùng gửi yêu cầu vai trò mới, hồ sơ sẽ hiện tại đây.' }),
      pager),
  });

  const rightNode = selected
    ? roleRequestDecisionCard(ctx, selected)
    : ui.empty({ icon: 'seal-check', title: 'Chưa chọn yêu cầu', text: 'Chọn một yêu cầu ở danh sách để xem và quyết định.' });

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Duyệt hồ sơ vai trò',
      sub: 'Quản trị viên duyệt từng yêu cầu xin vai trò chủ máy, thợ lái hoặc HTX. Không tự duyệt yêu cầu của chính mình.',
    }),
    ui.summaryLine([['Trang', pageNum], ['Hiển thị', items.length], ['Chờ duyệt', pendingCount], ['Đã quyết định', decidedCount]]),
    h('div', { class: 'admin-split' }, leftCard, h('div', { class: 'admin-sticky' }, rightNode)),
    certificateQueueSection(ctx, certResult, certOffset, keepRole));
}

// ---- A-03: Trọng tài tranh chấp ----

function freezeBanner(status) {
  if (status === 'OPEN') {
    return ui.banner({
      tone: 'warn',
      title: 'Vụ việc đang mở',
      text: 'Đơn đang bị chặn ghi nhận tài chính cho đến khi hai bên đồng ý một phương án hoặc đóng chưa giải quyết. Nền tảng không giữ hay chuyển tiền.',
    });
  }
  if (status === 'CLOSED_UNRESOLVED') {
    return ui.banner({
      tone: 'error',
      title: 'Đã đóng chưa giải quyết',
      text: 'Nghĩa vụ liên quan vẫn đang tranh chấp và tiếp tục chặn ghi nhận tài chính. Đây không phải thỏa thuận, công nợ hay lệnh thanh toán.',
    });
  }
  if (status === 'RESOLVED') {
    return ui.banner({
      tone: 'success',
      title: 'Hai bên đã đồng ý phương án',
      text: 'Đồng ý phương án là ghi nhận ý kiến hai bên, không phải thi hành tự động. Hệ thống không tự hoàn tiền hay trừ tiền.',
    });
  }
  return ui.banner({ tone: 'info', title: 'Vụ việc đã đóng', text: 'Không thể thao tác thêm trên vụ việc này.' });
}

function actorLabelInDispute(dispute, actorId) {
  if (actorId === dispute.claimantId) return 'Bên khiếu nại';
  if (actorId === dispute.respondentId) return 'Bên bị khiếu nại';
  return 'Quản trị viên';
}

function eventDetailText(e) {
  if (typeof e.data?.details === 'string' && e.data.details) return e.data.details;
  if (typeof e.data?.text === 'string' && e.data.text) return e.data.text;
  if (typeof e.data?.mediatorId === 'string') return `Người hòa giải: ${shortId(e.data.mediatorId)}`;
  return '';
}

function evidenceSection(ctx, dispute) {
  const isMediator = ctx.user.id === dispute.mediatorId;
  const isParty = ctx.user.id === dispute.claimantId || ctx.user.id === dispute.respondentId;
  if (!isMediator && !isParty) {
    return ui.card({
      title: 'Bằng chứng ảnh',
      body: ui.note({
        tone: 'info',
        icon: 'lock',
        text: 'Ảnh bằng chứng chỉ mở cho hai bên của đơn và quản trị viên được gán làm người hòa giải.',
      }),
    });
  }

  const box = h('div', { class: 'stack-sm', role: 'region', 'aria-label': 'Danh sách bằng chứng ảnh' }, ui.loading('Đang tải danh sách ảnh'));
  const objectUrls = new Set();
  registerCleanup(() => {
    for (const u of objectUrls) globalThis.URL.revokeObjectURL(u);
    objectUrls.clear();
  });

  async function openOriginalModal(item, index) {
    try {
      const blob = await ctx.api.binary(`/api/evidence/${item.id}/content`);
      if (ctx.stale() || !box.isConnected) return;
      const objUrl = globalThis.URL.createObjectURL(blob);
      objectUrls.add(objUrl);
      const img = h('img', {
        src: objUrl,
        alt: `Ảnh bằng chứng ${index + 1}`,
        style: 'max-width: 100%; height: auto; display: block; border-radius: 6px;',
      });
      const m = ui.modal({
        title: `Ảnh bằng chứng ${index + 1}`,
        body: h('div', { class: 'stack-sm' },
          img,
          h('p', { class: 'small muted' }, `${EVIDENCE_TYPES[item.contentType]}, ${item.width} x ${item.height} px, ${formatBytes(item.byteSize)}.`)),
        onClose() {
          globalThis.URL.revokeObjectURL(objUrl);
          objectUrls.delete(objUrl);
        },
      });
      m.el.classList.add('admin-modal');
    } catch (error) {
      if (ctx.stale()) return;
      ctx.toast(apiRefusalMessage(error), 'error');
    }
  }

  async function loadThumb(item, index, slot) {
    slot.replaceChildren(h('span', { class: 'small muted' }, 'Đang tải ảnh thu nhỏ...'));
    try {
      const blob = await ctx.api.binary(`/api/evidence/${item.id}/thumbnail`);
      if (ctx.stale() || !slot.isConnected) return;
      const objUrl = globalThis.URL.createObjectURL(blob);
      objectUrls.add(objUrl);
      const width = Math.min(240, item.width);
      const height = Math.max(1, Math.round((item.height * width) / item.width));
      slot.replaceChildren(h('img', {
        src: objUrl,
        alt: `Ảnh thu nhỏ bằng chứng ${index + 1}`,
        width,
        height,
        style: 'max-width: 100%; height: auto; border-radius: 6px;',
      }));
    } catch (error) {
      if (!ctx.stale() && slot.isConnected) {
        slot.replaceChildren(h('p', { class: 'small muted', role: 'alert' }, apiRefusalMessage(error)));
      }
    }
  }

  (async () => {
    try {
      const { data } = await ctx.api.request('GET', `/api/disputes/${dispute.id}/evidence?limit=20&offset=0`, { auth: true });
      if (ctx.stale() || !box.isConnected) return;
      const page = parseEvidencePage(data);
      if (!page) throw badResponse();
      if (!page.items.length) {
        box.replaceChildren(ui.empty({ icon: 'image', title: 'Chưa có bằng chứng ảnh', text: 'Hai bên chưa tải ảnh nào lên vụ việc này.' }));
        return;
      }
      const list = h('div', { class: 'stack-sm' }, page.items.map((item, idx) => {
        const thumbSlot = h('div');
        return ui.card({
          flat: true,
          title: `Ảnh ${idx + 1}`,
          subtitle: `${EVIDENCE_TYPES[item.contentType]} · ${item.width} x ${item.height} px · ${formatBytes(item.byteSize)} · ${fmtTime(item.createdAt)}`,
          body: h('div', { class: 'stack-sm' },
            h('div', { class: 'btn-row' },
              ui.button({ label: 'Xem ảnh thu nhỏ', icon: 'image', size: 'sm', onClick: () => loadThumb(item, idx, thumbSlot) }),
              ui.button({ label: 'Xem ảnh gốc', icon: 'arrows-out', size: 'sm', kind: 'secondary', onClick: () => openOriginalModal(item, idx) })),
            thumbSlot),
        });
      }));
      box.replaceChildren(list);
    } catch (error) {
      if (!ctx.stale() && box.isConnected) {
        box.replaceChildren(ui.note({ tone: 'error', text: apiRefusalMessage(error) }));
      }
    }
  })();

  return ui.card({
    title: 'Bằng chứng ảnh',
    subtitle: 'Ảnh riêng tư do hai bên tải lên; người hòa giải xem để đối chiếu.',
    body: box,
  });
}

function escalationTraceCard(dispute, escalations = []) {
  const level = dispute.mediationLevel === 'ADMIN' ? 'ADMIN' : 'HTX';
  const badge = MEDIATION_LEVEL_BADGE[level] || ['Cấp HTX', 'info'];
  const rows = [
    ['Cấp hòa giải hiện tại', MEDIATION_LEVEL_LABELS[level] || level],
  ];
  const latestEsc = escalations.length ? escalations[escalations.length - 1] : null;
  if (dispute.escalatedAt || latestEsc) {
    rows.push(['Thời điểm chuyển cấp', fmtTime(dispute.escalatedAt || latestEsc.createdAt)]);
    const conflictCode = dispute.escalationConflictType || latestEsc?.conflictType;
    if (conflictCode) {
      rows.push(['Căn cứ chuyển cấp', CONFLICT_TYPE_LABELS[conflictCode] || conflictCode]);
    }
    const reasonText = dispute.escalationReason || latestEsc?.reason;
    if (reasonText) {
      rows.push(['Lý do chuyển cấp', reasonText]);
    }
    const escActor = dispute.escalatedBy || latestEsc?.actorId;
    if (escActor) {
      rows.push(['Người lập biên bản', actorLabelInDispute(dispute, escActor)]);
    }
    if (latestEsc?.previousMediatorId) {
      rows.push(['Người hòa giải HTX trước đó', h('span', { class: 'mono', title: latestEsc.previousMediatorId }, shortId(latestEsc.previousMediatorId))]);
    }
  }

  return ui.card({
    title: 'Hồ sơ cấp hòa giải và chuyển cấp',
    subtitle: 'Theo dõi tiến trình từ cấp HTX lên Quản trị viên độc lập.',
    actions: ui.badge(...badge),
    body: h('div', { class: 'stack-sm' },
      ui.kv(rows),
      level === 'HTX'
        ? ui.note({
          tone: 'info',
          text: 'Vụ việc đang ở cấp HTX. Nếu có xung đột lợi ích hoặc có yêu cầu chuyển cấp, cần lập biên bản chuyển cấp có căn cứ trước khi gán Quản trị viên độc lập.',
        })
        : null),
  });
}

function assignMediatorCard(ctx, dispute) {
  if (dispute.mediationLevel === 'HTX') {
    const conflictSel = ui.select({
      name: 'conflictType',
      value: 'PARTY_REQUEST',
      options: [
        ['PARTY_REQUEST', CONFLICT_TYPE_LABELS.PARTY_REQUEST],
        ['AFFILIATION_CONFLICT', CONFLICT_TYPE_LABELS.AFFILIATION_CONFLICT],
        ['PARTY_CONFLICT', CONFLICT_TYPE_LABELS.PARTY_CONFLICT],
        ['ROLE_OVERLAP', CONFLICT_TYPE_LABELS.ROLE_OVERLAP],
        ['MACHINE_CONFLICT', CONFLICT_TYPE_LABELS.MACHINE_CONFLICT],
        ['RECUSAL_REQUEST', CONFLICT_TYPE_LABELS.RECUSAL_REQUEST],
      ],
    });
    const reasonArea = ui.textarea({
      name: 'reason',
      rows: 3,
      maxlength: 2000,
      placeholder: 'Ghi rõ căn cứ xung đột lợi ích hoặc lý do chuyển cấp lên Quản trị...',
    });
    const escalateForm = apiForm({
      submitLabel: 'Lập biên bản chuyển cấp lên Quản trị',
      submitKind: 'primary',
      fields: [
        ui.note({
          tone: 'warn',
          icon: 'warning',
          text: 'Vụ việc đang ở cấp hòa giải HTX. Theo quy định bảo đảm tính độc lập, cần lập biên bản chuyển cấp có lý do rõ ràng trước khi gán Quản trị viên hòa giải.',
        }),
        ui.field({
          label: 'Căn cứ chuyển cấp',
          hint: 'Chọn căn cứ xung đột hoặc yêu cầu chuyển cấp từ bên liên quan.',
          input: conflictSel,
        }),
        ui.field({
          label: 'Lý do chuyển cấp lên Quản trị',
          hint: 'Tối đa 2000 ký tự. Biên bản sẽ được lưu vào lịch sử vụ việc.',
          required: true,
          input: reasonArea,
        }),
      ],
      async run(formData) {
        const { error, payload } = escalationInput({
          reason: String(formData.get('reason') || ''),
          conflictType: String(formData.get('conflictType') || ''),
        });
        if (error) {
          reasonArea.focus();
          throw new Error(error);
        }
        try {
          await ctx.api.request('POST', `/api/disputes/${dispute.id}/escalate`, { auth: true, body: payload });
        } catch (err) {
          throw new Error(apiRefusalMessage(err), { cause: err });
        }
      },
      onDone() {
        if (ctx.stale()) return;
        ctx.toast('Đã lập biên bản chuyển cấp lên Quản trị độc lập.', 'ok');
        ctx.rerender();
      },
    });

    return ui.card({
      title: 'Chuyển cấp lên Quản trị độc lập',
      subtitle: 'Cần lập biên bản chuyển cấp trước khi gán người hòa giải quản trị.',
      body: escalateForm,
    });
  }

  const box = h('div', { class: 'stack-sm' }, ui.loading('Đang tải danh sách quản trị viên'));

  (async () => {
    try {
      const { data } = await ctx.api.request('GET', `/api/dispute-review/${dispute.id}/mediators?limit=20&offset=0`, { auth: true });
      if (ctx.stale() || !box.isConnected) return;
      const mediators = parseMediators(data);
      if (!mediators) throw badResponse();
      if (!mediators.length) {
        box.replaceChildren(ui.note({
          tone: 'warn',
          text: 'Chưa có quản trị viên nào độc lập với cả hai bên của vụ việc này.',
        }));
        return;
      }
      const select = ui.select({
        name: 'mediatorId',
        value: dispute.mediatorId && mediators.some((m) => m.id === dispute.mediatorId) ? dispute.mediatorId : mediators[0].id,
        options: mediators.map((m) => [m.id, m.id === ctx.user.id ? `${m.name} (bạn)` : m.name]),
      });
      const form = apiForm({
        submitLabel: dispute.mediatorId ? 'Đổi người hòa giải' : 'Gán người hòa giải',
        fields: [
          ui.field({
            label: 'Quản trị viên độc lập',
            hint: 'Máy chủ kiểm tra lại người được chọn không phải chủ đơn, điều phối, chủ máy hay thợ lái của đơn.',
            required: true,
            input: select,
          }),
        ],
        async run(formData) {
          const mediatorId = String(formData.get('mediatorId') || '');
          if (!isUuid(mediatorId)) throw new Error('Chọn quản trị viên hợp lệ.');
          try {
            await ctx.api.request('POST', `/api/disputes/${dispute.id}/mediator`, { auth: true, body: { mediatorId } });
          } catch (error) {
            throw new Error(apiRefusalMessage(error), { cause: error });
          }
        },
        onDone() {
          if (ctx.stale()) return;
          ctx.toast('Đã gán người hòa giải.', 'ok');
          ctx.rerender();
        },
      });
      box.replaceChildren(form);
    } catch (error) {
      if (!ctx.stale() && box.isConnected) {
        box.replaceChildren(ui.note({ tone: 'error', text: apiRefusalMessage(error) }));
      }
    }
  })();

  return ui.card({
    title: 'Gán người hòa giải độc lập',
    subtitle: 'Người hòa giải phải đứng ngoài cả hai bên. Gán người hòa giải không tự đồng ý thay bên nào.',
    body: box,
  });
}

function proposalCard(dispute, proposal, latest) {
  const isLatest = latest && proposal.version === latest.version;
  const consents = consentLines(dispute, proposal) || [];
  const staleMediator = isLatest && proposal.mediatorId !== dispute.mediatorId;

  return ui.card({
    flat: true,
    title: `Phiên bản ${proposal.version}`,
    subtitle: `Đề xuất lúc ${fmtTime(proposal.createdAt)}`,
    actions: ui.badge(isLatest ? 'Mới nhất' : 'Đã thay thế', isLatest ? 'info' : 'outline'),
    body: h('div', { class: 'stack-sm' },
      h('p', null, proposal.text),
      staleMediator
        ? ui.note({ tone: 'warn', text: 'Người hòa giải đã thay đổi sau phiên bản này. Hai bên chờ phương án mới để đồng ý.' })
        : null,
      ui.kv(consents.map((c) => [
        c.label,
        c.done ? ui.badge(`Đã đồng ý lúc ${fmtTime(c.at)}`, 'ok', 'check-circle') : ui.badge('Chưa đồng ý', 'idle', 'clock'),
      ]))),
  });
}

function mediatorActionsCard(ctx, dispute) {
  if (dispute.status !== 'OPEN') {
    return ui.card({
      title: 'Thao tác hòa giải',
      body: ui.note({ tone: 'info', text: 'Vụ việc đã kết thúc, không thể gửi phương án hoặc đóng thêm.' }),
    });
  }
  if (!canMediate(ctx.user, dispute)) {
    return ui.card({
      title: 'Thao tác hòa giải',
      body: ui.note({
        tone: 'info',
        icon: 'scales',
        text: dispute.mediatorId
          ? 'Chỉ quản trị viên đang được gán làm người hòa giải mới được đề xuất phương án hoặc đóng chưa giải quyết.'
          : 'Vụ việc chưa có người hòa giải. Gán quản trị viên độc lập trước khi đề xuất phương án.',
      }),
    });
  }

  const proposalArea = ui.textarea({ name: 'text', rows: 4, maxlength: 2000 });
  const proposeForm = apiForm({
    submitLabel: 'Gửi phương án mới',
    fields: [
      ui.field({
        label: 'Nội dung phương án hòa giải',
        hint: 'Tối đa 2000 ký tự. Gửi phiên bản mới chỉ lưu đề xuất văn bản; hai bên phải tự đồng ý độc lập trên phiên bản này.',
        required: true,
        input: proposalArea,
      }),
    ],
    async run(formData) {
      const { error, payload } = proposalInput(String(formData.get('text') ?? ''));
      if (error) {
        proposalArea.focus();
        throw new Error(error);
      }
      try {
        await ctx.api.request('POST', `/api/disputes/${dispute.id}/proposals`, { auth: true, body: payload });
      } catch (err) {
        throw new Error(apiRefusalMessage(err), { cause: err });
      }
    },
    onDone() {
      if (ctx.stale()) return;
      ctx.toast('Đã gửi phiên bản phương án mới.', 'ok');
      ctx.rerender();
    },
  });

  const closeArea = ui.textarea({ name: 'reason', rows: 3, maxlength: 2000 });
  const confirmCheck = h('input', { type: 'checkbox', name: 'confirmClose', value: '1' });
  const closeForm = apiForm({
    submitLabel: 'Đóng chưa giải quyết',
    submitKind: 'danger',
    fields: [
      ui.field({
        label: 'Lý do đóng chưa giải quyết',
        hint: 'Tối đa 2000 ký tự. Ghi rõ lý do không thể thống nhất; thao tác này không thể hoàn tác.',
        required: true,
        input: closeArea,
      }),
      h('label', { class: 'choice' },
        confirmCheck,
        h('span', null,
          h('span', { class: 'choice__title' }, 'Xác nhận đóng chưa giải quyết'),
          h('span', { class: 'choice__desc' }, 'Không tạo công nợ, không thanh toán, đơn tiếp tục bị chặn ghi nhận tài chính.'))),
    ],
    async run(formData) {
      if (formData.get('confirmClose') !== '1') {
        confirmCheck.focus();
        throw new Error('Đánh dấu ô xác nhận trước khi đóng chưa giải quyết.');
      }
      const { error, payload } = closeInput(String(formData.get('reason') ?? ''));
      if (error) {
        closeArea.focus();
        throw new Error(error);
      }
      try {
        await ctx.api.request('POST', `/api/disputes/${dispute.id}/close-unresolved`, { auth: true, body: payload });
      } catch (err) {
        throw new Error(apiRefusalMessage(err), { cause: err });
      }
    },
    onDone() {
      if (ctx.stale()) return;
      ctx.toast('Đã đóng vụ việc chưa giải quyết.', 'ok');
      ctx.rerender();
    },
  });

  return ui.card({
    title: 'Thao tác của người hòa giải',
    subtitle: 'Bạn đang là người hòa giải độc lập của vụ việc này.',
    body: h('div', { class: 'stack' },
      proposeForm,
      h('details', { class: 'admin-details' },
        h('summary', { class: 'row' }, ui.icon('caret-right'), h('span', null, 'Đóng chưa giải quyết')),
        h('div', { class: 'stack-sm' },
          ui.note({ tone: 'warn', text: 'Đóng chưa giải quyết không phải thỏa thuận và không tạo công nợ.' }),
          closeForm))),
  });
}

async function disputeDetailNode(ctx, disputeId) {
  let detail;
  let propData;
  try {
    const [detailRes, proposalRes] = await Promise.all([
      ctx.api.request('GET', `/api/disputes/${disputeId}`, { auth: true }),
      ctx.api.request('GET', `/api/disputes/${disputeId}/proposals`, { auth: true }),
    ]);
    detail = parseDetail(detailRes.data, disputeId);
    propData = parseProposals(proposalRes.data, disputeId);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return ui.empty({
        icon: 'gavel',
        title: 'Không mở được vụ việc này',
        text: apiRefusalMessage(error),
        action: ui.button({ label: 'Về hàng chờ trọng tài', kind: 'primary', href: url('quan-tri', 'A-03') }),
      });
    }
    throw error;
  }
  if (!detail || !propData) throw badResponse();

  const { dispute, events, escalations } = detail;
  const { closure, proposals, remedyEvents } = propData;
  const statusInfo = DISPUTE_STATUS[dispute.status] || [dispute.status, 'outline'];
  const levelKey = dispute.mediationLevel === 'ADMIN' ? 'ADMIN' : 'HTX';
  const levelBadge = MEDIATION_LEVEL_BADGE[levelKey] || ['Cấp HTX', 'info'];
  const roleKey = disputeRoleOf(ctx.user, dispute);
  const roleBadgeText = {
    mediator: 'Bạn là người hòa giải',
    reviewer: 'Đang xem xét (chưa gán hòa giải)',
    claimant: 'Bạn là bên khiếu nại',
    respondent: 'Bạn là bên bị khiếu nại',
  }[roleKey];
  const latest = proposals.reduce((top, p) => (!top || p.version > top.version ? p : top), null);

  const infoCard = ui.card({
    title: `Vụ việc ${shortId(dispute.id)}`,
    subtitle: DISPUTE_REASONS[dispute.reason] || dispute.reason,
    actions: h('div', { class: 'btn-row' },
      ui.badge(...statusInfo),
      ui.badge(...levelBadge),
      ui.badge(roleBadgeText, roleKey === 'mediator' ? 'info' : 'outline')),
    body: h('div', { class: 'stack' },
      freezeBanner(dispute.status),
      ui.kv([
        ['Mã vụ việc', h('span', { class: 'mono', title: dispute.id }, shortId(dispute.id))],
        ['Mã đơn', h('span', { class: 'mono', title: dispute.bookingId }, shortId(dispute.bookingId))],
        ['Lý do khiếu nại', DISPUTE_REASONS[dispute.reason] || dispute.reason],
        ['Cấp hòa giải', MEDIATION_LEVEL_LABELS[levelKey] || levelKey],
        ['Mở lúc', fmtTime(dispute.createdAt)],
        ['Người hòa giải', dispute.mediatorId
          ? (dispute.mediatorId === ctx.user.id ? 'Bạn (đã gán)' : h('span', { class: 'mono', title: dispute.mediatorId }, shortId(dispute.mediatorId)))
          : 'Chưa gán'],
        closure.closedAt ? ['Đóng lúc', fmtTime(closure.closedAt)] : null,
        closure.closureReason ? ['Lý do đóng', closure.closureReason] : null,
        closure.closedAt ? ['Nghĩa vụ tranh chấp', closure.obligationsDisputed ? 'Còn tranh chấp (chặn ghi nhận tài chính)' : 'Không'] : null,
      ])),
  });

  const timelineItems = [
    ...events.map((e) => ({
      seq: Number(e.sequence) || 0,
      time: e.createdAt,
      title: `${CASE_EVENTS[e.type] || e.type} (${actorLabelInDispute(dispute, e.actorId)})`,
      text: eventDetailText(e),
    })),
    ...(escalations || []).map((esc) => ({
      seq: Number(esc.sequence) || 0,
      time: esc.createdAt,
      title: `Chuyển cấp lên Quản trị độc lập (${actorLabelInDispute(dispute, esc.actorId)})`,
      text: [
        esc.conflictType ? `Căn cứ: ${CONFLICT_TYPE_LABELS[esc.conflictType] || esc.conflictType}` : null,
        esc.reason ? `Lý do: ${esc.reason}` : null,
        esc.previousMediatorId ? `Người hòa giải HTX trước đó: ${shortId(esc.previousMediatorId)}` : null,
      ].filter(Boolean).join(' · '),
    })),
  ].sort((a, b) => a.seq - b.seq);

  const timelineCard = ui.card({
    title: 'Diễn biến và phản hồi',
    subtitle: 'Mỗi phản hồi và biên bản chuyển cấp là một mục bất biến theo trình tự.',
    body: timelineItems.length
      ? ui.list(timelineItems.map((item) => h('div', { class: 'stack-sm' },
        h('div', { class: 'row row--between' },
          h('strong', null, item.title),
          h('span', { class: 'small muted' }, fmtTime(item.time))),
        item.text ? h('p', null, item.text) : null)))
      : ui.empty({ icon: 'file-text', title: 'Chưa có diễn biến', text: 'Diễn biến khiếu nại và phản hồi sẽ hiện tại đây.' }),
  });

  const proposalsCard = ui.card({
    title: 'Phương án hòa giải và đồng ý của hai bên',
    subtitle: 'Hai bên tự đồng ý độc lập trên đúng phiên bản mới nhất; nền tảng không tự thanh toán.',
    body: h('div', { class: 'stack' },
      proposals.length
        ? proposals.map((p) => proposalCard(dispute, p, latest))
        : ui.empty({ icon: 'scales', title: 'Chưa có phương án nào', text: 'Người hòa giải được gán có thể đề xuất phiên bản phương án đầu tiên.' }),
      remedyEvents.length
        ? h('details', { class: 'admin-details' },
          h('summary', { class: 'row' }, ui.icon('caret-right'), h('span', null, `Lịch sử sự kiện phương án (${remedyEvents.length})`)),
          ui.list(remedyEvents.map((e) => h('div', { class: 'stack-sm' },
            h('div', { class: 'row row--between' },
              h('span', null, `${PROPOSAL_EVENTS[e.event_type]}${e.version ? ` phiên bản ${e.version}` : ''} (${actorLabelInDispute(dispute, e.actor_id)})`),
              h('span', { class: 'small muted' }, fmtTime(e.created_at))),
            e.details ? h('p', { class: 'small' }, e.details) : null))))
        : null),
  });

  return h('div', { class: 'stack' },
    infoCard,
    escalationTraceCard(dispute, escalations),
    timelineCard,
    evidenceSection(ctx, dispute),
    proposalsCard,
    canAssignMediator(ctx.user, dispute) ? assignMediatorCard(ctx, dispute) : null,
    mediatorActionsCard(ctx, dispute));
}

async function disputeReviewScreen(ctx) {
  ctx.setAction(null);
  const tab = ctx.params.hang === 'hoa-giai' ? 'mine' : 'review';
  const capFilter = ctx.params.cap === 'admin' ? 'admin' : (ctx.params.cap === 'htx' ? 'htx' : 'all');
  const offset = parseOffset(ctx.params.tu);
  const rawSel = ctx.params.id;
  if (rawSel && !isUuid(rawSel)) {
    return ui.empty({
      icon: 'gavel',
      title: 'Mã vụ việc không hợp lệ',
      text: 'Đường dẫn không đúng định dạng.',
      action: ui.button({ label: 'Về hàng chờ trọng tài', kind: 'primary', href: url('quan-tri', 'A-03') }),
    });
  }

  const [revRes, mineRes] = await Promise.all([
    ctx.api.request('GET', `/api/dispute-review?limit=${PAGE}&offset=${tab === 'review' ? offset : 0}`, { auth: true }),
    ctx.api.request('GET', `/api/disputes?limit=${PAGE}&offset=${tab === 'mine' ? offset : 0}`, { auth: true }),
  ]);
  const revPage = reviewPage(revRes.data, tab === 'review' ? offset : 0);
  const minePage = disputeListPage(mineRes.data, tab === 'mine' ? offset : 0);
  if (!revPage || !minePage) throw badResponse();

  const htxItems = revPage.items.filter((it) => it.mediationLevel !== 'ADMIN');
  const adminItems = revPage.items.filter((it) => it.mediationLevel === 'ADMIN');
  const filteredReview = capFilter === 'admin' ? adminItems : (capFilter === 'htx' ? htxItems : revPage.items);
  const activeItems = tab === 'mine' ? minePage.items : filteredReview;
  const rawPageLen = tab === 'mine' ? minePage.items.length : revPage.items.length;
  const selectedId = (rawSel && rawSel.toLowerCase()) || activeItems[0]?.id || null;

  const listNodes = activeItems.map((item) => {
    const statusInfo = DISPUTE_STATUS[item.status] || [item.status, 'outline'];
    const levelKey = item.mediationLevel === 'ADMIN' ? 'ADMIN' : 'HTX';
    const levelBadge = MEDIATION_LEVEL_BADGE[levelKey] || ['Cấp HTX', 'info'];
    const metaText = tab === 'mine'
      ? `Đơn ${shortId(item.bookingId)} · ${fmtTime(item.createdAt)}`
      : levelKey === 'ADMIN'
        ? `Đơn ${shortId(item.bookingId)} · Cấp Quản trị · Sẵn sàng gán hòa giải`
        : `Đơn ${shortId(item.bookingId)} · Cấp HTX · Cần chuyển cấp trước khi gán`;
    return ui.pick({
      title: DISPUTE_REASONS[item.reason] || item.reason,
      meta: h('span', { class: 'row' }, ui.badge(...statusInfo), ui.badge(...levelBadge), h('span', null, metaText)),
      icon: 'gavel',
      selected: Boolean(selectedId && selectedId === item.id.toLowerCase()),
      control: 'none',
      onSelect() {
        ctx.go(url('quan-tri', 'A-03', {
          hang: tab === 'mine' ? 'hoa-giai' : null,
          cap: tab === 'review' && capFilter !== 'all' ? capFilter : null,
          tu: offset || null,
          id: item.id,
        }));
      },
    });
  });

  const pager = h('div', { class: 'btn-row' },
    offset > 0 ? ui.button({
      label: 'Trang trước',
      icon: 'arrow-left',
      href: url('quan-tri', 'A-03', {
        hang: tab === 'mine' ? 'hoa-giai' : null,
        cap: tab === 'review' && capFilter !== 'all' ? capFilter : null,
        tu: Math.max(0, offset - PAGE) || null,
      }),
    }) : null,
    rawPageLen === PAGE ? ui.button({
      label: 'Trang sau',
      icon: 'arrow-right',
      href: url('quan-tri', 'A-03', {
        hang: tab === 'mine' ? 'hoa-giai' : null,
        cap: tab === 'review' && capFilter !== 'all' ? capFilter : null,
        tu: offset + PAGE,
      }),
    }) : null,
    ui.button({ label: 'Tải lại', icon: 'arrows-clockwise', kind: 'ghost', onClick: () => ctx.rerender() }),
  );

  const subFilterTabs = tab === 'review'
    ? ui.tabs({
      active: capFilter,
      items: [
        { value: 'all', label: `Tất cả (${revPage.items.length})` },
        { value: 'admin', label: `Cấp Quản trị (${adminItems.length})` },
        { value: 'htx', label: `Cấp HTX (${htxItems.length})` },
      ],
      onChange(next) {
        ctx.go(url('quan-tri', 'A-03', { cap: next === 'all' ? null : next, tu: offset || null }));
      },
    })
    : null;

  const leftCard = ui.card({
    title: 'Danh sách vụ việc',
    body: h('div', { class: 'stack-sm' },
      h('div', { class: 'row' },
        ui.tabs({
          active: tab,
          items: [
            { value: 'review', label: `Xem xét (${revPage.items.length})` },
            { value: 'mine', label: `Tôi hòa giải (${minePage.items.length})` },
          ],
          onChange(next) {
            ctx.go(url('quan-tri', 'A-03', { hang: next === 'mine' ? 'hoa-giai' : null }));
          },
        })),
      subFilterTabs ? h('div', { class: 'row' }, subFilterTabs) : null,
      activeItems.length
        ? h('div', { class: 'stack-sm', role: 'group', 'aria-label': 'Danh sách tranh chấp' }, listNodes)
        : ui.empty({
          icon: 'gavel',
          title: tab === 'mine' ? 'Chưa có vụ việc bạn hòa giải' : 'Không có vụ việc phù hợp',
          text: tab === 'mine'
            ? 'Vụ việc bạn được gán làm người hòa giải sẽ hiện ở đây kể cả sau khi đóng.'
            : (capFilter === 'all' ? 'Vụ việc đang mở mà bạn không liên quan sẽ hiện tại đây.' : 'Không có vụ việc nào ở cấp lọc này trên trang hiện tại.'),
        }),
      pager),
  });

  const rightNode = selectedId
    ? await disputeDetailNode(ctx, selectedId)
    : ui.empty({ icon: 'gavel', title: 'Chưa chọn vụ việc', text: 'Chọn một vụ việc ở danh sách để xem diễn biến, chuyển cấp, gán người hòa giải hoặc đề xuất phương án.' });

  return h('div', { class: 'stack' },
    ui.screenHead({
      title: 'Trọng tài tranh chấp',
      sub: 'Phân biệt hàng chờ HTX và Quản trị. Vụ việc cấp HTX cần lập biên bản chuyển cấp trước khi gán Quản trị viên độc lập; nền tảng không giữ hay chuyển tiền.',
    }),
    ui.summaryLine([
      ['Chờ xem xét (trang này)', revPage.items.length],
      ['Cấp Quản trị (sẵn sàng gán)', adminItems.length],
      ['Cấp HTX (chờ chuyển cấp)', htxItems.length],
      ['Tôi hòa giải / liên quan', minePage.items.length],
    ]),
    h('div', { class: 'admin-split' }, leftCard, rightNode));
}

async function platformParametersScreen(ctx) {
  const { data } = await ctx.api.request('GET', '/api/admin/platform-parameters', { auth: true });
  const rows = Object.entries(data.effective.values || {}).map(([key, value]) => [key, String(value)]);
  const note = ui.textarea({ name: 'note', rows: 2, maxlength: 500 });
  const valuesArea = ui.textarea({ name: 'values', rows: 8, maxlength: 4000, value: JSON.stringify(data.effective.values || {}, null, 2) });
  const form = apiForm({ submitLabel: 'Lưu phiên bản giả định', fields: [ui.note({ tone: 'warn', text: 'Tham số gom cụm và báo giá đều là giả định vận hành, chưa xác nhận bằng khảo sát. Không phải mức phí thực thu.' }), ui.field({ label: 'Tham số dạng JSON', required: true, hint: 'Chỉ khóa đã hỗ trợ. Giá trị có giới hạn máy chủ.', input: valuesArea }), ui.field({ label: 'Lý do thay đổi', required: true, input: note })], async run(fd) {
    let values; try { values = JSON.parse(String(fd.get('values') || '')); } catch { throw new Error('JSON chưa hợp lệ.'); }
    await ctx.api.request('PUT', '/api/admin/platform-parameters', { auth: true, body: { values, note: String(fd.get('note') || '') } });
  }, onDone() { if (!ctx.stale()) { ctx.toast('Đã lưu phiên bản tham số.', 'ok'); ctx.rerender(); } } });
  return h('div', { class: 'stack' }, ui.screenHead({ title: 'Tham số vận hành', sub: 'Các giá trị là giả định được gắn nhãn. Không cấu hình thu phí thật.' }), ui.card({ title: `Phiên bản ${data.effective.version}`, subtitle: data.effective.createdAt ? fmtTime(data.effective.createdAt) : 'Chưa lưu phiên bản', body: h('div', { class: 'stack' }, ui.kv(rows), form) }), ui.card({ title: 'Lịch sử phiên bản', body: ui.table({ rows: data.history, cols: [{ key: 'version', label: 'Phiên bản' }, { key: 'note', label: 'Lý do' }, { key: 'created_at', label: 'Thời điểm' }] }) }));
}

async function complianceScreen(ctx) {
  const { data } = await ctx.api.request('GET', '/api/admin/compliance-status', { auth: true });
  return h('div', { class: 'stack' }, ui.screenHead({ title: 'Trạng thái tuân thủ', sub: 'Danh sách sự kiện đã lưu để theo dõi vận hành.' }), ui.banner({ tone: 'warn', title: 'Không phải chứng nhận pháp lý', text: 'Trạng thái này chỉ đọc nhật ký dữ liệu hiện có. Không đánh giá hoặc xác nhận tuân thủ pháp luật.' }), ui.table({ rows: data.items, cols: [{ key: 'source', label: 'Nguồn' }, { key: 'action', label: 'Sự kiện' }, { key: 'to_status', label: 'Trạng thái' }, { key: 'created_at', label: 'Thời điểm' }] }));
}

async function jobReportsScreen(ctx) {
  const limit = 20;
  const rawOffset = Number(ctx.params.offset ?? 0);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 10000 ? rawOffset : 0;
  const { data } = await ctx.api.request('GET', `/api/admin/job-reports?limit=${limit}&offset=${offset}`, { auth: true });
  const statuses = { OPEN: 'Chờ xem xét', REVIEWED: 'Đã xem xét', DISMISSED: 'Đã bác báo cáo' };
  const cards = data.items.map((r) => {
    const note = ui.textarea({ name: 'reviewNote', rows: 2, maxlength: 1000 });
    const decide = (label, status) => apiButton({
      label, kind: 'secondary',
      run: () => ctx.api.request('POST', `/api/admin/job-reports/${r.id}/review`, { auth: true, body: { status, note: note.value } }),
      onDone: () => ctx.rerender(),
    });
    const review = r.status === 'OPEN' ? h('div', { class: 'stack-sm' },
      ui.field({ label: 'Ghi chú xét duyệt', input: note }),
      h('div', { class: 'btn-row' }, decide('Ghi nhận đã xem xét', 'REVIEWED'), decide('Bác báo cáo', 'DISMISSED'))) : null;
    const reason = ui.textarea({ name: 'closeReason', rows: 2, maxlength: 1000 });
    const close = r.job_status === 'OPEN' ? h('div', { class: 'stack-sm' },
      ui.field({ label: 'Lý do đóng tin', input: reason, required: true }),
      apiButton({
        label: 'Đóng tin tuyển', kind: 'danger',
        confirm: { title: 'Đóng tin tuyển?', text: 'Tin ngừng nhận hồ sơ mới. Các đề nghị đã được nhận vẫn giữ nguyên.' },
        run: () => ctx.api.request('POST', `/api/admin/jobs/${r.job_id}/close`, { auth: true, body: { reason: reason.value.trim() } }),
        onDone: () => ctx.rerender(),
      })) : null;
    return ui.card({ title: r.title, body: h('div', { class: 'stack-sm' },
      h('div', { class: 'row' }, ui.badge(statuses[r.status] ?? 'Chưa rõ', 'outline'), ui.badge(r.job_status === 'OPEN' ? 'Tin đang mở' : 'Tin đã đóng', 'outline')),
      h('p', null, r.reason), r.review_note ? h('p', { class: 'muted' }, `Ghi chú: ${r.review_note}`) : null, review, close) });
  });
  return h('div', { class: 'stack' },
    ui.screenHead({ title: 'Báo cáo tin tuyển', sub: 'Xem xét báo cáo không tự đóng tin hoặc thay đổi đề nghị đã được nhận.' }),
    cards.length ? cards : ui.empty({ title: 'Không có báo cáo trên trang này', text: 'Báo cáo do thợ gửi sẽ hiện tại đây.' }),
    h('div', { class: 'btn-row' },
      offset > 0 ? ui.button({ label: 'Trang trước', href: ctx.url('quan-tri', 'A-06', { offset: Math.max(0, offset - limit) }) }) : null,
      cards.length === limit && offset + limit <= 10000 ? ui.button({ label: 'Trang sau', href: ctx.url('quan-tri', 'A-06', { offset: offset + limit }) }) : null));
}

export const screens = [
  { code: 'A-01', title: 'Duyệt hồ sơ', render: roleRequestsScreen },
  { code: 'A-03', title: 'Trọng tài', render: disputeReviewScreen },
  { code: 'A-04', title: 'Tham số vận hành', render: platformParametersScreen },
  { code: 'A-05', title: 'Trạng thái tuân thủ', render: complianceScreen },
  { code: 'A-06', title: 'Báo cáo tin tuyển', render: jobReportsScreen },
];
