// Browser regression for the local workforce path: P-08 recruitment, O-08 self-declared certificates,
// A-01 admin review, P-05 provider view, O-07 external wage acknowledgment.
// Disposable PostgreSQL + two real services + headless Chromium at 390 and 1440 px.
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

const log = (...args) => console.log('[workforce-path]', ...args);
const SHOTS = await mkdtemp(join(tmpdir(), 'agri-workforce-shots-'));
const PASSWORD = 'TestPass!12345';
const CERT_NAME = 'Vận hành máy gặt';
const CERT_EXPIRY = '2028-06-30';
const SKILLS_1 = 'gặt lúa, lái máy';
const SKILLS_2 = 'gặt lúa, lái máy, bảo dưỡng';
const WAGE_VND = '1250000';
const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const pageErrors = [];
const consoleErrors = [];
let browser;
let origin;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const localInput = (days, hour) => {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
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
  const phone = `0913${String(n).padStart(6, '0')}`;
  const reg = await must('POST', '/api/auth/register', { body: { phone, password: PASSWORD, name: `Thử ${role} ${n}` } });
  if (role !== 'farmer') await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1,$2) ON CONFLICT DO NOTHING', [reg.user.id, role]);
  const login = await must('POST', '/api/auth/login', { body: { phone, password: PASSWORD } });
  return { role, phone, id: reg.user.id, token: login.token };
}

// Each role gets a fresh browser profile so no session leaks between roles.
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

