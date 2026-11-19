// Màn chung C-01 đến C-04 trên API thật. Bố cục theo demo v2 demo/app/common.js; đăng nhập bằng số điện thoại và
// mật khẩu theo quyết định D4, không gửi OTP.
import { ui } from '../kit/ui.js';
import { apiButton, apiForm } from '../app/actions.js';
import { NAV, ROLES, homeSlugFor, slugForApiRole, url } from '../app/routes.js';

const h = ui.h;

const ROLE_INFO = {
  farmer: { name: 'Nông dân', desc: 'Khai báo thửa, đặt dịch vụ gặt, xác nhận ruộng, nghiệm thu.' },
  provider: { name: 'Chủ máy', desc: 'Nhận gói việc, quản lý máy và thợ, tuyển thợ, ghi nhận tiền.' },
  operator: { name: 'Thợ lái', desc: 'Tìm việc, ứng tuyển, chạy ca máy được giao.' },
  coop: { name: 'HTX điều phối', desc: 'Nhận ủy quyền, gom đơn thành gói, theo dõi hiện trường.' },
  admin: { name: 'Quản trị nền tảng', desc: 'Duyệt vai trò, phân công hòa giải độc lập.' },
};
const ROLE_ICON = { farmer: 'plant', provider: 'tractor', operator: 'identification-card', coop: 'users-three', admin: 'shield-check' };
const REQUESTABLE = ['provider', 'operator', 'coop'];
const REQUEST_STATUS = { PENDING: ['Chờ duyệt', 'idle'], APPROVED: ['Đã duyệt', 'ok'], REJECTED: ['Bị từ chối', 'error'] };

function safeNext(value) {
  // Only internal v2 routes are accepted as a return target.
  return typeof value === 'string' && /^\/[a-z-]+\/[A-Z]-\d{2}(\?[\w=&%.-]*)?$/.test(value) ? `#${value}` : null;
}

function passwordInput(autocomplete) {
  return ui.input({ type: 'password', name: 'password', autocomplete, maxlength: 128 });
}

/* ---------- C-01 ---------- */
function login(ctx) {
  const register = ctx.params.buoc === 'dang-ky';
  const next = safeNext(ctx.params.tiep);
  if (ctx.session.isSignedIn()) {
    return h('div', { class: 'stack' },
      ui.banner({ tone: 'success', title: 'Bạn đang đăng nhập', text: `Tài khoản ${ctx.user.name}.` }),
      ui.button({ label: 'Về trang chính', kind: 'primary', size: 'lg', block: true, href: next || ctx.session.homeHash() }));
  }
  const phone = ui.input({ type: register ? 'tel' : 'text', inputmode: register ? 'tel' : null, name: 'phone', autocomplete: register ? 'tel' : 'username', maxlength: 254 });
  const name = ui.input({ name: 'name', autocomplete: 'name', maxlength: 120 });
  const password = passwordInput(register ? 'new-password' : 'current-password');
  const fields = [
    h('p', null, register ? 'Tạo tài khoản bằng số điện thoại. Tài khoản mới có vai trò nông dân; vai trò khác xin thêm sau khi đăng nhập.' : 'Đăng nhập bằng số điện thoại và mật khẩu.'),
    ui.field({ label: 'Số điện thoại', hint: register ? 'Ví dụ 0901 234 567' : 'Ví dụ 0901 234 567. Tài khoản cũ tạo bằng email thì nhập email.', input: phone, required: true }),
    register ? ui.field({ label: 'Họ và tên', input: name, required: true }) : null,
    ui.field({ label: 'Mật khẩu', hint: register ? 'Ít nhất 12 ký tự.' : null, input: password, required: true }),
  ];
  const form = apiForm({
    fields,
    submitLabel: register ? 'Tạo tài khoản' : 'Đăng nhập',
    async run(data) {
      const phoneValue = String(data.get('phone') || '').trim();
      const pass = String(data.get('password') || '');
      if (!phoneValue) throw new Error('Nhập số điện thoại.');
      if (register) {
        const nameValue = String(data.get('name') || '').trim();
        if (!nameValue) throw new Error('Nhập họ và tên.');
        if ([...pass].length < 12) throw new Error('Mật khẩu cần ít nhất 12 ký tự.');
        await ctx.api.request('POST', '/api/auth/register', { body: { phone: phoneValue, password: pass, name: nameValue } });
      } else if (!pass) throw new Error('Nhập mật khẩu.');
      // Accounts created before phone sign-in still use their email as the identifier.
      const id = !register && phoneValue.includes('@') ? { email: phoneValue } : { phone: phoneValue };
      const { data: sessionData } = await ctx.api.request('POST', '/api/auth/login', { body: { ...id, password: pass } });
      return sessionData;
    },
    onDone(sessionData) {
      ctx.session.signIn(sessionData);
      ctx.toast(register ? 'Đã tạo tài khoản và đăng nhập' : 'Đăng nhập thành công', 'ok');
      ctx.go(next || ctx.session.homeHash());
    },
  });
  return h('div', { class: 'stack' },
    h('p', { class: 'row row--nowrap' }, ui.icon('plant'), h('strong', null, 'AgriDispatch VN'), h('span', { class: 'muted small' }, 'Điều phối máy gặt ĐBSCL')),
    form,
    h('p', { class: 'small muted' }, 'Bản thử nghiệm chưa gửi mã OTP qua tin nhắn. Mật khẩu chỉ gửi tới máy chủ của hệ thống.'),
    register
      ? ui.button({ label: 'Đã có tài khoản? Đăng nhập', kind: 'ghost', block: true, href: url('chung', 'C-01', { tiep: ctx.params.tiep }) })
      : ui.button({ label: 'Chưa có tài khoản? Tạo tài khoản', kind: 'ghost', block: true, href: url('chung', 'C-01', { buoc: 'dang-ky', tiep: ctx.params.tiep }) }));
}

