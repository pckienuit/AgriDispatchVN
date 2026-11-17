import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const secret = 'integration-service-credential-0123456789abcdef';

test('combined migrations and catalog use real account HTTP identity, then fail closed on outage', async (t) => {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url);
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
    await pool.end();
    await db.drop();
  });
  const applied = await migrate(pool);
  assert.ok(applied.includes('001_accounts.sql'));
  assert.ok(applied.includes('002_catalog.sql'));
  assert.deepEqual(await migrate(pool), []);
  await seedCatalog(pool);
  const listen = async (app) => {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  };
  const account = await listen(createAccountApp({ pool, internalServiceToken: secret }));
  const booking = await listen(createApp({ pool, accountServiceUrl: account.url, internalServiceToken: secret }));
  const post = (url, path, body, token) => fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const input = { email: 'integration@example.com', name: 'Synthetic Farmer', password: 'integration-only-passphrase' };
  assert.equal((await post(account.url, '/api/auth/register', input)).status, 201);
  const login = await post(account.url, '/api/auth/login', { email: input.email, password: input.password });
  const session = await login.json();
  const services = await fetch(booking.url + '/api/services');
  assert.equal(services.status, 200);
  assert.equal((await services.json()).items.length, 3);
  const fieldResponse = await post(booking.url, '/api/fields', { name: 'Ruộng demo', locality: 'Địa bàn mô phỏng', areaM2: 12000 }, session.token);
  assert.equal(fieldResponse.status, 201);
  const { field } = await fieldResponse.json();
  const request = { fieldId: field.id, serviceId: '00000000-0000-4000-8000-000000000102', startAt: '2026-11-25T08:00:00Z', endAt: '2026-11-25T12:00:00Z' };
  const createOrder = (token = session.token) => fetch(booking.url + '/api/bookings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'live-http-booking-key-0001' }, body: JSON.stringify(request),
  });
  const order = await createOrder();
  assert.equal(order.status, 201);
  const original = await order.json();
  assert.deepEqual(await (await createOrder()).json(), original);
  assert.equal(original.booking.totalVnd, '1440000');
  const mine = await fetch(booking.url + '/api/fields', { headers: { Authorization: `Bearer ${session.token}` } });
  assert.equal((await mine.json()).items.length, 1);
  const gatewayLogin = await post(booking.url, '/api/auth/login', { email: input.email, password: input.password });
  assert.equal(gatewayLogin.status, 200);
  const gatewaySession = await gatewayLogin.json();
  assert.equal((await fetch(booking.url + '/api/me', { headers: { Authorization: `Bearer ${gatewaySession.token}` } })).status, 200);
  assert.equal((await post(booking.url, '/api/machines', { name: 'Máy demo', type: 'harvester' }, session.token)).status, 403);
  const other = { ...input, email: 'other-integration@example.com' };
  assert.equal((await post(account.url, '/api/auth/register', other)).status, 201);
  const second = await (await post(account.url, '/api/auth/login', { email: other.email, password: other.password })).json();
  const theirs = await fetch(booking.url + '/api/fields', { headers: { Authorization: `Bearer ${second.token}` } });
  assert.deepEqual((await theirs.json()).items, []);
  await new Promise((resolve) => { account.server.close(resolve); account.server.closeAllConnections(); });
  const failed = await post(booking.url, '/api/fields', { name: 'Không lưu', locality: 'Demo', areaM2: 1000 }, session.token);
  assert.equal(failed.status, 503);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM dispatch.fields')).rows[0].n, 1);
});
