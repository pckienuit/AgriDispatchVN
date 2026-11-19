import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createAcceptanceRouter } from '../../src/acceptance.js';
import { createDispatchRouter } from '../../src/dispatch.js';
import { createLocalServiceExtensionsRouter } from '../../src/local-service-extensions.js';
import { createSchedulingRouter } from '../../src/scheduling.js';
import { createShiftRouter } from '../../src/shifts.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

parseDisposableRoot(process.env.TEST_DATABASE_URL);

// Synthetic fixtures only.
const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = id(1), OTHER_FARMER = id(2), COOP = id(3), OTHER_COOP = id(4);
const PROVIDER = id(5), OTHER_PROVIDER = id(6), OPERATOR = id(7), OTHER_OPERATOR = id(8);
const ADMIN = id(9), DUAL = id(10), MACHINE = id(20), MACHINE_DUAL = id(21);
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
const ALL_TRUE = { drained: true, mature: true, intakeReady: true };

const ACTORS = {
  [FARMER]: ['farmer'],
  [OTHER_FARMER]: ['farmer'],
  [COOP]: ['coop'],
  [OTHER_COOP]: ['coop'],
  [PROVIDER]: ['provider'],
  [OTHER_PROVIDER]: ['provider'],
  [OPERATOR]: ['operator'],
  [OTHER_OPERATOR]: ['operator'],
  [ADMIN]: ['admin'],
  [DUAL]: ['farmer', 'provider'],
};

function testAuthenticate(req, res, next) {
  const user = req.get('authorization')?.slice(7);
  if (!ACTORS[user]) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = { id: user, roles: ACTORS[user] };
  return next();
}

const ctx = {};
const servers = [];
let dayCounter = 0;
const nextDay = () => {
  dayCounter += 1;
  return dayCounter;
};
const at = (day, hour) => new Date(Date.UTC(2026, 11, day, hour)).toISOString();

async function call(method, path, actor, payload) {
  const headers = actor ? { authorization: `Bearer ${actor}` } : {};
  let body;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const res = await fetch(`${ctx.url}${path}`, { method, headers, body });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json');
  return { status: res.status, body: isJson && text ? JSON.parse(text) : null, text };
}
const get = (path, actor) => call('GET', path, actor);
const post = (path, payload, actor) => call('POST', path, actor, payload);

async function consentRecruitment(day, provider = PROVIDER) {
  const job = (await ctx.pool.query(
    "INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ($1, 'Synthetic job', 'Demo', 2, $2, $3) RETURNING id",
    [provider, at(day, 0), at(day, 23)],
  )).rows[0].id;
  const appId = (await ctx.pool.query(
    "INSERT INTO dispatch.applications (job_id, operator_id, status) VALUES ($1, $2, 'OFFERED') RETURNING id",
    [job, OPERATOR],
  )).rows[0].id;
  await ctx.pool.query(
    "INSERT INTO dispatch.offers (application_id, job_id, operator_id, status, responded_at) VALUES ($1, $2, $3, 'ACCEPTED', now())",
    [appId, job, OPERATOR],
  );
}

