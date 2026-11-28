import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { bootstrapDatabase } from '../../scripts/bootstrap-db.js';
import { bootstrapFirstAdmin } from '../../scripts/bootstrap-admin.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

const execFileAsync = promisify(execFile);
const ROOT = process.env.TEST_DATABASE_URL;
parseDisposableRoot(ROOT);

const BOOTSTRAP_CLI = fileURLToPath(new URL('../../scripts/bootstrap-db.js', import.meta.url));
const ADMIN_CLI = fileURLToPath(new URL('../../scripts/bootstrap-admin.js', import.meta.url));
const SERVICE_TOKEN = 'integration-only-service-token-0123456789abcdef';
const USER_PASS = 'correct horse battery';
const ROLE_LOCK_KEY = 62431877;

const randPw = () => `rt_${randomBytes(24).toString('base64url')}_A1!`;
const roleUrl = (baseUrl, username, password) => {
  const url = new URL(baseUrl);
  url.username = username;
  url.password = password;
  return url.href;
};

const ctx = {};
const createdRoles = [];

async function withRoleLock(fn) {
  const client = new pg.Client({ connectionString: ROOT });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ROLE_LOCK_KEY]);
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

before(async () => {
  ctx.db = await createDisposableDatabase(ROOT);
  ctx.pool = createPool(ctx.db.url, { statementTimeout: 60000 });
});

after(async () => {
  if (ctx.pool) {
    for (const role of createdRoles) {
      await ctx.pool.query(`DROP OWNED BY "${role}" CASCADE`).catch(() => {});
    }
    await ctx.pool.end().catch(() => {});
  }
  if (ctx.db) await ctx.db.drop().catch(() => {});
  const rootClient = new pg.Client({ connectionString: ROOT });
  await rootClient.connect().catch(() => {});
  try {
    for (const role of createdRoles) {
      await rootClient.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    }
  } finally {
    await rootClient.end().catch(() => {});
  }
});

