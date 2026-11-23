import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import {
  accountStatus, clearSessions, createCredentials, runCloudBookingBenchmark, runCloudRecruitmentBenchmark, setupAccounts,
} from '../../scripts/benchmark-cloud-writes.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

// Full API path against real local services: register, role requests, admin approval through the gateway, both cases.
test('API write tool sets up accounts, waits for admin approval and measures both write cases', async (t) => {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url);
  const servers = [];
  t.after(async () => {
    clearSessions();
    for (const server of servers) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    await pool.end();
    await db.drop();
  });
  await migrate(pool);
  await seedCatalog(pool);
  const secret = 'synthetic-service-credential-0123456789abcdef';
  const listen = async (app) => {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  // Staging-like throttle (small on purpose) so the resumable setup path is exercised.
  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret, throttle: { registerIpMax: 4 }, log: () => {} }));
  const origin = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret, log: () => {} }));

  const creds = createCredentials(origin, 4);
  let saves = 0;
  const first = await setupAccounts({ origin, creds, save: async () => { saves += 1; } });
  assert.deepEqual(first, { done: false, reason: 'REGISTER_RATE_LIMITED' });
  assert.equal([creds.farmer, creds.provider, ...creds.operators].filter((a) => a.registered).length, 4);
  await pool.query('DELETE FROM account.rate_limits'); // the throttle window ends
  assert.deepEqual(await setupAccounts({ origin, creds, save: async () => { saves += 1; } }), { done: true });
  assert.ok(saves >= 6);

  const before = await accountStatus({ origin, creds });
  assert.deepEqual(before.filter((row) => !row.ready).map((row) => row.needs).sort(), ['operator', 'operator', 'operator', 'operator', 'provider']);
  await assert.doesNotReject(async () => {
    const report = await runCloudRecruitmentBenchmark({ baseUrl: origin, creds, capacity: 2 });
    assert.equal(report.error.cause, 'ROLE_MISSING');
  });

  // Admin approves through the public gateway, exactly as on staging.
  const adminEmail = 'cl12-admin@bench.example.test';
  const call = (path, body, token, method = 'POST') => fetch(origin + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  await pool.query('DELETE FROM account.rate_limits');
  const admin = await (await call('/api/auth/register', { email: adminEmail, password: 'synthetic-admin-passphrase', name: 'Admin tổng hợp' })).json();
  await pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'admin')", [admin.user.id]); // test fixture, like bootstrap-admin
  const adminToken = (await (await call('/api/auth/login', { email: adminEmail, password: 'synthetic-admin-passphrase' })).json()).token;
  const listed = await call('/api/admin/role-requests?limit=20', null, adminToken, 'GET');
  const listedBody = await listed.json();
  assert.equal(listed.status, 200, JSON.stringify(listedBody));
  const pending = listedBody.items.filter((item) => item.status === 'PENDING');
  assert.equal(pending.length, 5);
  for (const request of pending) assert.equal((await call(`/api/admin/role-requests/${request.id}/approve`, {}, adminToken)).status, 200);
  assert.ok((await accountStatus({ origin, creds })).every((row) => row.ready));

  const booking = await runCloudBookingBenchmark({ baseUrl: origin, creds, count: 5, concurrency: 4 });
  assert.equal(booking.error, null, JSON.stringify(booking.error));
  assert.deepEqual(booking.violations, []);
  assert.equal(booking.rows.length, 10);
  assert.equal(booking.observed.distinctBookings, 5);
  const second = await runCloudBookingBenchmark({ baseUrl: origin, creds, count: 5, concurrency: 4 });
  assert.equal(second.ok, true, 'a second run reuses the session and field and still passes');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch.fields')).rows[0].n, 1);

  const recruitment = await runCloudRecruitmentBenchmark({ baseUrl: origin, creds, capacity: 2 });
  assert.equal(recruitment.error, null, JSON.stringify(recruitment.error));
  assert.deepEqual(recruitment.violations, []);
  assert.equal(recruitment.observed.acceptedOffers, 2);
  assert.equal(recruitment.observed.acceptCapacityFull, 2);
  assert.equal(recruitment.cleanup.jobClosed, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM dispatch.jobs WHERE status = 'OPEN'")).rows[0].n, 0);

  const serialized = JSON.stringify([booking, recruitment]);
  for (const secretValue of [creds.farmer.password, creds.provider.password, ...creds.operators.map((a) => a.password)]) {
    assert.equal(serialized.includes(secretValue), false, 'reports never contain passwords');
  }
  assert.equal(/Bearer|"token"/.test(serialized), false, 'reports never contain tokens');
});
