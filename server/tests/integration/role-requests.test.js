import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import express from 'express';
import { createPool } from '../../src/db.js';
import { createRoleRequestRouter } from '../../src/role-requests.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const ROOT = process.env.TEST_DATABASE_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAKE_HASH = `scrypt:v1:N=16384:r=8:p=1:${'a'.repeat(22)}:${'b'.repeat(86)}`;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const ACTOR = 'x-test-actor';
const ROLES = 'x-test-roles';
const DTO_KEYS = ['canDecide', 'createdAt', 'decidedAt', 'decisionReason', 'id', 'role', 'status', 'userId', 'userName'];

// Stand-in for the parent's authenticate. Identity comes from a header; the roles header is a claim the
// router must not trust for admin decisions. Tests send a stale admin claim to prove the DB is re-read.
function stubAuthenticate(req, res, next) {
  const id = req.get(ACTOR);
  if (!id || !UUID.test(id)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = { id, roles: (req.get(ROLES) ?? '').split(',').filter(Boolean) };
  next();
}

// upgradeFrom013: applies only migrations 001 to 013 so a test can prove 014 keeps existing grant rows intact.
async function fixture(t, { upgradeFrom013 = false } = {}) {
  assert.ok(ROOT, 'TEST_DATABASE_URL must be set for role request integration tests');
  const db = await createDisposableDatabase(ROOT);
  const pool = createPool(db.url, { statementTimeout: 60000 });
  let server;
  let dir;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await db.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  if (upgradeFrom013) {
    dir = await mkdtemp(join(tmpdir(), 'role-migrations-'));
    for (const name of (await readdir(MIGRATIONS)).filter((item) => item.endsWith('.sql') && item < '014_')) {
      await copyFile(join(MIGRATIONS, name), join(dir, name));
    }
    await migrate(pool, dir);
  } else {
    await migrate(pool);
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(createRoleRequestRouter({ pool, authenticate: stubAuthenticate }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { pool, url: `http://127.0.0.1:${server.address().port}` };
}

let seq = 0;
async function user(pool, name, roles = ['farmer']) {
  seq += 1;
  const email = `user${seq}@example.com`;
  const { rows } = await pool.query(
    'INSERT INTO account.users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [email, name, FAKE_HASH],
  );
  for (const role of roles) {
    await pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [rows[0].id, role]);
  }
  return { id: rows[0].id, email, name };
}

async function call(url, method, path, { actor, roles, body } = {}) {
  const headers = {};
  if (actor) headers[ACTOR] = actor;
  if (roles !== undefined) headers[ROLES] = roles;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(`${url}${path}`, { method, headers, body: payload });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

const scalar = async (pool, sql, params = []) => (await pool.query(sql, params)).rows[0].n;
const requestRow = async (pool, id) => (await pool.query(
  'SELECT status, decided_by, decided_at, decision_reason FROM account.role_requests WHERE id = $1',
  [id],
)).rows[0];
const grantOf = async (pool, userId, role) => (await pool.query(
  'SELECT granted_by FROM account.user_roles WHERE user_id = $1 AND role = $2',
  [userId, role],
)).rows[0];
const pendingCount = (pool) => scalar(pool, "SELECT count(*)::int AS n FROM account.role_requests WHERE status = 'PENDING'");

async function assertPgError(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}

async function makeRequest(url, actor, role = 'provider') {
  const res = await call(url, 'POST', '/api/role-requests', { actor: actor.id, body: { role } });
  assert.equal(res.status, 201, res.text);
  return res.body.request.id;
}

test('014 applies after 013, re-runs as a no-op, and keeps existing grants with granted_by NULL', async (t) => {
  const { pool } = await fixture(t, { upgradeFrom013: true });
  const old = await user(pool, 'Existing Operator', ['farmer', 'operator']);
  assert.deepEqual(await migrate(pool), ['014_role_requests.sql','015_role_request_reason.sql']);
  assert.deepEqual(await migrate(pool), []);
  const grant = await grantOf(pool, old.id, 'operator');
  assert.ok(grant, 'existing grant survives the migration');
  assert.equal(grant.granted_by, null);
  assert.equal(await scalar(pool, `SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'account' AND table_name = 'user_roles' AND column_name = 'granted_by' AND is_nullable = 'YES'`), 1);
});

test('schema refuses admin and non-requestable roles, duplicate pending rows and self decisions', async (t) => {
  const { pool } = await fixture(t);
  const farmer = await user(pool, 'Farmer');
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const insert = (role, status = 'PENDING') => pool.query(
    'INSERT INTO account.role_requests (user_id, requested_role, status) VALUES ($1, $2, $3)',
    [farmer.id, role, status],
  );
  await assertPgError(insert('admin'), '23514');
  await assertPgError(insert('farmer'), '23514');
  await insert('provider');
  await assertPgError(insert('provider'), '23505');
  await assertPgError(pool.query(
    `UPDATE account.role_requests SET status = 'APPROVED', decided_at = now(), decided_by = $1 WHERE user_id = $1`,
    [farmer.id],
  ), '23514');
  await assertPgError(pool.query(
    `INSERT INTO account.user_roles (user_id, role, granted_by) VALUES ($1, 'coop', $1)`,
    [admin.id],
  ), '23514');
});

test('direct SQL cannot rewrite, delete or reopen decided role request history', async (t) => {
  const { pool } = await fixture(t);
  const farmer = await user(pool, 'Farmer');
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const { rows } = await pool.query(
    "INSERT INTO account.role_requests (user_id, requested_role) VALUES ($1, 'operator') RETURNING id",
    [farmer.id],
  );
  const id = rows[0].id;
  await assertPgError(pool.query("UPDATE account.role_requests SET requested_role = 'coop' WHERE id = $1", [id]), '23514');
  await assertPgError(pool.query("DELETE FROM account.role_requests WHERE id = $1", [id]), '23514');
  await assertPgError(pool.query(
    "UPDATE account.role_requests SET status = 'APPROVED', decided_at = now() WHERE id = $1",
    [id],
  ), '23514');
  await assertPgError(pool.query(
    "UPDATE account.role_requests SET status = 'APPROVED', decided_at = now(), decided_by = $2, decision_reason = 'x' WHERE id = $1",
    [id, admin.id],
  ), '23514');
  await pool.query(
    "UPDATE account.role_requests SET status = 'APPROVED', decided_at = now(), decided_by = $2 WHERE id = $1",
    [id, admin.id],
  );
  await assertPgError(pool.query("UPDATE account.role_requests SET status = 'REJECTED', decision_reason = 'late' WHERE id = $1", [id]), '23514');
  await assertPgError(pool.query('DELETE FROM account.role_requests WHERE id = $1', [id]), '23514');
  await assertPgError(pool.query("UPDATE account.role_requests SET decided_at = now() WHERE id = $1", [id]), '23514');

  const rejected = await pool.query(
    "INSERT INTO account.role_requests (user_id, requested_role) VALUES ($1, 'provider') RETURNING id",
    [farmer.id],
  );
  await assertPgError(pool.query(
    "UPDATE account.role_requests SET status = 'REJECTED', decided_at = now(), decided_by = $2, decision_reason = $3 WHERE id = $1",
    [rejected.rows[0].id, admin.id, 'x'.repeat(501)],
  ), '23514');
  await assertPgError(pool.query(
    "UPDATE account.role_requests SET status = 'REJECTED', decided_at = now(), decided_by = $2, decision_reason = '' WHERE id = $1",
    [rejected.rows[0].id, admin.id],
  ), '23514');
  await assertPgError(pool.query(
    "UPDATE account.role_requests SET status = 'REJECTED', decided_at = now(), decided_by = $2, decision_reason = NULL WHERE id = $1",
    [rejected.rows[0].id, admin.id],
  ), '23514');
  await assertPgError(pool.query(
    "UPDATE account.role_requests SET status = 'REJECTED', decided_at = now(), decided_by = user_id, decision_reason = 'x' WHERE id = $1",
    [rejected.rows[0].id],
  ), '23514');
});

test('role request objects stay in the account schema and reference only account.users', async (t) => {
  const { pool } = await fixture(t);
  const targets = await pool.query(`SELECT confrelid::regclass::text AS target FROM pg_constraint
    WHERE conrelid = 'account.role_requests'::regclass AND contype = 'f'`);
  assert.deepEqual([...new Set(targets.rows.map((row) => row.target))], ['account.users']);
  assert.equal(await scalar(pool, `SELECT count(*)::int AS n FROM pg_constraint WHERE confrelid = 'account.role_requests'::regclass`), 0);
  const fn = await pool.query("SELECT pronamespace::regnamespace::text AS schema FROM pg_proc WHERE proname = 'role_requests_guard'");
  assert.deepEqual(fn.rows.map((row) => row.schema), ['account']);
});

test('POST creates own pending request with the shared DTO and no contact or secret fields', async (t) => {
  const { pool, url } = await fixture(t);
  const farmer = await user(pool, 'Nguyen An');
  const res = await call(url, 'POST', '/api/role-requests', { actor: farmer.id, body: { role: 'provider' } });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(Object.keys(res.body.request).sort(), DTO_KEYS);
  assert.equal(res.body.request.userId, farmer.id);
  assert.equal(res.body.request.userName, 'Nguyen An');
  assert.equal(res.body.request.role, 'provider');
  assert.equal(res.body.request.status, 'PENDING');
  assert.equal(res.body.request.canDecide, false);
  assert.equal(res.body.request.decidedAt, null);
  assert.equal(res.body.request.decisionReason, null);
  assert.ok(!res.text.includes('@') && !/password|token|session/i.test(res.text));
  assert.equal(await scalar(pool, 'SELECT count(*)::int AS n FROM account.role_requests WHERE user_id = $1', [farmer.id]), 1);
});

test('own list returns only the caller requests, newest first, with bounded paging', async (t) => {
  const { pool, url } = await fixture(t);
  const a = await user(pool, 'Farmer A');
  const b = await user(pool, 'Farmer B');
  await makeRequest(url, a, 'provider');
  await makeRequest(url, a, 'operator');
  await makeRequest(url, b, 'coop');
  const list = await call(url, 'GET', '/api/role-requests', { actor: a.id });
  assert.equal(list.status, 200);
  assert.equal(list.body.limit,20);
  assert.equal(list.body.offset,0);
  assert.deepEqual(list.body.items.map((item) => item.role), ['operator', 'provider']);
  assert.ok(list.body.items.every((item) => item.userId === a.id && item.canDecide === false));
  assert.deepEqual(Object.keys(list.body.items[0]).sort(), DTO_KEYS);
  const page = await call(url, 'GET', '/api/role-requests?limit=1&offset=1', { actor: a.id });
  assert.deepEqual(page.body.items.map((item) => item.role), ['provider']);
});

test('request creation refuses unknown fields, non-requestable roles and missing bodies with no row written', async (t) => {
  const { pool, url } = await fixture(t);
  const farmer = await user(pool, 'Farmer');
  const send = (body) => call(url, 'POST', '/api/role-requests', { actor: farmer.id, body });
  assert.equal((await send({ role: 'provider', extra: 1 })).body.error.code, 'UNKNOWN_FIELD');
  for (const body of [{ role: 'admin' }, { role: 'farmer' }, { role: 'Provider' }, { role: ['provider'] }, {}]) {
    const res = await send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'INVALID_ROLE', JSON.stringify(body));
  }
  const noBody = await call(url, 'POST', '/api/role-requests', { actor: farmer.id });
  assert.equal(noBody.status, 400);
  assert.equal(noBody.body.error.code, 'INVALID_REQUEST');
  assert.equal(await scalar(pool, 'SELECT count(*)::int AS n FROM account.role_requests'), 0);
});

test('already-granted roles and duplicate pending requests return 409 with stable codes', async (t) => {
  const { pool, url } = await fixture(t);
  const operator = await user(pool, 'Operator', ['farmer', 'operator']);
  const farmer = await user(pool, 'Farmer');
  const granted = await call(url, 'POST', '/api/role-requests', { actor: operator.id, body: { role: 'operator' } });
  assert.equal(granted.status, 409);
  assert.equal(granted.body.error.code, 'ROLE_ALREADY_GRANTED');
  await makeRequest(url, farmer, 'operator');
  const dup = await call(url, 'POST', '/api/role-requests', { actor: farmer.id, body: { role: 'operator' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'REQUEST_PENDING');
  assert.equal(await pendingCount(pool), 1);
});

test('concurrent duplicate requests yield exactly one 201 and one 409', async (t) => {
  const { pool, url } = await fixture(t);
  const farmer = await user(pool, 'Farmer');
  const results = await Promise.all([1, 2].map(() => call(url, 'POST', '/api/role-requests', { actor: farmer.id, body: { role: 'coop' } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409).body.error.code, 'REQUEST_PENDING');
  assert.equal(await pendingCount(pool), 1);
});

test('missing or malformed identity gets 401 on every role request route', async (t) => {
  const { url } = await fixture(t);
  const routes = [
    ['GET', '/api/role-requests'],
    ['POST', '/api/role-requests'],
    ['GET', '/api/admin/role-requests'],
    ['POST', `/api/admin/role-requests/${MISSING_ID}/approve`],
    ['POST', `/api/admin/role-requests/${MISSING_ID}/reject`],
  ];
  for (const [method, path] of routes) {
    const none = await call(url, method, path, { body: method === 'POST' ? {} : undefined });
    assert.equal(none.status, 401, `${method} ${path}`);
    assert.equal(none.body.error.code, 'UNAUTHENTICATED');
    const bad = await call(url, method, path, { actor: 'not-a-uuid', body: method === 'POST' ? {} : undefined });
    assert.equal(bad.status, 401, `${method} ${path} malformed`);
  }
});

test('admin queue and decisions refuse non-admin callers with 403 and change nothing', async (t) => {
  const { pool, url } = await fixture(t);
  const farmer = await user(pool, 'Farmer');
  const other = await user(pool, 'Other');
  const id = await makeRequest(url, farmer, 'provider');
  const list = await call(url, 'GET', '/api/admin/role-requests', { actor: other.id });
  assert.equal(list.status, 403);
  assert.equal(list.body.error.code, 'FORBIDDEN');
  const approve = await call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: other.id, body: {} });
  assert.equal(approve.status, 403);
  assert.equal(approve.body.error.code, 'FORBIDDEN');
  const reject = await call(url, 'POST', `/api/admin/role-requests/${id}/reject`, { actor: other.id, body: { reason: 'x' } });
  assert.equal(reject.status, 403);
  assert.equal((await requestRow(pool, id)).status, 'PENDING');
  assert.equal(await grantOf(pool, farmer.id, 'provider'), undefined);
});

test('admin queue lists pending first with canDecide and pages across the boundary', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const farmers = [];
  for (let i = 0; i < 21; i += 1) farmers.push(await user(pool, `Farmer ${i}`));
  const ids = [];
  for (const farmer of farmers) ids.push(await makeRequest(url, farmer, 'provider'));
  const ownId = await makeRequest(url, admin, 'operator');
  const rejected = await call(url, 'POST', `/api/admin/role-requests/${ids[0]}/reject`, { actor: admin.id, body: { reason: 'Thiếu hồ sơ' } });
  assert.equal(rejected.status, 200, rejected.text);

  const pages = [];
  for (const offset of [0, 20]) {
    const page = await call(url, 'GET', `/api/admin/role-requests?limit=20&offset=${offset}`, { actor: admin.id });
    assert.equal(page.status, 200);
    pages.push(...page.body.items);
  }
  assert.equal(pages.length, 22);
  assert.equal(new Set(pages.map((item) => item.id)).size, 22);
  assert.deepEqual(Object.keys(pages[0]).sort(), DTO_KEYS);
  // 21 pending rows (20 farmer + admin own) come first, oldest first; the rejected row is last.
  assert.deepEqual(pages.slice(0, 21).map((item) => item.status), Array(21).fill('PENDING'));
  assert.equal(pages[20].id, ownId, 'admin own request is the newest pending row');
  assert.equal(pages[21].id, ids[0]);
  assert.equal(pages[21].status, 'REJECTED');
  assert.equal(pages[21].canDecide, false);
  // canDecide is true only for other people's pending rows.
  assert.deepEqual(pages.filter((item) => !item.canDecide).map((item) => item.id).sort(), [ownId, ids[0]].sort());
  assert.equal(await scalar(pool, 'SELECT count(*)::int AS n FROM account.role_requests'), 22);
});

test('admin pagination rejects out-of-range, malformed, repeated and unknown parameters', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const bad = [
    'limit=0', 'limit=21', 'limit=abc', 'limit=1.5', 'limit=-1', 'limit=', 'offset=10001', 'offset=-1',
    'limit=1&limit=2', 'foo=1', 'limit=20&limit=20',
  ];
  for (const query of bad) {
    for (const path of ['/api/admin/role-requests', '/api/role-requests']) {
      const res = await call(url, 'GET', `${path}?${query}`, { actor: admin.id });
      assert.equal(res.status, 400, `${path}?${query}`);
      assert.equal(res.body.error.code, 'INVALID_PAGINATION', `${path}?${query}`);
    }
  }
  const ok = await call(url, 'GET', '/api/admin/role-requests?limit=20&offset=10000', { actor: admin.id });
  assert.equal(ok.status, 200);
});

test('approve grants the requested role with the approver recorded and blocks later decisions', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const farmer = await user(pool, 'Nguyen An');
  const id = await makeRequest(url, farmer, 'provider');
  const res = await call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: admin.id, body: {} });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.request.status, 'APPROVED');
  assert.equal(res.body.request.userName, 'Nguyen An');
  assert.equal(res.body.request.canDecide, false);
  assert.notEqual(res.body.request.decidedAt, null);
  assert.equal(res.body.request.decisionReason, null);
  assert.equal((await grantOf(pool, farmer.id, 'provider')).granted_by, admin.id);
  assert.equal((await requestRow(pool, id)).decided_by, admin.id);
  const own = await call(url, 'GET', '/api/role-requests', { actor: farmer.id });
  assert.equal(own.body.items[0].status, 'APPROVED');
  const again = await call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: admin.id, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'REQUEST_DECIDED');
  const late = await call(url, 'POST', `/api/admin/role-requests/${id}/reject`, { actor: admin.id, body: { reason: 'late' } });
  assert.equal(late.body.error.code, 'REQUEST_DECIDED');
  assert.equal((await grantOf(pool, farmer.id, 'provider')).granted_by, admin.id, 'original grant untouched');
});

