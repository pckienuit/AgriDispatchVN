// Browser check for admin A-04 (versioned platform parameters: save, readback, rejected input) and A-05
// (observational compliance log, no certification, no write controls) on /v2/.
// Disposable PostgreSQL (TEST_DATABASE_URL, loopback *_test) + two real services + headless Chromium at 1440 and 390 px.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const log = (...args) => console.log('[admin-platform-controls]', ...args);
const SHOTS = process.env.ADMIN_PLATFORM_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-admin-platform-shots-')));
await mkdir(SHOTS, { recursive: true });
const PASSWORD = 'TestPass!12345';
const PHONE = '0915000001';
const NAME = 'Thử quản trị A-04';
const SAVE_NOTE = `Thử nghiệm bán kính gom cụm ${randomBytes(4).toString('hex')}`;
const INVALID_JSON_NOTE = 'Thử JSON lỗi';
const VALIDATION_TEXT = 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.';
const COMPLIANCE_BANNER = 'Không phải chứng nhận pháp lý';
const FEE_LABEL = 'Không phải mức phí thực thu.';
const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const pageErrors = [];
const consoleErrors = [];
const checks = [];
let browser;
let origin;

const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hourCycle: 'h23', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// Mirrors ui.fmt.dateTime in web/v2/kit/ui.js: "HH:MM ngày DD/MM" in Asia/Ho_Chi_Minh.
const expectedDateTime = (iso) => {
  const p = {};
  dateFmt.formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
  return `${p.hour}:${p.minute} ngày ${p.day}/${p.month}`;
};

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

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    log('PASS', name);
  } catch (error) {
    const detail = 'actual' in error ? `${JSON.stringify(error.actual)} !== ${JSON.stringify(error.expected)}` : String(error.message).split('\n')[0];
    checks.push({ name, ok: false, error: detail.slice(0, 300) });
    log('FAIL', name, '::', detail.slice(0, 300));
  }
}

async function adminSession(width) {
  if (browser) {
    pageErrors.push(...browser.errors);
    consoleErrors.push(...browser.consoleErrors);
    await browser.close();
  }
  browser = await open({ width, height: width < 760 ? 844 : 900, mobile: width < 760 });
  await browser.go(`${origin}/v2/`);
  await browser.waitFor(`location.hash.startsWith('#/chung/C-01')`);
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', PHONE);
  await browser.fill('input[name=password]', PASSWORD);
  await browser.click('form button[type=submit]');
  await browser.waitFor(`location.hash.startsWith('#/quan-tri/')`);
  return browser;
}

