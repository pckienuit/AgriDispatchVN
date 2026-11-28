// Màn thợ lái (O-01, O-03, O-04, O-05, O-06, O-07, O-08) trên API thật.

import { ui } from '../kit/ui.js';
import { apiButton, apiForm, DEPOSIT_MESSAGES } from '../app/actions.js';
import { ApiError } from '../../api.js';

const h = ui.h;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AREA_M2 = 2147483647;
const MAX_TEXT = 500;
// parsePagination in server/src/catalog.js allows limit <= 100 and offset <= 10000.
const PAGE_LIMIT = 100;
const MAX_OFFSET = 10000;

const REFUSAL_MESSAGES = {
  ...DEPOSIT_MESSAGES,
  READINESS_INCOMPLETE: 'Chủ ruộng chưa xác nhận đủ 3 mục sẵn sàng (rút nước, lúa chín, lối vào).',
  INSPECTION_INCOMPLETE: 'HTX chưa kiểm tra thực địa đạt hoặc kết quả đã cũ. Chưa thể bắt đầu ca.',
  PACKAGE_NOT_CLAIMED: 'Gói việc chưa ở trạng thái đã nhận máy, chưa thể bắt đầu ca.',
  NOT_FOUND: 'Không tìm thấy dữ liệu hoặc bạn không có quyền thực hiện.',
  FORBIDDEN: 'Tài khoản này không có quyền thực hiện thao tác này.',
  INVALID_ID: 'Mã đơn hoặc kết quả kiểm tra không hợp lệ.',
  INVALID_RESULT: 'Chọn kết quả kiểm tra thực địa hợp lệ.',
  VALIDATION_FAILED: 'Nội dung ghi chú chưa hợp lệ. Kiểm tra lại rồi thử.',
  STALE_VERSION: 'Dữ liệu ruộng vừa thay đổi. Tải lại trước khi xác nhận.',
  SHIFT_ALREADY_STARTED: 'Gói này đã mở ca rồi. Tải lại danh sách để xem.',
  INVALID_TRANSITION: 'Trạng thái ca đã thay đổi. Tải lại màn hình trước khi thao tác.',
  AREA_EXCEEDS_BOOKINGS: 'Diện tích báo cao hơn tổng diện tích các đơn trong gói.',
  SHIFT_ALREADY_COMPLETED: 'Ca này đã kết thúc trước đó với số liệu khác.',
  JOB_CLOSED: 'Tin tuyển đã đóng, không thể nhận thêm ứng tuyển hoặc đề nghị.',
  JOB_NOT_REPORTABLE: 'Không thể báo cáo tin đã đóng hoặc tin do bạn đăng.',
  REPORTER_NOT_ALLOWED: 'Tài khoản này không được gửi báo cáo tin tuyển.',
  DUPLICATE_APPLICATION: 'Bạn đã ứng tuyển tin này rồi.',
  OFFER_ACCEPTED: 'Đề nghị đã được nhận, không thể rút ứng tuyển hoặc từ chối.',
  OFFER_DECLINED: 'Đề nghị này đã bị từ chối trước đó.',
  OFFER_WITHDRAWN: 'Đề nghị này đã được rút.',
  CAPACITY_FULL: 'Tin tuyển đã đủ số lượng thợ nhận việc.',
  STATE_CHANGED: 'Dữ liệu vừa thay đổi. Tải lại rồi thử lại.',
};

const SHIFT_EVENT_LABEL = {
  SHIFT_STARTED: 'Bắt đầu ca',
  SHIFT_PAUSED: 'Tạm dừng ca',
  SHIFT_RESUMED: 'Tiếp tục ca',
  SHIFT_COMPLETED: 'Kết thúc ca',
};

const APP_STATUS_BADGE = {
  APPLIED: ['Đã ứng tuyển', 'outline'],
  OFFERED: ['Đã gửi đề nghị', 'info'],
  ACCEPTED: ['Đã nhận đề nghị', 'ok'],
  WITHDRAWN: ['Đã rút', 'muted'],
};

const OFFER_STATUS_BADGE = {
  OFFERED: ['Chờ trả lời', 'info'],
  ACCEPTED: ['Đã nhận việc', 'ok'],
  DECLINED: ['Đã từ chối', 'muted'],
  WITHDRAWN: ['Đã rút', 'muted'],
};

const JOB_STATUS_BADGE = {
  OPEN: ['Đang tuyển', 'ok'],
  CLOSED: ['Đã đóng', 'muted'],
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

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
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

function formatWindow(startIso, endIso) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return '';
  return `${ui.fmt.dateTime(startMs)} đến ${ui.fmt.dateTime(endMs)}`;
}

function formatAreaM2(m2) {
  return `${ui.fmt.num(m2, 0)} m² (${ui.fmt.ha(m2 / 10000)})`;
}