test('approve with an out-of-band grant already present keeps the existing grant row', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const farmer = await user(pool, 'Farmer');
  const id = await makeRequest(url, farmer, 'operator');
  await pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'operator')", [farmer.id]);
  const res = await call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: admin.id, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.request.status, 'APPROVED');
  assert.equal(await scalar(pool, `SELECT count(*)::int AS n FROM account.user_roles WHERE user_id = $1 AND role = 'operator'`, [farmer.id]), 1);
  assert.equal((await grantOf(pool, farmer.id, 'operator')).granted_by, null);
});

test('reject records the trimmed reason, grants nothing, and allows a fresh request afterwards', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const farmer = await user(pool, 'Farmer');
  const id = await makeRequest(url, farmer, 'coop');
  const res = await call(url, 'POST', `/api/admin/role-requests/${id}/reject`, { actor: admin.id, body: { reason: '  Thiếu giấy tờ  ' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.request.status, 'REJECTED');
  assert.equal(res.body.request.decisionReason, 'Thiếu giấy tờ');
  assert.notEqual(res.body.request.decidedAt, null);
  assert.equal(await grantOf(pool, farmer.id, 'coop'), undefined);
  const fresh = await call(url, 'POST', '/api/role-requests', { actor: farmer.id, body: { role: 'coop' } });
  assert.equal(fresh.status, 201);
});

test('reject reason bounds and approve/reject body shapes are strict; failures leave the row pending', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const farmer = await user(pool, 'Farmer');
  const id = await makeRequest(url, farmer, 'provider');
  const reject = (body) => call(url, 'POST', `/api/admin/role-requests/${id}/reject`, { actor: admin.id, body });
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 'a\nb' }, { reason: 5 }]) {
    const res = await reject(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(res.body.error.code, 'INVALID_REQUEST');
  }
  const unknown = await reject({ reason: 'x', extra: true });
  assert.equal(unknown.body.error.code, 'UNKNOWN_FIELD');
  const approveExtra = await call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: admin.id, body: { role: 'coop' } });
  assert.equal(approveExtra.status, 400);
  assert.equal(approveExtra.body.error.code, 'UNKNOWN_FIELD');
  assert.equal((await requestRow(pool, id)).status, 'PENDING');
  const max = await reject({ reason: 'x'.repeat(500) });
  assert.equal(max.status, 200, 'exactly 500 characters is accepted');
});