test('bootstrapDatabase refuses unmigrated DB, then creates least-privilege SCRAM roles and enforces privileges', async (t) => {
  const suffix = randomBytes(4).toString('hex');
  const roles = { account: `rt_acc_${suffix}`, booking: `rt_book_${suffix}` };
  createdRoles.push(roles.account, roles.booking);
  const pw1 = { account: randPw(), booking: randPw() };

  await assert.rejects(() => bootstrapDatabase(ctx.pool, { roles, passwords: pw1 }), { code: 'SCHEMA_NOT_MIGRATED' });

  await migrate(ctx.pool);
  await seedCatalog(ctx.pool);

  const first = await bootstrapDatabase(ctx.pool, { roles, passwords: pw1 });
  assert.deepEqual(first.roles, { [roles.account]: 'created', [roles.booking]: 'created' });

  // Verify PG catalog flags & native SCRAM verifier storage.
  const roleRows = (await ctx.pool.query(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [[roles.account, roles.booking]],
  )).rows;
  assert.equal(roleRows.length, 2);
  for (const r of roleRows) {
    assert.equal(r.rolsuper, false);
    assert.equal(r.rolinherit, false);
    assert.equal(r.rolcreaterole, false);
    assert.equal(r.rolcreatedb, false);
    assert.equal(r.rolcanlogin, true);
    assert.equal(r.rolreplication, false);
    assert.equal(r.rolbypassrls, false);
  }
  const verifierPrefix = (await ctx.pool.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [roles.account])).rows[0]?.rolpassword;
  assert.match(verifierPrefix ?? '', /^SCRAM-SHA-256\$4096:/);

  // Native PG SCRAM login succeeds with old passwords, and idempotent re-run rotates passwords cleanly.
  const pw2 = { account: randPw(), booking: randPw() };
  const second = await bootstrapDatabase(ctx.pool, { roles, passwords: pw2 });
  assert.deepEqual(second.roles, { [roles.account]: 'updated', [roles.booking]: 'updated' });

  await assert.rejects(async () => {
    const stale = createPool(roleUrl(ctx.db.url, roles.account, pw1.account));
    try { await stale.query('SELECT 1'); } finally { await stale.end(); }
  }, /password authentication failed/);

  const accPool = createPool(roleUrl(ctx.db.url, roles.account, pw2.account));
  const bookPool = createPool(roleUrl(ctx.db.url, roles.booking, pw2.booking));
  t.after(async () => { await accPool.end(); await bookPool.end(); });

  assert.equal((await accPool.query('SELECT current_user')).rows[0].current_user, roles.account);
  assert.equal((await bookPool.query('SELECT current_user')).rows[0].current_user, roles.booking);

  // Negative checks: account_runtime cannot touch dispatch.*, schema_migrations, DDL or TRUNCATE.
  await assert.rejects(() => accPool.query('SELECT * FROM dispatch.services LIMIT 1'), /permission denied/);
  await assert.rejects(() => accPool.query('SELECT * FROM public.schema_migrations LIMIT 1'), /permission denied/);
  await assert.rejects(() => accPool.query('CREATE TABLE public.evil (x int)'), /permission denied/);
  await assert.rejects(() => accPool.query('CREATE TABLE account.evil (x int)'), /permission denied/);
  await assert.rejects(() => accPool.query('TRUNCATE account.rate_limits'), /permission denied/);

  // Negative checks: booking_runtime cannot read PII/credentials, write account.*, read schema_migrations, DDL or TRUNCATE.
  await assert.rejects(() => bookPool.query('SELECT email FROM account.users LIMIT 1'), /permission denied/);
  await assert.rejects(() => bookPool.query('SELECT password_hash FROM account.users LIMIT 1'), /permission denied/);
  await assert.rejects(() => bookPool.query('SELECT * FROM account.users LIMIT 1'), /permission denied/);
  await assert.rejects(() => bookPool.query('SELECT * FROM account.sessions LIMIT 1'), /permission denied/);
  await assert.rejects(() => bookPool.query('SELECT * FROM account.rate_limits LIMIT 1'), /permission denied/);
  await assert.rejects(() => bookPool.query('SELECT * FROM account.role_requests LIMIT 1'), /permission denied/);
  await assert.rejects(
    () => bookPool.query("INSERT INTO account.user_roles (user_id, role) VALUES (gen_random_uuid(), 'admin')"),
    /permission denied/,
  );
  await assert.rejects(() => bookPool.query('SELECT * FROM public.schema_migrations LIMIT 1'), /permission denied/);
  await assert.rejects(() => bookPool.query('CREATE TABLE public.evil (x int)'), /permission denied/);
  await assert.rejects(() => bookPool.query('CREATE TABLE dispatch.evil (x int)'), /permission denied/);
  await assert.rejects(() => bookPool.query('TRUNCATE dispatch.services'), /permission denied/);

  for (const table of ['provider_bank_accounts', 'deposit_holds']) {
    const relation = `dispatch.${table}`;
    const { rows: [grants] } = await ctx.pool.query(`SELECT
      has_table_privilege($1, $3, 'SELECT') AS account_read,
      has_table_privilege($2, $3, 'SELECT') AS booking_read,
      has_table_privilege($2, $3, 'INSERT') AS booking_insert,
      has_table_privilege($2, $3, 'UPDATE') AS booking_update,
      has_table_privilege($2, $3, 'DELETE') AS booking_delete`, [roles.account, roles.booking, relation]);
    assert.deepEqual(grants, { account_read: false, booking_read: true, booking_insert: true, booking_update: true, booking_delete: false });
  }

  // Allowed narrow read on account.users(id, name).
  await bookPool.query('SELECT id, name FROM account.users LIMIT 1');

  // Existing elevated role must be refused rather than silently demoted.
  const badRole = `rt_bad_${suffix}`;
  createdRoles.push(badRole);
  await ctx.pool.query(`CREATE ROLE "${badRole}" LOGIN SUPERUSER`);
  await assert.rejects(
    () => bootstrapDatabase(ctx.pool, { roles: { account: badRole, booking: roles.booking }, passwords: pw2 }),
    { code: 'UNSAFE_EXISTING_ROLE' },
  );
  assert.equal((await ctx.pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [badRole])).rows[0].rolsuper, true);
});

test('failed role bootstrap rolls back role creation and credential rotation together', async () => {
  const suffix = randomBytes(4).toString('hex');
  const fresh = `rt_atomic_${suffix}`, unsafe = `rt_unsafe_${suffix}`;
  createdRoles.push(fresh, unsafe);
  await ctx.pool.query(`CREATE ROLE "${unsafe}" LOGIN SUPERUSER`);
  await assert.rejects(bootstrapDatabase(ctx.pool, { roles: { account: fresh, booking: unsafe }, passwords: { account: randPw(), booking: randPw() } }), { code: 'UNSAFE_EXISTING_ROLE' });
  assert.equal((await ctx.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [fresh])).rowCount, 0);
});

