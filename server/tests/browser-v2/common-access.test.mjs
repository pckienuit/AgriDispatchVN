// Browser check for shared access screens C-01 (phone + password sign-in, D4) and C-04 (unknown route vs wrong role).
// Disposable PostgreSQL (TEST_DATABASE_URL, loopback *_test) + two real services + headless Chromium at 390 and 1440 px.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const log = (...args) => console.log('[common-access]', ...args);
const SHOTS = process.env.COMMON_ACCESS_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-common-access-shots-')));
const PASSWORD = 'TestPass!12345';
const WRONG_PASSWORD = 'WrongPass!99999';
const PHONE = '0914000001';
const NAME = 'Thử nông dân C-01';
const WRONG_MSG = 'Số điện thoại hoặc mật khẩu không đúng.';
const DENIED_TITLE = 'Tài khoản chưa có quyền xem nội dung này';
const NOT_FOUND_TITLE = 'Không tìm thấy trang này';
const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const pageErrors = [];
const consoleErrors = [];
const results = [];
let browser;
let origin;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function api(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function pressKey(key, code, windowsVirtualKeyCode) {
  const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(250);
}

// Returns the visible text and href of the first link or button with exactly this label.
const control = (label) => browser.ev(`(()=>{const el=[...document.querySelectorAll('a,button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&e.offsetParent!==null);return el?{tag:el.tagName,href:el.getAttribute('href'),type:el.getAttribute('type')}:null})()`);
// Empty-state title (h3 inside main, kit ui.empty).
const heading = () => browser.ev("(document.querySelector('#main h3')||{}).textContent||null");
// Screen title (first h1; mobile frame puts it in header.mbar, outside #main).
const screenTitle = () => browser.ev("(document.querySelector('h1')||{}).textContent||null");
const hash = () => browser.ev('location.hash');

async function openBrowser(width) {
  if (browser) {
    pageErrors.push(...browser.errors);
    consoleErrors.push(...browser.consoleErrors);
    await browser.close();
  }
  browser = await open({ width, height: width < 760 ? 844 : 900, mobile: width < 760 });
  return browser;
}

async function shot(name) {
  const path = join(SHOTS, `${name}.png`);
  await browser.shot(path);
  return path;
}

async function layoutOk(name) {
  const layout = await browser.layout();
  assert.ok(layout.sw <= layout.w, `${name}: horizontal overflow ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.wide, [], `${name}: elements past viewport ${JSON.stringify(layout)}`);
}

async function runFlow(width) {
  const tag = `${width}px`;
  await openBrowser(width);
  const b = browser;

  // C-04 unknown route while signed out is public: 404 page, not a login redirect.
  await b.go(`${origin}/v2/#/nong-dan/F-99`);
  await b.waitText(NOT_FOUND_TITLE);
  assert.equal(await heading(), NOT_FOUND_TITLE, `${tag} signed-out unknown route heading`);
  const signedOutLink = await control('Đăng nhập');
  assert.deepEqual(signedOutLink && { href: signedOutLink.href }, { href: '#/chung/C-01' }, `${tag} signed-out C-04 login link`);
  await layoutOk(`c04-unknown-out-${tag}`);
  results.push({ check: 'C-04 unknown route signed out', width: tag, link: '#/chung/C-01' });

  // Protected route while signed out: redirected to C-01 with the original route kept for resume.
  await b.go(`${origin}/v2/#/nong-dan/F-02`);
  await b.waitFor("location.hash.startsWith('#/chung/C-01') && location.hash.includes('tiep=')");
  const resume = await hash();
  assert.match(resume, /tiep=%2Fnong-dan%2FF-02$/, `${tag} resume target lost: ${resume}`);
  await b.waitFor('!!document.querySelector("input[name=phone]")');

  // Keyboard path: phone -> password -> submit, reached with real Tab key events.
  await b.ev("document.querySelector('input[name=phone]').focus()");
  await pressKey('Tab', 'Tab', 9);
  assert.equal(await b.ev("document.activeElement.name"), 'password', `${tag} Tab from phone should reach password`);
  await pressKey('Tab', 'Tab', 9);
  assert.equal(await b.ev("document.activeElement.getAttribute('type')"), 'submit', `${tag} Tab from password should reach submit`);

  // Wrong password: actual server message, no authentication, stays on C-01.
  await b.fill('input[name=phone]', PHONE);
  await b.fill('input[name=password]', WRONG_PASSWORD);
  await b.click('form button[type=submit]');
  await b.waitText(WRONG_MSG);
  assert.equal(await b.ev("document.querySelector('.msg--error').getAttribute('role')"), 'alert', `${tag} error message should be role=alert`);
  assert.equal(await b.ev("document.querySelector('.msg--error').hidden"), false, `${tag} error message hidden`);
  assert.match(await hash(), /^#\/chung\/C-01/, `${tag} wrong password changed route`);
  assert.equal(await b.ev("!!document.querySelector('input[name=password]')"), true, `${tag} wrong password left form`);
  assert.equal(await b.ev("document.body.innerText.includes('Đăng xuất')"), false, `${tag} wrong password authenticated`);
  const shotWrong = await shot(`c01-wrong-password-${width}`);
  await layoutOk(`c01-wrong-${tag}`);

  // Still unauthenticated: a protected route must redirect back to C-01, not render.
  await b.go(`${origin}/v2/#/nong-dan/F-02`);
  await b.waitFor("location.hash.startsWith('#/chung/C-01')");
  assert.equal(await b.ev("!!document.querySelector('input[name=password]')"), true, `${tag} protected route rendered after failed login`);

  // Correct password (retyped): resumes the stored protected route.
  await b.waitFor('!!document.querySelector("input[name=phone]")');
  await b.fill('input[name=phone]', PHONE);
  await b.fill('input[name=password]', PASSWORD);
  await b.click('form button[type=submit]');
  await b.waitFor("location.hash.startsWith('#/nong-dan/F-02')");
  await b.waitText('Thửa ruộng');
  assert.equal(await screenTitle(), 'Thửa ruộng', `${tag} resumed route heading`);
  assert.equal(await b.ev("document.body.innerText.includes('Đăng xuất') || document.body.innerText.includes('Thêm thửa')"), true, `${tag} resumed route not signed-in content`);
  await layoutOk(`f02-resumed-${tag}`);
  const shotResumed = await shot(`f02-resumed-${width}`);

  // C-04 wrong role on a registered route: farmer opens HTX screen (H-01). Distinct from unknown route.
  await b.go(`${origin}/v2/#/htx/H-01`);
  await b.waitText(DENIED_TITLE);
  assert.equal(await heading(), DENIED_TITLE, `${tag} denied heading`);
  assert.equal(await b.ev("document.body.innerText.includes('Không tìm thấy trang này')"), false, `${tag} denied page shows unknown-route copy`);
  const home = await control('Về trang chính');
  const account = await control('Tài khoản và vai trò');
  assert.deepEqual(home && { href: home.href }, { href: '#/nong-dan/F-01' }, `${tag} denied home link`);
  assert.deepEqual(account && { href: account.href }, { href: '#/chung/C-02' }, `${tag} denied account link`);
  assert.equal(await b.ev("!!document.querySelector('#main')") , true, `${tag} denied page missing main`);
  await layoutOk(`c04-denied-${tag}`);
  const shotDenied = await shot(`c04-denied-${width}`);
  results.push({ check: 'C-04 wrong role', width: tag, links: ['#/nong-dan/F-01', '#/chung/C-02'] });

  // Unknown route while signed in: different copy and home link only.
  await b.go(`${origin}/v2/#/nong-dan/F-99`);
  await b.waitText(NOT_FOUND_TITLE);
  assert.equal(await control('Tài khoản và vai trò'), null, `${tag} unknown route offers role-account link`);
  const shotUnknown = await shot(`c04-unknown-${width}`);
  await layoutOk(`c04-unknown-in-${tag}`);

  // Recovery link works: the denied page's account link opens C-02 with the signed-in user.
  await b.go(`${origin}/v2/#/htx/H-01`);
  await b.waitText(DENIED_TITLE);
  await b.click('a[href="#/chung/C-02"]');
  await b.waitFor("location.hash.startsWith('#/chung/C-02')");
  await b.waitText('Tài khoản');
  assert.equal(await b.ev("document.body.innerText.includes('Thử nông dân C-01')"), true, `${tag} C-02 missing user name`);

  results.push({ check: 'screenshots', width: tag, files: [shotWrong, shotResumed, shotDenied, shotUnknown] });
  log(`PASS ${tag}`, { hashes: [resume] });
}

try {
  await migrate(pool);
  const secret = randomBytes(32).toString('base64url');
  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret }));
  const reg = await api('POST', '/api/auth/register', { body: { phone: PHONE, password: PASSWORD, name: NAME } });
  assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.data)}`);
  log('disposable DB + two-service API ready', { db: db.name });

  for (const width of [390, 1440]) await runFlow(width);

  pageErrors.push(...browser.errors);
  consoleErrors.push(...browser.consoleErrors);
  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
  // Only the deliberate wrong-password attempt (one per width) may log a 401, and only from the login endpoint.
  const loginFailures = consoleErrors.filter((e) => /status of 401 \(Unauthorized\) \S*\/api\/auth\/login$/.test(e));
  assert.equal(loginFailures.length, consoleErrors.length, `unexpected console errors: ${consoleErrors.join(' | ')}`);
  assert.equal(loginFailures.length, 2, `expected one login 401 per width, got ${loginFailures.length}`);
  log('expected console errors (wrong-password 401 per width)', loginFailures.length);
  log('PASS common access C-01/C-04', { shots: SHOTS, results: results.length });
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      await Promise.all(servers.map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
      await pool.end();
    } finally {
      await db.drop();
    }
  }
}