function formatVnd(value) {
  return /^[1-9][0-9]{0,14}$/.test(String(value)) ? `${new Intl.NumberFormat('vi-VN').format(BigInt(value))} đ` : 'Số tiền không hợp lệ';
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

export function shiftActions(shift) {
  if (!shift || !shift.canOperate) return [];
  if (shift.status === 'RUNNING') return ['pause', 'complete'];
  if (shift.status === 'PAUSED') return ['resume'];
  return [];
}

export function pauseReason(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const len = [...trimmed].length;
  if (len < 1 || len > MAX_TEXT) return null;
  return trimmed;
}

export function completeInput(rawArea, rawNote) {
  const areaStr = String(rawArea ?? '').trim();
  if (!/^[0-9]+$/.test(areaStr)) return null;
  const areaM2 = Number(areaStr);
  if (!Number.isSafeInteger(areaM2) || areaM2 < 1 || areaM2 > MAX_AREA_M2) return null;
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if ([...note].length > MAX_TEXT) return null;
  return note ? { areaM2, note } : { areaM2 };
}

export function seatsLeft(job) {
  const cap = Number(job?.capacity) || 0;
  const acc = Number(job?.acceptedCount) || 0;
  return Math.max(0, cap - acc);
}

export function packageStartGate(pkg) {
  const ready = Boolean(pkg?.ready);
  const inspected = Boolean(pkg?.inspected);
  const canStart = ready && inspected;
  let reason = null;
  let badge = ['Sẵn sàng mở ca', 'ok'];

  if (!ready && !inspected) {
    badge = ['Chưa đủ điều kiện', 'warn'];
    reason = 'Chủ ruộng chưa khai báo đủ 3 mục sẵn sàng và HTX chưa kiểm tra thực địa đạt.';
  } else if (!ready && inspected) {
    badge = ['Chờ chủ ruộng', 'warn'];
    reason = 'Chủ ruộng chưa khai báo đủ 3 mục sẵn sàng (rút nước, lúa chín, nơi nhận lúa).';
  } else if (ready && !inspected) {
    badge = ['Chờ HTX kiểm tra', 'warn'];
    reason = 'Chủ ruộng đã khai báo đủ nhưng HTX chưa kiểm tra thực địa đạt (hoặc kết quả cũ đã hết hạn do đổi lịch hoặc đổi khai báo).';
  }

  return { canStart, ready, inspected, badge, reason };
}

export function jobMatches(job, filters = {}) {
  if (!job) return false;
  if (filters.openOnly && job.status !== 'OPEN') return false;
  if (filters.seatsOnly && seatsLeft(job) <= 0) return false;
  if (filters.q) {
    const needle = foldVi(filters.q);
    if (needle) {
      const hay = `${foldVi(job.title)} ${foldVi(job.locality)}`;
      if (!hay.includes(needle)) return false;
    }
  }
  return true;
}

export function offerActions(offer) {
  if (!offer || offer.status !== 'OFFERED') return { accept: false, decline: false };
  return {
    accept: offer.job?.status === 'OPEN',
    decline: true,
  };
}

// Root-cause fix: POST /api/offers/:id/accept only updates offers.status (server/src/recruitment.js:384);
// applications/mine keeps status='OFFERED'. Combine all loaded offers by applicationId and only expose
// withdraw when not WITHDRAWN, no offer is ACCEPTED, and OFFERED applications still have an OFFERED offer.
export function withdrawAllowed(application, allOffers) {
  if (!application || !Array.isArray(allOffers)) return false;
  if (application.status === 'WITHDRAWN') return false;
  const mine = allOffers.filter((o) => o && o.applicationId === application.id);
  if (mine.some((o) => o.status === 'ACCEPTED')) return false;
  if (application.status === 'OFFERED') return mine.some((o) => o.status === 'OFFERED');
  return application.status === 'APPLIED';
}

export function applicationStatusKey(application, allOffers) {
  if (!application) return 'APPLIED';
  if (Array.isArray(allOffers)) {
    const mine = allOffers.filter((o) => o && o.applicationId === application.id);
    if (mine.some((o) => o.status === 'ACCEPTED')) return 'ACCEPTED';
  }
  return application.status;
}

export function applicationStatusLabel(application, allOffers) {
  const key = applicationStatusKey(application, allOffers);
  return (APP_STATUS_BADGE[key] || [key])[0];
}

function opButton(opts) {
  return apiButton({
    ...opts,
    async run() {
      try {
        return await opts.run();
      } catch (error) {
        throw withMappedRefusal(error);
      }
    },
  });
}

/* ---------- O-01: Ca hôm nay & chi tiết ca ---------- */

function buildShiftControls(shift, ctx) {
  const actions = shiftActions(shift);
  const canPause = actions.includes('pause');
  const canResume = actions.includes('resume');
  const canComplete = actions.includes('complete');

  function openPauseModal() {
    let modalRef;
    const reasonInput = ui.textarea({ name: 'reason', rows: 3, maxlength: MAX_TEXT });
    const form = apiForm({
      fields: [
        h('p', { class: 'muted' }, 'Ghi rõ lý do tạm dừng (mưa, lún đất, sự cố máy...) để chủ máy và HTX theo dõi.'),
        ui.field({ label: 'Lý do tạm dừng', hint: 'Từ 1 đến 500 ký tự.', input: reasonInput, required: true }),
      ],
      submitLabel: 'Xác nhận tạm dừng',
      submitKind: 'secondary',
      async run(fd) {
        const reason = pauseReason(fd.get('reason'));
        if (!reason) throw new Error('Nhập lý do tạm dừng từ 1 đến 500 ký tự.');
        try {
          return await ctx.api.request('POST', `/api/shifts/${shift.id}/pause`, { auth: true, body: { reason } });
        } catch (error) {
          throw withMappedRefusal(error);
        }
      },
      onDone() {
        modalRef.close();
        ctx.toast('Đã ghi nhận tạm dừng ca', 'ok');
        ctx.rerender();
      },
    });
    modalRef = ui.modal({ title: 'Tạm dừng ca', body: form });
  }

  function openCompleteModal() {
    let modalRef;
    const areaInput = ui.input({ type: 'number', name: 'areaM2', inputmode: 'numeric', min: 1, max: MAX_AREA_M2, step: 1 });
    const noteNode = ui.voiceField({ name: 'note', rows: 3, maxlength: MAX_TEXT, label: 'Ghi chú sau ca', hint: 'Không bắt buộc, tối đa 500 ký tự.' });
    const form = apiForm({
      fields: [
        ui.note({ tone: 'warn', text: 'Kết thúc ca chỉ ghi công việc đã làm. Không thay cho nghiệm thu hay xác nhận đã nhận tiền.' }),
        ui.field({ label: 'Diện tích đã làm (m²)', hint: 'Số nguyên dương, ví dụ 12000 cho 1,2 ha.', input: areaInput, required: true }),
        noteNode,
      ],
      submitLabel: 'Xác nhận kết thúc ca',
      submitKind: 'primary',
      async run(fd) {
        const payload = completeInput(fd.get('areaM2'), fd.get('note'));
        if (!payload) throw new Error('Nhập diện tích là số nguyên dương (m²) và ghi chú tối đa 500 ký tự.');
        try {
          return await ctx.api.request('POST', `/api/shifts/${shift.id}/complete`, { auth: true, body: payload });
        } catch (error) {
          throw withMappedRefusal(error);
        }
      },
      onDone() {
        modalRef.close();
        ctx.toast('Đã kết thúc ca', 'ok');
        ctx.rerender();
      },
    });
    modalRef = ui.modal({ title: 'Xác nhận kết thúc ca', body: form });
  }

  const buttons = [];
  if (canPause) buttons.push(ui.button({ label: 'Tạm dừng', icon: 'pause', kind: 'secondary', size: 'lg', block: true, onClick: openPauseModal }));
  if (canResume) {
    buttons.push(opButton({
      label: 'Tiếp tục ca', icon: 'play', kind: 'primary', size: 'lg', block: true,
      run: () => ctx.api.request('POST', `/api/shifts/${shift.id}/resume`, { auth: true, body: {} }),
      okText: 'Đã tiếp tục ca',
      onDone: () => ctx.rerender(),
    }));
  }
  if (canComplete) buttons.push(ui.button({ label: 'Kết thúc ca', icon: 'flag-checkered', kind: 'primary', size: 'lg', block: true, onClick: openCompleteModal }));
  return buttons;
}

function shiftTimeline(shift) {
  return (shift.events || []).map((ev, i, arr) => ({
    title: SHIFT_EVENT_LABEL[ev.eventType] || ev.eventType,
    meta: [
      ui.fmt.dateTime(Date.parse(ev.createdAt)),
      ev.reason ? `Lý do: ${ev.reason}` : null,
      ev.areaM2 ? `Diện tích: ${formatAreaM2(ev.areaM2)}` : null,
      ev.note ? `Ghi chú: ${ev.note}` : null,
    ].filter(Boolean).join(' · '),
    done: i < arr.length - 1 || shift.status === 'COMPLETED',
    now: i === arr.length - 1 && shift.status !== 'COMPLETED',
  }));
}

async function renderShiftDetail(ctx, shiftId) {
  const { data } = await ctx.api.request('GET', `/api/shifts/${shiftId}`, { auth: true });
  const shift = data?.shift;
  if (!shift) {
    return ui.empty({
      icon: 'tractor',
      title: 'Không thấy ca này',
      action: ui.button({ label: 'Về Ca hôm nay', href: ctx.url('tho-lai', 'O-01') }),
    });
  }

  const buttons = buildShiftControls(shift, ctx);
  if (buttons.length) {
    ctx.setAction(ui.actionBar({
      info: shift.status === 'RUNNING' ? 'Đang chạy ca' : 'Đang tạm dừng',
      actions: buttons,
    }));
  }

  const timelineItems = shiftTimeline(shift);
  return h('div', { class: 'stack' },
    h('div', { class: 'btn-row' },
      ui.button({ label: 'Về danh sách ca hôm nay', icon: 'arrow-left', kind: 'ghost', href: ctx.url('tho-lai', 'O-01') }),
      ui.button({ label: 'Mở buồng lái', icon: 'tractor', kind: 'secondary', href: ctx.url('tho-lai', 'O-02', { id: shift.id }) })),
    ui.card({
      title: shift.status === 'RUNNING' ? 'Ca đang làm' : shift.status === 'PAUSED' ? 'Ca đang tạm dừng' : 'Chi tiết ca máy',
      actions: ui.shiftBadge(shift.status),
      body: h('div', { class: 'stack-sm' },
        ui.kv([
          ['Mã ca', shift.id.slice(0, 8)],
          ['Mã gói', shift.packageId.slice(0, 8)],
          ['Bắt đầu', ui.fmt.dateTime(Date.parse(shift.startedAt))],
          shift.completedAt ? ['Kết thúc', ui.fmt.dateTime(Date.parse(shift.completedAt))] : null,
          shift.areaM2 ? ['Diện tích đã báo', formatAreaM2(shift.areaM2)] : null,
          shift.note ? ['Ghi chú', shift.note] : null,
        ]),
        !shift.canOperate ? ui.note({ tone: 'info', text: 'Bạn chỉ có quyền xem ca này.' }) : null),
    }),
    timelineItems.length ? ui.card({ title: 'Nhật ký ca', body: ui.timeline(timelineItems) }) : null);
}

async function today(ctx) {
  if (ctx.params.id) {
    if (!isUuid(ctx.params.id)) {
      return ui.empty({
        icon: 'tractor',
        title: 'Mã ca không hợp lệ',
        text: 'Đường dẫn ca máy không đúng định dạng.',
        action: ui.button({ label: 'Về Ca hôm nay', href: ctx.url('tho-lai', 'O-01') }),
      });
    }
    return renderShiftDetail(ctx, ctx.params.id.toLowerCase());
  }

  const [pkgRes, shiftRes] = await Promise.all([
    ctx.api.request('GET', '/api/shift-packages?limit=100&offset=0', { auth: true }),
    ctx.api.request('GET', '/api/shifts?limit=100&offset=0', { auth: true }),
  ]);
  const packages = Array.isArray(pkgRes.data?.packages) ? pkgRes.data.packages : [];
  const shifts = Array.isArray(shiftRes.data?.shifts) ? shiftRes.data.shifts : [];

  const activeShift = shifts.find((s) => s.canOperate && (s.status === 'RUNNING' || s.status === 'PAUSED'));
  let activeDetail = null;
  if (activeShift) {
    const { data } = await ctx.api.request('GET', `/api/shifts/${activeShift.id}`, { auth: true });
    activeDetail = data?.shift || activeShift;
  }

  const history = shifts.filter((s) => !activeShift || s.id !== activeShift.id);

  let activeSection = null;
  if (activeDetail) {
    const buttons = buildShiftControls(activeDetail, ctx);
    if (buttons.length) {
      ctx.setAction(ui.actionBar({
        info: activeDetail.status === 'RUNNING' ? 'Ca đang chạy' : 'Ca đang tạm dừng',
        actions: buttons,
      }));
    }
    const timelineItems = shiftTimeline(activeDetail);
    activeSection = h('section', { class: 'card op-hero' },
      h('div', { class: 'card__head' },
        h('div', null,
          h('h2', null, activeDetail.status === 'RUNNING' ? 'Ca đang làm' : 'Ca đang tạm dừng'),
          h('p', { class: 'small muted' }, `Bắt đầu ${ui.fmt.dateTime(Date.parse(activeDetail.startedAt))}`)),
        ui.shiftBadge(activeDetail.status)),
      ui.kv([
        ['Mã ca', activeDetail.id.slice(0, 8)],
        ['Mã gói', activeDetail.packageId.slice(0, 8)],
      ]),
      timelineItems.length ? ui.timeline(timelineItems) : null,
      ui.link('Mở chi tiết ca', ctx.url('tho-lai', 'O-01', { id: activeDetail.id }), 'caret-right'));
  }

  const pendingCards = packages.map((pkg) => {
    const gate = packageStartGate(pkg);
    return ui.card({
      title: pkg.locality,
      actions: ui.badge(gate.badge[0], gate.badge[1], gate.canStart ? 'check-circle' : 'warning'),
      body: h('div', { class: 'stack-sm' },
        h('p', { class: 'small muted' }, formatWindow(pkg.startAt, pkg.endAt)),
        ui.summaryLine([
          ['Số đơn trong gói', pkg.bookingCount],
          ['Khai báo chủ ruộng', pkg.ready ? 'Đã đủ 3 mục' : 'Chưa đủ'],
          ['Kiểm tra thực địa HTX', pkg.inspected ? 'Đã kiểm tra đạt' : 'Chưa đạt hoặc hết hạn'],
        ]),
        gate.canStart
          ? opButton({
            label: 'Bắt đầu ca',
            icon: 'play',
            kind: 'primary',
            size: 'lg',
            block: true,
            run: async () => {
              try {
                return await ctx.api.request('POST', `/api/packages/${pkg.id}/shifts/start`, { auth: true, body: {} });
              } catch (error) {
                if (error instanceof ApiError && (error.status === 409 || error.code === 'STATE_CHANGED')) {
                  const msg = refusalText(error.code) || 'Dữ liệu gói vừa thay đổi. Tải lại danh sách.';
                  ctx.toast(msg, 'warn');
                  ctx.rerender();
                }
                throw error;
              }
            },
            okText: 'Đã bắt đầu ca',
            onDone: (res) => {
              const id = res?.data?.shift?.id;
              if (id) ctx.go(ctx.url('tho-lai', 'O-01', { id }));
              else ctx.rerender();
            },
          })
          : ui.note({ tone: 'warn', text: gate.reason })),
    });
  });

  const historyList = history.length
    ? ui.list(history.map((s) => ui.listItem({
      icon: 'tractor',
      title: `Ca ${s.id.slice(0, 8)} · ${s.areaM2 ? formatAreaM2(s.areaM2) : 'Chưa báo diện tích'}`,
      meta: `${ui.fmt.dateTime(Date.parse(s.startedAt))}${s.completedAt ? ` đến ${ui.fmt.dateTime(Date.parse(s.completedAt))}` : ''}`,
      right: ui.shiftBadge(s.status),
      href: ctx.url('tho-lai', 'O-01', { id: s.id }),
    })))
    : null;

  if (!activeSection && !packages.length && !history.length) {
    return ui.empty({
      icon: 'tractor',
      title: 'Chưa có ca nào được giao',
      text: 'Khi bạn nhận lời mời và chủ máy gán gói việc cho bạn, ca làm việc sẽ hiện ở đây.',
      action: ui.button({ label: 'Tìm tin tuyển thợ', icon: 'magnifying-glass', kind: 'primary', size: 'lg', href: ctx.url('tho-lai', 'O-03') }),
    });
  }

  return h('div', { class: 'stack' },
    activeSection,
    packages.length
      ? ui.section('Gói việc chờ bắt đầu ca',
        h('div', { class: 'card-grid' }, pendingCards),
        ui.button({ label: 'Tải lại trạng thái', icon: 'arrows-clockwise', kind: 'secondary', size: 'sm', onClick: () => ctx.rerender() }))
      : null,
    historyList ? ui.section('Lịch sử ca máy', historyList) : null);
}

/* ---------- O-03: Tìm việc ---------- */

async function jobs(ctx) {
  const allJobs = await loadAllPages(async (offset, limit) => {
    const { data } = await ctx.api.request('GET', `/api/jobs?limit=${limit}&offset=${offset}`, { auth: true });
    return data;
  });

  const filters = {
    q: ctx.params.tu || '',
    openOnly: ctx.params.mo !== '0',
    seatsOnly: ctx.params.con === '1',
    wageType: ctx.params.wage || 'all',
    machineType: ctx.params.machine || 'all',
    skill: foldVi(ctx.params.skill || ''),
  };

  const listBox = h('div', { class: 'stack-sm' });
  const countLine = h('p', { class: 'small muted' });

  function paintList() {
    const matched = allJobs.filter((j) => jobMatches(j, filters)
      && (filters.wageType === 'all' || j.wageType === filters.wageType)
      && (filters.machineType === 'all' || j.machineType === filters.machineType)
      && (!filters.skill || (j.requiredSkills || []).some((s) => foldVi(s).includes(filters.skill))));
    countLine.textContent = `Hiện ${matched.length} / ${allJobs.length} tin tuyển.`;
    if (!matched.length) {
      listBox.replaceChildren(ui.empty({
        icon: 'magnifying-glass',
        title: allJobs.length ? 'Không có tin khớp bộ lọc' : 'Chưa có tin tuyển nào',
        text: allJobs.length ? 'Thử xóa bớt từ khóa hoặc tắt bớt điều kiện lọc.' : 'Khi chủ máy đăng tin tuyển thợ lái, tin sẽ hiện ở đây.',
      }));
      return;
    }
    const items = matched.map((j) => {
      const left = seatsLeft(j);
      return h('a', { class: 'op-job', href: ctx.url('tho-lai', 'O-04', { id: j.id }) },
        h('div', { class: 'row row--between row--top row--nowrap' },
          h('span', { class: 'op-job__title' }, j.title),
          ui.badge(...(JOB_STATUS_BADGE[j.status] || [j.status, 'outline']))),
        h('div', { class: 'op-job__meta small' }, `${j.locality} · ${formatWindow(j.startAt, j.endAt)}`),
        ui.summaryLine([
          ['Chỉ tiêu', `${j.acceptedCount}/${j.capacity} thợ`],
          ['Còn chỗ', left],
          ['Đã ứng tuyển', j.applicationCount],
        ]),
        h('span', { class:'small muted' }, `${j.wageType ? ({PER_HA:'Theo ha',PER_SHIFT:'Theo ca',NEGOTIABLE:'Thỏa thuận'}[j.wageType] || '') : 'Chưa nêu tiền công'}${j.wageAmountVnd ? ` · ${ui.fmt.vnd(Number(j.wageAmountVnd))}` : ''}${j.machineType ? ` · ${j.machineType}` : ''}`),
        (j.requiredSkills || []).length ? h('span', { class:'small muted' }, `Kỹ năng: ${j.requiredSkills.join(', ')}`) : null);
    });
    listBox.replaceChildren(h('ul', { class: 'list list--grid op-jobs' }, items.map((n) => h('li', null, n))));
  }

  const searchInput = ui.input({
    name: 'q',
    value: filters.q,
    maxlength: 120,
    on: {
      input(e) {
        filters.q = e.target.value;
        paintList();
      },
    },
  });
  searchInput.spellcheck = false;
  searchInput.autocapitalize = 'none';

  const openChip = h('button', {
    type: 'button',
    class: 'badge badge--outline op-radar-chip',
    'aria-pressed': String(filters.openOnly),
    on: {
      click() {
        filters.openOnly = !filters.openOnly;
        openChip.setAttribute('aria-pressed', String(filters.openOnly));
        paintList();
      },
    },
  }, 'Chỉ tin đang tuyển');

  const seatsChip = h('button', {
    type: 'button',
    class: 'badge badge--outline op-radar-chip',
    'aria-pressed': String(filters.seatsOnly),
    on: {
      click() {
        filters.seatsOnly = !filters.seatsOnly;
        seatsChip.setAttribute('aria-pressed', String(filters.seatsOnly));
        paintList();
      },
    },
  }, 'Còn chỗ');

  const wageFilter = ui.select({ name: 'wageType', options: [['all', 'Mọi hình thức tiền công'], ['PER_HA', 'Theo ha'], ['PER_SHIFT', 'Theo ca'], ['NEGOTIABLE', 'Thỏa thuận']], on: { change(e) { filters.wageType = e.target.value; paintList(); } } });
  const machineFilter = ui.select({ name: 'machineType', options: [['all', 'Mọi loại máy'], ['harvester', 'Máy gặt'], ['tractor', 'Máy kéo'], ['drone', 'Drone']], on: { change(e) { filters.machineType = e.target.value; paintList(); } } });
  const skillFilter = ui.input({ name: 'skill', value: ctx.params.skill || '', maxlength: 80, placeholder: 'Kỹ năng cần có', on: { input(e) { filters.skill = foldVi(e.target.value); paintList(); } } });
  paintList();

  return h('div', { class: 'stack' },
    h('section', { class: 'card op-filter' },
      ui.field({ label: 'Tìm theo tiêu đề hoặc địa bàn', hint: 'Gõ tên xã, huyện hoặc loại máy.', input: searchInput }),
      ui.field({ label: 'Hình thức tiền công', input: wageFilter }),
      ui.field({ label: 'Loại máy', input: machineFilter }),
      ui.field({ label: 'Kỹ năng cần có', input: skillFilter }),
      h('div', { class: 'btn-row' }, openChip, seatsChip),
      countLine),
    listBox);
}

/* ---------- O-04: Chi tiết tin tuyển ---------- */

async function jobDetail(ctx) {
  if (!isUuid(ctx.params.id)) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Không tìm thấy tin tuyển',
      text: 'Mã tin tuyển không hợp lệ.',
      action: ui.button({ label: 'Về danh sách tin tuyển', href: ctx.url('tho-lai', 'O-03') }),
    });
  }
  const jobId = ctx.params.id.toLowerCase();

  const [{ data }, myApps, myOffers] = await Promise.all([
    ctx.api.request('GET', `/api/jobs/${jobId}`, { auth: true }),
    loadAllPages(async (offset, limit) => {
      const res = await ctx.api.request('GET', `/api/applications/mine?limit=${limit}&offset=${offset}`, { auth: true });
      return res.data;
    }),
    loadAllPages(async (offset, limit) => {
      const res = await ctx.api.request('GET', `/api/offers?limit=${limit}&offset=${offset}`, { auth: true });
      return res.data;
    }),
  ]);
  const job = data?.job;
  if (!job) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Tin tuyển không tồn tại',
      action: ui.button({ label: 'Về danh sách tin tuyển', href: ctx.url('tho-lai', 'O-03') }),
    });
  }

  const existingApp = myApps.find((a) => a.jobId === job.id);
  const relatedOffers = existingApp ? myOffers.filter((o) => o.applicationId === existingApp.id) : [];
  const liveOffer = relatedOffers.find((o) => o.status === 'OFFERED' || o.status === 'ACCEPTED');
  const left = seatsLeft(job);

  let statusNote = null;
  if (existingApp) {
    const label = applicationStatusLabel(existingApp, myOffers);
    statusNote = ui.banner({
      tone: liveOffer?.status === 'ACCEPTED' ? 'success' : 'info',
      title: `Trạng thái của bạn: ${label}`,
      text: liveOffer?.status === 'OFFERED'
        ? 'Chủ máy đã gửi đề nghị cho bạn. Mở màn Đơn của tôi để nhận hoặc từ chối.'
        : 'Xem và quản lý đơn tại màn Đơn của tôi.',
      action: ui.button({ label: 'Mở Đơn của tôi', icon: 'handshake', href: ctx.url('tho-lai', 'O-06') }),
    });
  } else if (job.status !== 'OPEN') {
    statusNote = ui.note({ tone: 'warn', text: 'Tin tuyển này đã đóng, không nhận hồ sơ mới.' });
  } else if (left <= 0) {
    statusNote = ui.note({ tone: 'warn', text: 'Tin tuyển đã đủ số lượng thợ nhận việc.' });
  }

  const canApply = !existingApp && job.status === 'OPEN';
  if (canApply) {
    ctx.setAction(ui.actionBar({
      info: `Còn ${left} chỗ`,
      actions: [ui.button({ label: 'Ứng tuyển ngay', icon: 'paper-plane-tilt', kind: 'primary', size: 'lg', block: true, href: ctx.url('tho-lai', 'O-05', { id: job.id }) })],
    }));
  }

  const reportPanel = job.status === 'OPEN' && !ctx.user?.roles.includes('admin')
    ? h('details', { class: 'card', 'data-job-report': '' },
      h('summary', null, 'Báo cáo tin tuyển'),
      h('div', { class: 'stack-sm' })) : null;
  if (reportPanel) {
    const content = reportPanel.lastElementChild;
    content.append(apiForm({
      fields: [ui.field({ label: 'Lý do báo cáo', input: ui.textarea({ name: 'reportReason', maxlength: 1000 }), required: true })],
      submitLabel: 'Gửi báo cáo',
      submitKind: 'secondary',
      async run(values) {
        const reason = String(values.get('reportReason') ?? '').trim();
        if (!reason || [...reason].length > 1000) throw new Error('Nhập lý do báo cáo, tối đa 1.000 ký tự.');
        try {
          await ctx.api.request('POST', `/api/jobs/${job.id}/reports`, { auth: true, body: { reason } });
        } catch (error) {
          throw withMappedRefusal(error);
        }
      },
      onDone() {
        if (ctx.stale()) return;
        const message = h('p', { role: 'status', tabindex: '-1' }, 'Đã gửi báo cáo. Quản trị viên sẽ xem xét.');
        content.replaceChildren(message);
        message.focus();
      },
    }));
  }

  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, ui.button({ label: 'Về danh sách tin tuyển', icon: 'arrow-left', kind: 'ghost', href: ctx.url('tho-lai', 'O-03') })),
    statusNote,
    ui.card({
      title: job.title,
      actions: ui.badge(...(JOB_STATUS_BADGE[job.status] || [job.status, 'outline'])),
      body: ui.kv([
        ['Địa bàn', job.locality],
        ['Thời gian dự kiến', formatWindow(job.startAt, job.endAt)],
        ['Số lượng tuyển', `${job.acceptedCount}/${job.capacity} thợ đã nhận (còn ${left})`],
        ['Số lượt ứng tuyển', String(job.applicationCount)],
        ['Đăng lúc', ui.fmt.dateTime(Date.parse(job.createdAt))],
        job.closedAt ? ['Đóng lúc', ui.fmt.dateTime(Date.parse(job.closedAt))] : null,
      ]),
    }),
    ui.note({ tone: 'info', text: 'Thông tin tiền công cụ thể và giấy tờ máy trao đổi trực tiếp với chủ máy; bản thử nghiệm chưa lưu hợp đồng lao động.' }),
    reportPanel);
}

