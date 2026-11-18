import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createDispatchRouter } from '../../src/dispatch.js';
import { createSchedulingRouter } from '../../src/scheduling.js';
import { createDisputeRouter, hasOpenDispute } from '../../src/disputes.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

parseDisposableRoot(process.env.TEST_DATABASE_URL);

// Synthetic fixtures only.
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = id(1), COOP = id(2), PROVIDER = id(3), OTHER_PROVIDER = id(4), OPERATOR = id(5);
const OTHER_FARMER = id(7), OTHER_COOP = id(8), OTHER_OPERATOR = id(6), DUAL = id(10);
const ADMIN_SEPARATE = id(11), ADMIN_INVOLVED = id(12), ADMIN_OPERATOR = id(13), ADMIN_MEDIATOR = id(14);
const ADMIN_FARMER = id(15);
const MACHINE = id(20), MACHINE_DUAL = id(21);
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
const ACTORS = {
  [FARMER]: ['farmer'], [OTHER_FARMER]: ['farmer'], [COOP]: ['coop'], [OTHER_COOP]: ['coop'],
  [PROVIDER]: ['provider'], [OTHER_PROVIDER]: ['provider'], [OPERATOR]: ['operator'], [OTHER_OPERATOR]: ['operator'],
  [DUAL]: ['farmer', 'provider'], [ADMIN_SEPARATE]: ['admin'], [ADMIN_INVOLVED]: ['admin', 'coop'],
  [ADMIN_OPERATOR]: ['operator', 'admin'], [ADMIN_MEDIATOR]: ['admin'],
  [ADMIN_FARMER]: ['farmer', 'admin'],
};
const OPEN_BODY = { reason: 'QUALITY', details: 'Synthetic quality concern' };

// TEST SEAM ONLY: bearer token equals a synthetic user ID.
function testAuthenticate(req, res, next) {
  const user = req.get('authorization')?.slice(7);
  if (!ACTORS[user]) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = { id: user, roles: ACTORS[user] };
  return next();
}

const ctx = {};
const servers = [];
let dayCounter = 0;
// Each fixture takes its own day so claimed packages never share a machine, operator or window.
function nextDay() {
  dayCounter += 1;
  return new Date(Date.UTC(2026, 10, 1) + dayCounter * 86400000).toISOString().slice(0, 10);
}

async function call(method, path, actor, payload) {
  const headers = { authorization: `Bearer ${actor}` };
  let body;
  if (payload !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(payload); }
  const res = await fetch(`${ctx.url}${path}`, { method, headers, body });
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json');
  return { status: res.status, body: isJson && text ? JSON.parse(text) : null, text };
}
const post = (path, payload, actor) => call('POST', path, actor, payload);
const get = (path, actor) => call('GET', path, actor);
const disputes = (bookingId, actor = FARMER, payload = OPEN_BODY) => post(`/api/bookings/${bookingId}/disputes`, payload, actor);
const respond = (disputeId, text, actor) => post(`/api/disputes/${disputeId}/responses`, { text }, actor);
const assign = (disputeId, mediatorId, actor) => post(`/api/disputes/${disputeId}/mediator`, { mediatorId }, actor);

async function count(sql, params) {
  return (await ctx.pool.query(sql, params)).rows[0].n;
}

async function recruit(day, provider, operator) {
  const job = (await ctx.pool.query(
    "INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ($1, 'Synthetic recruitment', 'Demo', 2, $2, $3) RETURNING id",
    [provider, `${day}T00:00:00Z`, `${day}T23:00:00Z`],
  )).rows[0].id;
  const application = (await ctx.pool.query(
    "INSERT INTO dispatch.applications (job_id, operator_id, status) VALUES ($1, $2, 'OFFERED') RETURNING id",
    [job, operator],
  )).rows[0].id;
  await ctx.pool.query(
    "INSERT INTO dispatch.offers (application_id, job_id, operator_id, status, responded_at) VALUES ($1, $2, $3, 'ACCEPTED', now())",
    [application, job, operator],
  );
}