async function createBooking(day, { owner = FARMER, coordinator = COOP, area = 10000, serviceCode = 'harvest-combine', total = null } = {}) {
  const field = (await ctx.pool.query(
    "INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'Synthetic paddy', 'An Giang', $2) RETURNING id",
    [owner, area],
  )).rows[0].id;
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT $1, $2, id, $3, $4, 'Synthetic paddy', $5::int, code, name, data_label, price_per_ha_vnd,
       COALESCE($6::bigint, floor((price_per_ha_vnd::numeric * $5::int + 5000) / 10000)::bigint), $7
       FROM dispatch.services WHERE code = $8 RETURNING id, total_vnd::text`,
    [owner, field, at(day, 8), at(day, 12), area, total, coordinator, serviceCode],
  );
  return rows[0];
}

async function createClaimedPackage({ owners = [FARMER], area = 10000, provider = PROVIDER, claim = true, serviceCode = 'harvest-combine' } = {}) {
  const day = nextDay();
  await consentRecruitment(day, provider);
  const bookings = [];
  for (const owner of owners) {
    bookings.push(await createBooking(day, { owner, area, serviceCode }));
  }
  const created = await post('/api/packages', { bookingIds: bookings.map((b) => b.id) }, COOP);
  assert.equal(created.status, 201);
  const packageId = created.body.package.id;
  if (claim) {
    const machineId = provider === DUAL ? MACHINE_DUAL : MACHINE;
    const claimed = await post(`/api/packages/${packageId}/claim`, { machineId, operatorId: OPERATOR }, provider);
    assert.equal(claimed.status, 200);
  }
  return { packageId, bookings, bookingIds: bookings.map((b) => b.id), day };
}

async function startAndOptionallyComplete(pkg, { completeArea = null } = {}) {
  for (const bId of pkg.bookingIds) {
    const owner = (await ctx.pool.query('SELECT owner_id FROM dispatch.bookings WHERE id = $1', [bId])).rows[0].owner_id;
    assert.equal((await post(`/api/bookings/${bId}/readiness`, ALL_TRUE, owner)).status, 200);
    assert.equal((await post(`/api/bookings/${bId}/inspections`, { result: 'PASSED' }, COOP)).status, 201);
  }
  const started = await post(`/api/packages/${pkg.packageId}/shifts/start`, {}, OPERATOR);
  assert.equal(started.status, 201);
  const shiftId = started.body.shift.id;
  if (completeArea !== null) {
    assert.equal((await post(`/api/shifts/${shiftId}/complete`, { areaM2: completeArea }, OPERATOR)).status, 200);
  }
  return shiftId;
}

function listen(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(createDispatchRouter({ pool, authenticate: testAuthenticate }));
  app.use(createSchedulingRouter({ pool, authenticate: testAuthenticate }));
  app.use(createShiftRouter({ pool, authenticate: testAuthenticate }));
  app.use(createAcceptanceRouter({ pool, authenticate: testAuthenticate }));
  app.use(createLocalServiceExtensionsRouter({ pool, authenticate: testAuthenticate }));
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  return once(server, 'listening').then(() => `http://127.0.0.1:${server.address().port}`);
}

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  await migrate(ctx.pool);
  await seedCatalog(ctx.pool);
  for (const [user, roles] of Object.entries(ACTORS)) {
    await ctx.pool.query('INSERT INTO account.users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [user, `${user}@example.com`, `Synthetic ${roles[0]}`, HASH]);
    for (const role of roles) {
      await ctx.pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user, role]);
    }
  }
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic combine', 'harvester')", [MACHINE, PROVIDER]);
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic combine dual', 'harvester')", [MACHINE_DUAL, DUAL]);
  ctx.url = await listen(ctx.pool);
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

