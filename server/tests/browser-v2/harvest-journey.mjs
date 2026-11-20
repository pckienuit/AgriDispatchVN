// Cross-role regression: one harvest request moves through four real v2 role surfaces.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';
import { open } from './cdp.mjs';

const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool = createPool(db.url);
const servers = [];
const password = randomBytes(18).toString('base64url');
const internalServiceToken = randomBytes(32).toString('base64url');
const label = `E2E gặt ${randomBytes(4).toString('hex')}`;
const quiet = () => {};
let browser;
let origin;

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function api(path, { actor, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status}, ${data.error?.code ?? 'unexpected response'}`);
  return data;
}

async function actor(role, n) {
  const phone = `090${String(n).padStart(7, '0')}`;
  const { user } = await api('/api/auth/register', { body: { name: `Kiểm thử ${role}`, phone, password } });
  if (role !== 'farmer') {
    await pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user.id, role]);
  }
  const { token } = await api('/api/auth/login', { body: { phone, password } });
  return { id: user.id, phone, token };
}

async function login(person, slug) {
  await browser.go(`${origin}/v2/`);
  await browser.waitFor('!!document.querySelector("input[name=phone]")');
  await browser.fill('input[name=phone]', person.phone);
  await browser.fill('input[name=password]', password);
  await browser.click('form button[type=submit]');
  await browser.waitFor(`location.hash.startsWith(${JSON.stringify(`#/${slug}/`)})`);
}

async function currentId() {
  const id = await browser.ev('new URLSearchParams(location.hash.split("?")[1]).get("id")');
  assert.match(id ?? '', /^[0-9a-f-]{36}$/);
  return id;
}

const utc = (days, hour) => {
  const date = new Date(Date.now() + days * 86400000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

try {
  await migrate(pool);
  await seedCatalog(pool);
  const accountServiceUrl = await listen(createAccountApp({ pool, internalServiceToken, log: quiet }));
  origin = await listen(createApp({ pool, accountServiceUrl, internalServiceToken, log: quiet }));
  const farmer = await actor('farmer', 1);
  const coop = await actor('coop', 2);
  const provider = await actor('provider', 3);
  const operator = await actor('operator', 4);
  const admin = await actor('admin', 5);
  const startAt = utc(14, 8);
  const endAt = utc(14, 12);
  const services = await api('/api/services');
  const harvest = services.items.find((item) => item.code === 'harvest-combine');
  assert.ok(harvest);

  // Set up only workforce and machine prerequisites; all dispatch writes below come from v2 UI.
  const { job } = await api('/api/jobs', { actor: provider, body: { title: label, locality: 'Xã thử nghiệm', capacity: 1, startAt: utc(14, 7), endAt: utc(14, 13) } });
  const { application } = await api(`/api/jobs/${job.id}/applications`, { actor: operator, body: {} });
  const { offer } = await api(`/api/applications/${application.id}/offers`, { actor: provider, body: {} });
  await api(`/api/offers/${offer.id}/accept`, { actor: operator, body: {} });
  await api('/api/machines', { actor: provider, body: { name: 'Máy gặt kiểm thử', type: 'harvester' } });

  browser = await open();
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  const commune = `${label} xã`;
  const territoriesPath = `/api/admin/coops/${coop.id}/territories`;
  await browser.viewport(1440, 900, false);
  await login(admin, 'quan-tri');
  await browser.hash(`#/quan-tri/A-02?coop=${coop.id}`);
  await browser.waitText('HTX chưa được gán xã');
  for (const [name, value] of Object.entries({ provinceName: 'Tỉnh kiểm thử', provinceCode: 'TEST', communeName: commune, communeCode: 'TEST-XA' })) {
    await browser.fill(`input[name=${name}]`, value);
  }
  await browser.clickText('Gán xã cho HTX', 'button');
  await browser.waitText(`${commune}, Tỉnh kiểm thử`);
  const assignment = (await api(territoriesPath, { actor: admin })).items.find((item) => item.communeName === commune);
  assert.ok(assignment, 'A-02 persists selected commune for selected coop');

  await browser.viewport(390, 844, true);
  await login(coop, 'htx');
  await browser.hash('#/htx/H-01');
  await browser.waitText(`${commune}, Tỉnh kiểm thử`);
  assert.equal((await api('/api/htx/territories/overview', { actor: coop })).delegated.bookingCount, 0);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  await login(farmer, 'nong-dan');
  await browser.hash('#/nong-dan/F-03');
  await browser.waitFor('!!document.querySelector("input[name=areaM2]")');
  await browser.fill('input[name=name]', label);
  await browser.fill('input[name=locality]', 'Xã thử nghiệm');
  await browser.fill('input[name=areaM2]', '12000');
  await browser.clickText('Lưu thửa ruộng', 'button');
  await browser.waitFor('location.hash.startsWith("#/nong-dan/F-02")');
  await browser.waitText(label);
  const field = (await api('/api/fields', { actor: farmer })).items.find((item) => item.name === label);
  assert.ok(field, 'F-03 saves field to PostgreSQL');

  assert.ok(await browser.ev('!!document.querySelector(\'a[href*="F-04?"]\')'), 'F-02 links to access details for the field');
  await browser.click('a[href*="F-04?"]');
  await browser.waitText('Đường vào và đất ruộng');
  for (const [name, value] of Object.entries({ roadWidthM: '2.5', bridgeLoadT: '4', soil: 'boggy', hasBoatDock: 'yes' })) {
    await browser.fill(`select[name=${name}]`, value);
  }
  await browser.clickText('Lưu điều kiện tiếp cận', 'button');
  await browser.waitText('Đã lưu điều kiện tiếp cận');
  const { details: fieldDetails } = await api(`/api/fields/${field.id}/details`, { actor: farmer });
  assert.deepEqual(fieldDetails.access, { roadWidthM: 2.5, bridgeLoadT: 4, soil: 'boggy', hasBoatDock: true });
  assert.equal(fieldDetails.areaM2, 12000);
  assert.equal(fieldDetails.locationConsent, false);
  assert.equal(fieldDetails.coordinates, null);
  await browser.hash('#/nong-dan/F-02');
  await browser.waitFor('!!document.querySelector(\'a[href*="F-04?"]\')');
  await browser.click('a[href*="F-04?"]');
  await browser.waitFor('document.querySelector("select[name=roadWidthM]")?.value === "2.5"');
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  console.log('V2_FIELD_ACCESS_PASS: access details persist without location consent or area change');

  const boundaryField = (await api('/api/fields', { actor: farmer, body: { name: `${label} ranh`, locality: 'Xã thử nghiệm', areaM2: 1000 } })).field;
  const boundaryRoute = `#/nong-dan/F-04?id=${boundaryField.id}`;
  const boundaryApi = `/api/fields/${boundaryField.id}/details`;
  const points = [[105.8, 10], [105.801, 10], [105.801, 10.001], [105.8, 10.001]];
  await browser.hash(boundaryRoute);
  await browser.waitText('Ranh thửa');
  assert.equal(await browser.ev('!!document.querySelector("textarea[name=boundary]")'), false);
  await browser.clickText('Đồng ý lưu tọa độ', 'button');
  await browser.waitFor('!!document.querySelector("textarea[name=boundary]")');
  await browser.fill('textarea[name=boundary]', [points[0], points[2], points[1], points[3]].map((pt) => pt.join(', ')).join('\n'));
  const rejectedBoundaryLog = browser.consoleErrors.length;
  await browser.clickText('Lưu ranh thửa', 'button');
  await browser.waitText('Ranh không hợp lệ');
  assert.deepEqual(browser.consoleErrors.slice(rejectedBoundaryLog), [
    `Failed to load resource: the server responded with a status of 400 (Bad Request) ${origin}${boundaryApi}`,
  ]);
  browser.consoleErrors.splice(rejectedBoundaryLog, 1);
  assert.equal((await api(boundaryApi, { actor: farmer })).details.coordinates, null);
  await browser.fill('textarea[name=boundary]', points.map((pt) => pt.join(', ')).join('\n'));
  await browser.clickText('Lưu ranh thửa', 'button');
  await browser.waitText('Diện tích tính từ ranh');
  const savedBoundary = (await api(boundaryApi, { actor: farmer })).details;
  assert.deepEqual(savedBoundary.coordinates, [...points, points[0]]);
  assert.ok(savedBoundary.areaM2 > 12000 && savedBoundary.areaM2 < 12500);
  assert.equal(savedBoundary.access.roadWidthM, null);
  assert.equal(await browser.ev('!!document.querySelector(".farmer-boundary-outline polygon")'), true);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  if (process.env.BOUNDARY_SCREENSHOT) {
    await browser.ev('document.querySelector(".farmer-boundary").scrollIntoView({block:"center"})');
    await browser.shot(process.env.BOUNDARY_SCREENSHOT);
  }
  await browser.hash('#/nong-dan/F-02');
  await browser.hash(boundaryRoute);
  await browser.waitText('Diện tích tính từ ranh');
  await browser.ev('document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight');
  assert.equal(await browser.ev(`(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Rút đồng ý lưu tọa độ');
    const box = button.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  })()`), true, 'withdraw button is reachable at maximum mobile scroll');
  await browser.clickText('Rút đồng ý lưu tọa độ', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Rút đồng ý lưu tọa độ', '[role=dialog] button');
  await browser.waitText('Đồng ý lưu tọa độ');
  const withdrawn = (await api(boundaryApi, { actor: farmer })).details;
  assert.equal(withdrawn.locationConsent, false);
  assert.equal(withdrawn.coordinates, null);
  assert.equal(withdrawn.areaM2, savedBoundary.areaM2);
  assert.equal((await pool.query('SELECT boundary FROM dispatch.fields WHERE id = $1', [boundaryField.id])).rows[0].boundary, null);
  await browser.clickText('Đồng ý lưu tọa độ', 'button');
  await browser.waitFor('document.querySelector("textarea[name=boundary]")?.value === ""');
  assert.deepEqual((await api(boundaryApi, { actor: farmer })).details, { ...withdrawn, locationConsent: true });
  console.log('V2_BOUNDARY_PASS: consent, invalid polygon, area, persistence and withdrawal');

  await browser.hash(`#/nong-dan/F-05?field=${field.id}&service=${harvest.id}`);
  await browser.waitFor('!!document.querySelector("input[name=startLocal]")');
  await browser.fill('input[name=startLocal]', startAt.slice(0, 16));
  await browser.fill('input[name=endLocal]', endAt.slice(0, 16));
  await browser.clickText('Xem bảng giá và xác nhận', 'button');
  await browser.waitFor('location.hash.startsWith("#/nong-dan/F-06")');
  await browser.waitText('Giá mô phỏng');
  await browser.clickText('Xác nhận gửi yêu cầu', 'button');
  await browser.waitFor('location.hash.startsWith("#/nong-dan/F-07?id=")');
  const bookingId = await currentId();
  await browser.waitFor('!!document.querySelector("select[name=coordinatorId]")');
  await browser.fill('select[name=coordinatorId]', coop.id);
  await browser.clickText('Ủy quyền HTX gom đơn', 'button');
  await browser.waitText('Đã ủy quyền HTX, chờ gom gói');
  assert.equal((await api(`/api/bookings/${bookingId}/coordinator`, { actor: farmer })).coordinatorId, coop.id);
  console.log('F-03/F-05/F-06/F-07: field, synthetic quote, booking and delegation persisted');

  await browser.viewport(1440, 900, false);
  await login(coop, 'htx');
  await browser.hash('#/htx/H-01');
  await browser.waitText('Đơn giao trực tiếp');
  assert.equal((await api('/api/htx/territories/overview', { actor: coop })).delegated.bookingCount, 1);

  await login(admin, 'quan-tri');
  await browser.hash(`#/quan-tri/A-02?coop=${coop.id}`);
  await browser.waitText(`${commune}, Tỉnh kiểm thử`);
  await browser.clickText('Gỡ địa bàn', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Gỡ địa bàn', '[role=dialog] button');
  await browser.waitText('HTX chưa được gán xã');
  const audit = await pool.query('SELECT action FROM dispatch.coop_territory_audit WHERE assignment_id=$1 ORDER BY sequence', [assignment.id]);
  assert.deepEqual(audit.rows.map(({ action }) => action), ['ASSIGNED', 'REMOVED']);

  await login(coop, 'htx');
  await browser.hash('#/htx/H-01');
  await browser.waitText('Chưa có xã được giao');
  assert.equal((await api('/api/htx/territories/overview', { actor: coop })).delegated.bookingCount, 1, 'removing a territory does not remove booking delegation');
  console.log('V2_TERRITORY_PASS: admin assigns/removes; coop sees only active communes; delegation remains');
  await browser.hash('#/htx/H-03');
  await browser.waitText(label);
  await browser.click(`input[aria-label="Chọn đơn ${label}"]`);
  await browser.clickText('Tạo gói việc', '.actionbar button');
  await browser.waitFor('location.hash.startsWith("#/htx/H-05?id=")');
  const packageId = await currentId();

  await login(provider, 'chu-may');
  await browser.hash(`#/chu-may/P-02?id=${packageId}`);
  const { package: offered } = await api(`/api/packages/${packageId}`, { actor: provider });
  assert.deepEqual(offered.accessSummary, { narrowRoad: 1, lowBridgeLoad: 1, boggySoil: 1, boatDock: 1, incomplete: 0 });
  for (const key of ['coordinates', 'boundary', 'ownerId', 'access_details']) assert.ok(!JSON.stringify(offered).includes(key), key);
  await browser.waitText('Hạn chế xe fooc');
  await browser.waitText('Đường dưới 3 m');
  await browser.waitText('Cầu dưới 5 tấn');
  await browser.waitText('Đất sình lầy');
  await browser.viewport(390, 844, true);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  if (process.env.PACKAGE_ACCESS_SCREENSHOT) {
    await browser.ev(`Array.from(document.querySelectorAll('main section')).find(el => el.textContent.includes('Hạn chế xe fooc'))?.scrollIntoView({block:'center'})`);
    await browser.shot(process.env.PACKAGE_ACCESS_SCREENSHOT);
  }
  console.log('V2_PACKAGE_ACCESS_PASS: provider sees package-level access warnings before claim, without field coordinates or owner IDs');
  await browser.viewport(1440, 900, false);
  await browser.hash(`#/chu-may/P-03?id=${packageId}`);
  await browser.waitText('Xác nhận nhận gói việc');
  await browser.clickText('Xác nhận nhận gói việc', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Nhận gói việc', '[role=dialog] button');
  await browser.waitFor('location.hash.startsWith("#/chu-may/P-02?id=")');
  assert.equal((await api(`/api/packages/${packageId}`, { actor: provider })).package.status, 'CLAIMED');
  console.log('H-03/P-03: cooperative grouped the request; provider assigned machine and operator');

  const schedulePath = `/api/packages/${packageId}/postponement`;
  const newStart = utc(14, 9);
  const newEnd = utc(14, 13);
  await browser.waitText('HTX có thể đề xuất, không đồng ý thay');
  await login(coop, 'htx');
  await browser.hash(`#/htx/H-07?id=${packageId}`);
  await browser.waitText('Gửi đề xuất dời lịch');
  await browser.fill('input[name=startAt]', newStart.slice(0, 16));
  await browser.fill('input[name=endAt]', newEnd.slice(0, 16));
  await browser.fill('textarea[name=reason]', 'Chờ đường vào ruộng khô');
  await browser.clickText('Gửi đề xuất dời lịch', 'button');
  await browser.waitText('0 trên 2 bên bắt buộc');
  const proposedSchedule = await api(schedulePath, { actor: coop });
  assert.equal(proposedSchedule.package.startAt, startAt);
  assert.equal(proposedSchedule.latest.version, 1);
  assert.equal(proposedSchedule.permissions.canConsent, false);

  await browser.viewport(390, 844, true);
  await login(farmer, 'nong-dan');
  await browser.hash(`#/nong-dan/F-07?id=${bookingId}`);
  await browser.waitFor('!!document.querySelector(\'a[href*="F-15?"]\')');
  await browser.click('a[href*="F-15?"]');
  await browser.waitText('Chờ đường vào ruộng khô');
  // Replace the proposal while the owner is still looking at v1. No consent may carry over.
  const replacement = await api(schedulePath, { actor: coop, body: { startAt: newStart, endAt: newEnd, reason: 'Đã kiểm tra lại đường vào ruộng' } });
  assert.equal(replacement.latest.version, 2);
  const staleErrorStart = browser.consoleErrors.length;
  await browser.clickText('Đồng ý dời lịch phiên bản 1', 'button');
  await browser.waitText('Đã có đề xuất dời lịch mới. Tải lại để xem đúng phiên bản.');
  const staleErrors = browser.consoleErrors.splice(staleErrorStart);
  assert.equal(staleErrors.length, 1);
  assert.ok(staleErrors[0].includes('409') && staleErrors[0].endsWith(`${origin}${schedulePath}/1/consent`));
  const afterStale = await api(schedulePath, { actor: farmer });
  assert.equal(afterStale.latest.consentedCount, 0);
  assert.equal(afterStale.history.find((item) => item.version === 1).consentedCount, 0);
  assert.equal(afterStale.package.startAt, startAt);
  assert.equal(await browser.ev('document.activeElement?.textContent.trim()'), 'Tải lại đề xuất');
  assert.equal(await browser.ev('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Đồng ý dời lịch phiên bản 1")'), false);
  await browser.clickText('Tải lại đề xuất', 'button');
  await browser.waitText('Đã kiểm tra lại đường vào ruộng');
  assert.equal(await browser.ev('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Đồng ý dời lịch phiên bản 1")'), false);
  await browser.clickText('Đồng ý dời lịch phiên bản 2', 'button');
  await browser.waitText('Đã đồng ý: 1/2 bên');
  const partialSchedule = await api(schedulePath, { actor: farmer });
  assert.equal(partialSchedule.latest.ownConsented, true);
  assert.equal(partialSchedule.package.startAt, startAt);
  assert.equal(partialSchedule.latest.appliedAt, null);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  await browser.viewport(1440, 900, false);
  await login(provider, 'chu-may');
  await browser.hash(`#/chu-may/P-02?id=${packageId}`);
  await browser.waitText('Đồng ý dời lịch phiên bản 2');
  await browser.clickText('Đồng ý dời lịch phiên bản 2', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Đồng ý dời lịch', '[role=dialog] button');
  await browser.waitText('Đã áp dụng lúc');
  const appliedSchedule = await api(schedulePath, { actor: provider });
  assert.equal(appliedSchedule.latest.version, 2);
  assert.equal(appliedSchedule.latest.consentedCount, 2);
  assert.ok(appliedSchedule.latest.appliedAt);
  assert.equal(appliedSchedule.package.startAt, newStart);
  assert.equal(appliedSchedule.package.endAt, newEnd);
  const { booking: unchangedBooking } = await api(`/api/bookings/${bookingId}`, { actor: farmer });
  assert.equal(unchangedBooking.startAt, startAt);
  assert.equal(unchangedBooking.endAt, endAt);
  console.log('V2_POSTPONEMENT_PASS: stale consent rejected; current version independently agreed; package moves, requested window stays');

  await browser.viewport(390, 844, true);
  await login(farmer, 'nong-dan');
  await browser.hash(`#/nong-dan/F-07?id=${bookingId}`);
  await browser.waitText('Thao tác theo đơn');
  assert.ok(await browser.ev('!!document.querySelector(\'a[href*="F-09?"]\')'), 'F-07 links to the deposit screen');
  await browser.click('a[href*="F-09?"]');
  await browser.waitText('Chờ HTX xác nhận đã gọi');
  assert.equal(await browser.ev('!!document.querySelector("input[name=reference]")'), false);

  await browser.viewport(1440, 900, false);
  await login(coop, 'htx');
  await browser.hash(`#/htx/H-05?id=${packageId}`);
  await browser.waitText('Ghi nhận đã gọi');
  await browser.clickText('Ghi nhận đã gọi', 'button');
  await browser.waitText('HTX đã xác nhận cuộc gọi');
  assert.equal((await api(`/api/packages/${packageId}/deposit-call-confirmation`, { actor: coop })).confirmed, true);

  await browser.viewport(390, 844, true);
  await login(farmer, 'nong-dan');
  await browser.hash(`#/nong-dan/F-09?id=${bookingId}`);
  await browser.waitText('Không dùng để chuyển tiền');
  await browser.waitFor('!!document.querySelector("input[name=reference]")');
  await browser.clickText('Báo đã chuyển cọc', 'button');
  await browser.waitText('Nhập mã tham chiếu');
  assert.equal((await api(`/api/bookings/${bookingId}/deposit`, { actor: farmer })).deposit, null);
  await browser.fill('input[name=reference]', 'TEST-LOCAL-123');
  await browser.clickText('Báo đã chuyển cọc', 'button');
  await browser.waitText('Chờ chủ máy xác nhận đã nhận cọc');
  assert.equal((await api(`/api/bookings/${bookingId}/deposit`, { actor: farmer })).deposit.status, 'REPORTED');
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  await browser.viewport(1440, 900, false);
  await login(provider, 'chu-may');
  await browser.hash(`#/chu-may/P-02?id=${packageId}`);
  await browser.waitText('Xác nhận đã nhận cọc');
  await browser.clickText('Xác nhận đã nhận cọc', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Xác nhận đã nhận cọc', '[role=dialog] button');
  await browser.waitText('Hai bên đã ghi nhận cọc');
  assert.equal((await api(`/api/bookings/${bookingId}/deposit`, { actor: farmer })).deposit.status, 'CONFIRMED');

  await browser.viewport(390, 844, true);
  await login(farmer, 'nong-dan');
  await browser.hash(`#/nong-dan/F-09?id=${bookingId}`);
  await browser.waitText('Hai bên đã ghi nhận cọc');
  assert.equal(await browser.ev('!!document.querySelector("input[name=reference]")'), false);
  await browser.hash(`#/nong-dan/F-08?id=${bookingId}`);
  for (const name of ['drained', 'mature', 'intakeReady']) {
    await browser.waitFor(`!!document.querySelector('input[name=${name}]')`);
    await browser.click(`input[name=${name}]`);
  }
  await browser.clickText('Lưu khai báo ruộng sẵn sàng', 'button');
  await browser.waitText('Đã khai báo đủ 3 mục');

  await login(operator, 'tho-lai');
  await browser.hash('#/tho-lai/O-08');
  await browser.waitText('Chưa khai chứng chỉ.');
  await browser.fill('input[name=skills]', 'Gặt lúa');
  await browser.fill('input[name=certName]', 'Chứng chỉ vận hành thử nghiệm');
  await browser.fill('input[name=certExpiry]', '2035-06-30');
  await browser.clickText('Lưu hồ sơ', 'button');
  await browser.waitText('Chưa xác minh');
  const { profile } = await api('/api/workforce/profile', { actor: operator });
  assert.deepEqual(profile.skills, ['Gặt lúa']);
  assert.equal(profile.certifications[0].name, 'Chứng chỉ vận hành thử nghiệm');
  assert.equal(profile.certifications[0].verificationStatus, 'UNVERIFIED');
  console.log('V2_WORKFORCE_PROFILE_PASS: operator profile persists through the mounted API');
  await browser.hash('#/tho-lai/O-01');
  await browser.waitText('Chờ HTX kiểm tra');
  assert.equal(await browser.ev('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Bắt đầu ca")'), false);

  await browser.viewport(1440, 900, false);
  await login(coop, 'htx');
  await browser.hash(`#/htx/H-04?pkg=${packageId}&id=${bookingId}`);
  await browser.waitText('Xác nhận Đạt thực địa');
  await browser.clickText('Xác nhận Đạt thực địa', 'button');
  await browser.waitText('Lần #1: Đạt');
  assert.equal((await api(`/api/bookings/${bookingId}/inspections`, { actor: coop })).passed, true);

  await browser.viewport(390, 844, true);
  await login(operator, 'tho-lai');
  await browser.hash('#/tho-lai/O-01');
  await browser.waitText('Sẵn sàng mở ca');
  await browser.clickText('Bắt đầu ca', 'button');
  await browser.waitFor('location.hash.startsWith("#/tho-lai/O-01?id=")');
  const shiftId = await currentId();
  await browser.waitText('Kết thúc ca');
  assert.ok(await browser.ev('!!document.querySelector(\'a[href*="O-02?"]\')'), 'O-01 links to telemetry for the current shift');
  await browser.click('a[href*="O-02?"]');
  await browser.waitFor('!!document.querySelector(\'[role=progressbar][aria-label="Tiến độ mô phỏng"]\')');
  await browser.waitText('Không phải GPS thật');
  await browser.hash(`#/tho-lai/O-01?id=${shiftId}`);
  await browser.waitText('Kết thúc ca');
  await browser.clickText('Kết thúc ca', 'button');
  await browser.waitFor('!!document.querySelector("input[name=areaM2]")');
  await browser.fill('input[name=areaM2]', '12000');
  await browser.clickText('Xác nhận kết thúc ca', 'button');
  await browser.waitText('Đã xong');
  const { shift } = await api(`/api/shifts/${shiftId}`, { actor: operator });
  assert.equal(shift.packageId, packageId);
  assert.equal(shift.status, 'COMPLETED');
  assert.equal(Number(shift.areaM2), 12000);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  const { snapshot } = await api(`/api/bookings/${bookingId}/deposit`, { actor: farmer });
  const balance = (BigInt(snapshot.bookingTotalVnd) - BigInt(snapshot.expectedDepositVnd)).toString();
  const paymentsPath = `/api/bookings/${bookingId}/payments`;
  await browser.viewport(1440, 900, false);
  await login(provider, 'chu-may');
  await browser.hash(`#/chu-may/P-07?id=${bookingId}`);
  await browser.waitText('Gửi đề nghị nghiệm thu');
  await browser.fill('input[name=areaM2]', '12000');
  await browser.fill('input[name=totalVnd]', snapshot.bookingTotalVnd);
  await browser.clickText('Gửi đề nghị nghiệm thu', 'button');
  await browser.waitText('Đồng ý nghiệm thu v1');
  await browser.clickText('Đồng ý nghiệm thu v1', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Đồng ý nghiệm thu', '[role=dialog] button');
  await browser.waitFor('![...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Đồng ý nghiệm thu v1")');

  await browser.viewport(390, 844, true);
  await login(farmer, 'nong-dan');
  await browser.hash(`#/nong-dan/F-11?id=${bookingId}`);
  await browser.waitText('Đồng ý nghiệm thu phiên bản 1');
  await browser.clickText('Đồng ý nghiệm thu phiên bản 1', 'button');
  await browser.waitText('Đi tới quyết toán (F-12)');
  await browser.clickText('Đi tới quyết toán (F-12)', 'a');
  await browser.waitText('Cọc đã xác nhận');
  await browser.waitFor(`document.querySelector('input[name=amountVnd]')?.value === ${JSON.stringify(balance)}`);
  const beforePayment = (await api(paymentsPath, { actor: farmer })).summary;
  assert.equal(beforePayment.confirmedDepositVnd, snapshot.expectedDepositVnd);
  assert.equal(beforePayment.outstandingVnd, balance);
  await browser.fill('input[name=reference]', 'TEST-FINAL-123');
  await browser.clickText('Ghi báo đã chuyển tiền', 'button');
  await browser.waitText('Chờ chủ máy xác nhận');
  assert.equal((await api(paymentsPath, { actor: farmer })).summary.outstandingVnd, balance);

  await browser.viewport(1440, 900, false);
  await login(provider, 'chu-may');
  await browser.hash(`#/chu-may/P-07?id=${bookingId}`);
  await browser.waitText('Xác nhận đã nhận ngoài hệ thống');
  await browser.clickText('Xác nhận đã nhận ngoài hệ thống', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Đã nhận đủ', '[role=dialog] button');
  await browser.waitFor('![...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Xác nhận đã nhận ngoài hệ thống")');
  assert.equal((await api(paymentsPath, { actor: farmer })).summary.outstandingVnd, '0');

  await browser.viewport(390, 844, true);
  await login(farmer, 'nong-dan');
  await browser.hash(`#/nong-dan/F-12?id=${bookingId}`);
  await browser.waitText('Cọc đã xác nhận');
  assert.equal(await browser.ev('!!document.querySelector("input[name=amountVnd]")'), false);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  console.log('V2_SETTLEMENT_PASS: independent consents; confirmed deposit deducted; balance reaches zero after final receipt');
  await browser.hash(`#/nong-dan/F-07?id=${bookingId}`);
  await browser.waitFor('!!document.querySelector(\'a[href*="F-10?"]\')');
  await browser.click('a[href*="F-10?"]');
  await browser.waitFor('!!document.querySelector(\'[role=progressbar][aria-valuenow="100"]\')');
  await browser.waitText('Không phải GPS thật');
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  await browser.viewport(1440, 900, false);
  await login(coop, 'htx');
  await browser.hash(`#/htx/H-06?id=${shiftId}`);
  await browser.waitFor('!!document.querySelector(\'[role=progressbar][aria-valuenow="100"]\')');
  await browser.waitText('Diện tích báo khi kết thúc ca');
  await browser.waitFor('!!document.querySelector(\'a[href$="/H-09"]\')');
  await browser.click('a[href$="/H-09"]');
  await browser.waitText('Ước tính hoa hồng');
  await browser.waitText(bookingId.slice(0, 8));
  await browser.waitText('không phải khoản phải thu');
  assert.deepEqual((await api('/api/htx/commission-estimates', { actor: coop })).items.map((item) => item.bookingId), [bookingId]);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  console.log('V2_MONITORING_PASS: O-02, F-10, H-06, H-09 use real API with labeled simulation and estimates');
  // Settlement freeze: a real dispute on the settled booking keeps history visible and bars new writes.
  const acceptancePath = `/api/bookings/${bookingId}/acceptance`;
  const before = {
    acceptance: (await api(acceptancePath, { actor: farmer })).acceptance,
    ...(await api(paymentsPath, { actor: farmer })),
  };
  assert.equal(before.acceptance.version, 1);
  assert.equal(before.acceptance.agreed, true);
  assert.ok(before.payments.some((p) => p.status === 'CONFIRMED'));
  await browser.viewport(390, 844, true);
  await login(farmer, 'nong-dan');
  await browser.hash(`#/nong-dan/F-13?booking=${bookingId}`);
  await browser.waitFor('!!document.querySelector("select[name=reason]")');
  await browser.fill('select[name=reason]', 'QUALITY');
  await browser.fill('textarea[name=details]', `Kiểm thử đóng băng quyết toán: ${label}`);
  await browser.clickText('Gửi khiếu nại', 'button');
  await browser.waitFor('location.hash.startsWith("#/nong-dan/F-13?id=")');
  const freezeDisputeId = await currentId();
  const freezeDispute = (await api(`/api/disputes/${freezeDisputeId}`, { actor: farmer })).dispute;
  assert.equal(freezeDispute.status, 'OPEN');
  assert.equal(freezeDispute.bookingId, bookingId);
  console.log('V2_SETTLEMENT_FREEZE_DISPUTE: farmer opened a real dispute on the settled booking via F-13');

  // Barred writes are refused by the API, while the same-version history stays readable.
  const rawWrite = async (path, actor, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return { status: response.status, code: (await response.json()).error?.code };
  };
  const confirmed = before.payments.find((p) => p.status === 'CONFIRMED');
  assert.deepEqual(await rawWrite(paymentsPath, farmer, { amountVnd: '1', reference: 'FREEZE-123' }), { status: 409, code: 'DISPUTE_OPEN' });
  assert.deepEqual(await rawWrite(acceptancePath, provider, { areaM2: 12000, totalVnd: before.summary.agreedVnd }), { status: 409, code: 'DISPUTE_OPEN' });
  assert.deepEqual(await rawWrite(`${acceptancePath}/1/consent`, farmer, {}), { status: 409, code: 'DISPUTE_OPEN' });
  assert.deepEqual(await rawWrite(`/api/payments/${confirmed.id}/confirm`, provider, {}), { status: 409, code: 'DISPUTE_OPEN' });

  await browser.hash(`#/nong-dan/F-11?id=${bookingId}`);
  await browser.waitText('Đơn đang có khiếu nại');
  await browser.waitText('Hai bên đã đồng ý');
  assert.equal(await browser.ev('[...document.querySelectorAll("button")].some(b => b.textContent.trim().startsWith("Đồng ý nghiệm thu phiên bản"))'), false);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  await browser.hash(`#/nong-dan/F-12?id=${bookingId}`);
  await browser.waitText('Đơn đang bị chặn ghi nhận tiền vì có khiếu nại');
  await browser.waitText('Lịch sử ghi báo thanh toán');
  await browser.waitText('Chủ máy đã xác nhận nhận ngoài hệ thống');
  assert.equal(await browser.ev('!!document.querySelector("input[name=amountVnd], input[name=reference]")'), false);
  assert.equal(await browser.ev('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Ghi báo đã chuyển tiền")'), false);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  await browser.viewport(1440, 900, false);
  await login(provider, 'chu-may');
  await browser.hash(`#/chu-may/P-07?id=${bookingId}`);
  await browser.waitText('Đơn đang bị khóa bởi tranh chấp');
  await browser.waitText('Khóa tranh chấp');
  await browser.waitText(`Đã xác nhận nhận`);
  for (const text of ['Đồng ý nghiệm thu v1', 'Gửi đề nghị thay thế', 'Gửi đề nghị nghiệm thu', 'Xác nhận đã nhận ngoài hệ thống']) {
    assert.equal(await browser.ev(`[...document.querySelectorAll("button")].some(b => b.textContent.trim() === ${JSON.stringify(text)})`), false, text);
  }
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  await browser.viewport(390, 844, true);
  await browser.hash(`#/chu-may/P-07?id=${bookingId}`);
  await browser.waitText('Đơn đang bị khóa bởi tranh chấp');
  assert.equal(await browser.ev('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Xác nhận đã nhận ngoài hệ thống")'), false);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);

  await browser.viewport(1440, 900, false);
  await login(farmer, 'nong-dan');
  await browser.hash(`#/nong-dan/F-11?id=${bookingId}`);
  await browser.waitText('Đơn đang có khiếu nại');
  assert.equal(await browser.ev('[...document.querySelectorAll("button")].some(b => b.textContent.trim().startsWith("Đồng ý nghiệm thu phiên bản"))'), false);
  await browser.hash(`#/nong-dan/F-12?id=${bookingId}`);
  await browser.waitText('Đơn đang bị chặn ghi nhận tiền vì có khiếu nại');
  assert.equal(await browser.ev('!!document.querySelector("input[name=amountVnd], input[name=reference]")'), false);
  assert.equal(await browser.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  await browser.viewport(390, 844, true);

  const after = { acceptance: (await api(acceptancePath, { actor: provider })).acceptance, ...(await api(paymentsPath, { actor: provider })) };
  assert.deepEqual(after.acceptance, before.acceptance, 'frozen acceptance version unchanged');
  assert.deepEqual(after.payments, before.payments, 'confirmed payments unchanged');
  assert.deepEqual(after.summary, before.summary, 'settlement summary unchanged');
  console.log('V2_SETTLEMENT_FREEZE_PASS: open dispute keeps v1 and confirmed payments visible; F-11, F-12, P-07 hide writes; API refuses them');

  const reason = `Thông tin cần kiểm tra: ${label}`;
  await browser.viewport(390, 844, true);
  await login(operator, 'tho-lai');
  await browser.hash(`#/tho-lai/O-04?id=${job.id}`);
  await browser.waitText(label);
  assert.ok(await browser.ev('!!document.querySelector("details[data-job-report] summary")'), 'O-04 offers job reporting');
  await browser.click('details[data-job-report] summary');
  await browser.clickText('Gửi báo cáo', 'button');
  await browser.waitText('Nhập lý do báo cáo');
  assert.deepEqual((await api('/api/admin/job-reports', { actor: admin })).items, []);
  await browser.fill('textarea[name=reportReason]', reason);
  await browser.clickText('Gửi báo cáo', 'button');
  await browser.waitText('Đã gửi báo cáo');
  const [report] = (await api('/api/admin/job-reports', { actor: admin })).items;
  assert.equal(report.reason, reason);
  assert.equal(report.status, 'OPEN');
  assert.equal(report.job_status, 'OPEN');

  await browser.viewport(1440, 900, false);
  await login(admin, 'quan-tri');
  await browser.hash('#/quan-tri/A-06');
  await browser.waitText(reason);
  await browser.fill('textarea[name=reviewNote]', 'Kiểm thử: cần xác minh thông tin');
  await browser.clickText('Ghi nhận đã xem xét', 'button');
  await browser.waitText('Đã xem xét');
  const reviewed = (await api('/api/admin/job-reports', { actor: admin })).items[0];
  assert.equal(reviewed.status, 'REVIEWED');
  assert.equal(reviewed.job_status, 'OPEN', 'review does not close job automatically');
  assert.equal(await browser.ev('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Ghi nhận đã xem xét")'), false);
  await browser.fill('textarea[name=closeReason]', 'Kiểm thử: đóng tin sau khi xem xét');
  await browser.clickText('Đóng tin tuyển', 'button');
  await browser.waitFor('!!document.querySelector("[role=dialog]")');
  await browser.clickText('Đóng tin tuyển', '[role=dialog] button');
  await browser.waitText('Tin đã đóng');
  assert.equal((await api(`/api/jobs/${job.id}`, { actor: provider })).job.status, 'CLOSED');
  assert.equal((await api('/api/offers', { actor: operator })).items.find((item) => item.id === offer.id).status, 'ACCEPTED');
  console.log('V2_JOB_MODERATION_PASS: report, independent review and explicit close; accepted offer retained');
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.consoleErrors, []);
} finally {
  try {
    await browser?.close();
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
    try {
      await pool.end();
    } finally {
      await db.drop();
    }
  }
}
console.log('V2_HARVEST_JOURNEY_PASS: four role surfaces, real HTTP and PostgreSQL, no seeded booking/package/inspection/shift');