async function submitFormOf(selector) {
  await browser.ev(`document.querySelector(${JSON.stringify(selector)}).form.requestSubmit()`);
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

const certRows = (operatorId) => pool.query('SELECT name, verification_status, reviewed_by FROM dispatch.operator_certifications WHERE operator_id=$1 ORDER BY created_at', [operatorId]);

try {
  await migrate(pool);
  await seedCatalog(pool);
  const secret = randomBytes(32).toString('base64url');
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const evidenceStore = {
    async put() { return { etag: '"workforce-test"', versionId: null }; },
    async get() { return { bytes: pngBytes, contentType: 'image/png' }; },
    async remove() { return true; },
  };
  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { loginIpMax: 1000 } }));
  origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret, evidenceStore }));
  log('disposable DB + two-service API ready', { db: db.name });

  const farmer = await makeActor('farmer', 1);
  const coop = await makeActor('coop', 2);
  const provider = await makeActor('provider', 3);
  const operator = await makeActor('operator', 4);
  const admin = await makeActor('admin', 5);

  // A-01 backlog: an older pending certificate that falls past the first page. One PUT per certificate gives each row its own
  // created_at (a single PUT shares one transaction timestamp, which makes page order ambiguous). Newest first, the order is:
  // operator-4 cert, then backlog 50..1, then the oldest backlog cert (OLD_CERT), so OLD_CERT lands on page 3 (rows 41-52).
  const backlog = await makeActor('operator', 6);
  const OLD_CERT = 'Chứng chỉ tồn đọng';
  const putCerts = (certifications) => must('PUT', '/api/workforce/profile', { token: backlog.token, body: { skills: ['gặt lúa'], certifications } });
  await putCerts([{ name: OLD_CERT, expiresAt: '2028-01-01' }]);
  for (let n = 1; n <= 50; n += 1) await putCerts([{ name: `Chứng chỉ mới ${n}`, expiresAt: '2029-01-01' }]);
  const backlogRows = await pool.query('SELECT count(*)::int AS n FROM dispatch.operator_certifications WHERE operator_id=$1', [backlog.id]);
  assert.equal(backlogRows.rows[0].n, 51);

  // P-08: provider posts recruitment through the real form with wage, machine and skill requirements.
  await session(provider, '#/chu-may/');
  await browser.hash('#/chu-may/P-08');
  await browser.waitFor(`!!document.querySelector('input[name=title]')`);
  const jobTitle = 'Tuyển thợ máy gặt vụ Đông Xuân';
  await browser.fill('input[name=title]', jobTitle);
  await browser.fill('input[name=locality]', 'Thoại Sơn, An Giang');
  await browser.fill('input[name=capacity]', '1');
  await browser.fill('input[name=startLocal]', localInput(10, 7));
  await browser.fill('input[name=endLocal]', localInput(10, 13));
  await browser.fill('select[name=wageType]', 'PER_SHIFT');
  await browser.fill('input[name=wageAmountVnd]', '1500000');
  await browser.fill('select[name=machineType]', 'harvester');
  await browser.fill('input[name=requiredSkills]', 'gặt lúa, lái máy');
  await submitFormOf('input[name=title]');
  await browser.waitText('Đã đăng tin tuyển thợ');
  const [jobRow] = (await pool.query('SELECT id, wage_type, wage_amount_vnd, machine_type, required_skills, start_at, end_at FROM dispatch.jobs WHERE provider_id=$1 AND title=$2', [provider.id, jobTitle])).rows;
  assert.ok(jobRow, 'job persisted from P-08 form');
  assert.equal(jobRow.wage_type, 'PER_SHIFT');
  assert.equal(String(jobRow.wage_amount_vnd), '1500000');
  assert.equal(jobRow.machine_type, 'harvester');
  assert.deepEqual(jobRow.required_skills, ['gặt lúa', 'lái máy']);
  log('P-08 recruitment saved wage, machine and skills');

  // Recruitment handoff through the v2 UI: operator finds the job (O-03), opens it (O-04), applies (O-05); provider sends the
  // offer (P-09); operator accepts (O-06). These are real browser actions, not API fixtures. Accepted offer = hire commitment for P-05.
  await session(operator, '#/tho-lai/');
  await browser.hash('#/tho-lai/O-03');
  await browser.waitText(jobTitle);
  const oo3Overflow = await browser.layout();
  await browser.ev(`(()=>{const a=[...document.querySelectorAll('a.op-job')].find((x)=>x.textContent.includes(${JSON.stringify(jobTitle)}));if(!a)throw new Error('job card missing');a.click();})()`);
  await browser.waitText('Ứng tuyển ngay');
  await browser.ev(`(()=>{const a=[...document.querySelectorAll('a')].find((x)=>x.textContent.trim()==='Ứng tuyển ngay');if(!a)throw new Error('apply link missing');a.click();})()`);
  await browser.waitText('Lời nhắn gửi chủ máy');
  await browser.fill('textarea[name=note]', 'Đã lái máy gặt ba vụ');
  await submitFormOf('textarea[name=note]');
  await browser.waitFor(`location.hash.startsWith('#/tho-lai/O-06')`);
  await browser.waitText('Đã ứng tuyển');
  const applied = await pollDb(() => pool.query('SELECT id, status FROM dispatch.applications WHERE job_id=$1 AND operator_id=$2', [jobRow.id, operator.id]), (r) => r.rowCount === 1, 'application created');
  assert.equal(applied.rows[0].status, 'APPLIED');
  log('O-03 -> O-05 operator application stored as APPLIED');

  // P-09: provider sees the applicant on the job's applicant list and sends the offer through the confirm dialog.
  await session(provider, '#/chu-may/');
  await browser.hash('#/chu-may/P-09');
  await browser.waitText('Ứng viên và đề nghị');
  await browser.waitText('Gửi đề nghị nhận việc');
  const p09Overflow = await browser.layout();
  await browser.clickText('Gửi đề nghị nhận việc', 'button');
  await browser.clickText('Gửi đề nghị', '.modal button');
  await browser.waitText('Đã gửi đề nghị nhận việc');
  const sentOffer = await pollDb(() => pool.query('SELECT id, status FROM dispatch.offers WHERE job_id=$1 AND operator_id=$2', [jobRow.id, operator.id]), (r) => r.rowCount === 1, 'offer created');
  assert.equal(sentOffer.rows[0].status, 'OFFERED');
  log('P-09 provider offer stored as OFFERED');

  // O-06: operator sees the offer, the withdraw action is still available before accept, then accepts through the confirm dialog.
  await session(operator, '#/tho-lai/');
  await browser.hash('#/tho-lai/O-06');
  await browser.waitText('Nhận đề nghị');
  await browser.waitText('Rút ứng tuyển');
  await browser.clickText('Nhận đề nghị', 'button');
  await browser.clickText('Nhận đề nghị', '.modal button');
  await browser.waitText('Đã nhận việc');
  const accepted = await pollDb(() => pool.query('SELECT id, status FROM dispatch.offers WHERE id=$1', [sentOffer.rows[0].id]), (r) => r.rows[0]?.status === 'ACCEPTED', 'operator accepts offer');
  assert.equal(accepted.rows[0].status, 'ACCEPTED');
  assert.equal(await browser.ev(`document.body.innerText.includes('Rút ứng tuyển')`), false, 'withdraw absent after acceptance');
  const o06Overflow = await browser.layout();
  await browser.shot(join(SHOTS, 'o06-accepted-mobile.png'));
  log('O-06 operator accepted offer; withdraw absent after acceptance');

  // O-08: operator declares skills and one certificate. Declared only, not verified.
  await session(operator, '#/tho-lai/');
  await browser.hash('#/tho-lai/O-08');
  await browser.waitText('Chứng chỉ đã khai');
  await browser.fill('input[name=skills]', SKILLS_1);
  await browser.fill('input[name=certName]', CERT_NAME);
  await browser.fill('input[name=certExpiry]', CERT_EXPIRY);
  await submitFormOf('input[name=skills]');
  await browser.waitText('Chưa xác minh');
  const declared = await pollDb(() => certRows(operator.id), (r) => r.rows.length === 1, 'certificate declared');
  assert.equal(declared.rows[0].verification_status, 'UNVERIFIED');
  assert.equal(declared.rows[0].reviewed_by, null);
  log('O-08 declared certificate stored as UNVERIFIED');
  const o08Overflow = await browser.layout();
  await browser.shot(join(SHOTS, 'o08-mobile.png'));

  // A-01: admin reviews the declared certificate and rejects it with a confirmation step.
  await session(admin, '#/quan-tri/', { width: 1440, height: 900, mobile: false });
  await browser.hash('#/quan-tri/A-01');
  await browser.waitText('Chứng chỉ tự khai chờ xem xét');
  await browser.waitText(CERT_NAME);
  await browser.clickText('Không xác minh', 'button');
  await browser.clickText('Không xác minh', '.modal button');
  const rejected = await pollDb(() => certRows(operator.id), (r) => r.rows[0]?.verification_status === 'REJECTED', 'admin rejects certificate');
  assert.equal(rejected.rows[0].reviewed_by, admin.id);
  await browser.waitText('Không xác minh');
  const a01Overflow = await browser.layout();
  await browser.shot(join(SHOTS, 'a01-desktop.png'));
  log('A-01 admin rejection stored with reviewer metadata');

  // A-01 backlog: the oldest pending certificate sits past page 1 and must stay reachable through certificate paging.
  // created_at DESC: operator-4 cert (row 1), mới 50..mới 1 (rows 2-51), OLD_CERT (row 52). PAGE=20 gives
  // page 1 = rows 1-20 (ends at mới 32), page 2 = rows 21-40 (ends at mới 12), page 3 = rows 41-52 (holds OLD_CERT, ct=40).
  const backlogCert = await pool.query('SELECT id FROM dispatch.operator_certifications WHERE operator_id=$1 AND name=$2', [backlog.id, OLD_CERT]);
  assert.equal(backlogCert.rows.length, 1);
  await browser.hash('#/quan-tri/A-01');
  await browser.waitText('Chứng chỉ tự khai chờ xem xét');
  await browser.waitText('Chứng chỉ mới 32');
  assert.equal(await browser.ev(`document.body.innerText.includes(${JSON.stringify(OLD_CERT)})`), false, 'older pending certificate is not on page 1');
  await browser.click('a[aria-label="Trang sau chứng chỉ"]');
  await browser.waitFor(`location.hash.includes('ct=20')`);
  await browser.waitText('Chứng chỉ mới 12');
  assert.equal(await browser.ev(`document.body.innerText.includes(${JSON.stringify(OLD_CERT)})`), false, 'older pending certificate is not on page 2');
  await browser.click('a[aria-label="Trang sau chứng chỉ"]');
  await browser.waitFor(`location.hash.includes('ct=40')`);
  await browser.waitText(OLD_CERT);
  await browser.ev(`(()=>{const li=[...document.querySelectorAll('li')].find((l)=>l.textContent.includes(${JSON.stringify(OLD_CERT)}));if(!li)throw new Error('no old cert card');const b=[...li.querySelectorAll('button')].find((x)=>x.textContent.trim()==='Xác minh chứng chỉ');if(!b)throw new Error('no verify button');b.click();})()`);
  await browser.clickText('Xác minh', '.modal button');
  const oldVerified = await pollDb(() => pool.query('SELECT verification_status, reviewed_by FROM dispatch.operator_certifications WHERE id=$1', [backlogCert.rows[0].id]), (r) => r.rows[0]?.verification_status === 'VERIFIED', 'admin verifies page-3 certificate');
  assert.equal(oldVerified.rows[0].reviewed_by, admin.id);
  // Persisted decision: a hard reload on the same page shows the stored status on that card.
  // Persisted decision: a fresh browser session (new profile, new login) opens the same page and shows the stored status.
  await session(admin, '#/quan-tri/', { width: 1440, height: 900, mobile: false });
  await browser.hash('#/quan-tri/A-01?ct=40');
  await browser.waitFor(`location.hash.includes('ct=40')`);
  await browser.waitFor(`[...document.querySelectorAll('li')].some((l)=>l.textContent.includes(${JSON.stringify(OLD_CERT)})&&l.textContent.includes('Đã xác minh nội bộ'))`);
  // Mobile bottom controls: at 390 px the certificate pager must be tappable above the fixed tab bar.
  await browser.viewport(390, 844, true);
  await browser.waitText(OLD_CERT);
  const pagerHit = await browser.ev(`(()=>{const a=document.querySelector('a[aria-label="Trang trước chứng chỉ"]');if(!a)return 'missing';a.scrollIntoView({block:'center'});const r=a.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return Boolean(hit&&(hit===a||a.contains(hit)));})()`);
  assert.equal(pagerHit, true, 'certificate pager reachable at 390 px');
  const pagerLayout = await browser.layout();
  assert.ok(pagerLayout.sw <= pagerLayout.w && pagerLayout.wide.length === 0, `A-01 paging horizontal overflow at 390: ${JSON.stringify(pagerLayout)}`);
  await browser.shot(join(SHOTS, 'a01-cert-page3-mobile.png'));
  await browser.viewport(1440, 900, false);
  log('A-01 older pending certificate reached on page 3 and verified; decision persisted');

  // Regression: re-saving skills must not re-create the rejected certificate as UNVERIFIED.
  await session(operator, '#/tho-lai/');
  await browser.hash('#/tho-lai/O-08');
  await browser.waitText('Không được xác minh');
  await browser.fill('input[name=skills]', SKILLS_2);
  await submitFormOf('input[name=skills]');
  await pollDb(async () => (await pool.query('SELECT skills FROM dispatch.operator_profiles WHERE operator_id=$1', [operator.id])).rows[0], (r) => r && r.skills.length === 3, 'skills saved');
  const afterResave = await certRows(operator.id);
  assert.equal(afterResave.rows.length, 1, 'no duplicate certificate after re-save');
  assert.equal(afterResave.rows[0].verification_status, 'REJECTED');
  await browser.waitText('Không được xác minh');
  log('O-08 re-save keeps rejected certificate, no UNVERIFIED duplicate');

  // Use the accepted commitment in the real dispatch and shift APIs before recording wages.
  const { items: services } = await must('GET', '/api/services');
  const service = services.find((item) => item.code === 'harvest-combine');
  assert.ok(service);
  const { field } = await must('POST', '/api/fields', { token: farmer.token, body: { name: 'Ruộng thử', locality: 'Thoại Sơn, An Giang', areaM2: 10000 } });
  const { booking } = await must('POST', '/api/bookings', {
    token: farmer.token,
    key: randomBytes(16).toString('hex'),
    body: { fieldId: field.id, serviceId: service.id, startAt: jobRow.start_at.toISOString(), endAt: jobRow.end_at.toISOString() },
  });
  await must('POST', `/api/bookings/${booking.id}/coordinator`, { token: farmer.token, body: { coordinatorId: coop.id } });
  const { machine } = await must('POST', '/api/machines', { token: provider.token, body: { name: 'Máy gặt thử', type: 'harvester' } });
  const { package: pkg } = await must('POST', '/api/packages', { token: coop.token, body: { bookingIds: [booking.id] } });
  await must('POST', `/api/packages/${pkg.id}/claim`, { token: provider.token, body: { machineId: machine.id, operatorId: operator.id } });
  await must('POST', `/api/bookings/${booking.id}/readiness`, { token: farmer.token, body: { drained: true, mature: true, intakeReady: true } });
  await must('POST', `/api/bookings/${booking.id}/inspections`, { token: coop.token, body: { result: 'PASSED' } });
  const { shift } = await must('POST', `/api/packages/${pkg.id}/shifts/start`, { token: operator.token, body: {} });
  await must('POST', `/api/shifts/${shift.id}/complete`, { token: operator.token, body: { areaM2: 10000 } });

  // P-05: provider sees the accepted operator's declared profile with honest review status, then records external wage.
  await session(provider, '#/chu-may/');
  await browser.hash('#/chu-may/P-05');
  await browser.waitText('Thợ sẵn sàng gán ca');
  await browser.waitText(`Kỹ năng tự khai: ${SKILLS_2}`);
  await browser.waitText(`${CERT_NAME}, hạn ${CERT_EXPIRY}, không được xác minh`);
  const p05Overflow = await browser.layout();
  await browser.shot(join(SHOTS, 'p05-mobile.png'));
  await browser.fill(`input[name="amount-${shift.id}"]`, WAGE_VND);
  await browser.fill(`input[name="note-${shift.id}"]`, 'Thỏa thuận ngoài ứng dụng');
  await submitFormOf(`input[name="amount-${shift.id}"]`);
  const wage = await pollDb(() => pool.query('SELECT id, amount_vnd, reported_by FROM dispatch.shift_wage_reports WHERE shift_id=$1', [shift.id]), (r) => r.rows.length === 1, 'wage reported');
  assert.equal(String(wage.rows[0].amount_vnd), WAGE_VND);
  assert.equal(wage.rows[0].reported_by, provider.id);
  log('P-05 provider wage report stored');

  // O-07: operator acknowledges the external wage. Acknowledgment is not payment or acceptance.
  await session(operator, '#/tho-lai/');
  await browser.hash('#/tho-lai/O-07');
  await browser.waitText('Báo cáo tiền công');
  await browser.waitText('không phải xác nhận nghiệm thu');
  await browser.clickText('Xác nhận đã nhận khoản này ngoài ứng dụng', 'button');
  await browser.waitText('Đã ghi nhận xác nhận');
  await pollDb(() => pool.query('SELECT 1 FROM dispatch.shift_wage_acknowledgments WHERE report_id=$1 AND actor_id=$2', [wage.rows[0].id, operator.id]), (r) => r.rowCount === 1, 'operator acknowledged');
  const o07Overflow = await browser.layout();
  await browser.shot(join(SHOTS, 'o07-mobile.png'));
  log('O-07 operator acknowledgment stored');

  // Role boundaries: operator cannot read admin queue; reporter cannot acknowledge own report.
  assert.equal((await api('GET', '/api/admin/workforce/certifications', { token: operator.token })).status, 403);
  assert.equal((await api('POST', `/api/wage-reports/${wage.rows[0].id}/acknowledge`, { token: provider.token, body: {} })).status, 404);
  // Accepted hire commitment still present after review.
  const commit = await pool.query("SELECT status FROM dispatch.offers WHERE id=$1", [sentOffer.rows[0].id]);
  assert.equal(commit.rows[0].status, 'ACCEPTED');

  // Layout: no horizontal overflow on any checked screen.
  for (const [name, layout] of Object.entries({ o03: oo3Overflow, p09: p09Overflow, o06: o06Overflow, o08: o08Overflow, a01: a01Overflow, p05: p05Overflow, o07: o07Overflow })) {
    assert.ok(layout && layout.sw <= layout.w && layout.wide.length === 0, `${name} horizontal overflow: ${JSON.stringify(layout)}`);
  }

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
log('PASS workforce path', { shots: SHOTS });
