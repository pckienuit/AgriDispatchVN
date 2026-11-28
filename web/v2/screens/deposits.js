import { ApiError } from '../../api.js';
import { apiButton, apiForm, errorText, DEPOSIT_MESSAGES } from '../app/actions.js';
import { ui } from '../kit/ui.js';

const { h } = ui;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });
const money = (value) => currency.format(BigInt(value));
const depositPath = (id) => `/api/bookings/${id}/deposit`;
const callPath = (id) => `/api/packages/${id}/deposit-call-confirmation`;
const get = async (ctx, path) => (await ctx.api.request('GET', path, { auth: true })).data;
const post = (ctx, path, body) => ctx.api.request('POST', path, { auth: true, body });
const blocked = {
  ...DEPOSIT_MESSAGES,
  HTX_CALL_NOT_CONFIRMED: 'Chờ HTX xác nhận đã gọi',
  BOOKING_UNAVAILABLE: 'Đơn chưa được giao máy hoặc đã hủy.',
  PACKAGE_NOT_CLAIMED: 'Chủ máy chưa nhận gói việc.',
  DEPOSIT_NOT_APPLICABLE: 'Đơn này không áp dụng cọc.',
  DISPUTE_OPEN: 'Tạm dừng ghi nhận cọc do đơn đang có khiếu nại.',
  PARTY_CONFLICT: 'Không thể ghi nhận cọc giữa cùng một tài khoản.',
};

function status(view) {
  if (view.deposit?.status === 'CONFIRMED') return ui.badge('Hai bên đã ghi nhận cọc', 'ok');
  if (view.deposit?.status === 'EXPIRED' || view.permissions.blockReason === 'DEPOSIT_EXPIRED') return ui.badge('Hết hạn cọc', 'warn');
  if (view.deposit?.status === 'REPORTED') return ui.badge('Chờ chủ máy xác nhận đã nhận cọc', 'warn');
  return ui.badge('Chưa báo chuyển cọc', 'outline');
}

function loadError(ctx, error) {
  if (!ctx.stale()) ui.clearToasts();
  return h('div', { class: 'stack-sm' },
    h('p', { role: 'alert', class: 'msg msg--error' }, errorText(error)),
    ui.button({ label: 'Tải lại thông tin cọc', kind: 'secondary', onClick: () => ctx.rerender() }));
}

const expiryLabel = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ['Hạn cọc', ui.fmt.dateTime(ms)] : null;
};

function vietqrCard(ctx, id) {
  const result = h('div', { class: 'stack-sm', 'aria-live': 'polite' });
  const issue = apiButton({
    label: 'Hiện mã VietQR',
    hint: 'Hạn chuyển cọc bắt đầu khi tạo mã lần đầu.',
    run: () => post(ctx, `/api/bookings/${id}/vietqr`, {}),
    onDone({ data }) {
      if (ctx.stale()) return;
      const { vietqr, expiresAt } = data;
      if (!vietqr?.svg || !/^[1-9]\d*$/.test(vietqr.amountVnd)) throw new ApiError(502, 'BAD_RESPONSE');
      // Render SVG as an image, never as active DOM markup.
      result.replaceChildren(
        h('img', { src: `data:image/svg+xml,${encodeURIComponent(vietqr.svg)}`, alt: 'Mã VietQR chuyển cọc cho chủ máy', width: 224, height: 224, style: 'max-width:100%;height:auto' }),
        ui.kv([
          ['Ngân hàng', vietqr.bankName || vietqr.bankBin], ['Chủ tài khoản', vietqr.accountHolder],
          ['Số tài khoản', vietqr.accountNumber], ['Số tiền', money(vietqr.amountVnd)],
          ['Nội dung chuyển khoản', vietqr.description], expiryLabel(expiresAt),
        ]),
      );
      issue.hidden = true;
    },
  });
  return ui.card({ title: 'Chuyển cọc cho chủ máy', body: h('div', { class: 'stack-sm' }, issue, result) });
}

