import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createPool } from '../../src/db.js';
import { createRecruitmentRouter } from '../../src/recruitment.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase, parseRootDatabaseUrl } from '../helpers/catalog-db.js';

// Fail closed at load time: the root URL must be a loopback PostgreSQL URL naming a *_test database.
parseRootDatabaseUrl(process.env.TEST_DATABASE_URL);

const FARMER_A = '10000000-0000-4000-8000-000000000001';
const COOP_A = '10000000-0000-4000-8000-000000000003';
const PROVIDER_A = '10000000-0000-4000-8000-000000000004';
const PROVIDER_B = '10000000-0000-4000-8000-000000000005';
const ADMIN_A = '10000000-0000-4000-8000-000000000007';
const UNKNOWN_ID = '20000000-0000-4000-8000-0000000000ff';
const operatorId = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// TEST SEAM ONLY: fixed bearer tokens mapped to synthetic actors. The parent app supplies the real
// cross-service authenticate middleware; this file never ships as runtime authentication.
const TEST_ACTORS = {
  'seam-provider-a': { id: PROVIDER_A, roles: ['provider'], name: 'Synthetic Provider A' },
  'seam-provider-b': { id: PROVIDER_B, roles: ['provider'], name: 'Synthetic Provider B' },
  'seam-farmer-a': { id: FARMER_A, roles: ['farmer'], name: 'Synthetic Farmer A' },
  'seam-coop-a': { id: COOP_A, roles: ['coop'], name: 'Synthetic Coop A' },
  'seam-admin-a': { id: ADMIN_A, roles: ['admin'], name: 'Synthetic Admin A' },
};
for (let n = 1; n <= 12; n += 1) {
  TEST_ACTORS[`seam-operator-${n}`] = { id: operatorId(n), roles: ['operator'], name: `Synthetic Operator ${n}` };
}

function testSeamAuthenticate(req, res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!Object.hasOwn(TEST_ACTORS, token)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = TEST_ACTORS[token];
  return next();
}

const ctx = {};
const state = {};

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL, { label: 'recruitment' });
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  ctx.applied = await migrate(ctx.pool);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(createRecruitmentRouter({ pool: ctx.pool, authenticate: testSeamAuthenticate }));
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  ctx.server = app.listen(0, '127.0.0.1');
  await once(ctx.server, 'listening');
  ctx.url = `http://127.0.0.1:${ctx.server.address().port}`;
});