/* ---------- C-02 ---------- */
function roleHome(slug) {
  const first = (NAV[slug] || [])[0];
  return first ? url(slug, first[2]) : null;
}

async function account(ctx) {
  const user = await ctx.session.refreshUser();
  const { data } = await ctx.api.request('GET', '/api/role-requests?limit=20&offset=0', { auth: true });
  const requests = Array.isArray(data?.items) ? data.items : [];
  const pending = new Set(requests.filter((r) => r.status === 'PENDING').map((r) => r.role));
  const roles = ROLES.filter((r) => r.apiRole && user.roles.includes(r.apiRole));

  const themeSeg = ui.segmented({
    label: 'Giao diện', value: ui.theme.get(),
    items: [{ value: 'light', label: 'Sáng' }, { value: 'auto', label: 'Tự động' }, { value: 'dark', label: 'Tối' }],
    onChange(v) { ui.theme.set(v); ctx.rerender(); },
  });

  const canRequest = REQUESTABLE.filter((r) => !user.roles.includes(r) && !pending.has(r));
  let picked = canRequest[0] || null;

  ctx.setAction(ui.actionBar({
    info: user.name,
    actions: [apiButton({ label: 'Đăng xuất', kind: 'secondary', run: () => ctx.session.logout() })],
  }));

  return h('div', { class: 'stack' },
    ui.card({ title: 'Tài khoản', body: ui.kv([
      ['Họ và tên', user.name],
      user.phone ? ['Số điện thoại', user.phone] : null,
      user.email ? ['Email', user.email] : null,
    ]) }),
    ui.card({ title: 'Vai trò đang có', subtitle: 'Chọn vai trò để mở màn làm việc tương ứng.', body: ui.list(roles.map((r) => ui.listItem({ title: ROLE_INFO[r.apiRole].name, meta: ROLE_INFO[r.apiRole].desc, href: roleHome(r.slug), icon: ROLE_ICON[r.apiRole] }))) }),
    ui.card({ title: 'Xin thêm vai trò', subtitle: 'Quản trị nền tảng duyệt từng yêu cầu. Chưa có bước kiểm giấy tờ.', body: canRequest.length
      ? h('div', { class: 'stack-sm' },
        ui.choices({ name: 'role', label: 'Vai trò muốn xin', value: picked, options: canRequest.map((r) => ({ value: r, label: ROLE_INFO[r].name, desc: ROLE_INFO[r].desc })), onChange(v) { picked = v; } }),
        apiButton({ label: 'Gửi yêu cầu', icon: 'paper-plane-tilt', run: () => ctx.api.request('POST', '/api/role-requests', { auth: true, body: { role: picked } }), okText: 'Đã gửi yêu cầu, chờ quản trị duyệt', onDone: () => ctx.rerender() }))
      : h('p', { class: 'muted' }, pending.size ? 'Bạn đang có yêu cầu chờ duyệt.' : 'Bạn đã có đủ các vai trò có thể xin.') }),
    requests.length ? ui.card({ title: 'Lịch sử yêu cầu vai trò', body: ui.list(requests.map((r) => h('div', { class: 'row row--between' },
      h('div', null, h('div', null, ROLE_INFO[r.role]?.name || r.role), h('div', { class: 'small muted' }, ui.fmt.dateTime(Date.parse(r.createdAt))), r.decisionReason ? h('div', { class: 'small' }, `Lý do: ${r.decisionReason}`) : null),
      ui.badge(...(REQUEST_STATUS[r.status] || [r.status, 'outline']))))) }) : null,
    ui.card({ title: 'Hiển thị', body: ui.field({ label: 'Giao diện', input: themeSeg }) }),
    ui.link('Hoạt động gần đây', url(ctx.role.slug === 'chung' ? (slugForApiRole(homeSlugFor(user)) || 'nong-dan') : ctx.role.slug, 'C-03'), 'bell'));
}