export async function farmerDepositScreen(ctx) {
  const id = ctx.params.id;
  const back = ui.button({ label: 'Chi tiết đơn', kind: 'secondary', href: ctx.url('nong-dan', 'F-07', UUID.test(id ?? '') ? { id } : undefined) });
  if (!UUID.test(id ?? '')) return ui.empty({ title: 'Chưa chọn đơn', text: 'Mở mục cọc từ chi tiết đơn dịch vụ.', action: back });
  let view;
  try {
    view = await get(ctx, depositPath(id));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      if (!ctx.stale()) ui.clearToasts();
      return ui.empty({ title: 'Không tìm thấy đơn', text: 'Đơn không tồn tại hoặc không thuộc tài khoản này.', action: back });
    }
    throw error;
  }
  const { snapshot, permissions, vietqrExample, htxCallConfirmation, deposit } = view;
  const form = permissions.canReport ? apiForm({
    fields: [ui.field({ label: 'Mã tham chiếu', input: ui.input({ name: 'reference', maxlength: 64 }), hint: '4-64 ký tự: chữ không dấu, số, dấu chấm, gạch ngang hoặc gạch dưới.' })],
    submitLabel: 'Báo đã chuyển cọc',
    async run(values) {
      const reference = String(values.get('reference') ?? '').trim();
      if (!/^[A-Za-z0-9._-]{4,64}$/.test(reference)) throw new Error('Nhập mã tham chiếu hợp lệ (4-64 ký tự).');
      return post(ctx, depositPath(id), { reference });
    },
    onDone: () => ctx.rerender(),
  }) : null;
  return h('div', { class: 'stack' },
    ui.screenHead({ title: 'Cọc ngoài hệ thống', actions: [back] }),
    ui.note({ tone: 'info', text: 'Ứng dụng chỉ ghi nhận xác nhận của hai bên. Không giữ tiền, không kiểm tra giao dịch ngân hàng.' }),
    ui.card({ title: 'Tình trạng cọc', body: h('div', { class: 'stack-sm' },
      status(view),
      ui.kv([
        ['Mức cọc giả định', `${snapshot.depositRatePercent}% (${money(snapshot.expectedDepositVnd)})`],
        deposit ? ['Số tiền đã báo', money(deposit.amountVnd)] : null,
        expiryLabel(view.expiresAt),
        htxCallConfirmation?.confirmed ? ['Cuộc gọi', 'HTX đã xác nhận'] : null,
      ]),
      deposit?.status === 'CONFIRMED' ? h('p', { class: 'muted' }, 'Khoản cọc đã xác nhận được trừ khi quyết toán.') : null,
      permissions.blockReason && !deposit?.confirmedAt ? h('p', { class: 'muted' }, blocked[permissions.blockReason] || 'Hiện chưa thể ghi nhận cọc.') : null,
      !form && !deposit && !permissions.blockReason ? h('p', { class: 'muted' }, 'Tài khoản này không thể báo chuyển cọc cho đơn.') : null,
    ) }),
    form && !vietqrExample ? vietqrCard(ctx, id) : null,
    vietqrExample?.simulated && vietqrExample.transferCapable === false && !deposit && permissions.canReport ? ui.card({
      title: 'Thông tin VietQR mô phỏng',
      subtitle: 'Không dùng để chuyển tiền.',
      body: ui.kv([['Số tiền minh họa', money(vietqrExample.amountVnd)], ['Mã tham chiếu mẫu', vietqrExample.suggestedReference]]),
    }) : null,
    form ? ui.card({ title: 'Báo chuyển cọc', body: form }) : null);
}

export async function coopDepositCallCard(ctx, packageId) {
  let view;
  try {
    view = await get(ctx, callPath(packageId));
  } catch (error) {
    return ui.card({ title: 'Cuộc gọi xác nhận cọc', body: loadError(ctx, error) });
  }
  return ui.card({ title: 'Cuộc gọi xác nhận cọc', body: view.confirmed
    ? h('p', null, 'HTX đã xác nhận cuộc gọi')
    : view.canConfirm
      ? apiButton({
        label: 'Ghi nhận đã gọi',
        hint: 'Chỉ ghi nhận sau khi đã gọi xác nhận với các bên.',
        run: () => post(ctx, callPath(packageId), {}),
        onDone: () => ctx.rerender(),
      })
      : h('p', { class: 'muted' }, 'Gói này chưa thể ghi nhận cuộc gọi.') });
}

export async function providerDepositList(ctx, bookingIds) {
  const rows = await Promise.all(bookingIds.map(async (id, index) => {
    let view;
    try {
      view = await get(ctx, depositPath(id));
    } catch (error) {
      return h('div', { class: 'stack-sm' }, h('strong', null, `Đơn ${index + 1}`), loadError(ctx, error));
    }
    return h('div', { class: 'stack-sm' },
      h('strong', null, `Đơn ${index + 1}`),
      status(view),
      view.deposit ? h('p', null, `Số tiền đã báo: ${money(view.deposit.amountVnd)}`) : null,
      view.permissions.blockReason && view.deposit?.status !== 'CONFIRMED'
        ? h('p', { class: 'muted' }, blocked[view.permissions.blockReason] || 'Hiện chưa thể ghi nhận cọc.') : null,
      view.permissions.canConfirm ? apiButton({
        label: 'Xác nhận đã nhận cọc', kind: 'secondary',
        confirm: { title: 'Xác nhận khoản cọc', text: 'Chỉ xác nhận nếu đã đối chiếu và nhận đúng số tiền ngoài ứng dụng.' },
        run: () => post(ctx, `/api/deposits/${view.deposit.id}/confirm`, {}),
        onDone: () => ctx.rerender(),
      }) : null);
  }));
  return ui.card({
    title: 'Cọc ngoài hệ thống',
    subtitle: 'Bản ghi của hai bên, không phải xác nhận từ ngân hàng.',
    body: ui.list(rows),
  });
}
