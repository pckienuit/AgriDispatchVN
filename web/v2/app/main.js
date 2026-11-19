// Product UI shell: hash router, role frames, session and API wiring. Screens come from ../screens/*.js.
// Session token lives only in module memory (same rule as the cloud UI): reloading the page signs out.
import { createApiClient } from '../../api.js';
import { ui } from '../kit/ui.js';
import { ROLES, codeAllowedInRole, homeSlugFor, navFor, parseHash, url } from './routes.js';
import { errorText } from './actions.js';
import { registry } from './registry.js';

const doc = globalThis.document;
const loc = globalThis.location;
const h = ui.h;
const mount = doc.getElementById('app');

const built = new Set(registry.keys());
const PUBLIC = new Set(['C-01', 'C-04']);

const session = { token: null, user: null, expiresAt: null, timer: null };
const api = createApiClient({
  getToken: () => session.token,
  onUnauthorized: () => {
    if (session.token) signOut('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  },
});

function signIn(data) {
  session.token = data.token;
  session.user = data.user;
  session.expiresAt = data.expiresAt;
  globalThis.clearTimeout(session.timer);
  const left = Date.parse(data.expiresAt) - Date.now();
  if (left > 0 && left < 2 ** 31) session.timer = globalThis.setTimeout(() => signOut('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'), left);
}

function signOut(message) {
  session.token = null;
  session.user = null;
  session.expiresAt = null;
  globalThis.clearTimeout(session.timer);
  if (message) ui.toast(message, 'error');
  loc.hash = url('chung', 'C-01');
}

async function logout() {
  try {
    await api.request('POST', '/api/auth/logout', { auth: true });
  } catch {
    // Local sign-out still happens; the server session expires on its own.
  }
  signOut();
}

// Reload the signed-in user (roles change after an admin approves a role request).
async function refreshUser() {
  const { data } = await api.request('GET', '/api/me', { auth: true });
  session.user = data.user;
  return data.user;
}

function homeHash() {
  const slug = homeSlugFor(session.user);
  if (!slug) return url('chung', 'C-02');
  const first = navFor(slug, null, built)[0];
  return first ? first.href : url('chung', 'C-02');
}

function whoLabel(role) {
  if (!session.user) return role.name;
  const id = session.user.phone || session.user.email || '';
  return h('span', { class: 'row row--nowrap' },
    h('span', null, `${role.name}: ${session.user.name}`),
    id ? h('span', { class: 'muted small' }, id) : null);
}

function frame(route, screen, body, action) {
  const role = route.role;
  const nav = navFor(role.slug, screen?.code, built);
  const current = nav.find((n) => n.current);
  const isRoot = Boolean(current && current.code === screen?.code);
  const back = nav.length ? (isRoot ? null : { href: current ? current.href : nav[0].href, label: 'Quay lại' }) : (session.user ? { href: homeHash(), label: 'Về trang chính' } : null);
  const title = screen ? screen.title : 'Không tìm thấy';
  if (role.frame === 'mobile') return ui.mobileFrame({ title, back, tabs: nav.length ? nav : null, body, action, isRoot });
  return ui.deskFrame({ size: role.frame === 'tablet' ? 'tablet' : 'desk', nav: nav.length ? nav : null, who: whoLabel(role), body, action, isRoot, back, brand: 'AgriDispatch VN' });
}

let seq = 0;
let lastHash = null;

function makeCtx(route, screen, mySeq) {
  let actionNode = null;
  const ctx = {
    code: screen.code,
    role: route.role,
    params: route.params || {},
    api,
    ui,
    h,
    user: session.user,
    built,
    session: { signIn, signOut, logout, refreshUser, homeHash, isSignedIn: () => Boolean(session.token) },
    url,
    go: (hash) => { loc.hash = hash; },
    rerender: () => { if (mySeq === seq) render(true); },
    stale: () => mySeq !== seq,
    toast: ui.toast,
    mounted: false,
    setAction(node) {
      const old = actionNode;
      actionNode = node || null;
      if (!ctx.mounted || old === actionNode) return;
      if (old && old.parentNode && actionNode) {
        if (old.classList.contains('actionbar--above-tab')) actionNode.classList.add('actionbar--above-tab');
        old.parentNode.replaceChild(actionNode, old);
      } else ctx.rerender();
    },
    getAction: () => actionNode,
  };
  return ctx;
}

let currentRouteKey = null;

function captureFocusKey() {
  const el = doc.activeElement;
  if (!el || el === doc.body || !mount.contains(el)) return null;
  const tag = el.tagName.toLowerCase();
  const id = el.id || '';
  const name = el.getAttribute('name') || '';
  const type = el.getAttribute('type') || '';
  const role = el.getAttribute('role') || '';
  const value = (tag === 'input' && (type === 'radio' || type === 'checkbox')) ? el.value : '';
  const text = (tag === 'button' || tag === 'a') ? (el.textContent || '').trim() : '';

  let index;
  const esc = (s) => (doc.defaultView?.CSS?.escape ? doc.defaultView.CSS.escape(s) : s);
  if (name) {
    const list = Array.from(mount.querySelectorAll(tag + '[name="' + esc(name) + '"]'));
    index = list.indexOf(el);
  } else {
    const list = Array.from(mount.querySelectorAll(tag));
    index = list.indexOf(el);
  }

  return { tag, id, name, type, role, value, text, index };
}

function restoreFocus(key) {
  if (!key) return false;
  let target = null;
  const esc = (s) => (doc.defaultView?.CSS?.escape ? doc.defaultView.CSS.escape(s) : s);
  if (key.id) {
    try {
      target = mount.querySelector('#' + esc(key.id));
    } catch { /* bo qua loi selector */ }
  }
  if (!target && key.name) {
    try {
      const candidates = Array.from(mount.querySelectorAll(key.tag + '[name="' + esc(key.name) + '"]'));
      if (key.value) {
        target = candidates.find((c) => c.value === key.value);
      }
      if (!target && key.index >= 0 && candidates[key.index]) {
        target = candidates[key.index];
      }
      if (!target && candidates.length === 1) {
        target = candidates[0];
      }
    } catch { /* bo qua loi selector */ }
  }
  if (!target && key.role === 'alert') {
    target = mount.querySelector('[role="alert"]:not([hidden])') || mount.querySelector('[role="alert"]');
  }
  if (!target && key.text && (key.tag === 'button' || key.tag === 'a')) {
    const candidates = Array.from(mount.querySelectorAll(key.tag));
    target = candidates.find((c) => (c.textContent || '').trim() === key.text);
  }
  if (!target) {
    const candidates = Array.from(mount.querySelectorAll(key.tag));
    if (key.index >= 0 && candidates[key.index]) {
      target = candidates[key.index];
    }
  }
  if (target && typeof target.focus === 'function') {
    try {
      target.focus({ preventScroll: true });
      return doc.activeElement === target;
    } catch {
      return false;
    }
  }
  return false;
}

function paint(node, focusMain, restoreKey) {
  mount.replaceChildren(node);
  if (restoreKey && restoreFocus(restoreKey)) return;
  if (focusMain) {
    const main = doc.getElementById('main');
    const heading = main && main.querySelector('h1');
    (heading || main)?.focus?.({ preventScroll: true });
  }
}

function deny(route, kind, reason) {
  const screen = registry.get('C-04');
  const r = { ...route, role: ROLES[0], params: { loai: kind, ly_do: reason || '' } };
  const ctx = makeCtx(r, screen, seq);
  return frame(r, screen, screen.render(ctx), null);
}

async function render(keepFocus) {
  const mySeq = ++seq;
  const hash = loc.hash || '';
  const route = parseHash(hash);
  const focusMain = !keepFocus && hash !== lastHash;
  lastHash = hash;

  if (route.kind === 'home') {
    loc.replace(session.token ? homeHash() : url('chung', 'C-01'));
    return;
  }
  if (route.kind === 'role') {
    const first = navFor(route.role.slug, null, built)[0];
    loc.replace(first ? first.href : url('chung', 'C-04', { loai: 'khong-tim-thay' }));
    return;
  }
  if (route.kind === 'notfound') {
    ui.closeOverlays();
    ui.dispose();
    currentRouteKey = null;
    return paint(deny(route, 'khong-tim-thay', route.reason), focusMain);
  }
  const screen = registry.get(route.code);
  if (!screen || !codeAllowedInRole(route.code, route.role.slug)) {
    ui.closeOverlays();
    ui.dispose();
    currentRouteKey = null;
    return paint(deny(route, 'khong-tim-thay', `Màn ${route.code} chưa có trong vai trò ${route.role.name}`), focusMain);
  }
  if (!PUBLIC.has(route.code) && !session.token) {
    loc.replace(url('chung', 'C-01', { tiep: hash.slice(1) }));
    return;
  }
  if (route.role.apiRole && !session.user?.roles?.includes(route.role.apiRole)) {
    ui.closeOverlays();
    ui.dispose();
    currentRouteKey = null;
    return paint(deny(route, 'khong-co-quyen'), focusMain);
  }

  const routeKey = route.role ? `${route.role.slug}:${route.code}` : null;
  const isSameRoute = Boolean(routeKey && routeKey === currentRouteKey);
  const restoreKey = (keepFocus && isSameRoute) ? captureFocusKey() : null;

  ui.closeOverlays();
  ui.dispose();

  const ctx = makeCtx(route, screen, mySeq);
  let body;
  try {
    const out = screen.render(ctx);
    if (out && typeof out.then === 'function') {
      if (!keepFocus) paint(frame(route, screen, ui.loading('Đang tải dữ liệu từ máy chủ'), null), focusMain);
      body = await out;
      if (mySeq !== seq) return;
      if (!keepFocus) ui.dispose();
    } else body = out;
  } catch (error) {
    if (mySeq !== seq) return;
    body = ui.errorState({ title: 'Chưa tải được màn này', text: errorText(error), retry: () => render(true) });
  }
  if (mySeq !== seq) return;
  paint(frame(route, screen, body, ctx.getAction()), focusMain, restoreKey);
  currentRouteKey = routeKey;
  ctx.mounted = true;
}

export { render };
globalThis.addEventListener('hashchange', () => render(false));
globalThis.addEventListener('offline', () => ui.toast('Mất kết nối mạng. Thao tác chưa được gửi; thử lại khi có mạng.', 'error'));
render(false).catch((error) => {
  mount.replaceChildren(ui.errorState({ title: 'Không mở được ứng dụng', text: errorText(error) }));
});