test('D5 deposit: requires claimed package and explicit HTX call confirmation by assigned coop', async () => {
  const openPkg = await createClaimedPackage({ claim: false });
  const [bOpen] = openPkg.bookingIds;
  // Open package cannot get HTX call confirmation or deposit.
  assert.equal((await post(`/api/packages/${openPkg.packageId}/deposit-call-confirmation`, {}, COOP)).body.error.code, 'PACKAGE_NOT_CLAIMED');
  assert.equal((await post(`/api/bookings/${bOpen}/deposit`, { reference: 'DEP-OPEN-1' }, FARMER)).body.error.code, 'BOOKING_UNAVAILABLE');
  const openView = await get(`/api/bookings/${bOpen}/deposit`, FARMER);
  assert.equal(openView.status, 200);
  assert.equal(openView.body.permissions.canReport, false);
  assert.equal(openView.body.permissions.blockReason, 'BOOKING_UNAVAILABLE');
  assert.equal(openView.body.vietqrExample, null);

  // Claimed package still blocks deposit until assigned HTX confirms call.
  const pkg = await createClaimedPackage();
  const [b0] = pkg.bookingIds;
  assert.equal((await post(`/api/bookings/${b0}/deposit`, { reference: 'DEP-WAIT-1' }, FARMER)).body.error.code, 'HTX_CALL_NOT_CONFIRMED');
  assert.equal((await get(`/api/bookings/${b0}/deposit`, FARMER)).body.vietqrExample, null);

  // Role and scope guards on HTX call confirmation.
  for (const actor of [FARMER, PROVIDER, OPERATOR, ADMIN]) {
    assert.equal((await post(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, {}, actor)).status, 403);
  }
  assert.equal((await post(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, {}, OTHER_COOP)).status, 404);
  assert.equal((await post(`/api/packages/${id(999)}/deposit-call-confirmation`, {}, COOP)).status, 404);
  assert.equal((await post('/api/packages/bad-id/deposit-call-confirmation', {}, COOP)).status, 400);

  const first = await post(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, { note: '  Đã gọi 2 bên  ' }, COOP);
  assert.equal(first.status, 201);
  assert.equal(first.body.callConfirmation.packageId, pkg.packageId);
  assert.equal(first.body.callConfirmation.note, 'Đã gọi 2 bên');

  // Idempotent retry with same note vs conflict with different note.
  const retry = await post(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, { note: 'Đã gọi 2 bên' }, COOP);
  assert.equal(retry.status, 200);
  assert.equal((await post(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, { note: 'Khác' }, COOP)).status, 409);

  // Read endpoint scoped properly.
  const readCoop = await get(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, COOP);
  assert.equal(readCoop.status, 200);
  assert.equal(readCoop.body.confirmed, true);
  assert.equal(readCoop.body.canConfirm, false);
  assert.equal(readCoop.body.callConfirmation.packageId, pkg.packageId);
  assert.equal((await get(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, FARMER)).status, 200);
  assert.equal((await get(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, PROVIDER)).status, 200);
  assert.equal((await get(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, OTHER_FARMER)).status, 404);
  assert.equal((await get(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, OTHER_COOP)).status, 404);
});