after(async () => {
  if (ctx.server) await new Promise((resolve, reject) => ctx.server.close((error) => (error ? reject(error) : resolve())));
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${ctx.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function count(sql, params = []) {
  return Number((await ctx.pool.query(sql, params)).rows[0].n);
}

function jobBody(overrides = {}) {
  return {
    title: 'Gặt lúa bằng máy (giả lập)',
    locality: 'Châu Thành',
    capacity: 1,
    startAt: '2026-12-01T01:00:00Z',
    endAt: '2026-12-01T05:00:00Z',
    ...overrides,
  };
}

async function createJob(token, overrides) {
  const response = await call('/api/jobs', { method: 'POST', token, body: jobBody(overrides) });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.job.id;
}

async function apply(jobId, n) {
  const response = await call(`/api/jobs/${jobId}/applications`, { method: 'POST', token: `seam-operator-${n}`, body: {} });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.application.id;
}

async function offer(applicationId, token = 'seam-provider-a') {
  const response = await call(`/api/applications/${applicationId}/offers`, { method: 'POST', token, body: {} });
  assert.ok(response.status === 201 || response.status === 200, JSON.stringify(response.body));
  return response.body.offer;
}

test('migration 004 creates recruitment tables and reruns as a no-op', async () => {
  assert.ok(ctx.applied.includes('004_recruitment.sql'));
  assert.deepEqual(await migrate(ctx.pool), []);
  const tables = (await ctx.pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'dispatch' ORDER BY table_name",
  )).rows.map((row) => row.table_name);
  for (const name of ['applications', 'jobs', 'offers', 'recruitment_events']) {
    assert.ok(tables.includes(name), name);
  }
});

test('provider creates validated jobs; other roles, missing tokens and injected fields are refused', async () => {
  const created = await call('/api/jobs', { method: 'POST', token: 'seam-provider-a', body: jobBody({ capacity: 3 }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.job.capacity, 3);
  assert.equal(created.body.job.status, 'OPEN');
  assert.equal(created.body.job.startAt, '2026-12-01T01:00:00.000Z');
  assert.equal(created.body.job.applicationCount, 0);
  assert.equal(created.body.job.acceptedCount, 0);
  assert.equal(created.body.job.providerId, undefined);
  state.jobSample = created.body.job.id;

  assert.deepEqual(await call('/api/jobs', { method: 'POST', token: 'seam-provider-a', body: jobBody({ capacity: 0 }) }),
    { status: 400, body: { error: { code: 'VALIDATION_FAILED', field: 'capacity' } } });
  assert.deepEqual(await call('/api/jobs', { method: 'POST', token: 'seam-provider-a', body: jobBody({ capacity: 101 }) }),
    { status: 400, body: { error: { code: 'VALIDATION_FAILED', field: 'capacity' } } });
  assert.deepEqual(await call('/api/jobs', { method: 'POST', token: 'seam-provider-a', body: jobBody({ startAt: '2026-12-01' }) }),
    { status: 400, body: { error: { code: 'VALIDATION_FAILED', field: 'startAt' } } });
  assert.deepEqual(await call('/api/jobs', { method: 'POST', token: 'seam-provider-a', body: jobBody({ endAt: '2026-12-01T00:00:00Z' }) }),
    { status: 400, body: { error: { code: 'VALIDATION_FAILED', field: 'endAt' } } });
  assert.deepEqual(await call('/api/jobs', { method: 'POST', token: 'seam-provider-a', body: jobBody({ providerId: PROVIDER_B }) }),
    { status: 400, body: { error: { code: 'UNKNOWN_FIELD' } } });
  assert.equal((await call('/api/jobs', { method: 'POST', token: 'seam-operator-1', body: jobBody() })).status, 403);
  assert.equal((await call('/api/jobs', { method: 'POST', token: 'seam-farmer-a', body: jobBody() })).status, 403);
  assert.equal((await call('/api/jobs', { method: 'POST', token: 'seam-admin-a', body: jobBody() })).status, 403);
  assert.equal((await call('/api/jobs', { method: 'POST', body: jobBody() })).status, 401);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.jobs'), 1);
});

test('public job list and detail expose jobs but never applicants or provider identity', async () => {
  const list = await call('/api/jobs');
  assert.equal(list.status, 200);
  assert.equal(list.body.limit, 20);
  assert.equal(list.body.offset, 0);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].providerId, undefined);

  const detail = await call(`/api/jobs/${state.jobSample}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.job.id, state.jobSample);
  for (const key of ['providerId', 'applications', 'operatorId', 'provider_id']) assert.equal(detail.body.job[key], undefined, key);

  for (const path of ['/api/jobs?limit=101', '/api/jobs?offset=10001', '/api/jobs?limit=-1']) {
    assert.deepEqual(await call(path), { status: 400, body: { error: { code: 'INVALID_PAGINATION' } } }, path);
  }
  assert.deepEqual(await call(`/api/jobs/${UNKNOWN_ID}`), { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.deepEqual(await call('/api/jobs/not-a-uuid'), { status: 400, body: { error: { code: 'INVALID_ID' } } });
});

test('ten operators apply to a capacity-one job; applications do not consume capacity', async () => {
  state.jobA = await createJob('seam-provider-a', { capacity: 1 });
  state.appA = {};
  for (let n = 1; n <= 10; n += 1) state.appA[n] = await apply(state.jobA, n);

  assert.equal(await count(`SELECT count(*)::text AS n FROM dispatch.applications WHERE job_id = '${state.jobA}'`), 10);
  const detail = await call(`/api/jobs/${state.jobA}`);
  assert.equal(detail.body.job.applicationCount, 10);
  assert.equal(detail.body.job.acceptedCount, 0);

  const duplicate = await call(`/api/jobs/${state.jobA}/applications`, { method: 'POST', token: 'seam-operator-1', body: { note: 'again' } });
  assert.deepEqual(duplicate, { status: 409, body: { error: { code: 'DUPLICATE_APPLICATION' } } });
  assert.equal((await call(`/api/jobs/${state.jobA}/applications`, { method: 'POST', token: 'seam-provider-a', body: {} })).status, 403);
  assert.deepEqual(await call(`/api/jobs/${state.jobA}/applications`, { method: 'POST', token: 'seam-operator-11', body: { ownerId: PROVIDER_B } }),
    { status: 400, body: { error: { code: 'UNKNOWN_FIELD' } } });
  assert.deepEqual(await call(`/api/jobs/${state.jobA}/applications`, { method: 'POST', token: 'seam-operator-11', body: { note: 'x'.repeat(501) } }),
    { status: 400, body: { error: { code: 'VALIDATION_FAILED', field: 'note' } } });
  assert.deepEqual(await call(`/api/jobs/${UNKNOWN_ID}/applications`, { method: 'POST', token: 'seam-operator-11', body: {} }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
});

test('application reads are provider-scoped, paginated and hidden from other roles', async () => {
  const listed = await call(`/api/jobs/${state.jobA}/applications`, { token: 'seam-provider-a' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 10);
  assert.ok(listed.body.items.every((item) => typeof item.operatorId === 'string' && item.activeOffer === null));
  const page = await call(`/api/jobs/${state.jobA}/applications?limit=4&offset=8`, { token: 'seam-provider-a' });
  assert.equal(page.body.items.length, 2);
  assert.deepEqual(await call(`/api/jobs/${state.jobA}/applications`, { token: 'seam-provider-b' }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.equal((await call(`/api/jobs/${state.jobA}/applications`, { token: 'seam-operator-1' })).status, 403);
  assert.equal((await call(`/api/jobs/${state.jobA}/applications`)).status, 401);
  assert.deepEqual(await call(`/api/jobs/${state.jobA}/applications?limit=101`, { token: 'seam-provider-a' }),
    { status: 400, body: { error: { code: 'INVALID_PAGINATION' } } });
});

test('provider offers are owner-scoped and one active offer per application', async () => {
  const first = await offer(state.appA[1]);
  assert.equal(first.status, 'OFFERED');
  const replay = await call(`/api/applications/${state.appA[1]}/offers`, { method: 'POST', token: 'seam-provider-a', body: {} });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.offer.id, first.id);
  assert.equal(await count(`SELECT count(*)::text AS n FROM dispatch.offers WHERE application_id = '${state.appA[1]}'`), 1);

  assert.deepEqual(await call(`/api/applications/${state.appA[1]}/offers`, { method: 'POST', token: 'seam-provider-b', body: {} }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.deepEqual(await call(`/api/applications/${UNKNOWN_ID}/offers`, { method: 'POST', token: 'seam-provider-a', body: {} }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.equal((await call(`/api/applications/${state.appA[1]}/offers`, { method: 'POST', token: 'seam-operator-1', body: {} })).status, 403);

  state.offerA = { 1: first.id, 2: (await offer(state.appA[2])).id };
  assert.equal((await ctx.pool.query('SELECT status FROM dispatch.applications WHERE id = $1', [state.appA[2]])).rows[0].status, 'OFFERED');
});

test('operators see only their own offers', async () => {
  const mine = await call('/api/offers', { token: 'seam-operator-1' });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.items.map((item) => item.id), [state.offerA[1]]);
  assert.equal(mine.body.items[0].job.title, 'Gặt lúa bằng máy (giả lập)');
  assert.deepEqual((await call('/api/offers', { token: 'seam-operator-3' })).body.items, []);
  assert.equal((await call('/api/offers', { token: 'seam-provider-a' })).status, 403);
  assert.equal((await call('/api/offers')).status, 401);
});

test('concurrent accepts on capacity one: exactly one winner, the rest get CAPACITY_FULL', async () => {
  const results = await Promise.all([
    call(`/api/offers/${state.offerA[1]}/accept`, { method: 'POST', token: 'seam-operator-1' }),
    call(`/api/offers/${state.offerA[2]}/accept`, { method: 'POST', token: 'seam-operator-2' }),
  ]);
  const winners = results.filter((result) => result.status === 200);
  const losers = results.filter((result) => result.status === 409);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(losers.length, 1, JSON.stringify(results));
  assert.equal(losers[0].body.error.code, 'CAPACITY_FULL');
  assert.equal(winners[0].body.offer.status, 'ACCEPTED');
  state.winner = winners[0].body.offer.id === state.offerA[1] ? 1 : 2;
  state.loser = state.winner === 1 ? 2 : 1;
  assert.equal(await count(`SELECT count(*)::text AS n FROM dispatch.offers WHERE job_id = '${state.jobA}' AND status = 'ACCEPTED'`), 1);
  assert.equal((await call(`/api/jobs/${state.jobA}`)).body.job.acceptedCount, 1);
});

test('action endpoints reject unknown body keys before changing state', async () => {
  const checks = [
    [`/api/jobs/${state.jobA}/close`, 'seam-provider-a'],
    [`/api/applications/${state.appA[state.loser]}/withdraw`, `seam-operator-${state.loser}`],
    [`/api/offers/${state.offerA[state.loser]}/accept`, `seam-operator-${state.loser}`],
    [`/api/offers/${state.offerA[state.loser]}/decline`, `seam-operator-${state.loser}`],
  ];
  for (const [path, token] of checks) {
    assert.deepEqual(await call(path, { method: 'POST', token, body: { actorId: UNKNOWN_ID } }),
      { status: 400, body: { error: { code: 'UNKNOWN_FIELD' } } });
  }
});

test('repeat accept by the winner returns the same success and takes no second slot', async () => {
  const repeat = await call(`/api/offers/${state.offerA[state.winner]}/accept`, { method: 'POST', token: `seam-operator-${state.winner}` });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.offer.status, 'ACCEPTED');
  assert.equal(repeat.body.offer.id, state.offerA[state.winner]);
  assert.equal(await count(`SELECT count(*)::text AS n FROM dispatch.offers WHERE job_id = '${state.jobA}' AND status = 'ACCEPTED'`), 1);
});

test('declined offer cannot be accepted; re-offer on a full job cannot be accepted', async () => {
  const loserOffer = state.offerA[state.loser];
  const declined = await call(`/api/offers/${loserOffer}/decline`, { method: 'POST', token: `seam-operator-${state.loser}` });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.offer.status, 'DECLINED');
  assert.deepEqual(await call(`/api/offers/${loserOffer}/accept`, { method: 'POST', token: `seam-operator-${state.loser}` }),
    { status: 409, body: { error: { code: 'OFFER_DECLINED' } } });
  assert.equal((await call(`/api/offers/${loserOffer}/decline`, { method: 'POST', token: `seam-operator-${state.loser}` })).status, 200);
  assert.equal((await ctx.pool.query('SELECT status FROM dispatch.applications WHERE id = $1', [state.appA[state.loser]])).rows[0].status, 'APPLIED');

  const reoffer = await offer(state.appA[state.loser]);
  assert.notEqual(reoffer.id, loserOffer);
  assert.equal(reoffer.status, 'OFFERED');
  assert.deepEqual(await call(`/api/offers/${reoffer.id}/accept`, { method: 'POST', token: `seam-operator-${state.loser}` }),
    { status: 409, body: { error: { code: 'CAPACITY_FULL' } } });
  state.loserReoffer = reoffer.id;
});

test('cross-party reads and writes are 404 and change nothing', async () => {
  const before = (await ctx.pool.query('SELECT id, status FROM dispatch.offers ORDER BY id')).rows;
  const other = state.winner === 1 ? 2 : 1;
  assert.deepEqual(await call(`/api/offers/${state.offerA[state.winner]}/accept`, { method: 'POST', token: 'seam-operator-3' }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.deepEqual(await call(`/api/offers/${state.offerA[other]}/decline`, { method: 'POST', token: `seam-operator-${state.winner}` }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.deepEqual(await call(`/api/applications/${state.appA[other]}/withdraw`, { method: 'POST', token: `seam-operator-${state.winner}` }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.deepEqual(await call(`/api/jobs/${state.jobA}/close`, { method: 'POST', token: 'seam-provider-b' }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.deepEqual((await ctx.pool.query('SELECT id, status FROM dispatch.offers ORDER BY id')).rows, before);
});

test('accepted offer blocks withdrawal; withdrawn offer cannot be accepted', async () => {
  const blocked = await call(`/api/applications/${state.appA[state.winner]}/withdraw`, { method: 'POST', token: `seam-operator-${state.winner}` });
  assert.deepEqual(blocked, { status: 409, body: { error: { code: 'OFFER_ACCEPTED' } } });
  assert.equal((await ctx.pool.query('SELECT status FROM dispatch.applications WHERE id = $1', [state.appA[state.winner]])).rows[0].status, 'OFFERED');

  const lateApplicant = await apply(state.jobA, 11);
  const lateOffer = await offer(lateApplicant);
  const withdrawn = await call(`/api/applications/${lateApplicant}/withdraw`, { method: 'POST', token: 'seam-operator-11' });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.application.status, 'WITHDRAWN');
  assert.equal((await call('/api/offers', { token: 'seam-operator-11' })).body.items[0].status, 'WITHDRAWN');
  assert.deepEqual(await call(`/api/offers/${lateOffer.id}/accept`, { method: 'POST', token: 'seam-operator-11' }),
    { status: 409, body: { error: { code: 'OFFER_WITHDRAWN' } } });
  assert.equal((await call(`/api/applications/${lateApplicant}/withdraw`, { method: 'POST', token: 'seam-operator-11' })).status, 200);
  assert.deepEqual(await call(`/api/applications/${lateApplicant}/offers`, { method: 'POST', token: 'seam-provider-a', body: {} }),
    { status: 409, body: { error: { code: 'APPLICATION_WITHDRAWN' } } });
});

test('closing the job refuses new applications, offers and accepts; close is idempotent', async () => {
  assert.deepEqual(await call(`/api/jobs/${state.jobA}/close`, { method: 'POST', token: 'seam-provider-a' }).then((r) => ({ status: r.status, status2: r.body.job.status })),
    { status: 200, status2: 'CLOSED' });
  const again = await call(`/api/jobs/${state.jobA}/close`, { method: 'POST', token: 'seam-provider-a' });
  assert.equal(again.status, 200);
  assert.ok(again.body.job.closedAt);

  assert.deepEqual(await call(`/api/jobs/${state.jobA}/applications`, { method: 'POST', token: 'seam-operator-12', body: {} }),
    { status: 409, body: { error: { code: 'JOB_CLOSED' } } });
  assert.deepEqual(await call(`/api/applications/${state.appA[4]}/offers`, { method: 'POST', token: 'seam-provider-a', body: {} }),
    { status: 409, body: { error: { code: 'JOB_CLOSED' } } });
  assert.deepEqual(await call(`/api/offers/${state.loserReoffer}/accept`, { method: 'POST', token: `seam-operator-${state.loser}` }),
    { status: 409, body: { error: { code: 'JOB_CLOSED' } } });
  assert.equal((await call(`/api/offers/${state.offerA[state.winner]}/accept`, { method: 'POST', token: `seam-operator-${state.winner}` })).status, 200);
  assert.deepEqual(await call(`/api/jobs/${state.jobA}/close`, { method: 'POST', token: 'seam-provider-b' }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
});

test('ten concurrent accepts on a fresh capacity-one job: exactly one winner', async () => {
  state.jobB = await createJob('seam-provider-a', { capacity: 1 });
  const offers = {};
  for (let n = 1; n <= 10; n += 1) offers[n] = (await offer(await apply(state.jobB, n))).id;

  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => call(
    `/api/offers/${offers[index + 1]}/accept`,
    { method: 'POST', token: `seam-operator-${index + 1}` },
  )));
  const statuses = results.map((result) => result.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409, 409, 409, 409, 409], JSON.stringify(results));
  assert.ok(results.filter((result) => result.status === 409).every((result) => result.body.error.code === 'CAPACITY_FULL'));
  assert.equal(await count(`SELECT count(*)::text AS n FROM dispatch.offers WHERE job_id = '${state.jobB}' AND status = 'ACCEPTED'`), 1);
});

test('close races accepts: capacity holds, closed job keeps accepted slots only', async () => {
  state.jobC = await createJob('seam-provider-a', { capacity: 2 });
  const offers = {};
  for (let n = 1; n <= 4; n += 1) offers[n] = (await offer(await apply(state.jobC, n))).id;

  const results = await Promise.all([
    call(`/api/jobs/${state.jobC}/close`, { method: 'POST', token: 'seam-provider-a' }),
    ...[1, 2, 3, 4].map((n) => call(`/api/offers/${offers[n]}/accept`, { method: 'POST', token: `seam-operator-${n}` })),
  ]);
  assert.equal(results[0].status, 200);
  const accepts = results.slice(1);
  for (const result of accepts) {
    const ok = result.status === 200 || (result.status === 409 && ['JOB_CLOSED', 'CAPACITY_FULL'].includes(result.body.error.code));
    assert.ok(ok, JSON.stringify(result));
  }
  const winners = accepts.filter((result) => result.status === 200).length;
  assert.ok(winners <= 2, `winners ${winners} exceed capacity`);
  assert.equal(await count(`SELECT count(*)::text AS n FROM dispatch.offers WHERE job_id = '${state.jobC}' AND status = 'ACCEPTED'`), winners);
  assert.equal((await ctx.pool.query('SELECT status FROM dispatch.jobs WHERE id = $1', [state.jobC])).rows[0].status, 'CLOSED');
});

test('no job ever holds more accepted offers than its capacity', async () => {
  const over = await ctx.pool.query(`
    SELECT j.id, j.capacity, count(o.id)::int AS accepted
      FROM dispatch.jobs j LEFT JOIN dispatch.offers o ON o.job_id = j.id AND o.status = 'ACCEPTED'
     GROUP BY j.id, j.capacity
    HAVING count(o.id) > j.capacity`);
  assert.deepEqual(over.rows, []);
});

test('events are append-only history with actor and transition order', async () => {
  const jobEvents = (await ctx.pool.query(
    'SELECT action, to_status, actor_id FROM dispatch.recruitment_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY id',
    ['job', state.jobA],
  )).rows;
  assert.deepEqual(jobEvents.map((row) => row.action), ['job.created', 'job.closed']);
  assert.equal(jobEvents[1].actor_id, PROVIDER_A);

  const winnerEvents = (await ctx.pool.query(
    'SELECT action, from_status, to_status, actor_id FROM dispatch.recruitment_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY id',
    ['offer', state.offerA[state.winner]],
  )).rows;
  assert.deepEqual(winnerEvents.map((row) => row.action), ['offer.created', 'offer.accepted']);
  assert.equal(winnerEvents.find((row) => row.action === 'offer.accepted').actor_id, operatorId(state.winner));
  assert.equal(winnerEvents.find((row) => row.action === 'offer.accepted').from_status, 'OFFERED');

  const withdrawal = (await ctx.pool.query(
    "SELECT action, to_status FROM dispatch.recruitment_events WHERE entity_type = 'application' AND action = 'application.withdrawn'",
  )).rows;
  assert.deepEqual(withdrawal, [{ action: 'application.withdrawn', to_status: 'WITHDRAWN' }]);
});

test('auth and id errors are refused before any write', async () => {
  const eventsBefore = await count('SELECT count(*)::text AS n FROM dispatch.recruitment_events');
  assert.deepEqual(await call('/api/offers/not-a-uuid/accept', { method: 'POST', token: 'seam-operator-1' }),
    { status: 400, body: { error: { code: 'INVALID_ID' } } });
  assert.deepEqual(await call('/api/applications/not-a-uuid/withdraw', { method: 'POST', token: 'seam-operator-1' }),
    { status: 400, body: { error: { code: 'INVALID_ID' } } });
  assert.deepEqual(await call(`/api/offers/${UNKNOWN_ID}/accept`, { method: 'POST', token: 'seam-operator-1' }),
    { status: 404, body: { error: { code: 'NOT_FOUND' } } });
  assert.equal((await call(`/api/offers/${state.offerA[1]}/accept`, { method: 'POST' })).status, 401);
  assert.equal((await call(`/api/offers/${state.offerA[1]}/accept`, { method: 'POST', token: 'seam-provider-a' })).status, 403);
  assert.equal((await call(`/api/jobs/${state.jobA}/close`, { method: 'POST', token: 'seam-operator-1' })).status, 403);
  assert.equal(await count('SELECT count(*)::text AS n FROM dispatch.recruitment_events'), eventsBefore);
});

test('direct SQL enforces recruitment constraints and append-only events', async () => {
  const providerId = PROVIDER_A;
  const window = "'2026-12-01T01:00:00Z', '2026-12-01T05:00:00Z'";
  const cases = [
    [`INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ('${providerId}', 'x', 'y', 0, ${window})`, '23514'],
    [`INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ('${providerId}', 'x', 'y', 101, ${window})`, '23514'],
    [`INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ('${providerId}', 'x', 'y', 1, '2026-12-01T05:00:00Z', '2026-12-01T05:00:00Z')`, '23514'],
    [`INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at, status) VALUES ('${providerId}', 'x', 'y', 1, ${window}, 'PENDING')`, '23514'],
    [`INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at, status) VALUES ('${providerId}', 'x', 'y', 1, ${window}, 'CLOSED')`, '23514'],
    [`INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at, status, closed_at) VALUES ('${providerId}', 'x', 'y', 1, ${window}, 'OPEN', now())`, '23514'],
    [`INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES (NULL, 'x', 'y', 1, ${window})`, '23502'],
  ];
  for (const [sql, code] of cases) {
    await assert.rejects(ctx.pool.query(sql), (error) => error.code === code, sql);
  }

  const dbJob = (await ctx.pool.query(
    `INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ('${providerId}', 'db job', 'y', 1, ${window}) RETURNING id`,
  )).rows[0].id;
  await assert.rejects(
    ctx.pool.query(`INSERT INTO dispatch.applications (job_id, operator_id, status) VALUES ('${dbJob}', '${operatorId(12)}', 'ACCEPTED')`),
    (error) => error.code === '23514',
  );
  const dbApp = (await ctx.pool.query(
    `INSERT INTO dispatch.applications (job_id, operator_id) VALUES ('${dbJob}', '${operatorId(12)}') RETURNING id`,
  )).rows[0].id;
  await assert.rejects(
    ctx.pool.query(`INSERT INTO dispatch.applications (job_id, operator_id) VALUES ('${dbJob}', '${operatorId(12)}')`),
    (error) => error.code === '23505',
  );
  await assert.rejects(
    ctx.pool.query(`INSERT INTO dispatch.offers (application_id, job_id, operator_id) VALUES ('${dbApp}', '${dbJob}', '${operatorId(11)}')`),
    (error) => error.code === '23503',
    'offer must reference the application operator',
  );
  await ctx.pool.query(`INSERT INTO dispatch.offers (application_id, job_id, operator_id) VALUES ('${dbApp}', '${dbJob}', '${operatorId(12)}')`);
  await assert.rejects(
    ctx.pool.query(`INSERT INTO dispatch.offers (application_id, job_id, operator_id) VALUES ('${dbApp}', '${dbJob}', '${operatorId(12)}')`),
    (error) => error.code === '23505',
    'only one active offer per application',
  );
  await assert.rejects(
    ctx.pool.query(`INSERT INTO dispatch.offers (application_id, job_id, operator_id, status) VALUES ('${dbApp}', '${dbJob}', '${operatorId(12)}', 'PAID')`),
    (error) => error.code === '23514',
  );

  const event = (await ctx.pool.query(
    `INSERT INTO dispatch.recruitment_events (entity_type, entity_id, action, actor_id, to_status) VALUES ('job', '${dbJob}', 'job.created', '${providerId}', 'OPEN') RETURNING id`,
  )).rows[0].id;
  await assert.rejects(ctx.pool.query(`UPDATE dispatch.recruitment_events SET action = 'job.closed' WHERE id = ${event}`), (error) => error.code === 'P0001');
  await assert.rejects(ctx.pool.query(`DELETE FROM dispatch.recruitment_events WHERE id = ${event}`), (error) => error.code === 'P0001');
});