test('failed grant changes preserve the existing runtime password', async () => {
  const suffix = randomBytes(4).toString('hex');
  const account = `rt_rotate_${suffix}`, booking = `rt_reject_${suffix}`;
  createdRoles.push(account, booking);
  const passwords = { account: randPw(), booking: randPw() };
  await bootstrapDatabase(ctx.pool, { roles: { account, booking }, passwords });
  await ctx.pool.query(`ALTER ROLE "${booking}" CREATEDB`);
  await assert.rejects(bootstrapDatabase(ctx.pool, { roles: { account, booking }, passwords: { account: randPw(), booking: randPw() } }), { code: 'UNSAFE_EXISTING_ROLE' });
  const runtime = createPool(roleUrl(ctx.db.url, account, passwords.account));
  try { assert.equal((await runtime.query('SELECT current_user')).rows[0].current_user, account); }
  finally { await runtime.end(); }
});

test('bootstrapFirstAdmin grants sole first admin, stays idempotent, and refuses missing users or second admins', async () => {
  await assert.rejects(
    () => bootstrapFirstAdmin(ctx.pool, '00000000-0000-4000-8000-000000000999'),
    { code: 'USER_NOT_FOUND' },
  );

  const hash = 'scrypt:v1:N=16384:r=8:p=1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const u1 = (await ctx.pool.query("INSERT INTO account.users (email, name, password_hash) VALUES ('admin1@example.com', 'Admin One', $1) RETURNING id", [hash])).rows[0].id;
  const u2 = (await ctx.pool.query("INSERT INTO account.users (email, name, password_hash) VALUES ('admin2@example.com', 'Admin Two', $1) RETURNING id", [hash])).rows[0].id;

  assert.deepEqual(await bootstrapFirstAdmin(ctx.pool, u1), { userId: u1, status: 'granted' });
  const roleRow = (await ctx.pool.query("SELECT granted_by FROM account.user_roles WHERE user_id = $1 AND role = 'admin'", [u1])).rows[0];
  assert.equal(roleRow.granted_by, null);

  assert.deepEqual(await bootstrapFirstAdmin(ctx.pool, u1), { userId: u1, status: 'already-admin' });
  await assert.rejects(() => bootstrapFirstAdmin(ctx.pool, u2), { code: 'ADMIN_ALREADY_EXISTS' });
});

