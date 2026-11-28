/* global document */
// Browser check for O-03 job filters (wage type, machine type, skill, search, Open/Seats chips, reset by hand,
// keyboard order) against real DB job rows, and O-08 certificate status transitions after A-01 review.
// Disposable PostgreSQL (TEST_DATABASE_URL, loopback *_test) + two real services + headless Chromium at 390 and 1440 px.
// Synthetic accounts only.
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

const log = (...args) => console.log('[operator-workforce-filters]', ...args);
const SHOTS = process.env.WORKFORCE_FILTER_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-workforce-filter-shots-')));
await mkdir(SHOTS, { recursive: true });
const PASSWORD = 'TestPass!12345';
const CERT_A = 'Vận hành máy gặt';
const CERT_B = 'Vận hành drone phun';
const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const pageErrors = [];
const consoleErrors = [];
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

async function must(method, path, opts) {
  const res = await api(method, path, opts);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data;
}

async function makeActor(role, n) {
  const phone = `0914${String(n).padStart(6, '0')}`;
  const reg = await must('POST', '/api/auth/register', { body: { phone, password: PASSWORD, name: `Thử ${role} ${n}` } });
  if (role !== 'farmer') await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1,$2) ON CONFLICT DO NOTHING', [reg.user.id, role]);
  const login = await must('POST', '/api/auth/login', { body: { phone, password: PASSWORD } });
  return { role, phone, id: reg.user.id, token: login.token };
}

// Each actor gets a separate browser profile and cookie jar.
async function session(person, prefix, { width = 390, height = 844, mobile = true } = {}) {
  if (browser) {
    pageErrors.push(...browser.errors);
    consoleErrors.push(...browser.consoleErrors);
    await browser.close();
  }
  browser = await open({ width, height, mobile });
  await browser.go(`${origin}/v2/`);
  await browser.waitFor(`location.hash.startsWith('#/chung/C-01')`);
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', person.phone);
  await browser.fill('input[name=password]', PASSWORD);
  await browser.click('form button[type=submit]');
  await browser.waitFor(`location.hash.startsWith(${JSON.stringify(prefix)})`);
  return browser;
}

