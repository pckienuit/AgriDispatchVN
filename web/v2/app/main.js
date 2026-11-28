// Product UI shell: hash router, role frames, session and API wiring. Screens come from ../screens/*.js.
// Restore the user from the same-origin HttpOnly session cookie before routing.
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
const PUBLIC = new Set(['C-01', 'C-04', 'C-05', 'C-06']);

const session = { user: null, timer: null };
const api = createApiClient({
  useSessionCookie: true,
  onUnauthorized: () => {
    if (session.user) signOut('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  },
});

function signIn(data) {
  session.user = data.user;
  globalThis.clearTimeout(session.timer);
  const left = Date.parse(data.expiresAt) - Date.now();
  if (left > 0 && left < 2 ** 31) session.timer = globalThis.setTimeout(() => signOut('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'), left);
}

function signOut(message) {
  session.user = null;
  globalThis.clearTimeout(session.timer);
  if (message) ui.toast(message, 'error');
  loc.hash = url('chung', 'C-01');
}

async function logout() {
  try {
    await api.request('POST', '/api/auth/logout', { auth: true });
  } catch (error) {
    if (error.status !== 401) {
      ui.toast(errorText(error), 'error');
      return;
    }
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

function frame(route, screen, body, action) {
  const role = route.role;
  const code = screen?.code;
  const nav = navFor(role.slug, code, built);
  const current = nav.find((n) => n.current);
  const isRoot = Boolean(current && current.code === code);
  const back = screen?.back ?? (nav.length
    ? (isRoot ? null : { href: (current || nav[0]).href })
    : (session.user && code !== 'C-02' ? { href: homeHash(), label: 'Về trang chính' } : null));
  const title = role.frame === 'mobile' ? screen?.title || 'Không tìm thấy' : null;
  const who = session.user && code !== 'C-02' ? h('a', {
    class: 'btn btn--ghost shell-account', href: url(role.slug, 'C-02'), 'aria-label': 'Tài khoản', title: session.user.name,
  }, ui.icon('user')) : null;
  const desktopNav = role.slug === 'chung' ? [
    { href: '/landing/', label: 'Giới thiệu' },
    { href: url('chung', 'C-05'), label: 'Danh mục dịch vụ', current: code === 'C-05' || code === 'C-06' },
  ] : nav;
  return ui.deskFrame({ size: role.frame, title, back, nav: desktopNav, tabs: nav, who, body, action, isRoot,
    brand: 'AgriDispatch VN', focused: ['C-01', 'C-04', 'C-06'].includes(code) });
}

let seq = 0;
let lastHash = null;

function makeCtx(route, screen, mySeq) {
  let actionNode = null;
  const hash = loc.hash;
  const ctx = {
    code: screen.code,
    role: route.role,
    params: route.params || {},
    api,
    ui,
    h,
    user: session.user,
    built,
    session: { signIn, signOut, logout, refreshUser, homeHash, isSignedIn: () => Boolean(session.user) },
    url,
    go: (hash) => { loc.hash = hash; },
    rerender: () => { if (mySeq === seq) render(true); },
    stale: () => mySeq !== seq || loc.hash !== hash,
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

function paint(node, focusMain, restoreKey, { loading = false } = {}) {
  if (focusMain && !loading) node.querySelector('main')?.classList.add('route-enter');
  if (focusMain) globalThis.scrollTo(0, 0);
  mount.replaceChildren(node);
  if (restoreKey && restoreFocus(restoreKey)) return;
  if (focusMain) {
    const main = doc.getElementById('main');
    const heading = node.querySelector('h1[tabindex="-1"]');
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
    loc.replace(session.user ? homeHash() : url('chung', 'C-01'));
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
  if (!PUBLIC.has(route.code) && !session.user) {
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
  let loadingShown = false;
  try {
    const out = screen.render(ctx);
    if (out && typeof out.then === 'function') {
      if (!keepFocus) {
        paint(frame(route, screen, ui.loading('Đang tải dữ liệu từ máy chủ'), null), focusMain, null, { loading: true });
        loadingShown = true;
      }
      body = await out;
      if (ctx.stale()) return;
    } else body = out;
  } catch (error) {
    if (ctx.stale()) return;
    ui.clearToasts();
    body = ui.errorState({ title: 'Chưa tải được màn này', text: errorText(error), retry: () => render(true) });
  } finally {
    if (loadingShown && mySeq === seq) ui.dispose();
  }
  if (ctx.stale()) return;
  paint(frame(route, screen, body, ctx.getAction()), focusMain, restoreKey);
  currentRouteKey = routeKey;
  ctx.mounted = true;
}

export { render };
globalThis.addEventListener('offline', () => ui.toast('Mất kết nối mạng. Thao tác chưa được gửi; thử lại khi có mạng.', 'error'));
async function start() {
  try {
    const { data } = await api.request('GET', '/api/me', { headers: { Prefer: 'anonymous' } });
    if (data) signIn(data);
  } catch (error) {
    if (error.status !== 401) throw error;
  }
  globalThis.addEventListener('hashchange', () => render(false));
  await render(false);
}
start().catch((error) => {
  mount.replaceChildren(ui.errorState({ title: 'Không mở được ứng dụng', text: errorText(error) }));
});