test('D5 deposit: server-derived 10% snapshot, safe VietQR example, payer report, independent payee confirm, idempotency', async () => {
  const pkg = await createClaimedPackage({ area: 10000 });
  const b0 = pkg.bookings[0].id;
  const bookingTotal = pkg.bookings[0].total_vnd;
  const expected10 = ((BigInt(bookingTotal) + 5n) / 10n).toString();
  assert.equal((await post(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, {}, COOP)).status, 201);

  const preview = await get(`/api/bookings/${b0}/deposit`, FARMER);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.snapshot.expectedDepositVnd, expected10);
  assert.equal(preview.body.snapshot.depositRatePercent, 10);
  assert.equal(preview.body.snapshot.hypothetical, true);
  assert.equal(preview.body.permissions.canReport, true);
  assert.equal(preview.body.vietqrExample.simulated, true);
  assert.equal(preview.body.vietqrExample.hypothetical, true);
  assert.equal(preview.body.vietqrExample.transferCapable, false);
  assert.equal(preview.body.vietqrExample.amountVnd, expected10);
  assert.match(preview.body.vietqrExample.analyticPayload, /NON_PAYABLE$/);

  // Tampered amount rejected; foreign payer / wrong role rejected.
  assert.equal((await post(`/api/bookings/${b0}/deposit`, { reference: 'DEP-BAD-AMT', amountVnd: '1000' }, FARMER)).body.error.code, 'DEPOSIT_AMOUNT_MISMATCH');
  assert.equal((await post(`/api/bookings/${b0}/deposit`, { reference: 'DEP-FOREIGN' }, OTHER_FARMER)).status, 404);
  assert.equal((await post(`/api/bookings/${b0}/deposit`, { reference: 'DEP-PROV' }, PROVIDER)).status, 403);
  assert.equal((await post(`/api/bookings/${b0}/deposit`, { reference: 'DEP-COOP' }, COOP)).status, 404);

  // Report deposit (idempotent retry vs conflict on different reference).
  const rep = await post(`/api/bookings/${b0}/deposit`, { reference: 'DEP-OK-0001', amountVnd: expected10 }, FARMER);
  assert.equal(rep.status, 201);
  assert.equal(rep.body.deposit.status, 'REPORTED');
  assert.equal(rep.body.deposit.amountVnd, expected10);
  assert.equal(rep.body.deposit.expectedDepositVnd, expected10);
  assert.equal(rep.body.deposit.hypothetical, true);
  assert.equal(rep.body.accounting.reportedDepositVnd, expected10);
  assert.equal(rep.body.accounting.confirmedDepositVnd, '0');
  assert.ok(!rep.text.includes('DEP-OK-0001'), 'reference must not leak in GET/view DTO');

  const retry = await post(`/api/bookings/${b0}/deposit`, { reference: 'DEP-OK-0001' }, FARMER);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deposit.id, rep.body.deposit.id);
  assert.equal((await post(`/api/bookings/${b0}/deposit`, { reference: 'DEP-DIFF-0002' }, FARMER)).body.error.code, 'DEPOSIT_ALREADY_EXISTS');

  // Payee independently confirms; payer cannot self-confirm; foreign provider gets 404.
  const depId = rep.body.deposit.id;
  assert.equal((await post(`/api/deposits/${depId}/confirm`, {}, FARMER)).status, 403);
  assert.equal((await post(`/api/deposits/${depId}/confirm`, {}, COOP)).status, 403);
  assert.equal((await post(`/api/deposits/${depId}/confirm`, {}, OTHER_PROVIDER)).status, 404);

  const provView = await get(`/api/bookings/${b0}/deposit`, PROVIDER);
  assert.equal(provView.status, 200);
  assert.equal(provView.body.permissions.canConfirm, true);
  assert.ok(!provView.text.includes('DEP-OK-0001'));

  const conf = await post(`/api/deposits/${depId}/confirm`, {}, PROVIDER);
  assert.equal(conf.status, 200);
  assert.equal(conf.body.deposit.status, 'CONFIRMED');
  assert.ok(conf.body.deposit.confirmedAt);
  assert.deepEqual(conf.body.deposit.events.map((e) => e.eventType), ['DEPOSIT_REPORTED', 'DEPOSIT_CONFIRMED']);
  assert.equal(conf.body.accounting.confirmedDepositVnd, expected10);
  assert.equal(conf.body.accounting.reportedDepositVnd, '0');
  assert.equal(conf.body.accounting.settlementIntegrated, true);

  // Idempotent repeat confirm produces no extra event.
  assert.equal((await post(`/api/deposits/${depId}/confirm`, {}, PROVIDER)).status, 200);
  const evCount = (await ctx.pool.query("SELECT count(*)::int AS n FROM dispatch.deposit_events WHERE deposit_id = $1 AND event_type = 'DEPOSIT_CONFIRMED'", [depId])).rows[0].n;
  assert.equal(evCount, 1);
});

