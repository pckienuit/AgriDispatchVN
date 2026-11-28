/* global document, window, location, matchMedia, IntersectionObserver, AbortSignal */
const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#site-nav');
const header = menu.closest('header');
const mobile = matchMedia('(max-width: 767px)');

function setMenu(open) {
  menu.setAttribute('aria-expanded', String(open));
  menu.querySelector('i').className = open ? 'ph ph-x' : 'ph ph-list';
}

header.classList.add('is-enhanced');
menu.hidden = !mobile.matches;
mobile.addEventListener('change', ({ matches }) => {
  const focus = document.activeElement;
  menu.hidden = !matches;
  setMenu(false);
  if (matches && nav.contains(focus)) menu.focus();
  if (!matches && focus === menu) nav.querySelector('a').focus();
});
menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') === 'false'));
header.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    setMenu(false);
    menu.focus();
  }
});
nav.addEventListener('click', (event) => {
  if (menu.getAttribute('aria-expanded') !== 'true') return;
  const link = event.target.closest('a');
  if (!link) return;
  setMenu(false);
  const target = link.hash && link.pathname === location.pathname ? document.getElementById(link.hash.slice(1)) : null;
  if (target) {
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
});

const motion = matchMedia('(prefers-reduced-motion: no-preference)');
// Match the sketch's two overlapping, eased intervals and its frame-based scroll scrub.
const hero = document.querySelector('[data-hero]');
const inner = hero.querySelector('.hero__inner');
const media = hero.querySelector('.hero__media');
const hint = hero.querySelector('.hero__hint');
const mask = hero.querySelector('.hero__tw');
const white = hero.querySelector('.hero__t--w');
const narrow = matchMedia('(max-width: 900px)');
const clamp = (n) => Math.min(1, Math.max(0, n));
const segment = (p, start, end) => 1 - (1 - clamp((p - start) / (end - start))) ** 2;
const progress = () => clamp(-hero.getBoundingClientRect().top / Math.max(1, hero.offsetHeight - window.innerHeight));
let current = 0;
let frame = 0;

function renderHero(p) {
  const w = inner.clientWidth;
  const h = inner.clientHeight;
  const shrink = narrow.matches ? 0 : segment(p, .585, 1);
  const width = w + (w * .3128 - w) * shrink;
  const height = h * segment(p, .037, .678);
  const radius = 12 + 52 * shrink;
  media.style.width = `${width}px`;
  media.style.height = `${height}px`;
  media.style.borderRadius = `${radius}px`;
  mask.style.clipPath = `inset(${h - height}px 0 0 ${w - width}px round ${radius}px)`;
  white.style.transform = `translateX(${-0.0746 * w * shrink}px)`;
  const opacity = clamp(1 - p / .16);
  hint.style.opacity = opacity;
  hint.inert = opacity < .3;
}

function tick() {
  const target = progress();
  current += (target - current) * .14;
  if (Math.abs(target - current) < .0004) current = target;
  renderHero(current);
  frame = current === target ? 0 : window.requestAnimationFrame(tick);
}

function syncHero() {
  window.cancelAnimationFrame(frame);
  frame = 0;
  hero.classList.toggle('hero--static', !motion.matches);
  current = motion.matches ? progress() : 1;
  renderHero(current);
}

window.addEventListener('scroll', () => {
  if (motion.matches && !frame) frame = window.requestAnimationFrame(tick);
}, { passive: true });
window.addEventListener('resize', syncHero);
motion.addEventListener('change', syncHero);
syncHero();

let observer;
function syncReveals() {
  observer?.disconnect();
  if (!motion.matches || !('IntersectionObserver' in window)) return;
  observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      target.classList.add('is-visible');
      observer.unobserve(target);
    }
  }, { threshold: .12 });
  document.querySelectorAll('[data-reveal]:not(.is-visible)').forEach((node) => observer.observe(node));
}