async function booking(day, { owner = FARMER, coordinator = COOP, area = 10000 } = {}) {
  const field = (await ctx.pool.query(
    "INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'Synthetic field', 'Demo', $2) RETURNING id",
    [owner, area],
  )).rows[0].id;
  const { rows } = await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT $1, $2, id, $3, $4, 'Synthetic field', $5::int, code, name, data_label, price_per_ha_vnd,
       floor((price_per_ha_vnd::numeric * $5::int + 5000) / 10000)::bigint, $6
       FROM dispatch.services WHERE code = 'tillage-tractor' RETURNING id`,
    [owner, field, `${day}T08:00:00Z`, `${day}T12:00:00Z`, area, coordinator],
  );
  return rows[0].id;
}

// Grouped by the coordinator, not claimed: the booking has a package but no provider yet.
async function grouped({ owner = FARMER, coordinator = COOP } = {}) {
  const day = nextDay();
  await recruit(day, PROVIDER, OPERATOR);
  const bookingId = await booking(day, { owner, coordinator });
  const created = await post('/api/packages', { bookingIds: [bookingId] }, coordinator);
  assert.equal(created.status, 201);
  return { bookingId, packageId: created.body.package.id };
}

// Assigned booking: package grouped by its coordinator and claimed by the provider.
async function claimed({ owner = FARMER, provider = PROVIDER, coordinator = COOP, operator = OPERATOR } = {}) {
  const day = nextDay();
  await recruit(day, provider, operator);
  const bookingId = await booking(day, { owner, coordinator });
  const created = await post('/api/packages', { bookingIds: [bookingId] }, coordinator);
  assert.equal(created.status, 201);
  const packageId = created.body.package.id;
  const machineId = provider === DUAL ? MACHINE_DUAL : MACHINE;
  const claim = await post(`/api/packages/${packageId}/claim`, { machineId, operatorId: operator }, provider);
  assert.equal(claim.status, 200);
  return { bookingId, packageId };
}

// Closed case inserted directly as a fixture: retention is checked without a close endpoint (G8b).
async function closedFixture(bookingId) {
  const disputeId = (await ctx.pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status) VALUES ($1, $2, $3, 'NO_SHOW', 'CLOSED') RETURNING id",
    [bookingId, FARMER, PROVIDER],
  )).rows[0].id;
  await ctx.pool.query(
    "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'DISPUTE_OPENED', $2, $3::jsonb)",
    [disputeId, FARMER, JSON.stringify({ reason: 'NO_SHOW', details: 'Synthetic closed case' })],
  );
  return disputeId;
}

function listen(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(createDispatchRouter({ pool, authenticate: testAuthenticate }));
  app.use(createSchedulingRouter({ pool, authenticate: testAuthenticate }));
  app.use(createDisputeRouter({ pool, authenticate: testAuthenticate }));
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
    for (const role of roles) await ctx.pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user, role]);
  }
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic tractor', 'tractor')",
    [MACHINE, PROVIDER]);
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic tractor', 'tractor')",
    [MACHINE_DUAL, DUAL]);
  ctx.url = await listen(ctx.pool);
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

test('only booking owner or claimed provider can open; roles and non-parties get 403 or 404', async () => {
  const { bookingId } = await claimed();
  assert.equal((await disputes(bookingId, OPERATOR)).status, 403);
  assert.equal((await disputes(bookingId, ADMIN_SEPARATE)).status, 403);
  assert.equal((await disputes(bookingId, COOP)).status, 404);
  assert.equal((await disputes(bookingId, OTHER_COOP)).status, 404);
  assert.equal((await disputes(bookingId, OTHER_FARMER)).status, 404);
  assert.equal((await disputes(bookingId, OTHER_PROVIDER)).status, 404);
  assert.equal((await disputes(id(999), FARMER)).status, 404);
  assert.equal((await post(`/api/bookings/not-a-uuid/disputes`, OPEN_BODY, FARMER)).body.error.code, 'INVALID_ID');
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.disputes WHERE booking_id=$1', [bookingId]), 0);
});

test('owner opens with derived OPEN state, claimant and respondent IDs; provider can open too', async () => {
  const { bookingId } = await claimed();
  const opened = await disputes(bookingId, FARMER);
  assert.equal(opened.status, 201);
  assert.equal(opened.body.dispute.status, 'OPEN');
  assert.equal(opened.body.dispute.reason, 'QUALITY');
  assert.equal(opened.body.dispute.claimantId, FARMER);
  assert.equal(opened.body.dispute.respondentId, PROVIDER);
  assert.equal(opened.body.dispute.mediatorId, null);
  assert.equal(opened.body.dispute.bookingId, bookingId);

  const other = await claimed();
  const byProvider = await disputes(other.bookingId, PROVIDER);
  assert.equal(byProvider.status, 201);
  assert.equal(byProvider.body.dispute.claimantId, PROVIDER);
  assert.equal(byProvider.body.dispute.respondentId, FARMER);
});

test('open refuses caller-supplied party, actor, status and evidence fields and bad input', async () => {
  const { bookingId } = await claimed();
  for (const extra of ['actorId', 'claimantId', 'respondentId', 'status', 'evidence', 'mediatorId']) {
    const res = await disputes(bookingId, FARMER, { ...OPEN_BODY, [extra]: id(1) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UNKNOWN_FIELD');
  }
  assert.equal((await disputes(bookingId, FARMER, { reason: 'FRAUD', details: 'Synthetic' })).status, 400);
  assert.equal((await disputes(bookingId, FARMER, { reason: 'QUALITY', details: '   ' })).status, 400);
  assert.equal((await disputes(bookingId, FARMER, { reason: 'QUALITY', details: 'x'.repeat(2001) })).status, 400);
  assert.equal((await disputes(bookingId, FARMER, [])).status, 400);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.disputes WHERE booking_id=$1', [bookingId]), 0);
});

test('booking must have an assigned provider and must not be cancelled', async () => {
  const pending = await grouped();
  const groupedRes = await disputes(pending.bookingId, FARMER);
  assert.equal(groupedRes.status, 409);
  assert.equal(groupedRes.body.error.code, 'BOOKING_UNAVAILABLE');

  const { bookingId, packageId } = await claimed();
  const cancelled = await post(`/api/packages/${packageId}/cancel`, { reason: 'Synthetic cancel' }, COOP);
  assert.equal(cancelled.status, 200);
  const cancelledRes = await disputes(bookingId, FARMER);
  assert.equal(cancelledRes.status, 409);
  assert.equal(cancelledRes.body.error.code, 'BOOKING_UNAVAILABLE');
});

test('coop booking owner can be respondent and answer without signing for another owner', async () => {
  const { bookingId } = await claimed({ owner: COOP });
  const opened = await disputes(bookingId, PROVIDER);
  assert.equal(opened.status, 201);
  assert.equal(opened.body.dispute.respondentId, COOP);
  assert.equal((await respond(opened.body.dispute.id, 'Synthetic owner reply', COOP)).status, 201);
  assert.equal((await respond(opened.body.dispute.id, 'Foreign coop reply', OTHER_COOP)).status, 404);
});

test('same owner and provider is a party conflict and cannot open', async () => {
  const { bookingId } = await claimed({ owner: DUAL, provider: DUAL });
  const res = await disputes(bookingId, DUAL);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PARTY_CONFLICT');
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.disputes WHERE booking_id=$1', [bookingId]), 0);
});

test('at most one OPEN case per booking: second open from either party is 409', async () => {
  const { bookingId } = await claimed();
  assert.equal((await disputes(bookingId, FARMER)).status, 201);
  const again = await disputes(bookingId, PROVIDER);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'DISPUTE_OPEN');
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.disputes WHERE booking_id=$1', [bookingId]), 1);
});

test('concurrent opens on the same booking produce exactly one OPEN case', async () => {
  const { bookingId } = await claimed();
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    disputes(bookingId, i % 2 === 0 ? FARMER : PROVIDER)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409 && r.body.error.code === 'DISPUTE_OPEN').length, 4);
  assert.equal(await count("SELECT count(*)::int AS n FROM dispatch.disputes WHERE booking_id=$1 AND status='OPEN'", [bookingId]), 1);
});

test('open cases on different bookings are independent, including concurrent opens', async () => {
  const first = await claimed();
  const second = await claimed();
  const [a, b] = await Promise.all([disputes(first.bookingId, FARMER), disputes(second.bookingId, FARMER)]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.dispute.id, b.body.dispute.id);
  assert.equal(await hasOpenDispute(ctx.pool, first.bookingId), true);
  assert.equal(await hasOpenDispute(ctx.pool, second.bookingId), true);
  const unrelated = await claimed();
  assert.equal(await hasOpenDispute(ctx.pool, unrelated.bookingId), false);
});

test('closed cases are retained: new open adds a row with a new ID and old rows are not overwritten', async () => {
  const { bookingId } = await claimed();
  const oldId = await closedFixture(bookingId);
  const oldEvents = await count('SELECT count(*)::int AS n FROM dispatch.dispute_events WHERE dispute_id=$1', [oldId]);
  const opened = await disputes(bookingId, FARMER);
  assert.equal(opened.status, 201);
  assert.notEqual(opened.body.dispute.id, oldId);
  const rows = (await ctx.pool.query('SELECT id, status FROM dispatch.disputes WHERE booking_id=$1 ORDER BY created_at, id', [bookingId])).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r) => r.id === oldId), { id: oldId, status: 'CLOSED' });
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.dispute_events WHERE dispute_id=$1', [oldId]), oldEvents);
});

test('list shows only disputes where caller is claimant, respondent or assigned mediator, paginated', async () => {
  const { bookingId } = await claimed();
  const opened = await disputes(bookingId, FARMER);
  const disputeId = opened.body.dispute.id;
  const farmerList = await get('/api/disputes', FARMER);
  assert.equal(farmerList.status, 200);
  assert.ok(farmerList.body.items.some((item) => item.id === disputeId));
  assert.equal((await get('/api/disputes?limit=1&offset=0', PROVIDER)).body.items.length, 1);
  const outsider = await get('/api/disputes', OTHER_FARMER);
  assert.equal(outsider.body.items.some((item) => item.id === disputeId), false);
  assert.equal((await get('/api/disputes?limit=0', FARMER)).status, 400);
  assert.equal((await get('/api/disputes?offset=10001', FARMER)).status, 400);
});

test('detail returns full ordered event history for parties and assigned mediator; foreign IDs are 404', async () => {
  const { bookingId } = await claimed();
  const opened = await disputes(bookingId, FARMER);
  const disputeId = opened.body.dispute.id;
  assert.equal((await respond(disputeId, 'Synthetic reply', PROVIDER)).status, 201);
  assert.equal((await assign(disputeId, ADMIN_SEPARATE, FARMER)).status, 403);
  for (const actor of [FARMER, PROVIDER]) {
    const detail = await get(`/api/disputes/${disputeId}`, actor);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.events.map((e) => e.type), ['DISPUTE_OPENED', 'RESPONSE_ADDED']);
    assert.equal(detail.body.events[0].data.reason, 'QUALITY');
    assert.equal(detail.body.events[0].data.details, 'Synthetic quality concern');
    assert.equal(detail.body.events[1].data.text, 'Synthetic reply');
    assert.equal(detail.body.events[1].actorId, PROVIDER);
  }
  for (const actor of [COOP, OPERATOR, OTHER_FARMER, OTHER_PROVIDER]) {
    assert.equal((await get(`/api/disputes/${disputeId}`, actor)).status, 404);
  }
  assert.equal((await get(`/api/disputes/${id(999)}`, FARMER)).status, 404);
  assert.equal((await get('/api/disputes/not-a-uuid', FARMER)).body.error.code, 'INVALID_ID');
});

test('response is accepted only from the respondent; claimant, mediator and foreign IDs are refused', async () => {
  const { bookingId } = await claimed();
  const disputeId = (await disputes(bookingId, FARMER)).body.dispute.id;
  assert.equal((await respond(disputeId, 'Synthetic claimant reply', FARMER)).status, 403);
  assert.equal((await respond(disputeId, 'Synthetic coop reply', COOP)).status, 404);
  assert.equal((await respond(disputeId, 'Synthetic outsider reply', OTHER_PROVIDER)).status, 404);
  assert.equal((await respond(disputeId, '   ', PROVIDER)).status, 400);
  assert.equal((await respond(disputeId, 'x'.repeat(2001), PROVIDER)).status, 400);
  assert.equal((await post(`/api/disputes/${disputeId}/responses`, { text: 'Synthetic', actorId: PROVIDER }, PROVIDER)).status, 400);

  const ok = await respond(disputeId, '  Synthetic respondent reply  ', PROVIDER);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.event.type, 'RESPONSE_ADDED');
  assert.equal(ok.body.event.data.text, 'Synthetic respondent reply');
  assert.equal(ok.body.event.actorId, PROVIDER);
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.dispute_events WHERE dispute_id=$1', [disputeId]), 2);
});

test('response on a closed case is refused and does not append', async () => {
  const { bookingId } = await claimed();
  const closedId = await closedFixture(bookingId);
  const res = await respond(closedId, 'Synthetic late reply', PROVIDER);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DISPUTE_NOT_OPEN');
  assert.equal(await count('SELECT count(*)::int AS n FROM dispatch.dispute_events WHERE dispute_id=$1', [closedId]), 1);
});

test('mediator assignment is admin only and refuses non-admin targets and involved parties', async () => {
  const { bookingId } = await claimed();
  const disputeId = (await disputes(bookingId, FARMER)).body.dispute.id;
  for (const actor of [FARMER, PROVIDER, COOP, OPERATOR]) {
    assert.equal((await assign(disputeId, ADMIN_MEDIATOR, actor)).status, 403);
  }
  assert.equal((await assign(disputeId, OTHER_FARMER, ADMIN_SEPARATE)).body.error.code, 'INVALID_MEDIATOR');
  assert.equal((await assign(disputeId, ADMIN_MEDIATOR, ADMIN_SEPARATE)).status, 200);
  assert.equal((await assign(disputeId, FARMER, ADMIN_SEPARATE)).status, 400);
  assert.equal((await assign(disputeId, 'not-a-uuid', ADMIN_SEPARATE)).body.error.code, 'VALIDATION_FAILED');
  assert.equal((await post(`/api/disputes/${disputeId}/mediator`, { mediatorId: ADMIN_MEDIATOR, role: 'admin' }, ADMIN_SEPARATE)).body.error.code, 'UNKNOWN_FIELD');
});

test('assigned mediator reads the case but cannot respond; reassignment audits the previous mediator', async () => {
  const { bookingId } = await claimed();
  const disputeId = (await disputes(bookingId, FARMER)).body.dispute.id;
  const first = await assign(disputeId, ADMIN_MEDIATOR, ADMIN_SEPARATE);
  assert.equal(first.status, 200);
  assert.equal(first.body.dispute.mediatorId, ADMIN_MEDIATOR);
  assert.equal((await get(`/api/disputes/${disputeId}`, ADMIN_MEDIATOR)).status, 200);
  assert.ok((await get('/api/disputes', ADMIN_MEDIATOR)).body.items.some((item) => item.id === disputeId));
  assert.equal((await respond(disputeId, 'Synthetic mediator reply', ADMIN_MEDIATOR)).status, 403);

  const again = await assign(disputeId, ADMIN_SEPARATE, ADMIN_SEPARATE);
  assert.equal(again.status, 200);
  assert.equal(again.body.dispute.mediatorId, ADMIN_SEPARATE);
  assert.equal((await get(`/api/disputes/${disputeId}`, ADMIN_MEDIATOR)).status, 200);
  const detail = await get(`/api/disputes/${disputeId}`, ADMIN_SEPARATE);
  assert.deepEqual(detail.body.events.map((e) => e.type), ['DISPUTE_OPENED', 'MEDIATOR_ASSIGNED', 'MEDIATOR_ASSIGNED']);
  assert.deepEqual(detail.body.events[1].data, { mediatorId: ADMIN_MEDIATOR, previousMediatorId: null });
  assert.deepEqual(detail.body.events[2].data, { mediatorId: ADMIN_SEPARATE, previousMediatorId: ADMIN_MEDIATOR });
});

test('involved admin must recuse; a separate admin can assign an uninvolved admin', async () => {
  const day = nextDay();
  await recruit(day, PROVIDER, OPERATOR);
  const bookingId = await booking(day, { owner: FARMER, coordinator: ADMIN_INVOLVED });
  const created = await post('/api/packages', { bookingIds: [bookingId] }, ADMIN_INVOLVED);
  assert.equal(created.status, 201);
  assert.equal((await post(`/api/packages/${created.body.package.id}/claim`, { machineId: MACHINE, operatorId: OPERATOR }, PROVIDER)).status, 200);
  const disputeId = (await disputes(bookingId, FARMER)).body.dispute.id;

  const recusal = await assign(disputeId, ADMIN_SEPARATE, ADMIN_INVOLVED);
  assert.equal(recusal.status, 403);
  assert.equal(recusal.body.error.code, 'RECUSAL_REQUIRED');
  assert.equal((await assign(disputeId, ADMIN_INVOLVED, ADMIN_INVOLVED)).status, 403);
  assert.equal((await assign(disputeId, ADMIN_INVOLVED, ADMIN_SEPARATE)).body.error.code, 'PARTY_CONFLICT');
  assert.equal((await assign(disputeId, ADMIN_SEPARATE, ADMIN_SEPARATE)).status, 200);
});

test('claimant who also holds admin role recuses; cannot be assigned as mediator of own case', async () => {
  const { bookingId } = await claimed({ owner: ADMIN_FARMER });
  const disputeId = (await disputes(bookingId, ADMIN_FARMER)).body.dispute.id;
  const recusal = await assign(disputeId, ADMIN_SEPARATE, ADMIN_FARMER);
  assert.equal(recusal.status, 403);
  assert.equal(recusal.body.error.code, 'RECUSAL_REQUIRED');
  const res = await assign(disputeId, ADMIN_FARMER, ADMIN_SEPARATE);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PARTY_CONFLICT');
});

test('package operator with admin role cannot be assigned as mediator of that package', async () => {
  const { bookingId } = await claimed({ operator: ADMIN_OPERATOR });
  const disputeId = (await disputes(bookingId, FARMER)).body.dispute.id;
  const res = await assign(disputeId, ADMIN_OPERATOR, ADMIN_SEPARATE);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PARTY_CONFLICT');
  assert.equal((await assign(disputeId, ADMIN_MEDIATOR, ADMIN_SEPARATE)).status, 200);
});

test('mediator cannot be assigned on a closed case', async () => {
  const { bookingId } = await claimed();
  const closedId = await closedFixture(bookingId);
  const res = await assign(closedId, ADMIN_MEDIATOR, ADMIN_SEPARATE);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DISPUTE_NOT_OPEN');
});

test('dispute rows change only mediator while OPEN; deletes and identity edits are refused by the database', async () => {
  const { bookingId } = await claimed();
  const disputeId = (await disputes(bookingId, FARMER)).body.dispute.id;
  await respond(disputeId, 'Synthetic reply', PROVIDER);
  const events = await ctx.pool.query('SELECT sequence FROM dispatch.dispute_events WHERE dispute_id=$1', [disputeId]);
  assert.equal(events.rows.length, 2);
  await assert.rejects(ctx.pool.query("UPDATE dispatch.disputes SET status='CLOSED' WHERE id=$1", [disputeId]), { code: '23001' });
  await assert.rejects(ctx.pool.query('UPDATE dispatch.disputes SET reason=\'OTHER\' WHERE id=$1', [disputeId]), { code: '23001' });
  await assert.rejects(ctx.pool.query('UPDATE dispatch.disputes SET claimant_id=$2 WHERE id=$1', [disputeId, OTHER_FARMER]), { code: '23001' });
  await assert.rejects(ctx.pool.query('DELETE FROM dispatch.disputes WHERE id=$1', [disputeId]), { code: '23001' });
  await assert.rejects(ctx.pool.query('UPDATE dispatch.dispute_events SET actor_id=$2 WHERE dispute_id=$1', [disputeId, OTHER_FARMER]), { code: '23001' });
  await assert.rejects(ctx.pool.query('DELETE FROM dispatch.dispute_events WHERE dispute_id=$1', [disputeId]), { code: '23001' });
  // A mediator change without its audit event in the same transaction is refused at commit.
  await assert.rejects(ctx.pool.query('UPDATE dispatch.disputes SET mediator_id=$2 WHERE id=$1', [disputeId, ADMIN_MEDIATOR]), { code: '23001' });
  assert.equal((await ctx.pool.query('SELECT mediator_id FROM dispatch.disputes WHERE id=$1', [disputeId])).rows[0].mediator_id, null);
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE dispatch.disputes SET mediator_id=$2 WHERE id=$1', [disputeId, ADMIN_MEDIATOR]);
    await client.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATOR_ASSIGNED', $2, $3::jsonb)",
      [disputeId, ADMIN_SEPARATE, JSON.stringify({ mediatorId: ADMIN_MEDIATOR, previousMediatorId: null })],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await assert.rejects(ctx.pool.query('UPDATE dispatch.disputes SET mediator_id=NULL WHERE id=$1', [disputeId]), { code: '23001' });
  await assert.rejects(ctx.pool.query('UPDATE dispatch.disputes SET status=\'CLOSED\' WHERE id=$1', [disputeId]), { code: '23001' });
});

test('mediator reassignment refuses a forged previous mediator and preserves prior state', async () => {
  const { bookingId } = await claimed();
  const disputeId = (await disputes(bookingId, FARMER)).body.dispute.id;
  assert.equal((await assign(disputeId, ADMIN_MEDIATOR, ADMIN_SEPARATE)).status, 200);
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE dispatch.disputes SET mediator_id=$2 WHERE id=$1', [disputeId, ADMIN_SEPARATE]);
    await assert.rejects(client.query(
      "INSERT INTO dispatch.dispute_events(dispute_id,event_type,actor_id,data) VALUES($1,'MEDIATOR_ASSIGNED',$2,$3::jsonb)",
      [disputeId, ADMIN_SEPARATE, JSON.stringify({ mediatorId: ADMIN_SEPARATE, previousMediatorId: null })],
    ), { code: '23001' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal((await ctx.pool.query('SELECT mediator_id FROM dispatch.disputes WHERE id=$1', [disputeId])).rows[0].mediator_id, ADMIN_MEDIATOR);
  assert.equal(await count("SELECT count(*)::int AS n FROM dispatch.dispute_events WHERE dispute_id=$1 AND event_type='MEDIATOR_ASSIGNED'", [disputeId]), 1);
  assert.equal((await assign(disputeId, ADMIN_SEPARATE, ADMIN_SEPARATE)).status, 200);
});

test('database enforces one OPEN case per booking, party identity, responder and bounded event data', async () => {
  const { bookingId } = await claimed();
  const disputeId = (await disputes(bookingId, FARMER)).body.dispute.id;
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status) VALUES ($1, $2, $3, 'OTHER', 'OPEN')",
    [bookingId, FARMER, PROVIDER],
  ), { code: '23505' });
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status) VALUES ($1, $2, $3, 'OTHER', 'CLOSED')",
    [bookingId, OTHER_FARMER, PROVIDER],
  ), { code: '23001' });
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'RESPONSE_ADDED', $2, '{\"text\":\"Synthetic\"}')",
    [disputeId, ADMIN_SEPARATE],
  ), { code: '23001' });
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'RESPONSE_ADDED', $2, '{\"text\":1}')",
    [disputeId, PROVIDER],
  ), { code: '23514' });
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'RESPONSE_ADDED', $2, $3::jsonb)",
    [disputeId, PROVIDER, JSON.stringify({ text: 'x'.repeat(2001) })],
  ), { code: '23514' });
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'RESPONSE_ADDED', $2, '{\"text\":{\"a\":\"b\"}}')",
    [disputeId, PROVIDER],
  ), { code: '23514' });
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'RESPONSE_ADDED', $2, '{\"text\":\"Synthetic\",\"extra\":1}')",
    [disputeId, PROVIDER],
  ), { code: '23514' });
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'DISPUTE_OPENED', $2, '{\"reason\":\"QUALITY\",\"details\":\"Synthetic\"}')",
    [disputeId, FARMER],
  ), { code: '23505' });
  await assert.rejects(ctx.pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status) VALUES ($1, $2, $3, 'FRAUD', 'CLOSED')",
    [bookingId, FARMER, PROVIDER],
  ), { code: '23514' });
});