/* ---------- O-05: Ứng tuyển ---------- */

async function applyJob(ctx) {
  if (!isUuid(ctx.params.id)) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Không tìm thấy tin tuyển',
      text: 'Mã tin tuyển không hợp lệ.',
      action: ui.button({ label: 'Về danh sách tin tuyển', href: ctx.url('tho-lai', 'O-03') }),
    });
  }
  const jobId = ctx.params.id.toLowerCase();

  const [{ data }, myApps] = await Promise.all([
    ctx.api.request('GET', `/api/jobs/${jobId}`, { auth: true }),
    loadAllPages(async (offset, limit) => {
      const res = await ctx.api.request('GET', `/api/applications/mine?limit=${limit}&offset=${offset}`, { auth: true });
      return res.data;
    }),
  ]);
  const job = data?.job;
  if (!job) {
    return ui.empty({
      icon: 'magnifying-glass',
      title: 'Tin tuyển không tồn tại',
      action: ui.button({ label: 'Về danh sách tin tuyển', href: ctx.url('tho-lai', 'O-03') }),
    });
  }

  const existingApp = myApps.find((a) => a.jobId === job.id);
  if (existingApp) {
    return h('div', { class: 'stack' },
      ui.banner({
        tone: 'info',
        title: 'Bạn đã ứng tuyển tin này',
        text: 'Mỗi thợ chỉ gửi một đơn cho mỗi tin tuyển.',
        action: ui.button({ label: 'Xem trong Đơn của tôi', kind: 'primary', href: ctx.url('tho-lai', 'O-06') }),
      }),
      ui.button({ label: 'Quay lại chi tiết tin', kind: 'ghost', href: ctx.url('tho-lai', 'O-04', { id: job.id }) }));
  }

  if (job.status !== 'OPEN') {
    return h('div', { class: 'stack' },
      ui.banner({
        tone: 'warn',
        title: 'Tin tuyển đã đóng',
        text: 'Không thể nộp ứng tuyển khi tin tuyển không còn mở.',
      }),
      ui.button({ label: 'Quay lại chi tiết tin', kind: 'ghost', href: ctx.url('tho-lai', 'O-04', { id: job.id }) }));
  }

  const noteNode = ui.voiceField({
    name: 'note',
    rows: 4,
    maxlength: MAX_TEXT,
    label: 'Lời nhắn gửi chủ máy (không bắt buộc)',
    hint: 'Ghi kinh nghiệm lái máy, vùng quen chạy hoặc khung giờ sẵn sàng. Tối đa 500 ký tự.',
  });

  const form = apiForm({
    fields: [
      ui.card({
        title: job.title,
        subtitle: `${job.locality} · ${formatWindow(job.startAt, job.endAt)}`,
        body: ui.summaryLine([['Còn chỗ', seatsLeft(job)], ['Đã ứng tuyển', job.applicationCount]]),
      }),
      noteNode,
    ],
    submitLabel: 'Gửi ứng tuyển',
    async run(fd) {
      const rawNote = String(fd.get('note') || '').trim();
      if ([...rawNote].length > MAX_TEXT) throw new Error('Lời nhắn tối đa 500 ký tự.');
      const body = rawNote ? { note: rawNote } : {};
      try {
        return await ctx.api.request('POST', `/api/jobs/${job.id}/applications`, { auth: true, body });
      } catch (error) {
        throw withMappedRefusal(error);
      }
    },
    onDone() {
      ctx.toast('Đã gửi ứng tuyển', 'ok');
      ctx.go(ctx.url('tho-lai', 'O-06'));
    },
  });

  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, ui.button({ label: 'Quay lại chi tiết tin', icon: 'arrow-left', kind: 'ghost', href: ctx.url('tho-lai', 'O-04', { id: job.id }) })),
    form);
}