async function pollDb(fn, ok, label, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}; last=${JSON.stringify(last)}`);
}

const certRows = (operatorId) => pool.query('SELECT name, verification_status, reviewed_by, reviewed_at IS NOT NULL AS decided FROM dispatch.operator_certifications WHERE operator_id=$1 ORDER BY created_at', [operatorId]);

// Node-side fold mirrors Vietnamese accent-insensitive matching; expected titles come from DB rows, not from UI code.
const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
function expectedTitles(rows, f) {
  return rows.filter((j) => {
    if (f.open && j.status !== 'OPEN') return false;
    if (f.seats && !(j.seats > 0)) return false;
    if (f.q && !fold(`${j.title} ${j.locality}`).includes(fold(f.q))) return false;
    if (f.wage !== 'all' && j.wage_type !== f.wage) return false;
    if (f.machine !== 'all' && j.machine_type !== f.machine) return false;
    if (f.skill && !j.required_skills.some((s) => fold(s).includes(fold(f.skill)))) return false;
    return true;
  }).map((j) => j.title).sort();
}

// Page-side readers: passed to browser.ev as stringified functions so no template escaping is needed.
function readOpJobs() {
  const titles = [...document.querySelectorAll('a.op-job .op-job__title')].map((e) => e.textContent.trim());
  const count = [...document.querySelectorAll('p')].map((p) => p.textContent.trim()).find((t) => /^Hiện \d+ \/ \d+ tin tuyển\.$/.test(t)) || null;
  const chips = [...document.querySelectorAll('.op-radar-chip')].map((b) => b.getAttribute('aria-pressed'));
  const empty = document.body.innerText.includes('Không có tin khớp bộ lọc');
  const resetControl = /Đặt lại|Xóa bộ lọc/.test(document.body.innerText);
  return { titles, count, chips, empty, resetControl };
}
function certCards(name) {
  return [...document.querySelectorAll('li')]
    .filter((l) => !l.querySelector('li') && l.innerText.includes('Hết hạn') && l.innerText.includes(name))
    .map((l) => l.innerText.replace(/\s+/g, ' ').trim());
}
function allCertCount() {
  return [...document.querySelectorAll('li')].filter((l) => !l.querySelector('li') && l.innerText.includes('Hết hạn')).length;
}
function clickCertButton(name, label) {
  const li = [...document.querySelectorAll('li')].find((l) => !l.querySelector('li') && l.textContent.includes(name) && [...l.querySelectorAll('button')].some((b) => b.textContent.trim() === label));
  if (!li) throw new Error(`no cert card ${name}`);
  [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === label).click();
}
function activeDescr() {
  const a = document.activeElement;
  return a.getAttribute('name') || (a.getAttribute('aria-pressed') !== null ? `chip:${a.textContent.trim()}` : null) || (a.tagName === 'A' ? 'card-link' : a.tagName.toLowerCase() + ':' + (a.textContent || '').trim().slice(0, 20));
}

async function pressKey(key, code, vk, text) {
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(150);
}

async function applyFilters(f) {
  const now = await browser.ev(`(${readOpJobs})()`);
  if ((now.chips[0] === 'true') !== f.open) await browser.clickText('Chỉ tin đang tuyển', 'button');
  if ((now.chips[1] === 'true') !== f.seats) await browser.clickText('Còn chỗ', 'button');
  await browser.fill('.op-filter select[name=wageType]', f.wage);
  await browser.fill('.op-filter select[name=machineType]', f.machine);
  await browser.fill('.op-filter input[name=skill]', f.skill);
  await browser.fill('.op-filter input[name=q]', f.q);
  await sleep(150);
  return browser.ev(`(${readOpJobs})()`);
}

const ALL = { open: true, seats: false, q: '', wage: 'all', machine: 'all', skill: '' };
const SCENARIOS = [
  ['default: Open chip on', {}, 5],
  ['Open chip off includes CLOSED job', { open: false }, 6],
  ['Seats chip on drops full job', { seats: true }, 4],
  ['wage PER_HA', { wage: 'PER_HA' }, 2],
  ['wage PER_SHIFT', { wage: 'PER_SHIFT' }, 2],
  ['wage NEGOTIABLE with Open on: no match', { wage: 'NEGOTIABLE' }, 0],
  ['wage NEGOTIABLE with Open off: CLOSED job', { wage: 'NEGOTIABLE', open: false }, 1],
  ['machine harvester', { machine: 'harvester' }, 2],
  ['machine drone', { machine: 'drone' }, 1],
  ['skill lái máy', { skill: 'lái máy' }, 2],
  ['skill without diacritics: phun', { skill: 'phun' }, 1],
  ['search tinh bien without diacritics', { q: 'tinh bien' }, 1],
  ['search an giang matches locality', { q: 'an giang' }, 3],
  ['combined PER_HA + harvester + Seats', { wage: 'PER_HA', machine: 'harvester', seats: true }, 1],
  ['combined drone + harvester: empty', { q: 'drone', machine: 'harvester' }, 0],
];

try {
  await migrate(pool);
  const secret = randomBytes(32).toString('base64url');
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const evidenceStore = {
    async put() { return { etag: '"o03-o08-test"', versionId: null }; },
    async get() { return { bytes: pngBytes, contentType: 'image/png' }; },
    async remove() { return true; },
  };
  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret, evidenceStore }));
  log('disposable DB + two-service API ready', { db: db.name });

  const provider = await makeActor('provider', 1);
  const accepter = await makeActor('operator', 2);
  const filterOp = await makeActor('operator', 3);
  const o08Op = await makeActor('operator', 4);
  const admin = await makeActor('admin', 5);

  // Six real jobs through POST /api/jobs. Job D gets one accepted offer (seats 0); job E is closed.
  const jobSpecs = [
    { key: 'A', title: 'Gặt máy Thoại Sơn', locality: 'Thoại Sơn, An Giang', capacity: 2, wageType: 'PER_HA', wageAmountVnd: 500000, machineType: 'harvester', skills: ['gặt lúa', 'lái máy'] },
    { key: 'B', title: 'Lái máy kéo Châu Thành', locality: 'Châu Thành, Tiền Giang', capacity: 1, wageType: 'PER_SHIFT', wageAmountVnd: 1200000, machineType: 'tractor', skills: ['lái máy'] },
    { key: 'C', title: 'Phun thuốc bằng drone Cờ Đỏ', locality: 'Cờ Đỏ, Cần Thơ', capacity: 1, wageType: 'PER_HA', wageAmountVnd: 300000, machineType: 'drone', skills: ['Phun thuốc', 'drone'] },
    { key: 'D', title: 'Gặt lúa Tịnh Biên', locality: 'Tịnh Biên, An Giang', capacity: 1, wageType: 'PER_SHIFT', wageAmountVnd: 900000, machineType: 'harvester', skills: ['gặt lúa'] },
    { key: 'E', title: 'Gặt lúa Vĩnh Thạnh', locality: 'Vĩnh Thạnh, Cần Thơ', capacity: 1, wageType: 'NEGOTIABLE', machineType: 'harvester', skills: [] },
    { key: 'F', title: 'Bốc xếp thủ công Tri Tôn', locality: 'Tri Tôn, An Giang', capacity: 3, skills: ['bốc xếp'] },
  ];
  const jobIds = {};
  for (const [i, s] of jobSpecs.entries()) {
    const start = new Date(Date.now() + (10 + i) * 86400000);
    const body = { title: s.title, locality: s.locality, capacity: s.capacity, startAt: start.toISOString(), endAt: new Date(start.getTime() + 6 * 3600000).toISOString(), requiredSkills: s.skills };
    if (s.wageType) body.wageType = s.wageType;
    if (s.wageAmountVnd) body.wageAmountVnd = s.wageAmountVnd;
    if (s.machineType) body.machineType = s.machineType;
    jobIds[s.key] = (await must('POST', '/api/jobs', { token: provider.token, body })).job.id;
  }
  const app = await must('POST', `/api/jobs/${jobIds.D}/applications`, { token: accepter.token, body: {} });
  const offer = await must('POST', `/api/applications/${app.application.id}/offers`, { token: provider.token, body: {} });
  await must('POST', `/api/offers/${offer.offer.id}/accept`, { token: accepter.token, body: {} });
  await must('POST', `/api/jobs/${jobIds.E}/close`, { token: provider.token, body: {} });

  const jobRows = (await pool.query(`SELECT j.title, j.locality, j.status, j.wage_type, j.machine_type, j.required_skills,
      GREATEST(0, j.capacity - (SELECT count(*)::int FROM dispatch.offers o WHERE o.job_id = j.id AND o.status = 'ACCEPTED')) AS seats
    FROM dispatch.jobs j`)).rows;
  assert.equal(jobRows.length, 6, 'six real job rows');
  assert.equal(jobRows.find((r) => r.title === 'Gặt lúa Tịnh Biên').seats, 0, 'job D full in DB');
  assert.equal(jobRows.find((r) => r.title === 'Gặt lúa Vĩnh Thạnh').status, 'CLOSED', 'job E closed in DB');
  log('seeded 6 jobs via API; D full (1/1 accepted), E closed');

  // O-03 filters at mobile and desktop widths.
  for (const [width, height, mobile] of [[390, 844, true], [1440, 900, false]]) {
    const tag = `${width}px`;
    await session(filterOp, '#/tho-lai/', { width, height, mobile });
    await browser.hash('#/tho-lai/O-03');
    await browser.waitText('Hiện 5 / 6 tin tuyển.');
    const initial = await browser.ev(`(${readOpJobs})()`);
    assert.deepEqual([...initial.titles].sort(), expectedTitles(jobRows, ALL), `${tag} default visible cards match DB`);
    // O-03 has no one-click reset button (provider P-06 has one); reset is verified by restoring each control.
    log(`${tag} O-03 one-click reset control present: ${initial.resetControl}`);
    const layoutO03 = await browser.layout();
    assert.ok(layoutO03.sw <= layoutO03.w && layoutO03.wide.length === 0, `${tag} O-03 overflow ${JSON.stringify(layoutO03)}`);
    await browser.shot(join(SHOTS, `o03-default-${width}.png`));

    for (const [name, override, want] of SCENARIOS) {
      const f = { ...ALL, ...override };
      const ui = await applyFilters(f);
      const expected = expectedTitles(jobRows, f);
      assert.equal(expected.length, want, `${tag} ${name}: hand count vs DB rows`);
      assert.deepEqual([...ui.titles].sort(), expected, `${tag} ${name}: visible cards match DB`);
      assert.equal(ui.count, `Hiện ${want} / 6 tin tuyển.`, `${tag} ${name}: count line`);
      assert.equal(ui.empty, want === 0, `${tag} ${name}: empty state iff zero matches`);
      assert.deepEqual(ui.chips, [String(f.open), String(f.seats)], `${tag} ${name}: chip aria-pressed`);
      log(`${tag} O-03 ${name}: ${want} card(s) match DB`);
    }
    const filtered = await browser.layout();
    assert.ok(filtered.sw <= filtered.w && filtered.wide.length === 0, `${tag} O-03 filtered overflow ${JSON.stringify(filtered)}`);
    await browser.shot(join(SHOTS, `o03-empty-${width}.png`));

    // Reset by hand: no reset control exists, so restore every control to its default.
    await applyFilters({ ...ALL, open: false, seats: true, wage: 'PER_HA', machine: 'drone', skill: 'phun', q: 'cờ đỏ' });
    const reset = await applyFilters(ALL);
    assert.deepEqual([...reset.titles].sort(), expectedTitles(jobRows, ALL), `${tag} reset restores default cards`);
    assert.equal(reset.count, 'Hiện 5 / 6 tin tuyển.', `${tag} reset count`);
    assert.deepEqual(reset.chips, ['true', 'false'], `${tag} reset chips`);
    log(`${tag} reset by hand restores 5/6 and default chips`);

    // Keyboard: Tab order through filter controls, then Enter toggles the Seats chip.
    await browser.ev(`document.querySelector('.op-filter input[name=q]').focus()`);
    const tabOrder = [];
    for (let i = 0; i < 6; i += 1) {
      await pressKey('Tab', 'Tab', 9);
      tabOrder.push(await browser.ev(`(${activeDescr})()`));
    }
    assert.deepEqual(tabOrder.slice(0, 5), ['wageType', 'machineType', 'skill', 'chip:Chỉ tin đang tuyển', 'chip:Còn chỗ'], `${tag} tab order`);
    assert.equal(tabOrder[5], 'card-link', `${tag} sixth tab stop is first job card`);
    await browser.ev(`document.querySelectorAll('.op-radar-chip')[1].focus()`);
    await pressKey('Enter', 'Enter', 13, '\r');
    const seatsOn = await browser.ev(`(${readOpJobs})()`);
    assert.deepEqual(seatsOn.chips, ['true', 'true'], `${tag} Enter turns Seats chip on`);
    assert.equal(seatsOn.count, 'Hiện 4 / 6 tin tuyển.', `${tag} Enter Seats chip count`);
    await pressKey('Enter', 'Enter', 13, '\r');
    const seatsOff = await browser.ev(`(${readOpJobs})()`);
    assert.deepEqual(seatsOff.chips, ['true', 'false'], `${tag} Enter turns Seats chip off`);
    assert.equal(seatsOff.count, 'Hiện 5 / 6 tin tuyển.', `${tag} Enter Seats off count`);
    log(`${tag} keyboard: tab order ${tabOrder.join(' > ')}; Enter toggles Seats chip`);
  }

  // O-08 -> A-01 -> O-08. First certificate: declared, admin verifies, operator sees verified.
  await session(o08Op, '#/tho-lai/');
  await browser.hash('#/tho-lai/O-08');
  await browser.waitText('Chưa khai chứng chỉ.');
  await browser.fill('input[name=skills]', 'gặt lúa, lái máy');
  await browser.fill('input[name=certName]', CERT_A);
  await browser.fill('input[name=certExpiry]', '2028-06-30');
  await browser.ev(`document.querySelector('input[name=skills]').form.requestSubmit()`);
  await browser.waitFor(`(${certCards})(${JSON.stringify(CERT_A)}).some((t) => t.includes('Chưa xác minh'))`);
  const declaredA = await pollDb(() => certRows(o08Op.id), (r) => r.rows.length === 1, 'cert A declared');
  assert.equal(declaredA.rows[0].verification_status, 'UNVERIFIED');
  assert.equal(declaredA.rows[0].reviewed_by, null);
  log('O-08 cert A declared: UNVERIFIED in PG, card shows Chưa xác minh');

  await session(admin, '#/quan-tri/', { width: 1440, height: 900, mobile: false });
  await browser.hash('#/quan-tri/A-01');
  await browser.waitText(CERT_A);
  await browser.ev(`(${clickCertButton})(${JSON.stringify(CERT_A)}, 'Xác minh chứng chỉ')`);
  await browser.clickText('Xác minh', '.modal button');
  const verifiedA = await pollDb(() => certRows(o08Op.id), (r) => r.rows[0]?.verification_status === 'VERIFIED', 'admin verifies cert A');
  assert.equal(verifiedA.rows[0].reviewed_by, admin.id);
  assert.equal(verifiedA.rows[0].decided, true);
  log('A-01 admin verified cert A: PG VERIFIED, reviewed_by = admin');

  await session(o08Op, '#/tho-lai/');
  await browser.hash('#/tho-lai/O-08');
  await browser.waitFor(`(${certCards})(${JSON.stringify(CERT_A)}).some((t) => t.includes('Đã được quản trị viên xác minh'))`);
  const cardsAfterVerify = await browser.ev(`(${certCards})(${JSON.stringify(CERT_A)})`);
  assert.equal(cardsAfterVerify.length, 1, 'one card for cert A');
  assert.ok(!cardsAfterVerify[0].includes('Chưa xác minh'), 'verified card no longer shows Chưa xác minh');
  const o08Layout390 = await browser.layout();
  assert.ok(o08Layout390.sw <= o08Layout390.w && o08Layout390.wide.length === 0, `O-08 390 overflow ${JSON.stringify(o08Layout390)}`);
  await browser.shot(join(SHOTS, 'o08-verified-390.png'));
  log('O-08 reload after admin verify shows "Đã được quản trị viên xác minh"');

  // Second certificate: declared, admin rejects, operator sees "Không được xác minh"; first stays verified.
  await browser.fill('input[name=skills]', 'gặt lúa, lái máy, bảo dưỡng');
  await browser.fill('input[name=certName]', CERT_B);
  await browser.fill('input[name=certExpiry]', '2027-12-31');
  await browser.ev(`document.querySelector('input[name=skills]').form.requestSubmit()`);
  await browser.waitFor(`(${certCards})(${JSON.stringify(CERT_B)}).some((t) => t.includes('Chưa xác minh'))`);
  const declaredB = await pollDb(() => certRows(o08Op.id), (r) => r.rows.length === 2, 'cert B declared');
  assert.equal(declaredB.rows[1].verification_status, 'UNVERIFIED');
  assert.equal(declaredB.rows[0].verification_status, 'VERIFIED', 'cert A keeps VERIFIED after skills re-save');

  await session(admin, '#/quan-tri/', { width: 1440, height: 900, mobile: false });
  await browser.hash('#/quan-tri/A-01');
  await browser.waitText(CERT_B);
  await browser.ev(`(${clickCertButton})(${JSON.stringify(CERT_B)}, 'Không xác minh')`);
  await browser.clickText('Không xác minh', '.modal button');
  const rejectedB = await pollDb(() => certRows(o08Op.id), (r) => r.rows[1]?.verification_status === 'REJECTED', 'admin rejects cert B');
  assert.equal(rejectedB.rows[1].reviewed_by, admin.id);
  await browser.waitText('Đã quyết định lúc');
  log('A-01 admin rejected cert B: PG REJECTED, reviewed_by = admin');

  await session(o08Op, '#/tho-lai/', { width: 390, height: 844, mobile: true });
  await browser.hash('#/tho-lai/O-08');
  await browser.waitFor(`(${certCards})(${JSON.stringify(CERT_B)}).some((t) => t.includes('Không được xác minh'))`);
  await browser.waitFor(`document.body.innerText.includes(${JSON.stringify(CERT_A)})`);
  const cardA = await browser.ev(`(${certCards})(${JSON.stringify(CERT_A)})`);
  const cardB = await browser.ev(`(${certCards})(${JSON.stringify(CERT_B)})`);
  assert.equal(await browser.ev(`(${allCertCount})()`), 2, 'two cert cards on O-08');
  assert.ok(cardA[0].includes('Đã được quản trị viên xác minh') && !cardA[0].includes('Chưa xác minh') && !cardA[0].includes('Không được xác minh'), 'cert A verified only');
  assert.ok(cardB[0].includes('Không được xác minh') && !cardB[0].includes('Chưa xác minh'), 'cert B rejected only');
  // Keyboard spot-check on the O-08 form: skills -> certName -> certExpiry -> submit button.
  await browser.ev(`document.querySelector('input[name=skills]').focus()`);
  const o08Tab = [];
  for (let i = 0; i < 3; i += 1) {
    await pressKey('Tab', 'Tab', 9);
    o08Tab.push(await browser.ev(`(${activeDescr})()`));
  }
  // Chromium date input: Tab steps through its month and day segments, so the focused element stays certExpiry.
  assert.deepEqual(o08Tab, ['certName', 'certExpiry', 'certExpiry'], 'O-08 tab order through cert fields');
  const o08Layout = await browser.layout();
  assert.ok(o08Layout.sw <= o08Layout.w && o08Layout.wide.length === 0, `O-08 reload 390 overflow ${JSON.stringify(o08Layout)}`);
  await browser.ev(`[...document.querySelectorAll('li')].find((l)=>!l.querySelector('li')&&l.textContent.includes(${JSON.stringify(CERT_B)})).scrollIntoView({block:'center'})`);
  await sleep(400);
  await browser.shot(join(SHOTS, 'o08-final-390.png'));
  log('O-08 reload shows verified card A and rejected card B; tab order', o08Tab.join(' > '));

  await session(o08Op, '#/tho-lai/', { width: 1440, height: 900, mobile: false });
  await browser.hash('#/tho-lai/O-08');
  await browser.waitFor(`(${certCards})(${JSON.stringify(CERT_B)}).some((t) => t.includes('Không được xác minh'))`);
  const desktopLayout = await browser.layout();
  assert.ok(desktopLayout.sw <= desktopLayout.w && desktopLayout.wide.length === 0, `O-08 1440 overflow ${JSON.stringify(desktopLayout)}`);
  await browser.shot(join(SHOTS, 'o08-final-1440.png'));

  const finalRows = await certRows(o08Op.id);
  assert.deepEqual(finalRows.rows.map((r) => [r.name, r.verification_status, r.reviewed_by === admin.id, r.decided]), [
    [CERT_A, 'VERIFIED', true, true],
    [CERT_B, 'REJECTED', true, true],
  ]);
  log('PG cert rows final', JSON.stringify(finalRows.rows.map((r) => [r.name, r.verification_status])));

  pageErrors.push(...browser.errors);
  consoleErrors.push(...browser.consoleErrors);
  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], 'no browser console errors');
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
log('PASS operator workforce filters + O-08 transitions', { shots: SHOTS });