test('D5 deposit: concurrent report race, party conflict, dispute freeze, combined accounting, and DB append-only guards', async () => {
  // Party conflict when owner === provider.
  const dualPkg = await createClaimedPackage({ owners: [DUAL], provider: DUAL });
  assert.equal((await post(`/api/packages/${dualPkg.packageId}/deposit-call-confirmation`, {}, COOP)).status, 201);
  assert.equal((await post(`/api/bookings/${dualPkg.bookingIds[0]}/deposit`, { reference: 'DEP-DUAL-1' }, DUAL)).body.error.code, 'PARTY_CONFLICT');

  // Concurrent report race: different references serialize cleanly to exactly one deposit row.
  const racePkg = await createClaimedPackage();
  const bRace = racePkg.bookingIds[0];
  assert.equal((await post(`/api/packages/${racePkg.packageId}/deposit-call-confirmation`, {}, COOP)).status, 201);
  const [r1, r2] = await Promise.all([
    post(`/api/bookings/${bRace}/deposit`, { reference: 'DEP-RACE-A' }, FARMER),
    post(`/api/bookings/${bRace}/deposit`, { reference: 'DEP-RACE-B' }, FARMER),
  ]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409]);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM dispatch.deposits WHERE booking_id = $1', [bRace])).rows[0].n, 1);

  // Open dispute blocks deposit report and confirm.
  const dispPkg = await createClaimedPackage({ owners: [FARMER, OTHER_FARMER] });
  const [b1, b2] = dispPkg.bookingIds;
  assert.equal((await post(`/api/packages/${dispPkg.packageId}/deposit-call-confirmation`, {}, COOP)).status, 201);
  const dep2 = (await post(`/api/bookings/${b2}/deposit`, { reference: 'DEP-DISP-2' }, OTHER_FARMER)).body.deposit.id;
  await ctx.pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status) VALUES ($1, $2, $3, 'PAYMENT', 'OPEN')",
    [b1, FARMER, PROVIDER],
  );
  await ctx.pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status) VALUES ($1, $2, $3, 'PAYMENT', 'OPEN')",
    [b2, OTHER_FARMER, PROVIDER],
  );
  assert.equal((await post(`/api/bookings/${b1}/deposit`, { reference: 'DEP-DISP-1' }, FARMER)).body.error.code, 'DISPUTE_OPEN');
  assert.equal((await post(`/api/deposits/${dep2}/confirm`, {}, PROVIDER)).body.error.code, 'DISPUTE_OPEN');

  // Combined deposit + final acceptance/payment accounting.
  const fullPkg = await createClaimedPackage({ area: 10000 });
  const bFull = fullPkg.bookingIds[0];
  const fullTotal = BigInt(fullPkg.bookings[0].total_vnd);
  const depAmt = (fullTotal + 5n) / 10n;
  assert.equal((await post(`/api/packages/${fullPkg.packageId}/deposit-call-confirmation`, {}, COOP)).status, 201);
  const depCreated = await post(`/api/bookings/${bFull}/deposit`, { reference: 'DEP-ACC-1' }, FARMER);
  const depositId = depCreated.body.deposit.id;
  await startAndOptionallyComplete(fullPkg, { completeArea: 10000 });
  assert.equal((await post(`/api/bookings/${bFull}/acceptance`, { areaM2: 10000, totalVnd: fullTotal.toString() }, PROVIDER)).status, 201);
  assert.equal((await post(`/api/bookings/${bFull}/acceptance/1/consent`, {}, FARMER)).status, 200);
  assert.equal((await post(`/api/bookings/${bFull}/acceptance/1/consent`, {}, PROVIDER)).status, 200);
  const remainder = (fullTotal - depAmt).toString();
  const path = `/api/bookings/${bFull}/payments`;
  const pending = (await get(path, FARMER)).body.summary;
  assert.equal(pending.outstandingVnd, fullTotal.toString());
  assert.equal(pending.availableToReportVnd, remainder, 'pending deposit reserves capacity without reducing outstanding');
  assert.equal((await post(path, { amountVnd: fullTotal.toString(), reference: 'FINAL-EXCESS' }, FARMER)).body.error.code, 'AMOUNT_EXCEEDS_OUTSTANDING');
  assert.equal((await post(path, { amountVnd: remainder, reference: 'DEP-ACC-1' }, FARMER)).body.error.code, 'REFERENCE_CONFLICT');
  await assert.rejects(ctx.pool.query(`INSERT INTO dispatch.payments (booking_id, acceptance_version, payer_id, amount_vnd, reference)
    VALUES ($1, 1, $2, $3, 'FINAL-DIRECT')`, [bFull, FARMER, fullTotal.toString()]), { code: '23001' });
  const payment = await post(path, { amountVnd: remainder, reference: 'FINAL-ACC-1' }, FARMER);
  assert.equal(payment.status, 201);
  assert.equal(payment.body.summary.confirmedVnd, '0');
  assert.equal(payment.body.summary.reportedVnd, remainder);
  assert.equal((await post(`/api/deposits/${depositId}/confirm`, {}, PROVIDER)).status, 200);
  const afterPay = await get(`/api/bookings/${bFull}/deposit`, FARMER);
  assert.equal(afterPay.body.accounting.referenceTotalSource, 'AGREED_ACCEPTANCE');
  assert.equal(afterPay.body.accounting.confirmedDepositVnd, depAmt.toString());
  assert.equal(afterPay.body.accounting.reportedFinalPaymentVnd, remainder);
  assert.equal(afterPay.body.accounting.remainingAfterConfirmedVnd, remainder);
  assert.equal(afterPay.body.accounting.remainingAvailableToReportVnd, '0');
  assert.equal(afterPay.body.accounting.settlementIntegrated, true);
  const confirmed = (await get(path, PROVIDER)).body.summary;
  assert.equal(confirmed.confirmedDepositVnd, depAmt.toString());
  assert.equal(confirmed.outstandingVnd, remainder);
  assert.equal(confirmed.availableToReportVnd, '0');
  const settled = await post(`/api/payments/${payment.body.payment.id}/confirm`, {}, PROVIDER);
  assert.equal(settled.status, 200);
  assert.equal(settled.body.summary.outstandingVnd, '0');

  // DB append-only guards block SQL mutation/bypass.
  await assert.rejects(ctx.pool.query('UPDATE dispatch.package_call_confirmations SET note = $1 WHERE package_id = $2', ['x', fullPkg.packageId]), { code: '23001' });
  await assert.rejects(ctx.pool.query('DELETE FROM dispatch.deposits WHERE booking_id = $1', [bFull]), { code: '23001' });
  await assert.rejects(ctx.pool.query('DELETE FROM dispatch.deposit_events WHERE deposit_id = $1', [depCreated.body.deposit.id]), { code: '23001' });
});