test('malformed request id is refused with 400 before lookup; unknown id is 404', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  for (const [action, body] of [['approve', {}], ['reject', { reason: 'x' }]]) {
    const bad = await call(url, 'POST', `/api/admin/role-requests/not-a-uuid/${action}`, { actor: admin.id, body });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_ID');
    const missing = await call(url, 'POST', `/api/admin/role-requests/${MISSING_ID}/${action}`, { actor: admin.id, body });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  }
});

test('self approval and self rejection are refused and leave the row pending', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Admin', ['farmer', 'admin']);
  const id = await makeRequest(url, admin, 'provider');
  const approve = await call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: admin.id, body: {} });
  assert.equal(approve.status, 403);
  assert.equal(approve.body.error.code, 'SELF_APPROVAL_FORBIDDEN');
  const reject = await call(url, 'POST', `/api/admin/role-requests/${id}/reject`, { actor: admin.id, body: { reason: 'x' } });
  assert.equal(reject.status, 403);
  assert.equal(reject.body.error.code, 'SELF_APPROVAL_FORBIDDEN');
  const row = await requestRow(pool, id);
  assert.equal(row.status, 'PENDING');
  assert.equal(row.decided_by, null);
  assert.equal(await grantOf(pool, admin.id, 'provider'), undefined);
});