const submitFormOf = (selector) => browser.ev(`document.querySelector(${JSON.stringify(selector)}).form.requestSubmit()`);
const fillValues = (text) => browser.ev(`(()=>{const t=document.querySelector('textarea[name=values]');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
// Subtitle text of the card whose title is "Phiên bản N" (the effective version card).
const effectiveSubtitle = (version) => browser.ev(`(()=>{const h=[...document.querySelectorAll('h2')].find(x=>x.textContent.trim()===${JSON.stringify(`Phiên bản ${version}`)});return h&&h.parentElement.querySelector('p')?h.parentElement.querySelector('p').textContent.trim():null;})()`);
const pageText = () => browser.ev('document.body.innerText');
const controlCount = () => browser.ev(`document.querySelectorAll('#main button, #main input, #main select, #main textarea, #main form').length`);

async function dbVersions() {
  return (await pool.query('SELECT version, parameters, changed_by, note, created_at FROM dispatch.platform_parameter_versions ORDER BY version')).rows;
}
async function dbEvents() {
  return (await pool.query("SELECT actor_id, event_type, entity_id, details, created_at FROM dispatch.platform_control_events WHERE event_type='PARAMETERS_CHANGED' ORDER BY sequence")).rows;
}

let ADMIN_ID;
let ADMIN_TOKEN;
let DEFAULT_VALUES_JSON = '';

try {
  await migrate(pool);
  const secret = randomBytes(32).toString('base64url');
  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret }));
  const reg = await api('POST', '/api/auth/register', { body: { phone: PHONE, password: PASSWORD, name: NAME } });
  assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.data)}`);
  ADMIN_ID = reg.data.user.id;
  await pool.query("INSERT INTO account.user_roles(user_id, role) VALUES($1,'admin') ON CONFLICT DO NOTHING", [ADMIN_ID]);
  const login = await api('POST', '/api/auth/login', { body: { phone: PHONE, password: PASSWORD } });
  assert.equal(login.status, 200, 'admin login');
  ADMIN_TOKEN = login.data.token;
  log('disposable DB + two-service API ready', { db: db.name });

  // ---- 1440 px: A-04 negatives, save, reload readback; A-05 observation ----
  await adminSession(1440);
  await browser.hash('#/quan-tri/A-04');
  await browser.waitText('Tham số vận hành');
  await browser.waitText('Phiên bản 0');
  await check('A-04 default version 0 has no saved timestamp', async () => {
    assert.equal(await effectiveSubtitle(0), 'Chưa lưu phiên bản');
    assert.equal((await dbVersions()).length, 0);
    DEFAULT_VALUES_JSON = await browser.ev(`document.querySelector('textarea[name=values]').value`);
    assert.ok(DEFAULT_VALUES_JSON && DEFAULT_VALUES_JSON.includes('"radiusM": 1500'), 'server default values not loaded into form');
  });
  await check('A-04 shows fee disclaimer label', async () => {
    assert.ok((await pageText()).includes(FEE_LABEL), 'fee disclaimer missing');
  });

  await check('A-04 rejects malformed JSON without version or event', async () => {
    await fillValues('{"radiusM": 1600');
    await browser.fill('textarea[name=note]', INVALID_JSON_NOTE);
    await submitFormOf('textarea[name=values]');
    await browser.waitText('JSON chưa hợp lệ.');
    assert.equal((await dbVersions()).length, 0, 'version written on malformed JSON');
    assert.equal((await dbEvents()).length, 0, 'event written on malformed JSON');
  });

  await check('A-04 rejects unknown key with server VALIDATION_FAILED, no version or event', async () => {
    await fillValues('{"mystery": 1}');
    await submitFormOf('textarea[name=values]');
    await browser.waitText(VALIDATION_TEXT);
    assert.equal((await dbVersions()).length, 0, 'version written on unknown key');
    assert.equal((await dbEvents()).length, 0, 'event written on unknown key');
  });

  await check('A-04 rejects empty reason with server VALIDATION_FAILED, no version or event', async () => {
    await fillValues(DEFAULT_VALUES_JSON);
    await browser.fill('textarea[name=note]', '');
    await submitFormOf('textarea[name=note]');
    await browser.waitText(VALIDATION_TEXT);
    assert.equal((await dbVersions()).length, 0, 'version written with empty reason');
    assert.equal((await dbEvents()).length, 0, 'event written with empty reason');
  });

  // Supported assumption: radiusM 1500 -> 1600, every other default kept. Unique reason per run.
  await check('A-04 saves supported assumption with unique reason', async () => {
    await browser.ev(`(()=>{const t=document.querySelector('textarea[name=values]');const o=JSON.parse(t.value);o.radiusM=1600;t.value=JSON.stringify(o,null,2);t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await browser.fill('textarea[name=note]', SAVE_NOTE);
    await submitFormOf('textarea[name=note]');
    await browser.waitText('Đã lưu phiên bản tham số.');
    await browser.waitText('Phiên bản 1');
    const rows = await dbVersions();
    assert.equal(rows.length, 1, `expected 1 version row, got ${rows.length}`);
    assert.equal(String(rows[0].version), '1');
    assert.equal(rows[0].parameters.radiusM, 1600);
    assert.equal(rows[0].note, SAVE_NOTE);
    assert.equal(rows[0].changed_by, ADMIN_ID);
  });

  await check('A-04 persisted PARAMETERS_CHANGED event for version 1', async () => {
    const events = await dbEvents();
    assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
    assert.equal(events[0].actor_id, ADMIN_ID, `event actor ${JSON.stringify(events[0])} vs admin ${ADMIN_ID}`);
    assert.equal(String(events[0].details.version), '1', `event details ${JSON.stringify(events[0].details)}`);
  });

  // Reload drops the in-memory session (token lives in JS memory only); sign in again and read state back from the server.
  await browser.send('Page.reload', { ignoreCache: true });
  await browser.waitFor(`location.hash.startsWith('#/chung/C-01')`);
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', PHONE);
  await browser.fill('input[name=password]', PASSWORD);
  await browser.click('form button[type=submit]');
  await browser.waitFor(`location.hash.startsWith('#/quan-tri/A-04')`);
  await browser.waitText('Phiên bản 1');
  await check('A-04 readback after reload: API matches PG (version, reason, radiusM)', async () => {
    const res = await api('GET', '/api/admin/platform-parameters', { token: ADMIN_TOKEN });
    assert.equal(res.status, 200);
    const dbRow = (await dbVersions())[0];
    assert.equal(String(res.data.effective.version), '1');
    assert.equal(res.data.effective.note, SAVE_NOTE);
    assert.equal(res.data.effective.values.radiusM, 1600);
    assert.equal(new Date(res.data.effective.createdAt).getTime(), new Date(dbRow.created_at).getTime(), 'createdAt DTO differs from PG');
    assert.equal(String(res.data.history[0].version), '1');
  });

  await check('A-04 persisted save date visible in effective card', async () => {
    const dbRow = (await dbVersions())[0];
    const sub = await effectiveSubtitle(1);
    assert.equal(sub, expectedDateTime(dbRow.created_at), `subtitle was ${JSON.stringify(sub)}`);
  });

  await check('A-04 readback shows radiusM value and reason in history', async () => {
    const text = await pageText();
    assert.ok(text.includes(SAVE_NOTE), 'reason not visible in history');
    const radiusRow = await browser.ev(`(()=>{const dt=[...document.querySelectorAll('dt')].find(d=>d.textContent.trim()==='radiusM');return dt&&dt.nextElementSibling?dt.nextElementSibling.textContent.trim():null;})()`);
    assert.equal(radiusRow, '1600');
  });

  await check('A-04 no unexpected control state after save', async () => {
    assert.ok((await pageText()).includes(FEE_LABEL), 'fee disclaimer missing after save');
  });
  await browser.shot(join(SHOTS, 'a04-1440.png'));

  // A-05 at 1440: observational log of the PARAMETERS_CHANGED event.
  await browser.hash('#/quan-tri/A-05');
  await browser.waitText(COMPLIANCE_BANNER);
  await check('A-05 PARAMETERS_CHANGED row shows event name in Sự kiện column', async () => {
    const cell = await browser.ev(`(()=>{const tr=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes('PARAMETERS_CHANGED'));if(!tr)return null;const td=tr.querySelector('td[data-label="Sự kiện"]');return td?td.textContent.trim():'NO_COLUMN';})()`);
    assert.equal(cell, 'PARAMETERS_CHANGED', `Sự kiện cell was ${JSON.stringify(cell)}`);
  });
  await check('A-05 API log has PARAMETERS_CHANGED with matching version and non-certification flag', async () => {
    const res = await api('GET', '/api/admin/compliance-status', { token: ADMIN_TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'OBSERVATIONAL_ONLY');
    assert.equal(res.data.legalCertification, false);
    const item = res.data.items.find((i) => i.source === 'control' && i.action === 'PARAMETERS_CHANGED');
    assert.ok(item, `PARAMETERS_CHANGED control row missing from API: ${JSON.stringify(res.data.items.slice(0, 2))}`);
    const [event] = await dbEvents();
    assert.equal(String(event.details.version), '1', 'event details version does not match saved version');
    assert.equal(new Date(item.created_at).getTime(), new Date(event.created_at).getTime(), 'API event time differs from PG');
  });
  await check('A-05 shows observational banner and no write controls', async () => {
    assert.ok((await pageText()).includes(COMPLIANCE_BANNER), 'banner missing');
    assert.equal(await controlCount(), 0, 'write control present on A-05');
  });
  await browser.shot(join(SHOTS, 'a05-1440.png'));
  const layout1440 = await browser.layout();
  await check('A-05 no horizontal overflow at 1440', async () => {
    assert.ok(layout1440.sw <= layout1440.w && layout1440.wide.length === 0, JSON.stringify(layout1440));
  });

  // ---- 390 px: fresh profile, same readback on mobile ----
  await adminSession(390);
  await browser.hash('#/quan-tri/A-04');
  await browser.waitText('Phiên bản 1');
  await check('A-04 390 px: persisted date visible and layout fits', async () => {
    const dbRow = (await dbVersions())[0];
    assert.equal(await effectiveSubtitle(1), expectedDateTime(dbRow.created_at));
    const layout = await browser.layout();
    assert.ok(layout.sw <= layout.w && layout.wide.length === 0, JSON.stringify(layout));
  });
  await browser.shot(join(SHOTS, 'a04-390.png'));

  await browser.hash('#/quan-tri/A-05');
  await browser.waitText(COMPLIANCE_BANNER);
  await check('A-05 390 px: event row and no write controls', async () => {
    const cell = await browser.ev(`(()=>{const tr=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes('PARAMETERS_CHANGED'));const td=tr&&tr.querySelector('td[data-label="Sự kiện"]');return td?td.textContent.trim():null;})()`);
    assert.equal(cell, 'PARAMETERS_CHANGED', `Sự kiện cell was ${JSON.stringify(cell)}`);
    assert.equal(await controlCount(), 0, 'write control present on A-05 at 390');
  });
  const layout390 = await browser.layout();
  await check('A-05 no horizontal overflow at 390', async () => {
    assert.ok(layout390.sw <= layout390.w && layout390.wide.length === 0, JSON.stringify(layout390));
  });
  await browser.shot(join(SHOTS, 'a05-390.png'));

  pageErrors.push(...browser.errors);
  consoleErrors.push(...browser.consoleErrors);
  // Only the two deliberately rejected PUTs (unknown key, empty reason) may log a 400, and only from the parameters endpoint.
  const expected400 = consoleErrors.filter((e) => /status of 400 \(Bad Request\) \S*\/api\/admin\/platform-parameters$/.test(e));
  const unexpected = consoleErrors.filter((e) => !expected400.includes(e));
  await check('no uncaught page errors; only deliberate 400s from parameters PUT', async () => {
    assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
    assert.deepEqual(unexpected, [], `unexpected console errors: ${unexpected.join(' | ')}`);
    assert.equal(expected400.length, 2, `expected 2 deliberate 400s, got ${expected400.length}`);
  });
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

const failed = checks.filter((c) => !c.ok);
log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const f of failed) log('FAILED', f.name, '::', f.error);
  process.exitCode = 1;
} else {
  log('PASS admin platform controls A-04/A-05', { shots: SHOTS });
}
