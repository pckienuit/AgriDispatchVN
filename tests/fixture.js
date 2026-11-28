import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createAccountApp } from '../server/src/account-app.js';
import { createApp } from '../server/src/app.js';
import { createPool } from '../server/src/db.js';
import { migrate } from '../server/scripts/migrate.js';
import { seedCatalog } from '../server/scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../server/tests/helpers/test-db.js';

export const PASSWORD = 'Btth5_Test123';
export const HARVEST = '00000000-0000-4000-8000-000000000102';
export const FIELD = { name: 'Thửa kiểm thử', locality: 'Xã thử nghiệm', areaM2: 12000 };
export const START = '2026-12-01T08:00:00.000Z';
export const END = '2026-12-01T12:00:00.000Z';

export function testRoot(value) {
  const url = parseDisposableRoot(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('BTTH5 requires a loopback TEST_DATABASE_URL');
  }
  return url.href;
}

export async function fixture(t) {
  const db = await createDisposableDatabase(testRoot(process.env.TEST_DATABASE_URL));
  const pool = createPool(db.url);
  const servers = [];
  t.after(async () => {
    try {
      for (const server of servers.reverse()) {
        await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      }
    } finally {
      try { await pool.end(); } finally {
        await db.drop();
        t.diagnostic(`Cleanup: closed HTTP servers and dropped ${db.name}`);
      }
    }
  });
  await migrate(pool);
  await seedCatalog(pool);
  t.diagnostic(`PostgreSQL: ${db.name} (migrated)`);
  const listen = async (app) => {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  const internalServiceToken = randomBytes(32).toString('hex');
  const log = () => {}; // Assertions and case diagnostics are logged; omit access logs for static assets.
  const accountServiceUrl = await listen(createAccountApp({ pool, internalServiceToken, log }));
  const origin = await listen(createApp({ pool, accountServiceUrl, internalServiceToken, log }));

  async function request(method, path, { token, body, key } = {}) {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
    const res = await fetch(origin + path, {
      method, headers, body: JSON.stringify(body), signal: globalThis.AbortSignal.timeout(8000),
    });
    const text = await res.text();
    assert.ok(!/password_?hash|scrypt:v1:/i.test(text), 'HTTP response exposed a password hash');
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function user(n, { coop = false, login = true } = {}) {
    const credentials = { phone: `09123456${String(n).padStart(2, '0')}`, password: PASSWORD };
    const name = `Tài khoản kiểm thử ${n}`;
    const registered = await request('POST', '/api/auth/register', { body: { ...credentials, name } });
    assert.equal(registered.status, 201);
    const { id } = registered.body.user;
    if (coop) await pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'coop')", [id]);
    const actor = { id, name, credentials };
    if (login) {
      const session = await request('POST', '/api/auth/login', { body: credentials });
      assert.equal(session.status, 200);
      actor.token = session.body.token;
    }
    return actor;
  }

  async function field(token) {
    const res = await request('POST', '/api/fields', { token, body: FIELD });
    assert.equal(res.status, 201);
    return res.body.field.id;
  }
  const rows = async (sql, args) => (await pool.query(sql, args)).rows;
  return { origin, request, user, field, rows };
}