/* ---------- O-06: Đơn của tôi và đề nghị ---------- */

const OFFER_ORDER = { OFFERED: 0, ACCEPTED: 1, DECLINED: 2, WITHDRAWN: 3 };
const APP_ORDER = { OFFERED: 0, APPLIED: 1, ACCEPTED: 2, WITHDRAWN: 3 };

async function myWork(ctx) {
  const [applications, offers] = await Promise.all([
    loadAllPages(async (offset, limit) => {
      const { data } = await ctx.api.request('GET', `/api/applications/mine?limit=${limit}&offset=${offset}`, { auth: true });
      return data;
    }),
    loadAllPages(async (offset, limit) => {
      const { data } = await ctx.api.request('GET', `/api/offers?limit=${limit}&offset=${offset}`, { auth: true });
      return data;
    }),
  ]);

  const sortedOffers = offers.slice().sort((a, b) => (OFFER_ORDER[a.status] ?? 9) - (OFFER_ORDER[b.status] ?? 9));
  const sortedApps = applications.slice().sort((a, b) => (APP_ORDER[applicationStatusKey(a, offers)] ?? 9) - (APP_ORDER[applicationStatusKey(b, offers)] ?? 9));

  const offerCards = sortedOffers.map((offer) => {
    const acts = offerActions(offer);
    const jobClosed = offer.job?.status !== 'OPEN';
    const buttons = [];
    if (acts.accept) {
      buttons.push(opButton({
        label: 'Nhận đề nghị',
        icon: 'check',
        kind: 'primary',
        size: 'lg',
        block: true,
        confirm: {
          title: 'Xác nhận nhận đề nghị?',
          text: 'Sau khi nhận, bạn giữ một chỗ trong tin tuyển và không thể tự rút đơn.',
          confirmLabel: 'Nhận đề nghị',
        },
        run: () => ctx.api.request('POST', `/api/offers/${offer.id}/accept`, { auth: true, body: {} }),
        okText: 'Đã nhận đề nghị',
        onDone: () => ctx.rerender(),
      }));
    }
    if (acts.decline) {
      buttons.push(opButton({
        label: 'Từ chối',
        icon: 'x',
        kind: 'secondary',
        size: 'lg',
        block: true,
        confirm: {
          title: 'Từ chối đề nghị này?',
          text: 'Đơn ứng tuyển của bạn sẽ quay lại trạng thái chờ chủ máy xem xét.',
          confirmLabel: 'Từ chối',
        },
        run: () => ctx.api.request('POST', `/api/offers/${offer.id}/decline`, { auth: true, body: {} }),
        okText: 'Đã từ chối đề nghị',
        onDone: () => ctx.rerender(),
      }));
    }

    return ui.card({
      title: offer.job?.title || 'Tin tuyển',
      actions: ui.badge(...(OFFER_STATUS_BADGE[offer.status] || [offer.status, 'outline'])),
      body: h('div', { class: 'op-offer' },
        h('p', { class: 'small muted' }, `${offer.job?.locality || ''} · ${formatWindow(offer.job?.startAt, offer.job?.endAt)}`),
        ui.kv([
          ['Gửi đề nghị lúc', ui.fmt.dateTime(Date.parse(offer.createdAt))],
          offer.respondedAt ? ['Phản hồi lúc', ui.fmt.dateTime(Date.parse(offer.respondedAt))] : null,
          ['Trạng thái tin', offer.job?.status === 'OPEN' ? 'Đang mở' : 'Đã đóng'],
        ]),
        offer.status === 'OFFERED' && jobClosed
          ? ui.note({ tone: 'warn', text: 'Tin tuyển đã đóng nên không nhận đề nghị được nữa; bạn vẫn có thể từ chối.' })
          : null,
        buttons.length ? h('div', { class: 'op-ctl' }, buttons) : null,
        ui.link('Xem chi tiết tin tuyển', ctx.url('tho-lai', 'O-04', { id: offer.jobId }), 'caret-right')),
    });
  });

  const appItems = sortedApps.map((app) => {
    const statusKey = applicationStatusKey(app, offers);
    const badgeSpec = APP_STATUS_BADGE[statusKey] || [statusKey, 'outline'];
    const canWithdraw = withdrawAllowed(app, offers);

    return h('div', { class: 'stack-sm' },
      h('div', { class: 'row row--between row--top row--nowrap' },
        ui.link(app.job?.title || 'Tin tuyển', ctx.url('tho-lai', 'O-04', { id: app.jobId })),
        ui.badge(...badgeSpec)),
      h('div', { class: 'small muted' }, `${app.job?.locality || ''} · ${formatWindow(app.job?.startAt, app.job?.endAt)}`),
      app.note ? h('p', { class: 'small' }, `Lời nhắn: ${app.note}`) : null,
      h('div', { class: 'small muted' }, `Gửi lúc ${ui.fmt.dateTime(Date.parse(app.createdAt))}`),
      canWithdraw
        ? opButton({
          label: 'Rút ứng tuyển',
          icon: 'arrow-u-up-left',
          kind: 'secondary',
          confirm: {
            title: 'Rút đơn ứng tuyển?',
            text: 'Chủ máy sẽ không gửi đề nghị cho đơn này nữa.',
            confirmLabel: 'Rút ứng tuyển',
          },
          run: () => ctx.api.request('POST', `/api/applications/${app.id}/withdraw`, { auth: true, body: {} }),
          okText: 'Đã rút ứng tuyển',
          onDone: () => ctx.rerender(),
        })
        : null);
  });

  if (!offers.length && !applications.length) {
    return ui.empty({
      icon: 'handshake',
      title: 'Chưa có đơn ứng tuyển hay đề nghị',
      text: 'Tìm tin tuyển phù hợp để gửi ứng tuyển cho chủ máy.',
      action: ui.button({ label: 'Tìm việc ngay', icon: 'magnifying-glass', kind: 'primary', size: 'lg', href: ctx.url('tho-lai', 'O-03') }),
    });
  }

  return h('div', { class: 'stack' },
    offers.length
      ? ui.section('Đề nghị từ chủ máy', ...offerCards)
      : ui.card({ title: 'Đề nghị từ chủ máy', body: h('p', { class: 'muted' }, 'Chưa có đề nghị nào.') }),
    applications.length
      ? ui.section('Đơn đã ứng tuyển', h('ul', { class: 'list op-apps' }, appItems.map((n) => h('li', null, n))))
      : null);
}

