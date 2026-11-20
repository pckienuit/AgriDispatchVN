import { ui } from '../kit/ui.js';

const h = ui.h;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;
const PHASE_LABEL = { OPEN: 'Chờ nhận gói', CLAIMED_PRE_SHIFT: 'Chưa mở ca', RUNNING: 'Đang làm', PAUSED: 'Tạm dừng', COMPLETED: 'Đã xong', CANCELLED: 'Đã hủy' };
const BOOKING_LABEL = { REQUESTED: 'Chờ gom', GROUPED: 'Đã gom', ASSIGNED: 'Đã giao máy', CANCELLED: 'Đã hủy' };
const currency = new Intl.NumberFormat('vi-VN');

function money(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value ?? ''))) return 'Không rõ';
  return `${currency.format(BigInt(value))} đ`;
}

function commissionRow(item) {
  const source = item.hypotheticalBaseSource === 'AGREED_ACCEPTANCE'
    ? 'Giá đã hai bên đồng ý'
    : item.hypotheticalBaseSource === 'CANCELLED_EXCLUDED'
      ? 'Đơn đã hủy'
      : 'Giá dự kiến lúc đặt đơn';
  return {
    ...item,
    source,
    state: BOOKING_LABEL[item.bookingState] || 'Chưa rõ',
  };
}

async function commissionScreen(ctx) {
  const offset = Number.parseInt(ctx.params.offset || '0', 10);
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 && offset <= 10000 ? offset : 0;
  const { data } = await ctx.api.request('GET', `/api/htx/commission-estimates?limit=${PAGE_SIZE}&offset=${safeOffset}`, { auth: true });
  const summary = data?.summary;
  if (!summary || !Array.isArray(data.items) || summary.hypothetical !== true || summary.payable !== false) {
    throw new Error('Máy chủ trả về ước tính hoa hồng không hợp lệ.');
  }
  const items = data.items.map(commissionRow);
  const rows = ui.table({
    caption: 'Ước tính hoa hồng HTX theo đơn',
    rows: items,
    cols: [
      { label: 'Đơn / địa bàn', render: (item) => h('div', null, h('strong', null, item.locality || 'Chưa có địa bàn'), h('div', { class: 'small muted' }, `Đơn ${item.bookingId.slice(0, 8)}`)) },
      { label: 'Cơ sở tính', render: (item) => h('div', null, money(item.hypotheticalBaseVnd), h('div', { class: 'small muted' }, item.source)) },
      { label: 'Ước tính 3%', render: (item) => h('strong', null, money(item.hypotheticalCommissionVnd)) },
      { label: 'Đã xác nhận thanh toán', render: (item) => money(item.confirmedCustomerTotalVnd) },
      { label: 'Tình trạng', render: (item) => h('span', null, item.hasOpenDispute ? `${item.state} · có khiếu nại` : item.state) },

    ],
  });
  return h('div', { class: 'stack' },
    ui.screenHead({ title: 'Ước tính hoa hồng', sub: 'Toàn bộ đơn thuộc phạm vi HTX này.', actions: [ui.button({ label: 'Về hiện trường', kind: 'secondary', href: ctx.url('htx', 'H-06') })] }),
    ui.note({ tone: 'warn', text: summary.notice || 'Tỷ lệ 3% chỉ là giả định, chưa được duyệt. Số liệu không phải khoản phải thu, khoản phải trả hay đã chi.' }),
    ui.summaryLine([
      ['Đơn trong phạm vi', summary.scopedBookingCount],
      ['Đã đồng ý giá', summary.agreedAcceptanceCount],
      ['Ước tính trên giá đã đồng ý', money(summary.totalHypotheticalCommissionOnAgreedVnd)],
      ['Ước tính mọi đơn chưa hủy', money(summary.totalHypotheticalCommissionAllNonCancelledVnd)],
    ]),
    ui.summaryLine([
      ['HTX phải thu', money(summary.owedToHtxVnd)],
      ['HTX đã nhận', money(summary.paidToHtxVnd)],
      ['Đã xác nhận từ khách', money(summary.totalConfirmedCustomerPaymentsVnd)],
    ]),
    items.length ? rows : ui.empty({ icon: 'hand-coins', title: 'Chưa có đơn trong phạm vi', text: 'Khi có đơn được giao trực tiếp hoặc thuộc gói của HTX, ước tính sẽ hiện tại đây.' }),
    h('div', { class: 'btn-row' },
      data.offset > 0 ? ui.button({ label: 'Đơn mới hơn', kind: 'secondary', href: ctx.url('htx', 'H-09', { offset: Math.max(0, data.offset - PAGE_SIZE) }) }) : null,
      data.offset + data.limit < summary.scopedBookingCount ? ui.button({ label: 'Đơn cũ hơn', kind: 'secondary', href: ctx.url('htx', 'H-09', { offset: data.offset + data.limit }) }) : null));
}