test('D5 settlement exposes confirmed deposits above a reduced agreement without creating a refund', async () => {
  const pkg = await createClaimedPackage();
  const [bookingId] = pkg.bookingIds;
  assert.equal((await post(`/api/packages/${pkg.packageId}/deposit-call-confirmation`, {}, COOP)).status, 201);
  const created = await post(`/api/bookings/${bookingId}/deposit`, { reference: 'DEP-EXCESS' }, FARMER);
  assert.equal(created.status, 201);
  const { id: depositId, amountVnd } = created.body.deposit;
  assert.equal((await post(`/api/deposits/${depositId}/confirm`, {}, PROVIDER)).status, 200);
  await startAndOptionallyComplete(pkg, { completeArea: 10000 });
  const totalVnd = (BigInt(amountVnd) - 1n).toString();
  assert.equal((await post(`/api/bookings/${bookingId}/acceptance`, { areaM2: 10000, totalVnd }, PROVIDER)).status, 201);
  for (const actor of [FARMER, PROVIDER]) {
    assert.equal((await post(`/api/bookings/${bookingId}/acceptance/1/consent`, {}, actor)).status, 200);
  }
  const path = `/api/bookings/${bookingId}/payments`;
  const { summary, payments } = (await get(path, FARMER)).body;
  assert.equal(summary.outstandingVnd, '0');
  assert.equal(summary.availableToReportVnd, '0');
  assert.equal(summary.excessConfirmedVnd, '1');
  assert.equal(summary.confirmedDepositVnd, amountVnd);
  assert.deepEqual(payments, []);
  assert.equal((await post(path, { amountVnd: '1', reference: 'FINAL-EXCESS-2' }, FARMER)).body.error.code, 'AMOUNT_EXCEEDS_OUTSTANDING');
});