/* ---------- O-08: Hồ sơ và chứng chỉ tự khai ---------- */
async function workforceProfile(ctx) {
  const { data } = await ctx.api.request('GET', '/api/workforce/profile', { auth: true });
  const profile = data.profile;
  const skills = ui.input({ name: 'skills', value: profile.skills.join(', '), maxlength: 2500 });
  const certName = ui.input({ name: 'certName', maxlength: 120 });
  const certExpiry = ui.input({ name: 'certExpiry', type: 'date' });
  const form = apiForm({
    fields: [ui.note({ tone: 'info', text: 'Kỹ năng và chứng chỉ do bạn tự khai. Nền tảng chưa xác minh giấy tờ từ biểu mẫu này.' }), ui.field({ label: 'Kỹ năng, cách nhau bằng dấu phẩy', input: skills }), ui.field({ label: 'Tên chứng chỉ muốn thêm', input: certName }), ui.field({ label: 'Ngày hết hạn', input: certExpiry })],
    submitLabel: 'Lưu hồ sơ',
    async run(fd) {
      const nextSkills = String(fd.get('skills')).split(',').map((s) => s.trim()).filter(Boolean);
      const certifications = [];
      const newName = String(fd.get('certName') || '').trim();
      const newExpiry = String(fd.get('certExpiry') || '').trim();
      if (newName || newExpiry) {
        if (!newName || !newExpiry) throw new Error('Nhập đủ tên chứng chỉ và ngày hết hạn.');
        certifications.push({ name: newName, expiresAt: newExpiry });
      }
      return ctx.api.request('PUT', '/api/workforce/profile', { auth: true, body: { skills: nextSkills, certifications } });
    },
    onDone: () => { ctx.toast('Đã lưu hồ sơ tự khai', 'ok'); ctx.rerender(); },
  });
  const certs = profile.certifications.length
    ? ui.list(profile.certifications.map((c) => h('div', { class: 'stack-sm' },
      h('strong', null, c.name), h('span', { class: 'small' }, `Hết hạn ${c.expiresAt}`),
      ui.badge(c.verificationStatus === 'VERIFIED' ? 'Đã được quản trị viên xác minh' : c.verificationStatus === 'REJECTED' ? 'Không được xác minh' : 'Chưa xác minh', c.verificationStatus === 'VERIFIED' ? 'ok' : 'warn'))))
    : h('p', { class: 'muted' }, 'Chưa khai chứng chỉ.');
  return h('div', { class: 'stack' }, ui.screenHead({ title: 'Hồ sơ thợ lái' }), ui.card({ title: 'Thông tin tự khai', body: form }), ui.card({ title: 'Chứng chỉ đã khai', body: certs }));
}

