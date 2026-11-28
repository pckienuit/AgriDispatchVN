import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { createPool } from '../../src/db.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const migrations = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

test('upgrade from schema 017 preserves email login and booking snapshots through the app gateway', async () => {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url, { statementTimeout: 60000 });
  const servers = [];
  let legacy;
  async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  }

  try {
    legacy = await mkdtemp(join(tmpdir(), 'agri-upgrade-'));
    const names = (await readdir(migrations)).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
    const old = names.filter((name) => name < '018_');
    assert.equal(old.length, 17);
    await Promise.all(old.map((name) => copyFile(join(migrations, name), join(legacy, name))));
    assert.deepEqual(await migrate(pool, legacy), old);
    await seedCatalog(pool);
    const password = randomBytes(24).toString('hex');
    const email = 'upgrade@example.test';
    const { rows: [farmer] } = await pool.query('INSERT INTO account.users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, 'Nông dân kiểm thử', await hashPassword(password)]);
    await pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1,'farmer')", [farmer.id]);
    const { rows: [field] } = await pool.query("INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1,'Thửa nâng cấp','Xã thử nghiệm',12500) RETURNING id", [farmer.id]);
    const { rows: [booking] } = await pool.query(`INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at,
        field_name, field_area_m2, service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd)
      SELECT $1,$2,id,now()+interval '1 day',now()+interval '1 day 4 hours',
        'Thửa nâng cấp',12500,code,name,data_label,price_per_ha_vnd,1500000
      FROM dispatch.services WHERE code='harvest-combine' RETURNING id`, [farmer.id, field.id]);

    const oldToken = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO account.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [createHash('sha256').update(oldToken).digest('hex'), farmer.id]);
    const applied = await migrate(pool);
    assert.deepEqual(applied, names.slice(old.length));
    assert.ok(applied.includes('027_auth_sessions_otp.sql'));
    assert.deepEqual(await migrate(pool), []);
    const internalServiceToken = randomBytes(24).toString('hex');
    const quiet = () => {};
    const accountServiceUrl = await listen(createAccountApp({ pool, internalServiceToken, log: quiet }));
    const origin = await listen(createApp({ pool, accountServiceUrl, internalServiceToken, log: quiet }));
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    async function get(path) {
      const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200, path);
      return response.json();
    }
    const legacySession = await fetch(`${origin}/api/me`, { headers: { Authorization: `Bearer ${oldToken}` } });
    assert.equal(legacySession.status, 200);
    const { sessions } = await get('/api/auth/sessions');
    assert.equal(sessions.length, 2);
    const oldSession = sessions.find((session) => !session.isCurrent);
    assert.match(oldSession.id, /^[0-9a-f-]{36}$/);
    assert.equal(oldSession.userAgent, null);
    assert.equal(oldSession.ip, null);
    const { user } = await get('/api/me');
    assert.equal(user.id, farmer.id);
    const { items: [migratedField] } = await get('/api/fields');
    assert.equal(migratedField.id, field.id);
    assert.equal(migratedField.areaM2, 12500);
    const { booking: migratedBooking } = await get(`/api/bookings/${booking.id}`);
    assert.equal(migratedBooking.state, 'REQUESTED');
    assert.equal(migratedBooking.totalVnd, '1500000');
    const { details } = await get(`/api/fields/${field.id}/details`);
    assert.equal(details.locationConsent, false);
    assert.equal(details.coordinates, null);
    const { deposit, accounting } = await get(`/api/bookings/${booking.id}/deposit`);
    assert.equal(deposit, null);
    assert.equal(accounting.settlementIntegrated, true);
    const page = await fetch(`${origin}/v2/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /app\/main\.js/);
  } finally {
    try {
      await Promise.all(servers.map((server) => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })));
      await pool.end();
    } finally {
      try {
        await db.drop();
      } finally {
        if (legacy) await rm(legacy, { recursive: true, force: true });
      }
    }
  }
});
