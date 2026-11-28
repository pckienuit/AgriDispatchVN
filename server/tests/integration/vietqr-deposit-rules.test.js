import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createPool } from '../../src/db.js';
import * as deposits from '../../src/local-service-extensions.js';
import { createShiftRouter } from '../../src/shifts.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const [farmer, coop, provider, otherProvider, operator] = Array.from({ length: 5 }, () => randomUUID());
const roles = { [farmer]: 'farmer', [coop]: 'coop', [provider]: 'provider', [otherProvider]: 'provider', [operator]: 'operator' };
const bank = { bankBin: '970436', bankName: 'Ngân hàng kiểm thử', accountNumber: '001234567890', accountHolder: 'Nguyễn Văn A' };
const bankPath = '/api/provider/bank-account';
const ready = { drained: true, mature: true, intakeReady: true };
let disposable, pool, server, origin;

before(async () => {
  disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  pool = createPool(disposable.url);
  await migrate(pool);
  await seedCatalog(pool);
  await pool.query(`INSERT INTO account.users (id, email, name, password_hash)
    SELECT id, id || '@example.test', role, $3 FROM unnest($1::uuid[], $2::text[]) AS a(id, role)`,
  [Object.keys(roles), Object.values(roles), `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`]);
  await pool.query('INSERT INTO account.user_roles (user_id, role) SELECT * FROM unnest($1::uuid[], $2::text[])',
    [Object.keys(roles), Object.values(roles)]);
  const authenticate = (req, _res, next) => {
    const id = req.get('x-test-user');
    if (roles[id]) req.actor = { id, roles: [roles[id]] };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(deposits.createLocalServiceExtensionsRouter({ pool, authenticate, depositExpiryHours: 2 }));
  app.use(createShiftRouter({ pool, authenticate }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (disposable) await disposable.drop();
});

async function call(method, path, actor, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers['x-test-user'] = actor;
  const response = await fetch(origin + path, { method, headers, body: JSON.stringify(data) });
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : null, cache: response.headers.get('cache-control') };
}

async function expectError(method, path, actor, status, code, data) {
  const result = await call(method, path, actor, data);
  assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error.code, code);
  return result.body.error;
}

async function fixture(count = 1) {
  const { rows: [machine] } = await pool.query(`INSERT INTO dispatch.machines (owner_id, name, machine_type)
    VALUES ($1, 'Máy kiểm thử', 'harvester') RETURNING id`, [provider]);
  const { rows: [pkg] } = await pool.query(`INSERT INTO dispatch.packages
    (coop_id, service_id, locality, window_start_at, window_end_at, status, provider_id, operator_id, machine_id)
    SELECT $1, id, 'An Giang', now() + interval '1 day', now() + interval '2 days', 'CLAIMED', $2, $3, $4
      FROM dispatch.services WHERE code = 'harvest-combine' RETURNING *`, [coop, provider, operator, machine.id]);
  const { rows: [field] } = await pool.query(`INSERT INTO dispatch.fields (owner_id, name, locality, area_m2)
    VALUES ($1, 'Ruộng kiểm thử', 'An Giang', 10000) RETURNING id`, [farmer]);
  const { rows } = await pool.query(`INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at,
      field_name, field_area_m2, service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id, state)
    SELECT $1, $2, id, $3, $4, 'Ruộng kiểm thử', 10000, code, name, data_label, price_per_ha_vnd, price_per_ha_vnd, $5, 'ASSIGNED'
    FROM dispatch.services CROSS JOIN generate_series(1, $6::int) WHERE id = $7 RETURNING id`,
  [farmer, field.id, pkg.window_start_at, pkg.window_end_at, coop, count, pkg.service_id]);
  const ids = rows.map(({ id }) => id);
  await pool.query('INSERT INTO dispatch.package_bookings (package_id, booking_id) SELECT $1, unnest($2::uuid[])', [pkg.id, ids]);
  await pool.query(`INSERT INTO dispatch.allocations (package_id, resource_key, start_at, end_at)
    SELECT $1, unnest($2::text[]), $3, $4`, [pkg.id, [`machine:${machine.id}`, `operator:${operator}`], pkg.window_start_at, pkg.window_end_at]);
  const callConfirm = () => call('POST', `/api/packages/${pkg.id}/deposit-call-confirmation`, coop, {});
  return { pkg: pkg.id, ids, callConfirm };
}

const bookingPath = (id, action) => `/api/bookings/${id}/${action}`;
const qr = (id) => call('GET', bookingPath(id, 'vietqr'), farmer);
const report = (id) => call('POST', bookingPath(id, 'deposit'), farmer, { reference: 'TEST-DEPOSIT' });
const confirm = (id) => call('POST', `/api/deposits/${id}/confirm`, provider, {});
const start = (id) => call('POST', `/api/packages/${id}/shifts/start`, operator, {});
const setReady = (id) => call('POST', bookingPath(id, 'readiness'), farmer, ready);
const inspect = (id, passed = true) => call('POST', bookingPath(id, 'inspections'), coop, passed ? { result: 'PASSED' } : { result: 'FAILED', reason: 'Lối vào chưa thông' });

async function eligible(count = 1) {
  const f = await fixture(count);
  assert.equal((await f.callConfirm()).status, 201);
  for (const id of f.ids) {
    assert.equal((await setReady(id)).status, 200);
    assert.equal((await inspect(id)).status, 201);
  }
  return f;
}

test('bank account is validated and scoped to signed-in provider only', async () => {
  await expectError('GET', bankPath, null, 401, 'UNAUTHENTICATED');
  await expectError('PUT', bankPath, farmer, 403, 'FORBIDDEN', bank);
  assert.deepEqual((await call('GET', bankPath, provider)).body, { bankAccount: null });
  for (const invalid of [{ bankBin: '97043X' }, { accountNumber: ' 1234' }, { accountHolder: '  ' }, { bankName: '\u0000' }]) {
    await expectError('PUT', bankPath, provider, 400, 'VALIDATION_FAILED', { ...bank, ...invalid });
  }
  const created = await call('PUT', bankPath, provider, bank);
  assert.equal(created.status, 200);
  assert.equal(created.cache, 'no-store');
  assert.deepEqual({ ...created.body.bankAccount, updatedAt: undefined }, { ...bank, updatedAt: undefined });
  assert.ok(Date.parse(created.body.bankAccount.updatedAt));
  assert.deepEqual((await call('GET', bankPath, otherProvider)).body, { bankAccount: null });
  await expectError('GET', `${bankPath}?providerUserId=${provider}`, otherProvider, 403, 'FORBIDDEN');
  await expectError('PUT', bankPath, otherProvider, 403, 'FORBIDDEN', { ...bank, providerUserId: provider });
  await expectError('PUT', `${bankPath}?providerUserId=${provider}`, otherProvider, 403, 'FORBIDDEN', bank);
  assert.equal((await call('PUT', bankPath, otherProvider, { ...bank, accountNumber: 'AN123456' })).status, 200);
  assert.deepEqual((await call('GET', bankPath, provider)).body, created.body);
  assert.equal((await call('PUT', bankPath, provider, { ...bank, accountHolder: 'Nguyễn Văn B' })).body.bankAccount.accountHolder, 'Nguyễn Văn B');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch.provider_bank_accounts')).rows[0].n, 2);
});

test('VietQR, report and shift share latest current HTX pass gate', async () => {
  const { pkg, ids: [id], callConfirm } = await fixture();
  assert.equal((await setReady(id)).status, 200);
  await expectError('GET', bookingPath(id, 'vietqr'), farmer, 409, 'HTX_CALL_NOT_CONFIRMED');
  await expectError('GET', bookingPath(id, 'vietqr'), otherProvider, 403, 'FORBIDDEN');
  assert.equal((await callConfirm()).status, 201);
  async function blocked(code) {
    for (const [method, path, actor, data] of [
      ['GET', bookingPath(id, 'vietqr'), farmer], ['POST', bookingPath(id, 'deposit'), farmer, { reference: 'TEST-DEPOSIT' }],
      ['POST', `/api/packages/${pkg}/shifts/start`, operator, {}],
    ]) assert.ok((await expectError(method, path, actor, 409, code, data)).message);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch.deposits WHERE booking_id = $1', [id])).rows[0].n, 0);
    assert.equal((await call('GET', bookingPath(id, 'deposit'), farmer)).body.expiresAt, null);
  }
  await blocked('FIELD_INSPECTION_REQUIRED');
  assert.equal((await inspect(id, false)).status, 201);
  await blocked('FIELD_INSPECTION_NOT_PASSED');
  assert.equal((await inspect(id)).status, 201);
  assert.equal((await setReady(id)).status, 200);
  await blocked('FIELD_INSPECTION_REQUIRED');
  assert.equal((await inspect(id)).status, 201);
  assert.equal((await call('GET', bookingPath(id, 'inspections'), farmer)).body.passed, true);
  const issued = await qr(id);
  assert.equal(issued.status, 200);
  assert.equal(issued.cache, 'no-store');
  assert.equal(issued.body.vietqr.accountNumber, bank.accountNumber);
  assert.match(issued.body.vietqr.payload, /^00020101021238/);
  assert.match(issued.body.vietqr.svg, /^<svg /);
  assert.equal((await qr(id)).body.expiresAt, issued.body.expiresAt);
  const recorded = await report(id);
  assert.equal(recorded.status, 201);
  assert.equal(recorded.body.expiresAt, issued.body.expiresAt);
  assert.equal(recorded.body.deposit.status, 'REPORTED');
  assert.equal(recorded.body.deposit.confirmedAt, null);
  assert.equal((await start(pkg)).status, 201);
  assert.equal((await confirm(recorded.body.deposit.id)).body.deposit.status, 'CONFIRMED');
});

test('expiry cancels only due unconfirmed holds, once, without releasing live siblings', async () => {
  const { pkg, ids: [due, paid, live] } = await eligible(3);
  const solo = (await eligible()).ids[0];
  const soloQr = await qr(solo);
  const [{ body: a }, { body: b }, { body: c }] = await Promise.all([report(due), report(paid), qr(live)]);
  assert.equal((await confirm(b.deposit.id)).body.deposit.status, 'CONFIRMED');
  const deadline = Date.parse(a.expiresAt);
  assert.ok(Math.abs(deadline - Date.now() - 7_200_000) < 10_000);
  assert.deepEqual(await deposits.expireOverdueDeposits(pool, new Date(Date.parse(soloQr.body.expiresAt) - 1)), []);
  assert.equal((await inspect(due, false)).status, 201);
  assert.deepEqual(await deposits.expireOverdueDeposits(pool, new Date(soloQr.body.expiresAt)), [solo]);
  await pool.query(`UPDATE dispatch.deposit_holds SET deposit_expires_at = CASE WHEN booking_id = $1 THEN now() + interval '3 hours'
    ELSE now() - interval '1 second' END WHERE booking_id = ANY($2::uuid[])`, [live, [due, paid, live]]);
  assert.deepEqual(await deposits.expireOverdueDeposits(pool), [due]);
  const items = await pool.query(`SELECT b.id, b.state, h.release_reason FROM dispatch.bookings b
    JOIN dispatch.deposit_holds h ON h.booking_id = b.id WHERE b.id = ANY($1::uuid[])`, [[due, paid, live]]);
  assert.deepEqual(Object.fromEntries(items.rows.map(({ id, state, release_reason }) => [id, [state, release_reason]])), {
    [due]: ['CANCELLED', 'DEPOSIT_EXPIRED'], [paid]: ['ASSIGNED', null], [live]: ['ASSIGNED', null],
  });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch.allocations WHERE package_id = $1 AND released_at IS NULL', [pkg])).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch.allocations WHERE package_id = $1 AND released_at IS NULL', [soloQr.body.packageId])).rows[0].n, 0);
  assert.deepEqual(await deposits.expireOverdueDeposits(pool), []);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM dispatch.booking_events
    WHERE booking_id = ANY($1::uuid[]) AND event_type = 'BOOKING_DEPOSIT_EXPIRED'`, [[due, paid, live, solo]])).rows[0].n, 2);
  const view = await call('GET', bookingPath(due, 'deposit'), farmer);
  assert.equal(view.body.deposit.status, 'EXPIRED');
  assert.equal(view.body.accounting.reportedDepositVnd, '0');
  await expectError('POST', `/api/deposits/${a.deposit.id}/confirm`, provider, 409, 'DEPOSIT_EXPIRED', {});
  await expectError('GET', bookingPath(due, 'vietqr'), farmer, 409, 'DEPOSIT_EXPIRED');
  assert.ok(c.expiresAt);
  assert.equal((await start(pkg)).status, 201);
});

test('maintenance skips booking lock held by a recipient; overdue confirmation cannot revive it', async () => {
  const { pkg, ids: [id] } = await eligible();
  const { body } = await report(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM dispatch.packages WHERE id = $1 FOR UPDATE', [pkg]);
    await client.query('SELECT id FROM dispatch.bookings WHERE id = $1 FOR UPDATE', [id]);
    assert.deepEqual(await deposits.expireOverdueDeposits(pool, new Date(Date.parse(body.expiresAt) + 1000)), []);
    await client.query("INSERT INTO dispatch.deposit_events(deposit_id, event_type, actor_id) VALUES ($1, 'DEPOSIT_CONFIRMED', $2)", [body.deposit.id, provider]);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.deepEqual(await deposits.expireOverdueDeposits(pool, new Date(Date.parse(body.expiresAt) + 1000)), []);

  const overdue = (await eligible()).ids[0];
  const { body: old } = await report(overdue);
  await pool.query("UPDATE dispatch.deposit_holds SET deposit_expires_at = now() - interval '1 second' WHERE booking_id = $1", [overdue]);
  await assert.rejects(pool.query("INSERT INTO dispatch.deposit_events (deposit_id, event_type, actor_id) VALUES ($1, 'DEPOSIT_CONFIRMED', $2)",
    [old.deposit.id, provider]), { code: '23001', constraint: 'deposit_deadline' });
  const [receipt, swept] = await Promise.all([confirm(old.deposit.id), deposits.expireOverdueDeposits(pool)]);
  assert.equal(receipt.status, 409);
  assert.equal(receipt.body.error.code, 'DEPOSIT_EXPIRED');
  if (!swept.includes(overdue)) assert.deepEqual(await deposits.expireOverdueDeposits(pool), [overdue]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM dispatch.deposit_events WHERE deposit_id = $1 AND event_type = 'DEPOSIT_CONFIRMED'", [old.deposit.id])).rows[0].n, 0);
});
