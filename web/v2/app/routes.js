// Route table for the product UI. Pure data and functions, no DOM, so node tests import it directly.
/* global URLSearchParams */
// Hash format follows demo v2: #/<role-slug>/<SCREEN-CODE>?key=value

export const ROLES = [
  { slug: 'chung', name: 'Chung', frame: 'mobile', apiRole: null },
  { slug: 'nong-dan', name: 'Nông dân', frame: 'mobile', apiRole: 'farmer' },
  { slug: 'chu-may', name: 'Chủ máy', frame: 'tablet', apiRole: 'provider' },
  { slug: 'tho-lai', name: 'Thợ lái', frame: 'mobile', apiRole: 'operator' },
  { slug: 'htx', name: 'HTX điều phối', frame: 'desk', apiRole: 'coop' },
  { slug: 'quan-tri', name: 'Quản trị nền tảng', frame: 'desk', apiRole: 'admin' },
];

// Tab order from demo v2 screens.js NAV. [label, icon, code, child codes]. Items whose screen is not built are hidden.
export const NAV = {
  'nong-dan': [['Trang chính', 'house', 'F-01'], ['Thửa ruộng', 'map-trifold', 'F-02', ['F-03', 'F-04']], ['Đơn', 'clipboard-text', 'F-07', ['F-05', 'F-06', 'F-08', 'F-09', 'F-10', 'F-11', 'F-12', 'F-13', 'F-14', 'F-15']], ['Tài khoản', 'user', 'C-02', ['C-03']]],
  'tho-lai': [['Ca hôm nay', 'tractor', 'O-01', ['O-02', 'O-07']], ['Tìm việc', 'magnifying-glass', 'O-03', ['O-04', 'O-05']], ['Đơn của tôi', 'handshake', 'O-06'], ['Hồ sơ', 'identification-card', 'O-08'], ['Tài khoản', 'user', 'C-02', ['C-03']]],
  'chu-may': [['Gói việc', 'package', 'P-01', ['P-02', 'P-03']], ['Ca máy', 'tractor', 'P-06'], ['Tiền', 'hand-coins', 'P-07', ['P-10']], ['Đội máy', 'wrench', 'P-04'], ['Thợ', 'users', 'P-05'], ['Tuyển thợ', 'megaphone', 'P-08', ['P-09']], ['Tài khoản', 'user', 'C-02', ['C-03']]],
  htx: [['Tổng quan', 'squares-four', 'H-01'], ['Hàng chờ', 'list-checks', 'H-02', ['H-04']], ['Gom cụm', 'map-trifold', 'H-03', ['H-05']], ['Hiện trường', 'binoculars', 'H-06'], ['Sự cố', 'cloud-rain', 'H-07'], ['Hòa giải', 'scales', 'H-08', ['H-09']], ['Tài khoản', 'user', 'C-02', ['C-03']]],
  'quan-tri': [['Duyệt hồ sơ', 'seal-check', 'A-01'], ['Trọng tài', 'gavel', 'A-03'], ['Tuân thủ', 'shield-check', 'A-05'], ['Địa bàn HTX', 'map-pin', 'A-02'], ['Tham số', 'gear', 'A-04'], ['Báo cáo tin', 'flag', 'A-06'], ['Tài khoản', 'user', 'C-02', ['C-03']]],
  chung: [],
};

const ROLE_BY_SLUG = Object.fromEntries(ROLES.map((r) => [r.slug, r]));
const SLUG_BY_API_ROLE = Object.fromEntries(ROLES.filter((r) => r.apiRole).map((r) => [r.apiRole, r.slug]));
// Landing order when an account holds several roles: the most operational role first.
const ROLE_PRIORITY = ['admin', 'coop', 'provider', 'operator', 'farmer'];
const CODE = /^[CFPOHA]-\d{2}$/;
const PARAM_KEY = /^[a-z][a-z0-9-]{0,23}$/;

export function roleBySlug(slug) {
  return Object.hasOwn(ROLE_BY_SLUG, slug) ? ROLE_BY_SLUG[slug] : null;
}

export function slugForApiRole(apiRole) {
  return Object.hasOwn(SLUG_BY_API_ROLE, apiRole) ? SLUG_BY_API_ROLE[apiRole] : null;
}

export function url(roleSlug, code, params) {
  const query = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString() : '';
  return `#/${roleSlug}/${code}${query ? `?${query}` : ''}`;
}

// Returns { kind: 'home' } | { kind: 'role', role } | { kind: 'screen', role, code, params } | { kind: 'notfound', reason }.
export function parseHash(hash) {
  const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const params = {};
  if (q >= 0) {
    for (const [key, value] of new URLSearchParams(raw.slice(q + 1))) {
      // Login carries an already serialized in-app URL, not a single field value.
      const limit = key === 'tiep' ? 2048 : 200;
      if (PARAM_KEY.test(key) && value.length <= limit && !Object.hasOwn(params, key)) params[key] = value;
    }
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home' };
  const role = roleBySlug(parts[0]);
  if (!role) return { kind: 'notfound', reason: 'Không có vai trò này' };
  if (parts.length === 1) return { kind: 'role', role };
  const code = parts[1].toUpperCase();
  if (parts.length > 2 || !CODE.test(code)) return { kind: 'notfound', reason: 'Đường dẫn không đúng dạng' };
  return { kind: 'screen', role, code, params };
}

// Screen codes belong to one role by their first letter, except C-02 and C-03 which every signed-in role can open.
export function codeAllowedInRole(code, roleSlug) {
  if (code === 'C-02' || code === 'C-03') return true;
  const letter = { chung: 'C', 'nong-dan': 'F', 'chu-may': 'P', 'tho-lai': 'O', htx: 'H', 'quan-tri': 'A' }[roleSlug];
  return code.charAt(0) === letter;
}

export function homeSlugFor(user) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  const top = ROLE_PRIORITY.find((r) => roles.includes(r));
  return top ? slugForApiRole(top) : null;
}

// Nav items for a role, keeping only screens that exist in `built` (a Set of codes).
export function navFor(roleSlug, currentCode, built) {
  return (NAV[roleSlug] || [])
    .filter(([, , code]) => built.has(code))
    .map(([label, icon, code, children = []]) => ({ label, icon, code, href: url(roleSlug, code), current: code === currentCode || children.includes(currentCode) }));
}