test('concurrent approvals by two admins produce one 200 and one 409 with one grant', async (t) => {
  const { pool, url } = await fixture(t);
  const a1 = await user(pool, 'Admin 1', ['farmer', 'admin']);
  const a2 = await user(pool, 'Admin 2', ['farmer', 'admin']);
  const farmer = await user(pool, 'Farmer');
  const id = await makeRequest(url, farmer, 'operator');
  const admins = [a1, a2];
  const results = await Promise.all(admins.map((admin) => call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: admin.id, body: {} })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = admins[results.findIndex((r) => r.status === 200)];
  assert.equal(results.find((r) => r.status === 409).body.error.code, 'REQUEST_DECIDED');
  assert.equal(await scalar(pool, `SELECT count(*)::int AS n FROM account.user_roles WHERE user_id = $1 AND role = 'operator'`, [farmer.id]), 1);
  assert.equal((await grantOf(pool, farmer.id, 'operator')).granted_by, winner.id);
});

test('approve racing reject: exactly one decision wins and the grant matches it', async (t) => {
  const { pool, url } = await fixture(t);
  const a1 = await user(pool, 'Admin 1', ['farmer', 'admin']);
  const a2 = await user(pool, 'Admin 2', ['farmer', 'admin']);
  const farmer = await user(pool, 'Farmer');
  const id = await makeRequest(url, farmer, 'provider');
  const [approve, reject] = await Promise.all([
    call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: a1.id, body: {} }),
    call(url, 'POST', `/api/admin/role-requests/${id}/reject`, { actor: a2.id, body: { reason: 'Không đủ điều kiện' } }),
  ]);
  assert.deepEqual([approve.status, reject.status].sort(), [200, 409]);
  const row = await requestRow(pool, id);
  const grant = await grantOf(pool, farmer.id, 'provider');
  if (approve.status === 200) {
    assert.equal(row.status, 'APPROVED');
    assert.equal(grant.granted_by, a1.id);
  } else {
    assert.equal(row.status, 'REJECTED');
    assert.equal(grant, undefined, 'a rejected request grants nothing');
  }
});

test('live admin revocation: stale admin claim gets 403 on queue and decisions', async (t) => {
  const { pool, url } = await fixture(t);
  const admin = await user(pool, 'Demoted Admin', ['farmer', 'admin']);
  const farmer = await user(pool, 'Farmer');
  const id = await makeRequest(url, farmer, 'provider');
  await pool.query("DELETE FROM account.user_roles WHERE user_id = $1 AND role = 'admin'", [admin.id]);
  const list = await call(url, 'GET', '/api/admin/role-requests', { actor: admin.id, roles: 'farmer,admin' });
  assert.equal(list.status, 403);
  const approve = await call(url, 'POST', `/api/admin/role-requests/${id}/approve`, { actor: admin.id, roles: 'farmer,admin', body: {} });
  assert.equal(approve.status, 403);
  assert.equal(approve.body.error.code, 'FORBIDDEN');
  assert.equal((await requestRow(pool, id)).status, 'PENDING');
  assert.equal(await grantOf(pool, farmer.id, 'provider'), undefined);
});