test('D6 telemetry: read-only server-simulated metrics scoped to actors, phase-derived, no real GPS', async () => {
  const pkg = await createClaimedPackage({ owners: [FARMER, OTHER_FARMER], area: 10000 });
  const [b1, b2] = pkg.bookingIds;

  // Pre-shift telemetry.
  const prePkg = await get(`/api/packages/${pkg.packageId}/telemetry`, COOP);
  assert.equal(prePkg.status, 200);
  assert.equal(prePkg.body.telemetry.phase, 'CLAIMED_PRE_SHIFT');
  assert.equal(prePkg.body.telemetry.metrics.speedKmh, 0);
  assert.equal(prePkg.body.telemetry.simulation.simulated, true);
  assert.equal(prePkg.body.telemetry.simulation.realDeviceTelemetry, false);
  assert.equal(prePkg.body.telemetry.simulation.measuredCoordinatesAvailable, false);
  assert.equal(prePkg.body.telemetry.syntheticTrack.realGpsCoordinates, false);
  assert.equal(prePkg.body.telemetry.syntheticTrack.coordSpace, 'SYNTHETIC_LOCAL_GRID_0_100');

  // Role & scope boundaries.
  assert.equal((await get(`/api/packages/${pkg.packageId}/telemetry`, FARMER)).status, 403);
  assert.equal((await get(`/api/packages/${pkg.packageId}/telemetry`, OTHER_COOP)).status, 404);
  assert.equal((await get(`/api/packages/${pkg.packageId}/telemetry`, OTHER_OPERATOR)).status, 404);
  assert.equal((await get(`/api/bookings/${b1}/telemetry`, OTHER_FARMER)).status, 404);
  assert.equal((await get(`/api/bookings/${b1}/telemetry`, OPERATOR)).status, 403);

  // Start shift -> RUNNING telemetry.
  const shiftId = await startAndOptionallyComplete(pkg);
  const runShift = await get(`/api/shifts/${shiftId}/telemetry`, OPERATOR);
  assert.equal(runShift.status, 200);
  assert.equal(runShift.body.telemetry.phase, 'RUNNING');
  assert.equal(runShift.body.telemetry.metrics.implementActive, true);
  assert.ok(runShift.body.telemetry.metrics.speedKmh > 0);
  assert.ok(runShift.body.telemetry.metrics.cutterBarRpm > 0);
  assert.ok(!runShift.text.includes('"lat"') && !runShift.text.includes('"lng"'));

  // Booking telemetry scoped to owner (never leaks sibling booking b2 or other owner).
  const farmerTel = await get(`/api/bookings/${b1}/telemetry`, FARMER);
  assert.equal(farmerTel.status, 200);
  assert.equal(farmerTel.body.telemetry.bookingId, b1);
  assert.equal(farmerTel.body.telemetry.metrics.scopeAreaM2, 10000);
  assert.ok(!farmerTel.text.includes(b2));
  assert.ok(!farmerTel.text.includes(OTHER_FARMER));

  // Pause -> PAUSED telemetry (speed=0, implementActive=false), then resume & complete -> COMPLETED.
  assert.equal((await post(`/api/shifts/${shiftId}/pause`, { reason: 'Mưa lớn' }, OPERATOR)).status, 200);
  const pauseTel = await get(`/api/shifts/${shiftId}/telemetry`, PROVIDER);
  assert.equal(pauseTel.status, 200);
  assert.equal(pauseTel.body.telemetry.phase, 'PAUSED');
  assert.equal(pauseTel.body.telemetry.metrics.speedKmh, 0);
  assert.equal(pauseTel.body.telemetry.metrics.cutterBarRpm, 0);
  assert.equal(pauseTel.body.telemetry.metrics.implementActive, false);

  assert.equal((await post(`/api/shifts/${shiftId}/resume`, {}, OPERATOR)).status, 200);
  assert.equal((await post(`/api/shifts/${shiftId}/complete`, { areaM2: 19000 }, OPERATOR)).status, 200);
  const doneTel = await get(`/api/shifts/${shiftId}/telemetry`, COOP);
  assert.equal(doneTel.status, 200);
  assert.equal(doneTel.body.telemetry.phase, 'COMPLETED');
  assert.equal(doneTel.body.telemetry.metrics.actualCompletedAreaM2, 19000);
  assert.equal(doneTel.body.telemetry.metrics.progressRatioSimulated, 1);

  // Confirm shift state wasn't mutated by telemetry reads.
  const shiftState = (await ctx.pool.query('SELECT status, area_m2 FROM dispatch.shifts WHERE id = $1', [shiftId])).rows[0];
  assert.equal(shiftState.status, 'COMPLETED');
  assert.equal(shiftState.area_m2, 19000);
});