test('full cross-service HTTP flow runs end-to-end under account_runtime and booking_runtime', async (t) => {
  const suffix = randomBytes(4).toString('hex');
  const roles = { account: `rt_flow_acc_${suffix}`, booking: `rt_flow_book_${suffix}` };
  createdRoles.push(roles.account, roles.booking);
  const passwords = { account: randPw(), booking: randPw() };
  await bootstrapDatabase(ctx.pool, { roles, passwords });

  const accPool = createPool(roleUrl(ctx.db.url, roles.account, passwords.account));
  const bookPool = createPool(roleUrl(ctx.db.url, roles.booking, passwords.booking));
  t.after(async () => { await accPool.end(); await bookPool.end(); });

  const accountApp = createAccountApp({ pool: accPool, internalServiceToken: SERVICE_TOKEN });
  const accountServer = accountApp.listen(0, '127.0.0.1');
  await once(accountServer, 'listening');
  t.after(() => new Promise((resolve) => { accountServer.close(resolve); accountServer.closeAllConnections(); }));
  const accountUrl = `http://127.0.0.1:${accountServer.address().port}`;

  const bookingApp = createApp({ pool: bookPool, accountServiceUrl: accountUrl, internalServiceToken: SERVICE_TOKEN });
  const bookingServer = bookingApp.listen(0, '127.0.0.1');
  await once(bookingServer, 'listening');
  t.after(() => new Promise((resolve) => { bookingServer.close(resolve); bookingServer.closeAllConnections(); }));
  const bookingUrl = `http://127.0.0.1:${bookingServer.address().port}`;

  const reqJson = async (base, method, path, body, token, extra = {}) => {
    const headers = { 'content-type': 'application/json', ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // Register users via real account-service HTTP + account_runtime DB role.
  const registerAndLogin = async (email, name) => {
    const reg = await reqJson(bookingUrl, 'POST', '/api/auth/register', { email, password: USER_PASS, name });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const login = await reqJson(bookingUrl, 'POST', '/api/auth/login', { email, password: USER_PASS });
    assert.equal(login.status, 200);
    return { id: reg.body.user.id, token: login.body.token };
  };

  const farmer = await registerAndLogin(`farmer.${suffix}@example.com`, 'Farmer One');
  const coop = await registerAndLogin(`coop.${suffix}@example.com`, 'Coop One');
  const provider = await registerAndLogin(`provider.${suffix}@example.com`, 'Provider One');
  const operator = await registerAndLogin(`operator.${suffix}@example.com`, 'Operator One');
  const adminUser = await registerAndLogin(`mediator.${suffix}@example.com`, 'Mediator One');

  // Clear initial admin (previous test created admin1) via test fixture only, then exercise bootstrapFirstAdmin.
  await ctx.pool.query("DELETE FROM account.user_roles WHERE role = 'admin'");
  const promoted = await bootstrapFirstAdmin(ctx.pool, adminUser.id);
  assert.equal(promoted.status, 'granted');

  // Re-login admin so token carries fresh state, then approve coop/provider/operator role requests via API.
  const adminLogin = await reqJson(bookingUrl, 'POST', '/api/auth/login', { email: `mediator.${suffix}@example.com`, password: USER_PASS });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.body.token;

  for (const [actor, role] of [[coop, 'coop'], [provider, 'provider'], [operator, 'operator']]) {
    const created = await reqJson(bookingUrl, 'POST', '/api/role-requests', { role }, actor.token);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const approved = await reqJson(bookingUrl, 'POST', `/api/admin/role-requests/${created.body.request.id}/approve`, {}, adminToken);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  }

  // Booking-runtime cross-schema operations: field, booking, coordinator list/assign, package, recruitment/machine/claim, dispute + mediator.
  const servicesRes = await reqJson(bookingUrl, 'GET', '/api/services', undefined, farmer.token);
  assert.equal(servicesRes.status, 200);
  const serviceId = servicesRes.body.items.find((s) => s.code === 'tillage-tractor').id;

  const field = await reqJson(bookingUrl, 'POST', '/api/fields', { name: 'Lô 1', locality: 'Châu Thành', areaM2: 10000 }, farmer.token);
  assert.equal(field.status, 201, JSON.stringify(field.body));

  const coords = await reqJson(bookingUrl, 'GET', '/api/coordinators', undefined, farmer.token);
  assert.equal(coords.status, 200);
  assert.ok(coords.body.items.some((c) => c.id === coop.id));

  const booking = await reqJson(
    bookingUrl,
    'POST',
    '/api/bookings',
    { fieldId: field.body.field.id, serviceId, startAt: '2026-12-01T01:00:00Z', endAt: '2026-12-01T05:00:00Z' },
    farmer.token,
    { 'idempotency-key': `runtime-roles-flow-${suffix}` },
  );
  assert.equal(booking.status, 201, JSON.stringify(booking.body));
  const bookingId = booking.body.booking.id;

  const assignCoord = await reqJson(bookingUrl, 'POST', `/api/bookings/${bookingId}/coordinator`, { coordinatorId: coop.id }, farmer.token);
  assert.equal(assignCoord.status, 200, JSON.stringify(assignCoord.body));

  const pkg = await reqJson(bookingUrl, 'POST', '/api/packages', { bookingIds: [bookingId] }, coop.token);
  assert.equal(pkg.status, 201, JSON.stringify(pkg.body));
  const packageId = pkg.body.package.id;

  const machine = await reqJson(bookingUrl, 'POST', '/api/machines', { name: 'Máy cày 1', type: 'tractor' }, provider.token);
  assert.equal(machine.status, 201, JSON.stringify(machine.body));

  // Recruitment link so operator is eligible.
  const job = await reqJson(
    bookingUrl,
    'POST',
    '/api/jobs',
    { title: 'Lái máy', locality: 'Châu Thành', startAt: '2026-12-01T01:00:00Z', endAt: '2026-12-01T05:00:00Z', capacity: 1 },
    provider.token,
  );
  assert.equal(job.status, 201, JSON.stringify(job.body));
  const appRes = await reqJson(bookingUrl, 'POST', `/api/jobs/${job.body.job.id}/applications`, { note: 'Sẵn sàng' }, operator.token);
  assert.equal(appRes.status, 201, JSON.stringify(appRes.body));
  const offer = await reqJson(bookingUrl, 'POST', `/api/applications/${appRes.body.application.id}/offers`, {}, provider.token);
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const accept = await reqJson(bookingUrl, 'POST', `/api/offers/${offer.body.offer.id}/accept`, {}, operator.token);
  assert.equal(accept.status, 200, JSON.stringify(accept.body));

  const claim = await reqJson(bookingUrl, 'POST', `/api/packages/${packageId}/claim`, { machineId: machine.body.machine.id, operatorId: operator.id }, provider.token);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));

  // Open dispute + assign mediator (exercises migration 016 trigger + account.user_roles check under booking_runtime).
  const dispute = await reqJson(bookingUrl, 'POST', `/api/bookings/${bookingId}/disputes`, { reason: 'NO_SHOW', details: 'Máy chưa tới' }, farmer.token);
  assert.equal(dispute.status, 201, JSON.stringify(dispute.body));
  const disputeId = dispute.body.dispute.id;

  const mediators = await reqJson(bookingUrl, 'GET', `/api/dispute-review/${disputeId}/mediators`, undefined, adminToken);
  assert.equal(mediators.status, 200, JSON.stringify(mediators.body));
  assert.ok(mediators.body.items.some((m) => m.id === adminUser.id));

  const escalated = await reqJson(bookingUrl, 'POST', `/api/disputes/${disputeId}/escalate`, { reason: 'Chuyển cấp hòa giải' }, farmer.token);
  assert.equal(escalated.status, 200, JSON.stringify(escalated.body));

  const assigned = await reqJson(bookingUrl, 'POST', `/api/disputes/${disputeId}/mediator`, { mediatorId: adminUser.id }, adminToken);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
});

