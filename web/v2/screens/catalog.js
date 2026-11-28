// Màn công khai C-05 (danh mục dịch vụ) và C-06 (chi tiết dịch vụ). Đọc API công khai, không cần đăng nhập.
// Khách bấm đặt thì sang C-01 kèm đích quay lại là chính chi tiết này.
import { ApiError } from '../../api.js';
import { ui } from '../kit/ui.js';
import { url } from '../app/routes.js';

const h = ui.h;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICE_LABEL = { synthetic: 'Giá mô phỏng', 'real-labelled': 'Giá đã gắn nhãn dữ liệu thật' };

function price(service) {
  const n = Number(service.pricePerHaVnd);
  return Number.isFinite(n) ? `${ui.fmt.vnd(n)}/ha` : 'Chưa có giá';
}

function authButtons(next) {
  return h('div', { class: 'stack-sm' },
    ui.button({ label: 'Đăng nhập', kind: 'primary', size: 'lg', block: true, href: url('chung', 'C-01', { tiep: next }) }),
    ui.button({ label: 'Tạo tài khoản', block: true, href: url('chung', 'C-01', { buoc: 'dang-ky', tiep: next }) }));
}

// The shared network message talks about orders being saved; these screens only read, so say that instead.
function offline(ctx) {
  if (!ctx.stale()) ui.clearToasts();
  return ui.errorState({ title: 'Chưa tải được màn này', text: 'Không kết nối được máy chủ. Kiểm tra mạng rồi bấm Thử lại.', retry: () => ctx.rerender() });
}
const isOffline = (error) => error instanceof ApiError && (error.code === 'NETWORK' || error.code === 'TIMEOUT');

async function catalog(ctx) {
  let data;
  try {
    ({ data } = await ctx.api.request('GET', '/api/services?limit=100&offset=0'));
  } catch (error) {
    if (isOffline(error)) return offline(ctx);
    throw error;
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return ui.empty({ icon: 'tractor', title: 'Chưa có dịch vụ nào đang mở', text: 'Danh mục sẽ hiện ở đây khi có dịch vụ được mở.' });
  const list = ui.list(items.map((s) => ui.listItem({
    title: s.name,
    meta: `${price(s)}${PRICE_LABEL[s.dataLabel] ? `. ${PRICE_LABEL[s.dataLabel]}` : ''}`,
    icon: 'tractor',
    href: url('chung', 'C-06', { id: s.id }),
  })));
  list.classList.add('list--grid');
  return h('div', { class: 'stack service-catalog' },
    h('p', { class: 'muted' }, 'Chọn một dịch vụ để xem chi tiết. Bạn cần đăng nhập khi đặt dịch vụ.'),
    list,
    ctx.session.isSignedIn() ? null : authButtons(null));
}

async function detail(ctx) {
  const id = UUID.test(ctx.params.id || '') ? ctx.params.id.toLowerCase() : null;
  const missing = ui.empty({ icon: 'question', title: 'Không tìm thấy dịch vụ', text: 'Dịch vụ này không tồn tại hoặc đã ngừng mở.' });
  if (!id) {
    if (!ctx.stale()) ui.clearToasts();
    return missing;
  }
  let service;
  try {
    ({ data: { service } } = await ctx.api.request('GET', `/api/services/${id}`));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      if (!ctx.stale()) ui.clearToasts();
      return missing;
    }
    if (isOffline(error)) return offline(ctx);
    throw error;
  }
  const here = `/chung/C-06?id=${service.id}`;
  let order;
  if (!ctx.session.isSignedIn()) order = authButtons(here);
  else if (ctx.user?.roles?.includes('farmer')) order = ui.button({ label: 'Đặt dịch vụ này', kind: 'primary', size: 'lg', block: true, icon: 'tractor', href: url('nong-dan', 'F-05', { service: service.id }) });
  else order = ui.banner({ tone: 'info', title: 'Đặt dịch vụ cần vai trò nông dân', text: 'Xin thêm vai trò ở mục Tài khoản.', action: ui.button({ label: 'Tài khoản và vai trò', href: url('chung', 'C-02') }) });
  return h('div', { class: 'stack service-catalog' },
    ui.card({ title: service.name, body: h('div', { class: 'stack-sm' },
      h('dl', { class: 'catalog-price' },
        h('div', null, h('dt', { class: 'small muted' }, 'Đơn giá'), h('dd', { class: 'catalog-price__amount' }, price(service))),
        h('div', null, h('dt', { class: 'small muted' }, 'Nguồn giá'), h('dd', null, PRICE_LABEL[service.dataLabel] || 'Chưa ghi nhãn'))),
      h('p', { class: 'small muted' }, 'Nền tảng không giữ hay chuyển tiền. Việc đặt dịch vụ chỉ tạo đơn, chưa thỏa thuận giá hay điều máy.')) }),
    order);
}

export const screens = [
  { code: 'C-05', title: 'Danh mục dịch vụ', render: catalog },
  { code: 'C-06', title: 'Chi tiết dịch vụ', render: detail, back: { href: url('chung', 'C-05'), label: 'Quay lại danh mục dịch vụ' } },
];