syncReveals();
motion.addEventListener('change', syncReveals);

const kinds = { harvest: 'harvest', drone: 'drone', tillage: 'tractor' };
const labels = new Map([
  ['synthetic', 'Giá mô phỏng'],
  ['real-labelled', 'Giá đã gắn nhãn dữ liệu thật'],
]);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const currency = new Intl.NumberFormat('vi-VN');
const list = document.querySelector('#service-list');
const status = document.querySelector('#catalog-status');
const catalog = document.querySelector('.catalog');
const filters = document.querySelector('.filters');
const skeleton = document.querySelector('.skeleton');
const retry = document.querySelector('.retry');
let services = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(className) {
  const node = element('i', className);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function readService(row) {
  if (typeof row?.id !== 'string' || !uuid.test(row.id)
    || typeof row.name !== 'string' || !row.name.trim()
    || typeof row.code !== 'string' || !labels.has(row.dataLabel)
    || !(typeof row.pricePerHaVnd === 'string' || Number.isSafeInteger(row.pricePerHaVnd))
    || !/^[0-9]{1,19}$/.test(row.pricePerHaVnd)) throw new Error('Invalid service');
  return { ...row, kind: row.code.split('-', 1)[0] };
}

function serviceItem(service) {
  const item = element('li', 'service');
  const link = element('a', 'service-link');
  link.href = `/v2/#/chung/C-06?id=${encodeURIComponent(service.id)}`;
  const photo = element('span', 'service-pic');
  if (Object.hasOwn(kinds, service.kind)) {
    const img = element('img');
    img.src = `img/${kinds[service.kind]}.webp`;
    img.alt = '';
    img.width = 350;
    img.height = 150;
    img.loading = 'lazy';
    photo.append(img);
  } else {
    photo.append(icon('ph ph-tractor'));
  }
  const title = service.dataLabel === 'synthetic' ? service.name.replace(/ \(giả lập\)$/, '') : service.name;
  const name = element('h3', '', title.replace(/[\u2013\u2014]/g, '-'));
  const price = element('dl', 'service-price');
  price.append(element('dt', '', 'Đơn giá'), element('dd', '', `${currency.format(BigInt(service.pricePerHaVnd))} đ/ha`));
  const badge = element('span', 'service-badge', labels.get(service.dataLabel));
  badge.dataset.label = service.dataLabel;
  link.append(photo, name, price, badge, icon('service-arrow ph ph-arrow-right'));
  item.append(link);
  return item;
}

function renderServices(filter = 'all') {
  const visible = filter === 'all' ? services : services.filter(({ kind }) => kind === filter);
  list.replaceChildren(...visible.map(serviceItem));
  status.textContent = visible.length ? '' : filter === 'all' ? 'Chưa có dịch vụ nào đang mở.' : 'Chưa có dịch vụ thuộc nhóm này.';
  for (const button of filters.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
}

async function loadServices() {
  retry.hidden = true;
  filters.hidden = true;
  list.replaceChildren();
  skeleton.hidden = false;
  catalog.setAttribute('aria-busy', 'true');
  status.textContent = 'Đang tải danh mục dịch vụ…';
  try {
    const response = await fetch('/api/services?limit=20&offset=0', {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Catalog unavailable');
    const { items } = await response.json();
    services = items.flatMap((row) => {
      try { return [readService(row)]; } catch { return []; }
    });
    if (items.length && !services.length) throw new Error('No valid services');
    renderServices();
    filters.hidden = services.length === 0;
  } catch {
    status.textContent = 'Chưa tải được danh mục dịch vụ. Bạn có thể thử lại.';
    retry.hidden = false;
  } finally {
    skeleton.hidden = true;
    catalog.setAttribute('aria-busy', 'false');
  }
}

filters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (button) renderServices(button.dataset.filter);
});
retry.addEventListener('click', () => {
  status.focus({ preventScroll: true });
  loadServices();
});
loadServices();