test('bootstrap CLI commands work end-to-end under advisory lock with non-superuser CREATEROLE migrator', async () => {
  await withRoleLock(async (rootClient) => {
    const pre = await rootClient.query("SELECT rolname FROM pg_roles WHERE rolname IN ('account_runtime', 'booking_runtime')");
    if (pre.rowCount > 0) {
      console.warn('Skipping default-role CLI test: pre-existing account_runtime/booking_runtime roles detected');
      return;
    }
    const subDb = await createDisposableDatabase(ROOT);
    const migName = `rt_migrator_${randomBytes(4).toString('hex')}`;
    const migPw = randPw();
    const accPw = randPw();
    const bookPw = randPw();
    try {
      await rootClient.query(`CREATE ROLE "${migName}" LOGIN CREATEROLE PASSWORD '${migPw}'`);
      await rootClient.query(`ALTER DATABASE "${subDb.name}" OWNER TO "${migName}"`);
      const migUrl = roleUrl(subDb.url, migName, migPw);
      const migPool = createPool(migUrl, { statementTimeout: 60000 });
      try {
        await migrate(migPool);
      } finally {
        await migPool.end();
      }

      const dbUrlObj = new URL(migUrl);
      const res = await execFileAsync(
        process.execPath,
        [BOOTSTRAP_CLI, '--apply', '--confirm-host', dbUrlObj.hostname, '--confirm-database', subDb.name],
        { env: { DATABASE_URL: migUrl, NEW_ACCOUNT_DB_PASSWORD: accPw, NEW_BOOKING_DB_PASSWORD: bookPw } },
      );
      const out = JSON.parse(res.stdout);
      assert.equal(out.mode, 'apply');
      assert.deepEqual(out.roles, { account_runtime: 'created', booking_runtime: 'created' });

      // Insert one user and exercise bootstrap-admin CLI.
      const subPool = createPool(migUrl);
      let userId;
      try {
        userId = (await subPool.query(
          "INSERT INTO account.users (email, name, password_hash) VALUES ('cli@example.com', 'CLI User', $1) RETURNING id",
          ['scrypt:v1:N=16384:r=8:p=1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
        )).rows[0].id;
      } finally {
        await subPool.end();
      }

      const adminOut = await execFileAsync(
        process.execPath,
        [ADMIN_CLI, '--user-id', userId, '--apply', '--confirm-user-id', userId, '--confirm-host', dbUrlObj.hostname, '--confirm-database', subDb.name],
        { env: { DATABASE_URL: migUrl } },
      );
      assert.equal(JSON.parse(adminOut.stdout).status, 'granted');
    } finally {
      const cleanup = createPool(subDb.url);
      await cleanup.query('DROP OWNED BY account_runtime, booking_runtime CASCADE').catch(() => {});
      await cleanup.end().catch(() => {});
      await subDb.drop().catch(() => {});
      await rootClient.query('DROP ROLE IF EXISTS account_runtime, booking_runtime').catch(() => {});
      await rootClient.query(`DROP ROLE IF EXISTS "${migName}"`).catch(() => {});
    }
  });
});
