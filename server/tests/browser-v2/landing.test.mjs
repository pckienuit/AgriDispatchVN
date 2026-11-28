// TEST_DATABASE_URL must point to a disposable loopback *_test DB. Set LANDING_SHOTS to keep screenshots together.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const shots = process.env.LANDING_SHOTS || await mkdtemp(join(tmpdir(), 'agri-landing-shots-'));
await mkdir(shots, { recursive: true });
const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const endpoint = '/api/services?limit=20&offset=0';
const catalogRequests = [];
let mode = 'real';
let release;
let fixtureItems;

async function listen(handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function noOverflow(b) {
  const layout = await b.layout();
  assert.ok(layout.sw <= layout.w, `horizontal overflow: ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.wide, [], `elements outside viewport: ${JSON.stringify(layout)}`);
}

async function heroAt(b, p, width, reduced = false) {
  const heightProgress = 1 - (1 - Math.min(1, Math.max(0, (p - .037) / .641))) ** 2;
  const shrink = width <= 900 ? 0 : 1 - (1 - Math.min(1, Math.max(0, (p - .585) / .415))) ** 2;
  const metrics = await b.ev(`(() => {
    const hero = document.querySelector('[data-hero]');
    if (!hero) return {};
    const inner = hero.querySelector('.hero__inner');
    const stage = hero.querySelector('.hero__stage');
    if (!${reduced}) scrollTo({top: hero.offsetTop + ${p} * (hero.offsetHeight - innerHeight), behavior: 'instant'});
    return {w: inner.clientWidth, h: inner.clientHeight, sticky: getComputedStyle(stage).position,
      distance: hero.offsetHeight - innerHeight, static: hero.classList.contains('hero--static')};
  })()`);
  assert.equal(metrics.static, reduced, 'hero should reflect the motion preference');
  assert.equal(metrics.sticky, reduced ? 'relative' : 'sticky');
  if (!reduced) assert.equal(metrics.distance, width <= 900 ? 1500 : 3100);
  const h = heightProgress * metrics.h;
  const w = metrics.w * (1 - .6872 * shrink);
  const radius = 12 + 52 * shrink;
  const opacity = Math.max(0, 1 - p / .16);
  await b.waitFor(`(() => {
    const media = document.querySelector('.hero__media').getBoundingClientRect();
    const style = getComputedStyle(document.querySelector('.hero__media'));
    const mask = getComputedStyle(document.querySelector('.hero__tw')).clipPath;
    const hint = document.querySelector('.hero__hint');
    const white = getComputedStyle(document.querySelector('.hero__t--w')).transform;
    const [inset, round] = mask.slice(6, -1).split(' round ');
    const [top, right = top, bottom = top, left = right] = inset.split(' ').map(parseFloat);
    const near = (a, b) => Math.abs(a - b) < 1;
    return near(media.height, ${h}) && near(media.width, ${w})
      && near(parseFloat(style.borderRadius), ${radius}) && mask.startsWith('inset(')
      && near(top, ${metrics.h - h}) && near(right, 0) && near(bottom, 0) && near(left, ${metrics.w - w})
      && near(parseFloat(round), ${radius}) && near(new DOMMatrix(white === 'none' ? undefined : white).m41, ${-.0746 * metrics.w * shrink})
      && Math.abs(Number(getComputedStyle(hint).opacity) - ${opacity}) < .01
      && hint.inert === ${opacity < .3};
  })()`);
  if (!reduced && p > 0) assert.ok(await b.ev("Math.abs(document.querySelector('.hero__stage').getBoundingClientRect().top - 115) < 2"));
  await noOverflow(b);
}

async function capturePage(b, width, height) {
  const pageHeight = await b.ev('document.documentElement.scrollHeight');
  for (let top = 0; top < pageHeight; top += Math.floor(height * .7)) {
    await b.ev(`scrollTo({top: ${top}, behavior: 'instant'})`);
    await b.sleep(65);
  }
  await b.waitFor("[...document.images].every(img => img.complete && img.naturalWidth > 0)");
  await b.ev("scrollTo({top: 0, behavior: 'instant'})");
  await noOverflow(b);
  const response = await b.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: pageHeight, scale: 1 },
  });
  await writeFile(join(shots, `landing-full-${width}.png`), Buffer.from(response.result.data, 'base64'));
}

async function clickRoute(b, selector, hash, screen) {
  await b.click(selector);
  await b.waitFor(`location.pathname === '/v2/' && location.hash === ${JSON.stringify(hash)}`);
  await b.waitText(screen);
}

try {
  await migrate(pool);
  const secret = randomBytes(32).toString('base64url');
  const accountServiceUrl = await listen(createAccountApp({ pool, internalServiceToken: secret }));
  const app = createApp({ pool, accountServiceUrl, internalServiceToken: secret });
  const origin = await listen((req, res) => {
    if (req.url !== endpoint) return app(req, res);
    catalogRequests.push({ method: req.method, mode });
    if (mode === 'loading') {
      release = () => app(req, res);
      return;
    }
    if (mode === 'error') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (mode === 'fixture') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: fixtureItems }));
      return;
    }
    app(req, res);
  });
  const landing = `${origin}/landing/`;

  const state = await open();
  try {
    mode = 'loading';
    await state.go(landing);
    await state.waitText('Đang tải danh mục dịch vụ');
    assert.equal(await state.ev("document.querySelector('.catalog').getAttribute('aria-busy')"), 'true');
    assert.deepEqual(catalogRequests.at(-1), { method: 'GET', mode: 'loading' });
    mode = 'real';
    release();
    await state.waitText('Chưa có dịch vụ nào đang mở.');
    assert.equal(await state.ev("document.querySelectorAll('.service').length"), 0);
    await noOverflow(state);

    mode = 'error';
    await state.go(landing);
    await state.waitText('Chưa tải được danh mục dịch vụ.');
    assert.equal(await state.ev("document.querySelectorAll('.service').length"), 0);
    assert.equal(await state.ev("!document.querySelector('.retry').hidden"), true);
    await seedCatalog(pool);
    mode = 'real';
    await state.click('.retry');
    await state.waitFor("document.querySelectorAll('.service').length === 3");
    assert.deepEqual(catalogRequests.map(({ method }) => method), ['GET', 'GET', 'GET']);
    assert.deepEqual(state.errors, []);
    assert.equal(state.consoleErrors.length, 1);
    assert.match(state.consoleErrors[0], /503.*\/api\/services\?limit=20&offset=0/);
    console.log('[landing] PASS loading, empty, HTTP 503 and retry via real GET');
  } finally {
    await state.close();
  }

  const payload = await (await fetch(`${origin}${endpoint}`)).json();
  assert.equal(payload.items.length, 3);
  assert.ok(payload.items.every(({ dataLabel }) => dataLabel === 'synthetic'));
  assert.ok(payload.items.every(({ name }) => name.endsWith(' (giả lập)')));
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    const b = await open({ width, height, mobile: width === 390 });
    try {
      await b.go(landing);
      await b.waitFor("document.querySelectorAll('.service').length === 3");
      await b.ev('document.fonts.ready.then(() => true)');
      assert.equal(await b.ev("document.fonts.check('700 22px Be Vietnam Pro')"), true);
      assert.equal(await b.ev("getComputedStyle(document.documentElement).scrollBehavior"), 'smooth');
      assert.equal(await b.ev("document.querySelector('.bundle').classList.contains('is-visible')"), false);
      for (const p of [0, .08, .4, .8, 1]) {
        await heroAt(b, p, width);
        if ((width === 1440 && p !== .08) || (width === 390 && (p === 0 || p === 1))) {
          await b.shot(join(shots, `hero-${width === 390 ? '390-' : ''}p${Math.round(p * 100)}.png`));
        }
      }
      await heroAt(b, 0, width);
      const rendered = await b.ev("[...document.querySelectorAll('.service-link')].map(a => ({ path: a.getAttribute('href'), name: a.querySelector('h3').textContent, price: a.querySelector('dd').textContent, label: a.querySelector('.service-badge').textContent }))");
      assert.deepEqual(rendered, payload.items.map((s) => ({
        path: `/v2/#/chung/C-06?id=${s.id}`, name: s.name.slice(0, -' (giả lập)'.length),
        price: `${new Intl.NumberFormat('vi-VN').format(BigInt(s.pricePerHaVnd))} đ/ha`,
        label: 'Giá mô phỏng',
      })));
      await b.click('[data-filter="drone"]');
      assert.equal(await b.ev("document.querySelectorAll('.service').length"), 1);
      assert.equal(await b.ev("document.querySelector('[data-filter=drone]').getAttribute('aria-pressed')"), 'true');
      await b.click('[data-filter="all"]');
      if (width === 390) {
        assert.equal(await b.ev("getComputedStyle(document.querySelector('#site-nav')).display"), 'none');
        await b.click('.menu-toggle');
        assert.equal(await b.ev("document.querySelector('.menu-toggle').getAttribute('aria-expanded')"), 'true');
        await noOverflow(b);
        await b.ev("document.querySelector('#site-nav a').focus()");
        await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        assert.equal(await b.ev("document.activeElement.matches('.menu-toggle[aria-expanded=false]')"), true);
      }
      assert.equal(await b.ev("[...document.querySelectorAll('.footer-grid a')].every(a => a.offsetHeight >= 44)"), true);
      await b.ev("document.querySelector('.bundle').scrollIntoView({behavior: 'instant'})");
      await b.waitFor("document.querySelector('.bundle').classList.contains('is-visible')");
      await heroAt(b, 0, width);
      assert.deepEqual(b.errors, []);
      assert.deepEqual(b.consoleErrors, []);

      const detail = payload.items[0];
      await clickRoute(b, '.service-link', `#/chung/C-06?id=${detail.id}`, 'Đơn giá');
      await b.go(landing);
      await clickRoute(b, '.hero__hint a', '#/chung/C-05', 'Danh mục dịch vụ');
      await b.go(landing);
      if (width === 390) await b.click('.menu-toggle');
      await clickRoute(b, '#site-nav a[href$="C-01"]', '#/chung/C-01', 'Đăng nhập bằng số điện thoại');
      await b.go(landing);
      await clickRoute(b, '.bundle-note a', '#/chung/C-01?buoc=dang-ky', 'Tài khoản mới có vai trò nông dân');

      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await b.go(landing);
      await b.waitFor("document.querySelectorAll('.service').length === 3");
      await b.waitFor("document.querySelector('.hero--static')");
      await heroAt(b, 1, width, true);
      await b.ev("document.querySelector('.bundle').scrollIntoView()");
      const reduced = await b.ev(`(() => ({
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        scroll: getComputedStyle(document.documentElement).scrollBehavior,
        cta: getComputedStyle(document.querySelector('.hero__hint a')).transitionDuration,
        visible: getComputedStyle(document.querySelector('.bundle')).opacity,
        reveals: document.querySelectorAll('.is-visible').length,
      }))()`);
      assert.deepEqual(reduced, { matches: true, scroll: 'auto', cta: '0s', visible: '1', reveals: 0 });
      await noOverflow(b);
      if (width === 1440) await capturePage(b, width, height);
      assert.deepEqual(b.errors, []);
      assert.deepEqual(b.consoleErrors, []);
      console.log(`[landing] PASS ${width}x${height}: API and labels, filters, routes, motion, no overflow or browser errors`);
    } finally {
      await b.close();
    }
  }
  // Response fixtures run after capture; the seeded catalog remains unchanged.
  const states = await open();
  try {
    mode = 'fixture';
    const name = 'Phun thuốc bằng drone';
    fixtureItems = [null, { ...payload.items.find(({ code }) => code === 'drone-spray'), name, dataLabel: 'real-labelled' }];
    await states.go(landing);
    await states.waitFor("document.querySelectorAll('.service').length === 1");
    assert.equal(await states.ev("document.querySelector('.service h3').textContent"), name);
    assert.equal(await states.ev("document.querySelector('.service-badge').textContent"), 'Giá đã gắn nhãn dữ liệu thật');
    fixtureItems = [null];
    await states.go(landing);
    await states.waitText('Chưa tải được danh mục dịch vụ.');
    assert.equal(await states.ev("document.querySelectorAll('.service').length"), 0);
    assert.equal(await states.ev("!document.querySelector('.retry').hidden"), true);
    assert.deepEqual(states.errors, []);
    assert.deepEqual(states.consoleErrors, []);
    console.log('[landing] PASS malformed rows and separate real-labelled fixture');
  } finally {
    await states.close();
  }
  console.log(`[landing] screenshots: ${shots}`);
} finally {
  try {
    await Promise.all(servers.map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
    await pool.end();
  } finally {
    await db.drop();
  }
}
