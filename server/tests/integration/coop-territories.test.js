import assert from 'node:assert/strict';
import express from 'express';
import { after, before, test } from 'node:test';
import { createPool } from '../../src/db.js';
import { createCoopTerritoriesRouter } from '../../src/coop-territories.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

const ROOT = process.env.TEST_DATABASE_URL;
parseDisposableRoot(ROOT);
const db = {};
const ids = {
  admin: '11111111-1111-4111-8111-111111111111',
  coopA: '22222222-2222-4222-8222-222222222222',
  coopB: '33333333-3333-4333-8333-333333333333',
  farmer: '44444444-4444-4444-8444-444444444444',
};
let app;

before(async () => {
  db.disposable = await createDisposableDatabase(ROOT);
  db.pool = createPool(db.disposable.url);
  await migrate(db.pool);
  await db.pool.query(`INSERT INTO account.users (id,email,name,password_hash) VALUES
    ($1,'admin@example.test','Admin','scrypt:v1:N=16384:r=8:p=1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ($2,'coop-a@example.test','HTX A','scrypt:v1:N=16384:r=8:p=1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ($3,'coop-b@example.test','HTX B','scrypt:v1:N=16384:r=8:p=1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ($4,'farmer@example.test','Farmer','scrypt:v1:N=16384:r=8:p=1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')`,
  [ids.admin, ids.coopA, ids.coopB, ids.farmer]);
  await db.pool.query(`INSERT INTO account.user_roles (user_id,role) VALUES ($1,'admin'),($2,'coop'),($3,'coop'),($4,'farmer')`, Object.values(ids));
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const user = req.headers['x-test-user'];
    req.actor = user === 'admin' ? { id: ids.admin, roles: ['admin'] }
      : user === 'coop-a' ? { id: ids.coopA, roles: ['coop'] }
        : user === 'coop-b' ? { id: ids.coopB, roles: ['coop'] }
          : { id: ids.farmer, roles: ['farmer'] };
    next();
  });
  app.use(createCoopTerritoriesRouter({ pool: db.pool, authenticate: (req, res, next) => next() }));
});

after(async () => {
  await db.pool?.end();
  await db.disposable?.drop();
});

async function request(actor, method, path, body) {
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': actor },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

test('admin assigns same commune to multiple coops, rejects duplicate pair and records audit', async () => {
  const commune = { provinceCode: 'AG', provinceName: 'An Giang', communeCode: 'THOAI-SON', communeName: 'Thoại Sơn' };
  const first = await request('admin', 'POST', `/api/admin/coops/${ids.coopA}/territories`, commune);
  assert.equal(first.status, 201);
  const second = await request('admin', 'POST', `/api/admin/coops/${ids.coopB}/territories`, commune);
  assert.equal(second.status, 201);
  assert.equal((await request('admin', 'POST', `/api/admin/coops/${ids.coopA}/territories`, commune)).status, 409);
  const audit = await db.pool.query(`SELECT action FROM dispatch.coop_territory_audit ORDER BY sequence`);
  assert.deepEqual(audit.rows.map((row) => row.action), ['ASSIGNED', 'ASSIGNED']);
  const overview = await request('coop-a', 'GET', '/api/htx/territories/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.communes.length, 1);
  assert.deepEqual(overview.data.communes[0], commune);
  assert.equal(overview.data.delegated.bookingCount, 0);
  assert.equal(overview.data.directorySource, 'ADMIN_ENTERED');
});

test('remove assignment preserves audit and H-01 exposes only assigned communes and scoped operational counts', async () => {
  const row = (await db.pool.query('SELECT id FROM dispatch.commune_territories WHERE coop_id=$1 LIMIT 1', [ids.coopA])).rows[0];
  assert.ok(row);
  const removed = await request('admin', 'DELETE', `/api/admin/coops/${ids.coopA}/territories/${row.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await db.pool.query('SELECT action FROM dispatch.coop_territory_audit WHERE assignment_id=$1 ORDER BY sequence', [row.id])).rows.at(-1).action, 'REMOVED');
  const view = await request('coop-a', 'GET', '/api/htx/territories/overview');
  assert.equal(view.status, 200);
  assert.deepEqual(view.data.communes, []);
  assert.equal((await request('farmer', 'GET', '/api/htx/territories/overview')).status, 403);
});

test('admin input validation rejects empty administrative identifiers without importing a directory', async () => {
  const result = await request('admin', 'POST', `/api/admin/coops/${ids.coopA}/territories`, {
    provinceCode: '', provinceName: 'An Giang', communeCode: 'XX', communeName: 'Xã thử',
  });
  assert.equal(result.status, 400);
  assert.equal(result.data.error.code, 'VALIDATION_FAILED');
});
