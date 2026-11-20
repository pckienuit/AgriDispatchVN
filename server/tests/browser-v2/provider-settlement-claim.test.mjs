// Browser test for provider P-02 access warnings, P-03 compatibility warnings, P-05 operator skills and certificates,
// and P-07 acceptance proposal plus receipt confirmation on /v2/.
// Always starts a fresh disposable PostgreSQL 17 Docker container (unique name) on loopback, with a unique database.
// Uses real account and app HTTP and headless Chromium at 390 and 1440 px. Synthetic identities only.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const log = (...args) => console.log('[provider-settlement-claim]', ...args);
const SHOTS = process.env.SETTLEMENT_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-settlement-shots-')));
await mkdir(SHOTS, { recursive: true });

const PASSWORD = 'TestPass!12345';
const secret = randomBytes(32).toString('base64url');
const pageErrors = [];
const consoleErrors = [];
const servers = [];
const evidence = {};

let containerName = null;
let rootUrl = process.env.TEST_DATABASE_URL || null;
let db = null;
let pool = null;
let origin = null;
let browser = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (offsetDays, hour) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function api(method, path, { token, body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function must(method, path, opts) {
  const res = await api(method, path, opts);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data;
}

async function makeActor(role, n) {
  const phone = `0916${String(n).padStart(6, '0')}`;
  const reg = await must('POST', '/api/auth/register', { body: { phone, password: PASSWORD, name: `Thử ${role} ${n}` } });
  if (role !== 'farmer') {
    await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1,$2) ON CONFLICT DO NOTHING', [reg.user.id, role]);
  }
  const login = await must('POST', '/api/auth/login', { body: { phone, password: PASSWORD } });
  return { role, phone, id: reg.user.id, name: `Thử ${role} ${n}`, token: login.token };
}

async function login(person, { width, height, mobile }) {
  if (browser) {
    pageErrors.push(...browser.errors);
    consoleErrors.push(...browser.consoleErrors);
    await browser.close();
  }
  browser = await open({ width, height, mobile });
  await browser.go(`${origin}/v2/`);
  await browser.waitFor('location.hash.startsWith("#/chung/C-01")');
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', person.phone);
  await browser.fill('input[name=password]', PASSWORD);
  await browser.click('form button[type=submit]');
  await browser.waitFor('location.hash.startsWith("#/chu-may/")');
}

async function assertLayoutNoOverflow(label) {
  const layout = await browser.layout();
  assert.ok(layout && layout.sw <= layout.w && layout.wide.length === 0, `${label} horizontal overflow: ${JSON.stringify(layout)}`);
}

// dt -> dd lookup for ui.kv rows, whitespace-normalised.
const kvValue = (label) => browser.ev(`(()=>{const dt=[...document.querySelectorAll('dt')].find(e=>e.textContent.trim()===${JSON.stringify(label)});return dt&&dt.nextElementSibling?dt.nextElementSibling.textContent.trim().replace(/\\s+/g,' '):null})()`);
const kvPairs = () => browser.ev(`[...document.querySelectorAll('dl.kv')].flatMap(dl=>[...dl.querySelectorAll(':scope > dt')].map(dt=>[dt.textContent.trim(), dt.nextElementSibling?dt.nextElementSibling.textContent.trim().replace(/\\s+/g,' '):null]))`);
const PICKS_JS = `[...document.querySelectorAll('.pick')].map(p=>({title:(p.querySelector('.pick__title')||{}).textContent?.trim()||null,reasons:[...p.querySelectorAll('.pick__reason')].map(r=>({cls:r.className,text:r.textContent.trim()}))}))`;
const reasonsOf = (picks, title) => picks.find((p) => p.title === title)?.reasons ?? null;

// Normalise like the UI: Intl vi-VN grouping plus " đ".
const vnd = (n) => `${new Intl.NumberFormat('vi-VN').format(BigInt(n))} đ`;

try {
  if (!rootUrl) {
    const dbPass = randomBytes(12).toString('hex');
    containerName = `agri-pg-settle-${randomBytes(4).toString('hex')}`;
    log('Spawning PostgreSQL 17 container:', containerName);
    execSync(`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=${dbPass} -e POSTGRES_DB=bootstrap_test -p 127.0.0.1::5432 postgres:17-alpine`, { stdio: 'ignore' });
    const port = execSync(`docker port ${containerName} 5432`, { encoding: 'utf8' }).trim().split('\n')[0].split(':').pop();
    rootUrl = `postgresql://postgres:${dbPass}@127.0.0.1:${port}/bootstrap_test`;
    for (let i = 0; i < 100; i++) {
      try {
        const probe = new pg.Client({ connectionString: rootUrl });
        await probe.connect();
        await probe.query('SELECT 1');
        await probe.end();
        break;
      } catch {
        await sleep(200);
      }
    }
  }

  db = await createDisposableDatabase(rootUrl);
  pool = createPool(db.url);
  log('Database ready:', db.name);
  await migrate(pool);
  await seedCatalog(pool);

  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const evidenceStore = {
    async put() { return { etag: '"p0201-test"', versionId: null }; },
    async get() { return { bytes: pngBytes, contentType: 'image/png' }; },
    async remove() { return true; },
  };
  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret, evidenceStore }));
  log('Account and app services on loopback HTTP');

  const farmer = await makeActor('farmer', 1);
  const coop = await makeActor('coop', 2);
  const provider = await makeActor('provider', 3);
  const opA = await makeActor('operator', 4);
  const opB = await makeActor('operator', 5);
  const admin = await makeActor('admin', 6);

  // ---------------------------------------------------------------------------
  // Prerequisites: synthetic machines, recruitment commitments, field access facts, bookings delegated to HTX.
  // These are out-of-scope setup for the four provider screens under test; every provider-visible check runs in the UI.
  // ---------------------------------------------------------------------------
  const services = (await must('GET', '/api/services')).items;
  const harvestSvc = services.find((s) => s.code === 'harvest-combine');
  assert.ok(harvestSvc, 'harvest-combine service in catalog');

  await must('POST', '/api/machines', { token: provider.token, body: { name: 'Máy gặt Kubota DC70', type: 'harvester' } });
  await must('POST', '/api/machines', { token: provider.token, body: { name: 'Máy kéo Kubota test', type: 'tractor' } });

  const jobA = (await must('POST', '/api/jobs', {
    token: provider.token,
    body: {
      title: 'Tuyển thợ gặt P0201 lịch dài', locality: 'Thoại Sơn, An Giang', capacity: 2,
      startAt: iso(1, 6), endAt: iso(20, 18), wageType: 'PER_SHIFT', wageAmountVnd: 1200000, machineType: 'harvester', requiredSkills: ['gặt lúa'],
    },
  })).job;
  const jobB = (await must('POST', '/api/jobs', {
    token: provider.token,
    body: { title: 'Tuyển thợ gặt P0201 lịch khác', locality: 'Thoại Sơn, An Giang', capacity: 1, startAt: iso(30, 6), endAt: iso(31, 18) },
  })).job;

  // Each operator accepts one offer. A covers the package window on day +5; B does not.
  const hire = async (job, op) => {
    const application = (await must('POST', `/api/jobs/${job.id}/applications`, { token: op.token, body: {} })).application;
    const offer = (await must('POST', `/api/applications/${application.id}/offers`, { token: provider.token, body: {} })).offer;
    await must('POST', `/api/offers/${offer.id}/accept`, { token: op.token, body: {} });
  };
  await hire(jobA, opA);
  await hire(jobB, opB);

  const field = async (name, areaM2, access) => {
    const f = (await must('POST', '/api/fields', { token: farmer.token, body: { name, locality: 'Thoại Sơn, An Giang', areaM2 } })).field;
    await must('PUT', `/api/fields/${f.id}/details`, { token: farmer.token, body: { access } });
    return f;
  };
  // Narrow road (2.5 m) plus low bridge (4 t) field, plus a normal field with boat dock.
  const f1 = await field('Ruộng hẹp P0201', 12000, { roadWidthM: 2.5, bridgeLoadT: 4, soil: 'firm', hasBoatDock: false });
  const f2 = await field('Ruộng bến ghe P0201', 15000, { roadWidthM: 3.5, bridgeLoadT: 8, soil: 'firm', hasBoatDock: true });
  const f3 = await field('Ruộng thanh toán P0201', 14000, { roadWidthM: 3.5, bridgeLoadT: 8, soil: 'firm', hasBoatDock: false });

  const book = async (f, label) => {
    const b = (await must('POST', '/api/bookings', {
      token: farmer.token,
      key: `p0201-booking-${label}-${randomBytes(6).toString('hex')}`,
      body: { fieldId: f.id, serviceId: harvestSvc.id, startAt: iso(5, 8), endAt: iso(5, 12) },
    })).booking;
    await must('POST', `/api/bookings/${b.id}/coordinator`, { token: farmer.token, body: { coordinatorId: coop.id } });
    return b;
  };
  const b1 = await book(f1, 'b1');
  const b2 = await book(f2, 'b2');
  const b3 = await book(f3, 'b3');
  assert.ok(/^\d+$/.test(b3.totalVnd), 'booking DTO carries totalVnd');

  const pkgA = (await must('POST', '/api/packages', { token: coop.token, body: { bookingIds: [b1.id, b2.id] } })).package;
  const pkgB = (await must('POST', '/api/packages', { token: coop.token, body: { bookingIds: [b3.id] } })).package;
  assert.equal(pkgA.status, 'OPEN');
  assert.equal(pkgB.status, 'OPEN');

  // Operator A declares skills and two certificates; admin verifies one and rejects one, leaving one unverified.
  await must('PUT', '/api/workforce/profile', {
    token: opA.token,
    body: {
      skills: ['Gặt lúa', 'Lái máy gặt'],
      certifications: [
        { name: 'Chứng chỉ lái máy gặt P0201', expiresAt: '2035-06-30' },
        { name: 'Chứng chỉ sơ cứu P0201', expiresAt: '2030-01-01' },
        { name: 'Chứng chỉ bị từ chối P0201', expiresAt: '2031-03-31' },
      ],
    },
  });
  const certs = (await must('GET', '/api/admin/workforce/certifications?limit=100&offset=0', { token: admin.token })).items;
  const reviewStatus = { 'Chứng chỉ lái máy gặt P0201': 'VERIFIED', 'Chứng chỉ bị từ chối P0201': 'REJECTED' };
  for (const cert of certs.filter((c) => reviewStatus[c.name])) {
    await must('POST', `/api/admin/workforce/certifications/${cert.id}/review`, { token: admin.token, body: { status: reviewStatus[cert.name] } });
  }
  const dbCerts = (await pool.query('SELECT name, verification_status FROM dispatch.operator_certifications WHERE operator_id=$1 ORDER BY name', [opA.id])).rows;
  assert.deepEqual(dbCerts.map((r) => [r.name, r.verification_status]), [
    ['Chứng chỉ bị từ chối P0201', 'REJECTED'],
    ['Chứng chỉ lái máy gặt P0201', 'VERIFIED'],
    ['Chứng chỉ sơ cứu P0201', 'UNVERIFIED'],
  ]);

  // ---------------------------------------------------------------------------
  // P-02: package access card and warn banner (OPEN package A, one narrow-road and one low-bridge booking)
  // ---------------------------------------------------------------------------
  log('Step 1: P-02 access warnings, 390 px');
  await login(provider, { width: 390, height: 844, mobile: true });
  await browser.hash(`#/chu-may/P-02?id=${pkgA.id}`);
  await browser.waitText(`Gói việc ${pkgA.id.slice(0, 8)}`);
  await browser.waitText('Đường vào và đất ruộng');
  await browser.waitText('Hạn chế xe fooc');
  const p02Warn = await browser.ev(`[...document.querySelectorAll('.note--warn')].map(n=>n.textContent.trim().replace(/\\s+/g,' '))`);
  assert.ok(p02Warn.some((t) => t.includes('Hạn chế xe fooc')), `P-02 warn banner present: ${JSON.stringify(p02Warn)}`);
  const p02Kv = await kvPairs();
  const p02Access = {
    narrowRoad: p02Kv.find(([k]) => k === 'Đường dưới 3 m')?.[1],
    lowBridge: p02Kv.find(([k]) => k === 'Cầu dưới 5 tấn')?.[1],
    boggy: p02Kv.find(([k]) => k === 'Đất sình lầy')?.[1],
    boatDock: p02Kv.find(([k]) => k === 'Có bến ghe')?.[1],
    incomplete: p02Kv.find(([k]) => k === 'Chưa đủ thông tin')?.[1],
  };
  assert.deepEqual(p02Access, { narrowRoad: '1 đơn', lowBridge: '1 đơn', boggy: '0 đơn', boatDock: '1 đơn', incomplete: '0 đơn' });
  await assertLayoutNoOverflow('P-02 access 390');
  await browser.ev(`Array.from(document.querySelectorAll('main section, section')).find(el => el.textContent.includes('Đường vào và đất ruộng'))?.scrollIntoView({block:'center'})`);
  await browser.shot(join(SHOTS, 'p02-access-warn-390.png'));
  evidence.p02 = { warnBanner: p02Warn, access: p02Access, viewport: 390 };

  await browser.viewport(1440, 900, false);
  await browser.waitText('Hạn chế xe fooc');
  await assertLayoutNoOverflow('P-02 access 1440');
  await browser.shot(join(SHOTS, 'p02-access-warn-1440.png'));
  evidence.p02.desktopOk = true;

  // ---------------------------------------------------------------------------
  // P-03: compatibility and window warn labels on the open package (no claim yet)
  // ---------------------------------------------------------------------------
  log('Step 2: P-03 compatibility and window warnings');
  await browser.viewport(390, 844, true);
  await browser.hash(`#/chu-may/P-03?id=${pkgA.id}`);
  await browser.waitText('Chọn máy thực hiện');
  await browser.waitText('Chọn thợ lái');
  await browser.waitText(opB.name);
  const picks = await browser.ev(PICKS_JS);
  assert.deepEqual(reasonsOf(picks, 'Máy kéo Kubota test'), [{ cls: 'pick__reason pick__reason--warn', text: 'Cần Máy gặt đập liên hợp.' }]);
  assert.deepEqual(reasonsOf(picks, 'Máy gặt Kubota DC70'), [{ cls: 'pick__reason pick__reason--ok', text: 'Phù hợp dịch vụ và sẵn sàng' }]);
  assert.deepEqual(reasonsOf(picks, opB.name), [{ cls: 'pick__reason pick__reason--warn', text: 'Chưa bao trọn khung giờ của gói' }]);
  assert.deepEqual(reasonsOf(picks, opA.name), [{ cls: 'pick__reason pick__reason--ok', text: 'Bao trọn khung giờ của gói' }]);
  assert.equal(await kvValue('Máy đã chọn'), 'Máy gặt Kubota DC70 (Máy gặt đập liên hợp)', 'default machine is the compatible harvester');
  assert.equal(await kvValue('Thợ lái đã chọn'), opA.name, 'default operator is the covering one');
  await assertLayoutNoOverflow('P-03 390');
  await browser.ev(`Array.from(document.querySelectorAll('.pick')).find(p => p.textContent.includes('Máy kéo Kubota test'))?.scrollIntoView({block:'center'})`);
  await browser.shot(join(SHOTS, 'p03-compat-warn-390.png'));
  evidence.p03 = { picks, defaultMachine: 'Máy gặt Kubota DC70', defaultOperator: opA.name, viewport: 390 };

  await browser.viewport(1440, 900, false);
  await browser.waitText('Chưa bao trọn khung giờ của gói');
  await assertLayoutNoOverflow('P-03 1440');
  await browser.shot(join(SHOTS, 'p03-compat-warn-1440.png'));
  evidence.p03.desktopOk = true;

  // ---------------------------------------------------------------------------
  // P-03 claim through the UI on package B (default compatible machine + covering operator A)
  // ---------------------------------------------------------------------------
  log('Step 3: claim package B through P-03 UI');
  await browser.viewport(390, 844, true);
  await browser.hash(`#/chu-may/P-03?id=${pkgB.id}`);
  await browser.waitText('Xác nhận nhận gói việc');
  await browser.clickText('Xác nhận nhận gói việc', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Nhận gói việc', '[role=dialog] button');
  await browser.waitFor('location.hash.startsWith("#/chu-may/P-02")');
  await browser.waitText('Nghiệm thu và tiền');
  const claimed = (await pool.query('SELECT status, machine_id, operator_id FROM dispatch.packages WHERE id=$1', [pkgB.id])).rows[0];
  assert.equal(claimed.status, 'CLAIMED');
  assert.equal(claimed.operator_id, opA.id);

  // Shift lifecycle prerequisite (API): readiness, HTX pass, shift start, completion.
  await must('POST', `/api/bookings/${b3.id}/readiness`, { token: farmer.token, body: { drained: true, mature: true, intakeReady: true } });
  await must('POST', `/api/bookings/${b3.id}/inspections`, { token: coop.token, body: { result: 'PASSED' } });
  const started = await must('POST', `/api/packages/${pkgB.id}/shifts/start`, { token: opA.token, body: {} });
  await must('POST', `/api/shifts/${started.shift.id}/complete`, { token: opA.token, body: { areaM2: 14000, note: 'Gặt xong P0201' } });

  // ---------------------------------------------------------------------------
  // P-05: operator declared skills and certificate verification state
  // ---------------------------------------------------------------------------
  log('Step 4: P-05 operator skills and certificates');
  await browser.hash('#/chu-may/P-01');
  await browser.hash('#/chu-may/P-05');
  await browser.waitText(opA.name);
  await browser.waitText('Chứng chỉ lái máy gặt P0201');
  const rowA = await browser.ev(`(()=>{const tr=[...document.querySelectorAll('tr')].find(t=>t.textContent.includes(${JSON.stringify(opA.name)}));return tr?tr.innerText.replace(/\\s+/g,' '):null})()`);
  assert.ok(rowA, 'P-05 row for operator A');
  // Each skill / certificate line needs its own vertical position; innerText alone cannot show merged lines.
  const lineTops = await browser.ev(`(()=>{const tr=[...document.querySelectorAll('tr')].find(t=>t.textContent.includes(${JSON.stringify(opA.name)}));return [...tr.querySelectorAll('span,div')].filter(e=>e.childElementCount===0&&/Kỹ năng tự khai|Chứng chỉ /.test(e.textContent)).map(e=>Math.round(e.getBoundingClientRect().top))})()`);
  assert.equal(lineTops.length, 4, `P-05 expected 1 skills line + 3 cert lines, got tops ${JSON.stringify(lineTops)}`);
  assert.equal(new Set(lineTops).size, 4, `P-05 skills and cert lines must not share a line box: tops ${JSON.stringify(lineTops)}`);
  evidence.p05LineTops390 = lineTops;
  for (const s of ['Kỹ năng tự khai: Gặt lúa, Lái máy gặt', 'Chứng chỉ lái máy gặt P0201, hạn 2035-06-30, đã được quản trị viên xác minh', 'Chứng chỉ sơ cứu P0201, hạn 2030-01-01, chưa xác minh', 'Chứng chỉ bị từ chối P0201, hạn 2031-03-31, không được xác minh']) {
    assert.ok(rowA.includes(s), `P-05 row shows "${s}" in ${rowA}`);
  }
  const rowB = await browser.ev(`(()=>{const tr=[...document.querySelectorAll('tr')].find(t=>t.textContent.includes(${JSON.stringify(opB.name)}));return tr?tr.innerText.replace(/\\s+/g,' '):null})()`);
  // Operator B never declared a profile: API returns empty skills and no certificates, so the row shows "Chưa khai".
  assert.ok(rowB && rowB.includes('Kỹ năng tự khai: Chưa khai') && !rowB.includes('hạn '), `operator B empty profile row: ${rowB}`);
  await assertLayoutNoOverflow('P-05 390');
  await browser.shot(join(SHOTS, 'p05-operator-certs-390.png'));
  await browser.viewport(1440, 900, false);
  await browser.waitText('đã được quản trị viên xác minh');
  const lineTops1440 = await browser.ev(`(()=>{const tr=[...document.querySelectorAll('tr')].find(t=>t.textContent.includes(${JSON.stringify(opA.name)}));return [...tr.querySelectorAll('span,div')].filter(e=>e.childElementCount===0&&/Kỹ năng tự khai|Chứng chỉ /.test(e.textContent)).map(e=>({t:e.textContent.trim().slice(0,30),top:Math.round(e.getBoundingClientRect().top),h:Math.round(e.getBoundingClientRect().height)}))})()`);
  evidence.p05Lines1440 = lineTops1440;
  assert.equal(new Set(lineTops1440.map((x) => x.top)).size, 4, `P-05 1440 skills and cert lines share a line box: ${JSON.stringify(lineTops1440)}`);
  await assertLayoutNoOverflow('P-05 1440');
  await browser.shot(join(SHOTS, 'p05-operator-certs-1440.png'));
  evidence.p05 = { operatorRow: rowA, otherOperatorRow: rowB };

  // ---------------------------------------------------------------------------
  // P-07: provider proposes acceptance v1 (UI), provider consents (UI), farmer consents (API), farmer reports payment (API),
  // provider confirms receipt (UI). Outstanding must drop to 0 in DOM and PostgreSQL.
  // ---------------------------------------------------------------------------
  log('Step 5: P-07 propose acceptance v1 via UI, 390 px');
  await browser.viewport(390, 844, true);
  await browser.hash('#/chu-may/P-01');
  await browser.hash(`#/chu-may/P-07?id=${b3.id}`);
  await browser.waitText('Gửi đề nghị nghiệm thu');
  await browser.fill('input[name=areaM2]', '14000');
  await browser.fill('input[name=totalVnd]', b3.totalVnd);
  await browser.clickText('Gửi đề nghị nghiệm thu', 'button');
  await browser.waitText('Đồng ý nghiệm thu v1');
  const proposed = (await pool.query('SELECT version, area_m2, total_vnd FROM dispatch.acceptances WHERE booking_id=$1', [b3.id])).rows;
  assert.deepEqual(proposed.map((r) => [r.version, Number(r.area_m2), r.total_vnd]), [[1, 14000, b3.totalVnd]]);
  assert.equal(await kvValue('Chủ ruộng đồng ý'), 'Chưa đồng ý');

  log('Step 5b: provider consents v1 via UI');
  await browser.clickText('Đồng ý nghiệm thu v1', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Đồng ý nghiệm thu', '[role=dialog] button');
  await browser.waitFor('![...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Đồng ý nghiệm thu v1")');
  assert.equal(await kvValue('Chủ máy đồng ý'), 'Đã đồng ý');

  log('Step 6: farmer consents v1 and reports payment (API)');
  await must('POST', `/api/bookings/${b3.id}/acceptance/1/consent`, { token: farmer.token, body: {} });
  const agreed = (await must('GET', `/api/bookings/${b3.id}/acceptance`, { token: farmer.token })).acceptance;
  assert.equal(agreed.agreed, true);
  await must('POST', `/api/bookings/${b3.id}/payments`, { token: farmer.token, body: { amountVnd: b3.totalVnd, reference: 'P0201-SETTLE-0001' } });
  const beforeConfirm = (await must('GET', `/api/bookings/${b3.id}/payments`, { token: farmer.token })).summary;
  assert.equal(beforeConfirm.outstandingVnd, b3.totalVnd, 'reported but unconfirmed payment does not reduce outstanding');

  log('Step 7: provider sees reported payment on P-07, 1440 px, and confirms receipt');
  await browser.viewport(1440, 900, false);
  await browser.hash('#/chu-may/P-01');
  await browser.hash(`#/chu-may/P-07?id=${b3.id}`);
  await browser.waitText('Xác nhận đã nhận ngoài hệ thống');
  const outBefore = await kvValue('Còn lại chưa xác nhận');
  assert.equal(outBefore, vnd(b3.totalVnd), `outstanding before confirm in DOM: ${outBefore}`);
  await browser.shot(join(SHOTS, 'p07-reported-1440.png'));
  await browser.clickText('Xác nhận đã nhận ngoài hệ thống', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Đã nhận đủ', '[role=dialog] button');
  await browser.waitFor('![...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Xác nhận đã nhận ngoài hệ thống")');
  await browser.waitFor(`(()=>{const dt=[...document.querySelectorAll('dt')].find(e=>e.textContent.trim()==='Còn lại chưa xác nhận');return !!(dt&&dt.nextElementSibling&&dt.nextElementSibling.textContent.trim()==='0 đ')})()`);
  const outDom = await kvValue('Còn lại chưa xác nhận');
  const confirmedDom = await kvValue('Thanh toán thêm đã xác nhận');
  assert.equal(outDom, '0 đ');
  assert.equal(confirmedDom, vnd(b3.totalVnd));
  await assertLayoutNoOverflow('P-07 1440 settled');
  await browser.shot(join(SHOTS, 'p07-settled-1440.png'));

  // PostgreSQL and API cross-check: no deposit rows, one payment, one confirmation event, computed outstanding 0.
  const pgRows = (await pool.query(`SELECT p.id, p.amount_vnd::text AS amount, (SELECT count(*)::int FROM dispatch.payment_events e WHERE e.payment_id=p.id AND e.event_type='PAYMENT_CONFIRMED') AS confirmed
      FROM dispatch.payments p WHERE p.booking_id=$1`, [b3.id])).rows;
  assert.equal(pgRows.length, 1);
  assert.equal(pgRows[0].confirmed, 1);
  const pgAgreed = (await pool.query('SELECT total_vnd::text AS t FROM dispatch.acceptances WHERE booking_id=$1 AND version=1', [b3.id])).rows[0].t;
  const pgConfirmed = BigInt(pgRows[0].amount);
  const pgOutstanding = BigInt(pgAgreed) - pgConfirmed;
  assert.equal(pgOutstanding.toString(), '0', 'PostgreSQL computed outstanding is 0');
  const afterConfirm = (await must('GET', `/api/bookings/${b3.id}/payments`, { token: farmer.token })).summary;
  assert.equal(afterConfirm.outstandingVnd, '0');
  evidence.p07 = { agreedVnd: pgAgreed, outstandingBeforeConfirmDom: outBefore, outstandingAfterConfirmDom: outDom, confirmedDom, pgOutstanding: pgOutstanding.toString(), apiOutstanding: afterConfirm.outstandingVnd };

  log('Step 7b: P-07 settled view at 390 px');
  await browser.viewport(390, 844, true);
  await browser.hash('#/chu-may/P-01');
  await browser.hash(`#/chu-may/P-07?id=${b3.id}`);
  await browser.waitFor(`(()=>{const dt=[...document.querySelectorAll('dt')].find(e=>e.textContent.trim()==='Còn lại chưa xác nhận');return !!(dt&&dt.nextElementSibling&&dt.nextElementSibling.textContent.trim()==='0 đ')})()`);
  await assertLayoutNoOverflow('P-07 390 settled');
  await browser.shot(join(SHOTS, 'p07-settled-390.png'));

  // Error and console accounting. Postponement GET returns 404 for claimed packages by design (client maps it to null);
  // Chromium logs that as a resource error. Any other console error or uncaught exception fails the run.
  pageErrors.push(...browser.errors);
  consoleErrors.push(...browser.consoleErrors);
  const expectedNoise = consoleErrors.filter((e) => /Failed to load resource/.test(e) && /\/api\/packages\/[0-9a-f-]{36}\/postponement/.test(e));
  const unexpected = consoleErrors.filter((e) => !expectedNoise.includes(e));
  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(unexpected, [], `unexpected console errors: ${unexpected.join(' | ')}`);
  evidence.consoleAccounting = { expectedPostponement404: expectedNoise.length, unexpected: unexpected.length, uncaught: pageErrors.length };

  for (const f of ['p02-access-warn-390.png', 'p02-access-warn-1440.png', 'p03-compat-warn-390.png', 'p03-compat-warn-1440.png', 'p05-operator-certs-390.png', 'p05-operator-certs-1440.png', 'p07-reported-1440.png', 'p07-settled-1440.png', 'p07-settled-390.png']) {
    const s = await stat(join(SHOTS, f));
    assert.ok(s.size > 1000, `screenshot ${f} too small (${s.size})`);
  }
  await writeFile(join(SHOTS, 'evidence.json'), JSON.stringify(evidence, null, 2));
  log('EVIDENCE', JSON.stringify(evidence.consoleAccounting));
  log('ALL P-02, P-03, P-05 AND P-07 ASSERTIONS PASSED CLEANLY');
} finally {
  try { if (browser) await browser.close(); } catch (err) { void err; }
  try {
    await Promise.all(servers.map((s) => new Promise((resolve) => { s.close(resolve); s.closeAllConnections?.(); })));
  } catch (err) { void err; }
  try { if (pool) await pool.end(); } catch (err) { void err; }
  try { if (db) await db.drop(); } catch (err) { void err; }
  if (containerName) {
    try { execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' }); log('Removed container:', containerName); } catch (err) { void err; }
  }
}