function telemetryMetrics(telemetry, scope) {
  const metrics = telemetry.metrics;
  if (!metrics || !telemetry.simulation?.simulated || telemetry.simulation.realDeviceTelemetry !== false || telemetry.simulation.measuredCoordinatesAvailable !== false) {
    throw new Error('Máy chủ trả về dữ liệu telemetry không đúng định dạng mô phỏng.');
  }
  const pct = Math.round(Number(metrics.progressRatioSimulated) * 100);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Tiến độ mô phỏng không hợp lệ.');
  return h('div', { class: 'stack-sm' },
    ui.note({ tone: 'warn', text: 'Dữ liệu do máy chủ mô phỏng. Không phải GPS thật hoặc dữ liệu cảm biến.' }),
    ui.summaryLine([
      ['Trạng thái', PHASE_LABEL[telemetry.phase] || 'Chưa rõ'],
      ['Tốc độ mô phỏng', `${metrics.speedKmh} km/h`],
      ['Vòng quay mô phỏng', `${metrics.cutterBarRpm} vòng/phút`],
      ['Nhiên liệu mô phỏng', `${metrics.fuelPercentSimulated}%`],
      ['Diện tích mô phỏng', `${ui.fmt.num(metrics.simulatedWorkedAreaM2)} m²`],
    ]),
    scope === 'shift' && metrics.actualCompletedAreaM2 !== null
      ? ui.kv([['Diện tích báo khi kết thúc ca', `${ui.fmt.num(metrics.actualCompletedAreaM2)} m²`]]) : null,
    ui.progress(pct, 'Tiến độ mô phỏng'),
    h('p', { class: 'small muted' }, `Tiến độ mô phỏng ${pct}%. Giờ máy chủ: ${ui.fmt.dateTime(Date.parse(telemetry.serverTime))}.`));
}

export async function telemetryCard(ctx, scope, id) {
  const resource = scope === 'booking' ? 'bookings' : 'shifts';
  const { data } = await ctx.api.request('GET', `/api/${resource}/${id}/telemetry`, { auth: true });
  const telemetry = data?.telemetry;
  if (telemetry?.scope !== scope || telemetry[`${scope}Id`] !== id) throw new Error('Máy chủ trả về dữ liệu không đúng hồ sơ.');
  return ui.card({ title: 'Chỉ số máy mô phỏng', body: telemetryMetrics(telemetry, scope) });
}

async function telemetryScreen(ctx, scope) {
  const id = ctx.params.id?.toLowerCase();
  const valid = UUID.test(id || '');
  const farmer = scope === 'booking';
  const back = ui.button({ label: farmer ? 'Về đơn dịch vụ' : 'Về ca máy', kind: 'secondary', href: farmer ? ctx.url('nong-dan', 'F-07', valid ? { id } : undefined) : ctx.url('tho-lai', 'O-01', valid ? { id } : undefined) });
  return h('div', { class: 'stack' },
    ui.screenHead({ title: farmer ? 'Theo dõi máy' : 'Buồng lái', actions: [back, valid ? ui.button({ label: 'Tải lại chỉ số', kind: 'ghost', onClick: () => ctx.rerender() }) : null].filter(Boolean) }),
    valid ? await telemetryCard(ctx, scope, id) : ui.empty({ icon: 'binoculars', title: farmer ? 'Chưa chọn đơn' : 'Chưa chọn ca', text: farmer ? 'Mở theo dõi từ chi tiết đơn.' : 'Mở buồng lái từ ca máy.' }));
}

export const screens = [
  { code: 'H-09', title: 'Ước tính hoa hồng', render: commissionScreen },
  { code: 'F-10', title: 'Theo dõi máy', render: (ctx) => telemetryScreen(ctx, 'booking') },
  { code: 'O-02', title: 'Buồng lái', render: (ctx) => telemetryScreen(ctx, 'shift') },
];