test('D8 H-09 commission estimates: read-only, scoped to HTX, hypothetical and distinct from owed/paid', async () => {
  // Fresh coop scope via OTHER_COOP so counts are isolated and deterministic.
  const d1 = nextDay();
  const d2 = nextDay();
  const bActive = await createBooking(d1, { owner: FARMER, coordinator: OTHER_COOP, area: 10000, total: 1200000 });
  const bCancel = await createBooking(d2, { owner: FARMER, coordinator: OTHER_COOP, area: 10000, total: 1200000 });
  const cancelPkg = await post('/api/packages', { bookingIds: [bCancel.id] }, OTHER_COOP);
  assert.equal(cancelPkg.status, 201);
  assert.equal((await post(`/api/packages/${cancelPkg.body.package.id}/cancel`, { reason: 'Cancelled for H-09 test' }, OTHER_COOP)).status, 200);
  // Give bActive an agreed acceptance at 900000 VND and a confirmed deposit? Actually test snapshot vs agreed acceptance!
  await ctx.pool.query(
    "INSERT INTO dispatch.acceptances (booking_id, version, proposer_id, area_m2, total_vnd) VALUES ($1, 1, $2, 9000, 900000)",
    [bActive.id, PROVIDER],
  );
  await ctx.pool.query(
    "INSERT INTO dispatch.acceptance_consents (booking_id, version, party, actor_id) VALUES ($1, 1, 'owner', $2), ($1, 1, 'provider', $3)",
    [bActive.id, FARMER, PROVIDER],
  );

  // Role & query validation guards.
  for (const actor of [FARMER, PROVIDER, OPERATOR, ADMIN]) {
    assert.equal((await get('/api/htx/commission-estimates', actor)).status, 403);
  }
  assert.equal((await get('/api/htx/commission-estimates?from=invalid', OTHER_COOP)).status, 400);
  assert.equal((await get('/api/htx/commission-estimates?limit=101', OTHER_COOP)).status, 400);

  const res = await get('/api/htx/commission-estimates', OTHER_COOP);
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.hypothetical, true);
  assert.equal(res.body.summary.approvedPolicy, false);
  assert.equal(res.body.summary.payable, false);
  assert.equal(res.body.summary.hypotheticalRateBps, 300);
  assert.equal(res.body.summary.hypotheticalRatePercent, 3);
  assert.equal(res.body.summary.owedToHtxVnd, '0');
  assert.equal(res.body.summary.paidToHtxVnd, '0');
  assert.equal(res.body.summary.scopedBookingCount, 2);
  assert.equal(res.body.summary.agreedAcceptanceCount, 1);
  // 3% of 900000 = 27000; cancelled booking excluded (0).
  assert.equal(res.body.summary.totalHypotheticalCommissionOnAgreedVnd, '27000');
  assert.equal(res.body.summary.totalHypotheticalCommissionAllNonCancelledVnd, '27000');

  const activeItem = res.body.items.find((i) => i.bookingId === bActive.id);
  const cancelItem = res.body.items.find((i) => i.bookingId === bCancel.id);
  assert.equal(activeItem.hypotheticalCommissionVnd, '27000');
  assert.equal(activeItem.hypotheticalBaseSource, 'AGREED_ACCEPTANCE');
  assert.equal(activeItem.owedVnd, '0');
  assert.equal(activeItem.paidVnd, '0');
  assert.equal(activeItem.payable, false);
  assert.equal(cancelItem.hypotheticalBaseSource, 'CANCELLED_EXCLUDED');
  assert.equal(cancelItem.hypotheticalCommissionVnd, '0');

  // Ensure COOP cannot see OTHER_COOP's bookings.
  const coopRes = await get('/api/htx/commission-estimates?limit=20&offset=0', COOP);
  assert.equal(coopRes.status, 200);
  assert.ok(!coopRes.text.includes(bActive.id));
  assert.ok(!coopRes.text.includes(bCancel.id));
});
