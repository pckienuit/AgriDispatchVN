// Browser check for the public entry (DEV-14): C-05 catalog and C-06 detail without sign-in, empty and API-down states,
// and the order button sending a guest through C-01 and back to the same detail. Disposable PostgreSQL
// (TEST_DATABASE_URL, loopback *_test) + two real services + headless Chromium at 390 and 1440 px.
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
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const log = (...args) => console.log('[public-catalog]', ...args);
const SHOTS = process.env.PUBLIC_CATALOG_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-public-catalog-shots-')));
const PASSWORD = 'TestPass!12345';
const PHONE = '0914000002';
const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const pageErrors = [];
let browser;
let origin;

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function openBrowser(width) {
  if (browser) {
    pageErrors.push(...browser.errors);
    await browser.close();
  }
  browser = await open({ width, height: width < 760 ? 844 : 900, mobile: width < 760 });
  return browser;
}

async function layoutOk(name) {
  const layout = await browser.layout();
  assert.ok(layout.sw <= layout.w, `${name}: horizontal overflow ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.wide, [], `${name}: elements past viewport ${JSON.stringify(layout)}`);
}

const hash = () => browser.ev('location.hash');

async function runFlow(width, { empty }) {
  const tag = `${width}px`;
  const b = await openBrowser(width);

  if (empty) {
    await b.go(`${origin}/v2/#/chung/C-05`);
    await b.waitText('Chưa có dịch vụ nào đang mở');
    assert.match(await hash(), /^#\/chung\/C-05/, `${tag} empty catalog redirected`);
    await layoutOk(`c05-empty-${tag}`);
    await b.shot(join(SHOTS, `c05-empty-${width}.png`));
    return;
  }

  // The sign-in screen links to the public catalog, so guests can find it.
  await b.go(`${origin}/v2/#/chung/C-01`);
  await b.waitFor("!!document.querySelector('a[href=\"#/chung/C-05\"]')");

  // Guest sees the catalog from the API, no redirect to sign-in.
  await b.go(`${origin}/v2/#/chung/C-05`);
  await b.waitFor("!!document.querySelector('a.item')");
  assert.match(await hash(), /^#\/chung\/C-05/, `${tag} catalog redirected a guest`);
  assert.equal(await b.ev("document.body.innerText.includes('Giá mô phỏng')"), true, `${tag} catalog hides the synthetic price label`);
  await layoutOk(`c05-guest-${tag}`);
  await b.shot(join(SHOTS, `c05-guest-${width}.png`));

  // Detail opens for a guest and offers sign-in and sign-up, not the order screen.
  await b.click('a.item');
  await b.waitFor("location.hash.startsWith('#/chung/C-06?id=')");
  const detailHash = await hash();
  await b.waitText('Đơn giá');
  assert.equal(await b.ev("!!document.querySelector('a[href*=\"buoc=dang-ky\"]')"), true, `${tag} detail has no sign-up link`);
  await layoutOk(`c06-guest-${tag}`);
  await b.shot(join(SHOTS, `c06-guest-${width}.png`));

  // Order button: guest goes to C-01 with the detail kept as the return target, then lands back on it.
  await b.clickText('Đăng nhập');
  await b.waitFor("location.hash.startsWith('#/chung/C-01')");
  assert.ok((await hash()).includes('tiep='), `${tag} return target lost`);
  await b.waitFor('!!document.querySelector("input[name=phone]")');
  await b.fill('input[name=phone]', PHONE);
  await b.fill('input[name=password]', PASSWORD);
  await b.click('form button[type=submit]');
  await b.waitFor(`location.hash === ${JSON.stringify(detailHash)}`);
  await b.waitText('Đặt dịch vụ này');
  assert.deepEqual(await b.ev("[...document.querySelectorAll('.mbar a, #main a[href=\"#/chung/C-05\"]')].map(a => [a.getAttribute('href'), a.getAttribute('aria-label')])"),
    [['#/chung/C-05', 'Quay lại danh mục dịch vụ']], `${tag} detail should have one back link, to the catalog`);
  await layoutOk(`c06-signed-in-${tag}`);
  await b.shot(join(SHOTS, `c06-signed-in-${width}.png`));

  // Signed in, the same button opens the booking screen with this service preselected.
  await b.clickText('Đặt dịch vụ này', 'a');
  await b.waitFor("location.hash.startsWith('#/nong-dan/F-05')");
  assert.match(await hash(), /service=/, `${tag} order link lost the service`);

  // Unknown and malformed ids show the not-found state, not a crash.
  await b.hash('#/chung/C-06?id=00000000-0000-4000-8000-000000000000');
  await b.waitText('Không tìm thấy dịch vụ');
  await b.hash('#/chung/C-06?id=khong-phai-uuid');
  await b.waitText('Không tìm thấy dịch vụ');
  await b.shot(join(SHOTS, `c06-not-found-${width}.png`));
  log(`PASS ${tag}`, { detailHash });
}

try {
  await migrate(pool);
  const secret = randomBytes(32).toString('base64url');
  const account = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  const booking = await listen(createApp({ pool, accountServiceUrl: account.url, internalServiceToken: secret }));
  origin = booking.url;
  const reg = await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: PHONE, password: PASSWORD, name: 'Thử khách C-05' }),
  });
  assert.equal(reg.status, 201, 'register');

  for (const width of [390, 1440]) await runFlow(width, { empty: true });
  await seedCatalog(pool);
  for (const width of [390, 1440]) await runFlow(width, { empty: false });

  // API down: the catalog says so in Vietnamese and offers a retry instead of a blank page.
  await openBrowser(390);
  await browser.go(`${origin}/v2/#/chung/C-05`);
  await browser.waitFor("!!document.querySelector('a.item')");
  await new Promise((resolve) => { booking.server.close(resolve); booking.server.closeAllConnections(); });
  await browser.hash('#/chung/C-04');
  await browser.ev("import('/v2/kit/ui.js').then(({ ui }) => ui.toast('Đã lưu thay đổi', 'ok'))");
  assert.equal(await browser.ev("!!document.getElementById('toasts')?.childElementCount"), true);
  await browser.hash('#/chung/C-05');
  await browser.waitText('Chưa tải được màn này');
  assert.equal(await browser.ev("document.body.innerText.includes('Thử lại')"), true, 'error state has no retry');
  assert.equal(await browser.ev("document.getElementById('toasts')?.childElementCount ?? 0"), 0, 'stale success toast survived offline error');
  await browser.shot(join(SHOTS, 'c05-api-error-390.png'));

  pageErrors.push(...browser.errors);
  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
  log('PASS public catalog C-05/C-06', { shots: SHOTS });
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