/* ---------- C-03 ---------- */
// Feed links point at cloud-UI routes (#booking/<id>); map them to the v2 screen for the role being viewed.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET = {
  booking: { 'nong-dan': 'F-07' },
  job: { 'chu-may': 'P-09', 'tho-lai': 'O-04' },
  shift: { 'tho-lai': 'O-01', 'chu-may': 'P-06', htx: 'H-06' },
  dispute: { 'nong-dan': 'F-13', 'chu-may': 'P-10', htx: 'H-07', 'quan-tri': 'A-03' },
};
export function v2LinkFor(href, roleSlug, built) {
  const m = /^#(booking|job|shift|dispute)\/(.+)$/.exec(href || '');
  if (!m || !UUID.test(m[2])) return null;
  const code = TARGET[m[1]][roleSlug];
  return code && built.has(code) ? url(roleSlug, code, { id: m[2].toLowerCase() }) : null;
}

async function activity(ctx) {
  const offset = Math.max(0, Math.min(10000, Number.parseInt(ctx.params.tu || '0', 10) || 0));
  const { data } = await ctx.api.request('GET', `/api/activity?limit=20&offset=${offset}`, { auth: true });
  const items = Array.isArray(data?.items) ? data.items : [];
  const roleSlug = ctx.role.slug;
  const pager = h('div', { class: 'btn-row' },
    offset > 0 ? ui.button({ label: 'Mới hơn', icon: 'arrow-left', href: url(roleSlug, 'C-03', { tu: Math.max(0, offset - 20) || null }) }) : null,
    items.length === 20 ? ui.button({ label: 'Cũ hơn', icon: 'arrow-right', href: url(roleSlug, 'C-03', { tu: offset + 20 }) }) : null);
  if (!items.length) return ui.empty({ icon: 'bell', title: offset ? 'Không còn hoạt động cũ hơn' : 'Chưa có hoạt động', text: 'Khi đơn, ca máy, tin tuyển hay khiếu nại của bạn đổi trạng thái, dòng hoạt động sẽ hiện ở đây.', action: offset ? pager : null });
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'Danh sách ghi lại thay đổi trên các việc của bạn. Hệ thống chưa gửi Zalo hay tin nhắn.'),
    ui.list(items.map((it) => {
      const href = v2LinkFor(it.href, roleSlug, ctx.built);
      return ui.listItem({ title: it.text, meta: ui.fmt.dateTime(Date.parse(it.createdAt)), href, icon: 'bell' });
    })),
    pager);
}

/* ---------- C-04 ---------- */
function errorPage(ctx) {
  const denied = ctx.params.loai === 'khong-co-quyen';
  const signedIn = ctx.session.isSignedIn();
  const reason = ctx.params.ly_do ? `${ctx.params.ly_do}. ` : '';
  return h('div', { class: 'stack' },
    ui.empty({
      icon: denied ? 'lock' : 'question',
      title: denied ? 'Tài khoản chưa có quyền xem nội dung này' : 'Không tìm thấy trang này',
      text: denied ? 'Màn này thuộc vai trò khác. Xin thêm vai trò ở mục Tài khoản, hoặc đăng nhập đúng tài khoản.' : `${reason}Đường dẫn có thể đã đổi hoặc bị gõ sai.`,
      action: h('div', { class: 'btn-row' },
        signedIn ? ui.button({ label: 'Về trang chính', kind: 'primary', href: ctx.session.homeHash() }) : ui.button({ label: 'Đăng nhập', kind: 'primary', href: url('chung', 'C-01') }),
        signedIn && denied ? ui.button({ label: 'Tài khoản và vai trò', href: url('chung', 'C-02') }) : null),
    }));
}

export const screens = [
  { code: 'C-01', title: 'Đăng nhập', render: login },
  { code: 'C-02', title: 'Tài khoản và vai trò', render: account },
  { code: 'C-03', title: 'Hoạt động gần đây', render: activity },
  { code: 'C-04', title: 'Không mở được trang', render: errorPage },
];