/* ---------- O-07: assigned operator acknowledges provider's external wage report ---------- */
async function wageReports(ctx) {
  const { data } = await ctx.api.request('GET', '/api/workforce/wages?limit=100&offset=0', { auth: true });
  const items = data.items || [];
  const reports = items.map((w) => h('div', { class:'stack-sm' },
    h('strong', null, `Ca ${w.shiftId.slice(0,8)} · ${formatVnd(w.amountVnd)}`),
    h('span', { class:'small muted' }, w.note || 'Không có ghi chú'),
    w.acknowledged ? ui.badge('Đã ghi nhận xác nhận', 'ok') : apiButton({ label:'Xác nhận đã nhận khoản này ngoài ứng dụng', kind:'primary', run:()=>ctx.api.request('POST',`/api/wage-reports/${w.id}/acknowledge`,{auth:true,body:{}}), okText:'Đã xác nhận', onDone:()=>ctx.rerender() })));
  return h('div',{class:'stack'},ui.screenHead({title:'Tiền công ngoài ứng dụng'}),ui.note({tone:'info',text:'Báo cáo của chủ máy và xác nhận của thợ là hai mốc riêng. Đây không phải xác nhận nghiệm thu, chuyển tiền hoặc trạng thái thanh toán của đơn.'}),ui.card({title:'Báo cáo tiền công',body:reports.length?ui.list(reports):h('p',{class:'muted'},'Chưa có báo cáo tiền công cho ca của bạn.')}));
}

export const screens = [
  { code: 'O-01', title: 'Ca hôm nay', render: today },
  { code: 'O-07', title: 'Tiền công', render: wageReports },
  { code: 'O-08', title: 'Hồ sơ', render: workforceProfile },
  { code: 'O-03', title: 'Tìm việc', render: jobs },
  { code: 'O-04', title: 'Chi tiết tin tuyển', render: jobDetail },
  { code: 'O-05', title: 'Ứng tuyển', render: applyJob },
  { code: 'O-06', title: 'Đơn của tôi', render: myWork },
];
