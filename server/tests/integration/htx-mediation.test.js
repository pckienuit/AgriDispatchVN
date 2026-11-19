import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, copyFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createDispatchRouter } from '../../src/dispatch.js';
import { createSchedulingRouter } from '../../src/scheduling.js';
import { createDisputeRouter, hasOpenDispute } from '../../src/disputes.js';
import { createRemedyRouter } from '../../src/remedies.js';
import { createEvidenceRouter } from '../../src/evidence.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

parseDisposableRoot(process.env.TEST_DATABASE_URL);

const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = id(1), OTHER_FARMER = id(2), COOP = id(3), COOP_WITH_FARMER = id(4), OTHER_COOP = id(5);
const PROVIDER = id(6), OPERATOR = id(7), ADMIN_SEPARATE = id(8), ADMIN_MEDIATOR = id(9);
const COOP_PROVIDER = id(10), COOP_OPERATOR = id(11), COOP_ADMIN = id(12), COOP_MACHINE = id(13);
const ADMIN_OPERATOR = id(14), ADMIN_FARMER = id(15);
const MACHINE = id(20), MACHINE_COOP = id(21), MACHINE_COOP_PROVIDER = id(22);
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;

const ACTORS = {
  [FARMER]: ['farmer'],
  [OTHER_FARMER]: ['farmer'],
  [COOP]: ['coop'],
  [COOP_WITH_FARMER]: ['farmer', 'coop'],
  [OTHER_COOP]: ['coop'],
  [PROVIDER]: ['provider'],
  [OPERATOR]: ['operator'],
  [ADMIN_SEPARATE]: ['admin'],
  [ADMIN_MEDIATOR]: ['admin'],
  [COOP_PROVIDER]: ['coop', 'provider'],
  [COOP_OPERATOR]: ['coop', 'operator'],
  [COOP_ADMIN]: ['coop', 'admin'],
  [COOP_MACHINE]: ['farmer', 'coop'],
  [ADMIN_OPERATOR]: ['operator', 'admin'],
  [ADMIN_FARMER]: ['farmer', 'admin'],
};

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

function memoryEvidenceStore() {
  const blobs = new Map();
  return {
    async put(key, bytes, contentType) {
      const etag = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      blobs.set(key, { bytes: Buffer.from(bytes), contentType, etag, versionId: 'v1' });
      return { etag, versionId: 'v1' };
    },
    async get(key, { thumbnail = false } = {}) {
      if (thumbnail) return null;
      return blobs.get(key) ?? null;
    },
    async remove(key) {
      blobs.delete(key);
    },
  };
}

function testAuthenticate(req, res, next) {
  const user = req.get('authorization')?.slice(7);
  if (!ACTORS[user]) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = { id: user, roles: ACTORS[user] };
  return next();
}

const ctx = {};
const servers = [];
let dayCounter = 0;
function nextDay() {
  dayCounter += 1;
  return new Date(Date.UTC(2026, 11, 1) + dayCounter * 86400000).toISOString().slice(0, 10);
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
const get = (path, actor) => call('GET', path, actor);
const post = (path, payload, actor) => call('POST', path, actor, payload);

async function uploadEvidence(disputeId, actor) {
  const res = await fetch(`${ctx.url}/api/disputes/${disputeId}/evidence`, {
    method: 'POST',
    headers: { authorization: `Bearer ${actor}`, 'content-type': 'image/png' },
    body: PNG_1X1,
  });
  return { status: res.status, body: await res.json() };
}

function mountApp(pool, evidenceStore) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(createDispatchRouter({ pool, authenticate: testAuthenticate }));
  app.use(createSchedulingRouter({ pool, authenticate: testAuthenticate }));
  app.use(createDisputeRouter({ pool, authenticate: testAuthenticate }));
  app.use(createRemedyRouter({ pool, authenticate: testAuthenticate }));
  app.use(createEvidenceRouter({ pool, authenticate: testAuthenticate, store: evidenceStore }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: { code: error.code ?? 'INTERNAL_ERROR' } }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  return once(server, 'listening').then(() => `http://127.0.0.1:${server.address().port}`);
}

async function recruit(pool, day, provider, operator) {
  const job = (await pool.query(
    "INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at) VALUES ($1, 'Synthetic recruitment', 'Demo', 2, $2, $3) RETURNING id",
    [provider, `${day}T00:00:00Z`, `${day}T23:00:00Z`],
  )).rows[0].id;
  const application = (await pool.query(
    "INSERT INTO dispatch.applications (job_id, operator_id, status) VALUES ($1, $2, 'OFFERED') RETURNING id",
    [job, operator],
  )).rows[0].id;
  await pool.query(
    "INSERT INTO dispatch.offers (application_id, job_id, operator_id, status, responded_at) VALUES ($1, $2, $3, 'ACCEPTED', now())",
    [application, job, operator],
  );
}

async function setupClaimed({ owner = FARMER, coordinator = COOP, provider = PROVIDER, operator = OPERATOR, machineId = MACHINE } = {}) {
  const day = nextDay();
  await recruit(ctx.pool, day, provider, operator);
  const field = (await ctx.pool.query(
    "INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'Synthetic field', 'Demo', 10000) RETURNING id",
    [owner],
  )).rows[0].id;
  const bookingId = (await ctx.pool.query(
    `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
     SELECT $1, $2, id, $3, $4, 'Synthetic field', 10000, code, name, data_label, price_per_ha_vnd, price_per_ha_vnd, $5
       FROM dispatch.services WHERE code = 'tillage-tractor' RETURNING id`,
    [owner, field, `${day}T08:00:00Z`, `${day}T12:00:00Z`, coordinator],
  )).rows[0].id;
  const pkg = (await ctx.pool.query(
    `INSERT INTO dispatch.packages (coop_id, service_id, locality, window_start_at, window_end_at, provider_id, machine_id, operator_id, status)
     SELECT $1, service_id, 'Demo', start_at, end_at, $2, $4, $5, 'CLAIMED'
       FROM dispatch.bookings WHERE id = $3 RETURNING id`,
    [coordinator, provider, bookingId, machineId, operator],
  )).rows[0].id;
  await ctx.pool.query('INSERT INTO dispatch.package_bookings (package_id, booking_id) VALUES ($1, $2)', [pkg, bookingId]);
  await ctx.pool.query("UPDATE dispatch.bookings SET state = 'GROUPED' WHERE id = $1", [bookingId]);
  await ctx.pool.query("UPDATE dispatch.bookings SET state = 'ASSIGNED' WHERE id = $1", [bookingId]);
  return { bookingId, packageId: pkg };
}

async function openDispute(bookingId, actor = FARMER) {
  const res = await post(`/api/bookings/${bookingId}/disputes`, { reason: 'AREA_MISMATCH', details: 'Synthetic area mismatch' }, actor);
  assert.equal(res.status, 201);
  return res.body.dispute;
}

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  await migrate(ctx.pool);
  await seedCatalog(ctx.pool);
  for (const [user, roles] of Object.entries(ACTORS)) {
    await ctx.pool.query('INSERT INTO account.users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [user, `${user}@example.com`, `Synthetic ${roles.join('+')}`, HASH]);
    for (const role of roles) {
      await ctx.pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user, role]);
    }
  }
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Synthetic tractor', 'tractor')",
    [MACHINE, PROVIDER]);
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Coop owned tractor', 'tractor')",
    [MACHINE_COOP, COOP_MACHINE]);
  await ctx.pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Coop provider tractor', 'tractor')",
    [MACHINE_COOP_PROVIDER, COOP_PROVIDER]);
  ctx.store = memoryEvidenceStore();
  ctx.url = await mountApp(ctx.pool, ctx.store);
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

test('HTX first-level mediation: eligible coop mediates with versioned proposals and independent consents; evidence stays scoped', async () => {
  const { bookingId } = await setupClaimed({ coordinator: COOP_WITH_FARMER });
  const dispute = await openDispute(bookingId, FARMER);
  assert.equal(dispute.mediationLevel, 'HTX');
  assert.equal(dispute.mediatorId, null);
  assert.equal(dispute.escalatedAt, null);

  const ev = await uploadEvidence(dispute.id, FARMER);
  assert.equal(ev.status, 201);
  const evidenceId = ev.body.evidence.id;

  // Unassigned coop (even the coordinating coop) cannot read restricted material yet.
  assert.equal((await get(`/api/disputes/${dispute.id}`, COOP_WITH_FARMER)).status, 404);
  assert.equal((await get(`/api/disputes/${dispute.id}/evidence`, COOP_WITH_FARMER)).status, 404);
  assert.equal((await get(`/api/evidence/${evidenceId}/content`, COOP_WITH_FARMER)).status, 404);
  assert.equal((await get(`/api/disputes/${dispute.id}/proposals`, COOP_WITH_FARMER)).status, 404);

  // Unrelated coop does not see the case in HTX queue and gets 404 everywhere.
  const otherQueue = await get('/api/htx/disputes', OTHER_COOP);
  assert.equal(otherQueue.status, 200);
  assert.equal(otherQueue.body.items.some((i) => i.id === dispute.id), false);
  assert.equal((await post(`/api/disputes/${dispute.id}/htx-mediator`, {}, OTHER_COOP)).status, 404);
  assert.equal((await post(`/api/disputes/${dispute.id}/htx-mediator`, { mediatorId: OTHER_COOP }, ADMIN_SEPARATE)).body.error.code, 'HTX_NOT_RELATED');

  // Non-coop cannot access HTX queue.
  assert.equal((await get('/api/htx/disputes', FARMER)).status, 403);
  assert.equal((await get('/api/htx/disputes', ADMIN_SEPARATE)).status, 403);

  // Eligible coordinating coop (which also has default 'farmer' registration role, not party) sees triage entry only.
  const queue = await get('/api/htx/disputes', COOP_WITH_FARMER);
  assert.equal(queue.status, 200);
  const entry = queue.body.items.find((i) => i.id === dispute.id);
  assert.ok(entry);
  assert.equal(entry.eligible, true);
  assert.equal(entry.conflictCode, null);
  assert.equal(entry.mediationLevel, 'HTX');

  // Self-assign HTX first-level mediator.
  const assigned = await post(`/api/disputes/${dispute.id}/htx-mediator`, {}, COOP_WITH_FARMER);
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.dispute.mediationLevel, 'HTX');
  assert.equal(assigned.body.dispute.mediatorId, COOP_WITH_FARMER);
  // Idempotent repeat does not fail or duplicate audit event.
  assert.equal((await post(`/api/disputes/${dispute.id}/htx-mediator`, {}, COOP_WITH_FARMER)).status, 200);

  // Active assigned HTX mediator reads restricted material, but cannot upload evidence, respond, consent, or close-unresolved.
  const detail = await get(`/api/disputes/${dispute.id}`, COOP_WITH_FARMER);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.events.filter((e) => e.type === 'MEDIATOR_ASSIGNED').length, 1);
  const evList = await get(`/api/disputes/${dispute.id}/evidence`, COOP_WITH_FARMER);
  assert.equal(evList.status, 200);
  assert.equal(evList.body.canUpload, false);
  assert.equal(evList.body.items.length, 1);
  assert.equal((await get(`/api/evidence/${evidenceId}/content`, COOP_WITH_FARMER)).status, 200);
  assert.equal((await uploadEvidence(dispute.id, COOP_WITH_FARMER)).status, 403);
  assert.equal((await post(`/api/disputes/${dispute.id}/responses`, { text: 'Spoof' }, COOP_WITH_FARMER)).status, 404);

  // Unassigned triage admin STILL cannot read private evidence.
  assert.equal((await get(`/api/disputes/${dispute.id}/evidence`, ADMIN_SEPARATE)).status, 404);

  // HTX proposes v1, farmer consents, HTX proposes v2; HTX cannot consent for parties or close-unresolved.
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals`, { text: 'HTX proposal v1' }, COOP_WITH_FARMER)).status, 201);
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals/1/consent`, {}, COOP_WITH_FARMER)).status, 403);
  assert.equal((await post(`/api/disputes/${dispute.id}/close-unresolved`, { reason: 'HTX close attempt' }, COOP_WITH_FARMER)).status, 403);
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals/1/consent`, {}, FARMER)).status, 200);
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals`, { text: 'HTX proposal v2' }, COOP_WITH_FARMER)).status, 201);
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals/1/consent`, {}, PROVIDER)).body.error.code, 'STALE_VERSION');
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals/2/consent`, {}, FARMER)).body.dispute.status, 'OPEN');
  const resolved = await post(`/api/disputes/${dispute.id}/proposals/2/consent`, {}, PROVIDER);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.dispute.status, 'RESOLVED');
  assert.equal(await hasOpenDispute(ctx.pool, bookingId), false);
});

test('persisted conflicts block HTX mediation: party, provider, operator, machine owner, role overlap', async () => {
  // 1. Coop owns booking (party conflict).
  const owned = await setupClaimed({ owner: COOP, coordinator: COOP });
  const dOwned = await openDispute(owned.bookingId, PROVIDER);
  assert.equal((await post(`/api/disputes/${dOwned.id}/htx-mediator`, {}, COOP)).status, 403);
  assert.equal((await post(`/api/disputes/${dOwned.id}/htx-mediator`, {}, COOP)).body.error.code, 'RECUSAL_REQUIRED');
  assert.equal((await post(`/api/disputes/${dOwned.id}/htx-mediator`, { mediatorId: COOP }, ADMIN_SEPARATE)).body.error.code, 'PARTY_CONFLICT');

  // 2. Coop is assigned provider AND owns machine + has provider role overlap.
  const provCase = await setupClaimed({ coordinator: COOP_PROVIDER, provider: COOP_PROVIDER, machineId: MACHINE_COOP_PROVIDER });
  const dProv = await openDispute(provCase.bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dProv.id}/htx-mediator`, {}, COOP_PROVIDER)).body.error.code, 'RECUSAL_REQUIRED');
  assert.equal((await post(`/api/disputes/${dProv.id}/htx-mediator`, { mediatorId: COOP_PROVIDER }, ADMIN_SEPARATE)).body.error.code, 'PARTY_CONFLICT');

  // 3. Coop holds provider role overlap even when another provider claims the package.
  const overlapProv = await setupClaimed({ coordinator: COOP_PROVIDER, provider: PROVIDER, machineId: MACHINE });
  const dOverlapProv = await openDispute(overlapProv.bookingId, FARMER);
  const qOverlap = await get('/api/htx/disputes', COOP_PROVIDER);
  const qItem = qOverlap.body.items.find((i) => i.id === dOverlapProv.id);
  assert.equal(qItem.eligible, false);
  assert.equal(qItem.conflictCode, 'ROLE_OVERLAP');
  assert.equal((await post(`/api/disputes/${dOverlapProv.id}/htx-mediator`, {}, COOP_PROVIDER)).body.error.code, 'RECUSAL_REQUIRED');

  // 4. Coop is operator / holds operator role overlap.
  const opCase = await setupClaimed({ coordinator: COOP_OPERATOR, operator: COOP_OPERATOR });
  const dOp = await openDispute(opCase.bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dOp.id}/htx-mediator`, {}, COOP_OPERATOR)).body.error.code, 'RECUSAL_REQUIRED');

  // 5. Coop holds admin role overlap (cannot bypass admin recusal as HTX).
  const adminOverlap = await setupClaimed({ coordinator: COOP_ADMIN });
  const dAdm = await openDispute(adminOverlap.bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dAdm.id}/htx-mediator`, {}, COOP_ADMIN)).body.error.code, 'RECUSAL_REQUIRED');

  // 6. Coop owns a machine (dispatch.machines.owner_id = COOP_MACHINE).
  const machCase = await setupClaimed({ coordinator: COOP_MACHINE, provider: PROVIDER, machineId: MACHINE });
  const dMach = await openDispute(machCase.bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dMach.id}/htx-mediator`, {}, COOP_MACHINE)).body.error.code, 'RECUSAL_REQUIRED');
  await assert.rejects(
    ctx.pool.query('UPDATE dispatch.disputes SET mediator_id = $2 WHERE id = $1', [dMach.id, COOP_MACHINE]),
    { code: '23001' },
  );
});

test('escalation with reason and log revokes HTX access, preserves evidence/proposals, and hands off to independent admin', async () => {
  const { bookingId } = await setupClaimed({ coordinator: COOP });
  const dispute = await openDispute(bookingId, FARMER);
  const ev = await uploadEvidence(dispute.id, FARMER);
  assert.equal(ev.status, 201);
  const evidenceId = ev.body.evidence.id;

  // Admin assigns eligible HTX.
  assert.equal((await post(`/api/disputes/${dispute.id}/htx-mediator`, { mediatorId: COOP }, ADMIN_SEPARATE)).status, 200);
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals`, { text: 'HTX level-1 proposal' }, COOP)).status, 201);
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals/1/consent`, {}, FARMER)).status, 200);

  // Admin cannot silently replace active HTX without escalating first.
  const overwrite = await post(`/api/disputes/${dispute.id}/mediator`, { mediatorId: ADMIN_MEDIATOR }, ADMIN_SEPARATE);
  assert.equal(overwrite.status, 409);
  assert.equal(overwrite.body.error.code, 'ESCALATION_REQUIRED');

  // Provider (or HTX) escalates due to unrepresented affiliation conflict with reason & log.
  const esc = await post(`/api/disputes/${dispute.id}/escalate`, {
    reason: 'HTX co quan he gia dinh voi chu ruong, khong du doc lap',
    conflictType: 'AFFILIATION_CONFLICT',
  }, PROVIDER);
  assert.equal(esc.status, 200);
  assert.equal(esc.body.dispute.mediationLevel, 'ADMIN');
  assert.equal(esc.body.dispute.mediatorId, null);
  assert.equal(esc.body.dispute.escalationConflictType, 'AFFILIATION_CONFLICT');
  assert.equal(esc.body.dispute.escalationReason, 'HTX co quan he gia dinh voi chu ruong, khong du doc lap');
  assert.ok(esc.body.dispute.escalatedAt);

  // Former HTX immediately loses all restricted read & mutate access.
  assert.equal((await get(`/api/disputes/${dispute.id}`, COOP)).status, 404);
  assert.equal((await get(`/api/disputes/${dispute.id}/evidence`, COOP)).status, 404);
  assert.equal((await get(`/api/evidence/${evidenceId}/content`, COOP)).status, 404);
  assert.equal((await get(`/api/disputes/${dispute.id}/proposals`, COOP)).status, 404);
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals`, { text: 'Stale HTX' }, COOP)).status, 404);
  assert.equal((await get('/api/disputes', COOP)).body.items.some((i) => i.id === dispute.id), false);
  assert.equal((await get('/api/htx/disputes', COOP)).body.items.some((i) => i.id === dispute.id), false);
  assert.equal((await post(`/api/disputes/${dispute.id}/htx-mediator`, {}, COOP)).body.error.code, 'ESCALATED_TO_ADMIN');

  // Remaining party cannot consent to displaced HTX proposal v1.
  assert.equal((await post(`/api/disputes/${dispute.id}/proposals/1/consent`, {}, PROVIDER)).body.error.code, 'MEDIATOR_CHANGED');

  // Second escalation is refused.
  assert.equal((await post(`/api/disputes/${dispute.id}/escalate`, { reason: 'Duplicate' }, FARMER)).body.error.code, 'ALREADY_ESCALATED');

  // Uninvolved admin sees escalated case in review queue and assigns independent admin mediator.
  const review = await get('/api/dispute-review', ADMIN_SEPARATE);
  assert.ok(review.body.items.some((i) => i.id === dispute.id && i.mediationLevel === 'ADMIN'));
  const assignedAdmin = await post(`/api/disputes/${dispute.id}/mediator`, { mediatorId: ADMIN_MEDIATOR }, ADMIN_SEPARATE);
  assert.equal(assignedAdmin.status, 200);
  assert.equal(assignedAdmin.body.dispute.mediatorId, ADMIN_MEDIATOR);

  // Independent admin reads preserved evidence, dispute escalations log, proposes v2, closes unresolved.
  assert.equal((await get(`/api/disputes/${dispute.id}/evidence`, ADMIN_MEDIATOR)).body.items.length, 1);
  assert.equal((await get(`/api/evidence/${evidenceId}/content`, ADMIN_MEDIATOR)).status, 200);
  const detail = await get(`/api/disputes/${dispute.id}`, ADMIN_MEDIATOR);
  assert.equal(detail.body.escalations.length, 1);
  assert.equal(detail.body.escalations[0].conflictType, 'AFFILIATION_CONFLICT');
  assert.equal(detail.body.escalations[0].previousMediatorId, COOP);
  assert.deepEqual(detail.body.events.map((e) => e.type), ['DISPUTE_OPENED', 'MEDIATOR_ASSIGNED', 'MEDIATOR_ASSIGNED']);
  assert.deepEqual(detail.body.events[2].data, { mediatorId: ADMIN_MEDIATOR, previousMediatorId: COOP });

  // Migration 017 audit validation passes over HTX -> Escalated -> Admin history.
  const auditSql = await readFile(new URL('../../../db/migrations/017_validate_mediator_history.sql', import.meta.url), 'utf8');
  await ctx.pool.query(auditSql);

  assert.equal((await post(`/api/disputes/${dispute.id}/proposals`, { text: 'Admin proposal v2' }, ADMIN_MEDIATOR)).status, 201);
  const closed = await post(`/api/disputes/${dispute.id}/close-unresolved`, { reason: 'Khong dat dong thuan sau hoa giai cap 2' }, ADMIN_MEDIATOR);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.dispute.status, 'CLOSED_UNRESOLVED');
  assert.equal(await hasOpenDispute(ctx.pool, bookingId), true);
});

test('post-assignment HTX role-overlap blocks active mediator until escalated; concurrent escalate vs consent serializes cleanly', async () => {
  // Post-assignment role-overlap on active HTX mediator.
  const a = await setupClaimed({ coordinator: COOP });
  const dA = await openDispute(a.bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dA.id}/htx-mediator`, {}, COOP)).status, 200);
  assert.equal((await post(`/api/disputes/${dA.id}/proposals`, { text: 'Early HTX proposal' }, COOP)).status, 201);
  // Grant provider role dynamically -> COOP immediately loses independence!
  await ctx.pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'provider') ON CONFLICT DO NOTHING", [COOP]);
  try {
    assert.equal((await post(`/api/disputes/${dA.id}/proposals`, { text: 'Blocked after conflict' }, COOP)).body.error.code, 'RECUSAL_REQUIRED');
    assert.equal((await get(`/api/disputes/${dA.id}/evidence`, COOP)).status, 404);
    assert.equal((await post(`/api/disputes/${dA.id}/proposals/1/consent`, {}, FARMER)).body.error.code, 'RECUSAL_REQUIRED');
    // HTX recuses up to independent admin.
    assert.equal((await post(`/api/disputes/${dA.id}/escalate`, { reason: 'Moi phat sinh vai tro chu may', conflictType: 'ROLE_OVERLAP' }, COOP)).status, 200);
  } finally {
    await ctx.pool.query("DELETE FROM account.user_roles WHERE user_id = $1 AND role = 'provider'", [COOP]);
  }

  // Concurrency race: escalate vs second-party consent to HTX proposal.
  const b = await setupClaimed({ coordinator: COOP });
  const dB = await openDispute(b.bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dB.id}/htx-mediator`, {}, COOP)).status, 200);
  assert.equal((await post(`/api/disputes/${dB.id}/proposals`, { text: 'Racing HTX proposal' }, COOP)).status, 201);
  assert.equal((await post(`/api/disputes/${dB.id}/proposals/1/consent`, {}, FARMER)).status, 200);

  const [escRes, consentRes] = await Promise.all([
    post(`/api/disputes/${dB.id}/escalate`, { reason: 'Concurrent escalation' }, COOP),
    post(`/api/disputes/${dB.id}/proposals/1/consent`, {}, PROVIDER),
  ]);
  const row = (await ctx.pool.query('SELECT status, mediation_level, mediator_id FROM dispatch.disputes WHERE id = $1', [dB.id])).rows[0];
  if (row.status === 'RESOLVED') {
    assert.equal(consentRes.status, 200);
    assert.equal(escRes.status, 409);
    assert.equal(escRes.body.error.code, 'DISPUTE_NOT_OPEN');
  } else {
    assert.equal(row.status, 'OPEN');
    assert.equal(row.mediation_level, 'ADMIN');
    assert.equal(row.mediator_id, null);
    assert.equal(escRes.status, 200);
    assert.equal(consentRes.status, 409);
    assert.equal(consentRes.body.error.code, 'MEDIATOR_CHANGED');
  }
});

test('DB triggers refuse HTX downgrade, un-audited escalation, and HTX unresolved closure', async () => {
  const { bookingId } = await setupClaimed({ coordinator: COOP });
  const dispute = await openDispute(bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dispute.id}/htx-mediator`, {}, COOP)).status, 200);
  await assert.rejects(
    ctx.pool.query(
      "UPDATE dispatch.disputes SET status = 'CLOSED_UNRESOLVED', closed_at = now(), closure_reason = 'Bypass' WHERE id = $1",
      [dispute.id],
    ),
    { code: '23001' },
  );
  await assert.rejects(
    ctx.pool.query(
      "UPDATE dispatch.disputes SET mediation_level = 'ADMIN', mediator_id = NULL, escalated_at = now(), escalated_by = $2, escalation_reason = 'No event', escalation_conflict_type = 'PARTY_REQUEST' WHERE id = $1",
      [dispute.id, FARMER],
    ),
    { code: '23001' },
  );
  await assert.rejects(
    ctx.pool.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATION_ESCALATED', $2, $3::jsonb)",
      [dispute.id, FARMER, JSON.stringify({ reason: 'Forged', conflictType: 'PARTY_REQUEST', previousMediatorId: COOP })],
    ),
    { code: '23001' },
  );
  assert.equal((await post(`/api/disputes/${dispute.id}/escalate`, { reason: 'Escalated properly' }, COOP)).status, 200);
  await assert.rejects(
    ctx.pool.query("UPDATE dispatch.disputes SET mediation_level = 'HTX' WHERE id = $1", [dispute.id]),
    { code: '23001' },
  );
});

test('migration 020 backwards compatibility preserves pre-020 open, admin-assigned and closed disputes', async (t) => {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url, { statementTimeout: 60000 });
  let server;
  const dir = await mkdtemp(join(tmpdir(), 'h08-mig-'));
  t.after(async () => {
    if (server) await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    await pool.end();
    await db.drop();
    await rm(dir, { recursive: true, force: true });
  });

  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql') && file < '020_')) {
    await copyFile(join(MIGRATIONS, name), join(dir, name));
  }
  await migrate(pool, dir);
  await seedCatalog(pool);
  for (const [user, roles] of [[FARMER, 'farmer'], [COOP, 'coop'], [PROVIDER, 'provider'], [OPERATOR, 'operator'], [ADMIN_MEDIATOR, 'admin'], [ADMIN_SEPARATE, 'admin']]) {
    await pool.query('INSERT INTO account.users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [user, `${user}@example.com`, 'Legacy', HASH]);
    await pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user, roles]);
  }
  await pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Legacy tractor', 'tractor')", [MACHINE, PROVIDER]);

  const legacyAssigned = async (day) => {
    await recruit(pool, day, PROVIDER, OPERATOR);
    const field = (await pool.query("INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, 'F', 'Demo', 10000) RETURNING id", [FARMER])).rows[0].id;
    const bId = (await pool.query(
      `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
         service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id)
       SELECT $1, $2, id, $3, $4, 'F', 10000, code, name, data_label, price_per_ha_vnd, price_per_ha_vnd, $5
         FROM dispatch.services WHERE code = 'tillage-tractor' RETURNING id`,
      [FARMER, field, `${day}T08:00Z`, `${day}T12:00Z`, COOP],
    )).rows[0].id;
    const pId = (await pool.query(
      `INSERT INTO dispatch.packages (coop_id, service_id, locality, window_start_at, window_end_at, provider_id, machine_id, operator_id, status)
       SELECT $1, service_id, 'Demo', start_at, end_at, $2, $4, $5, 'CLAIMED' FROM dispatch.bookings WHERE id = $3 RETURNING id`,
      [COOP, PROVIDER, bId, MACHINE, OPERATOR],
    )).rows[0].id;
    await pool.query('INSERT INTO dispatch.package_bookings (package_id, booking_id) VALUES ($1, $2)', [pId, bId]);
    await pool.query("UPDATE dispatch.bookings SET state = 'GROUPED' WHERE id = $1", [bId]);
    await pool.query("UPDATE dispatch.bookings SET state = 'ASSIGNED' WHERE id = $1", [bId]);
    return bId;
  };

  const bAdmin = await legacyAssigned('2026-12-20');
  const dAdmin = (await pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status) VALUES ($1, $2, $3, 'QUALITY', 'OPEN') RETURNING id",
    [bAdmin, FARMER, PROVIDER],
  )).rows[0].id;
  await pool.query("INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'DISPUTE_OPENED', $2, '{\"reason\":\"QUALITY\",\"details\":\"Legacy open\"}')", [dAdmin, FARMER]);
  await pool.query('BEGIN');
  await pool.query('UPDATE dispatch.disputes SET mediator_id = $2 WHERE id = $1', [dAdmin, ADMIN_MEDIATOR]);
  await pool.query("INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATOR_ASSIGNED', $2, $3::jsonb)", [dAdmin, ADMIN_SEPARATE, JSON.stringify({ mediatorId: ADMIN_MEDIATOR, previousMediatorId: null })]);
  await pool.query('COMMIT');

  const bClosed = await legacyAssigned('2026-12-21');
  const dClosed = (await pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status, closed_at, closure_reason) VALUES ($1, $2, $3, 'NO_SHOW', 'CLOSED_UNRESOLVED', now(), 'Legacy closed') RETURNING id",
    [bClosed, FARMER, PROVIDER],
  )).rows[0].id;

  const bOpenLegacy = await legacyAssigned('2026-12-22');
  const dOpenLegacy = (await pool.query(
    "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status) VALUES ($1, $2, $3, 'OTHER', 'OPEN') RETURNING id",
    [bOpenLegacy, FARMER, PROVIDER],
  )).rows[0].id;
  await pool.query("INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'DISPUTE_OPENED', $2, '{\"reason\":\"OTHER\",\"details\":\"Legacy unassigned\"}')", [dOpenLegacy, FARMER]);

  const migration = '020_htx_mediation.sql';
  await copyFile(join(MIGRATIONS, migration), join(dir, migration));
  assert.deepEqual(await migrate(pool, dir), [migration]);
  assert.deepEqual(await migrate(pool, dir), []);

  const rowAdmin = (await pool.query('SELECT mediation_level, mediator_id FROM dispatch.disputes WHERE id = $1', [dAdmin])).rows[0];
  assert.equal(rowAdmin.mediation_level, 'ADMIN');
  assert.equal(rowAdmin.mediator_id, ADMIN_MEDIATOR);
  const rowClosed = (await pool.query('SELECT mediation_level, status FROM dispatch.disputes WHERE id = $1', [dClosed])).rows[0];
  assert.equal(rowClosed.mediation_level, 'ADMIN');
  assert.equal(rowClosed.status, 'CLOSED_UNRESOLVED');
  const rowOpenLegacy = (await pool.query('SELECT mediation_level, mediator_id FROM dispatch.disputes WHERE id = $1', [dOpenLegacy])).rows[0];
  assert.equal(rowOpenLegacy.mediation_level, 'ADMIN');
  assert.equal(rowOpenLegacy.mediator_id, null);

  const app = express();
  app.use(express.json());
  app.use(createDisputeRouter({ pool, authenticate: testAuthenticate }));
  app.use(createRemedyRouter({ pool, authenticate: testAuthenticate }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, actor, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${actor}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  // Pre-020 unassigned open dispute retains ADMIN level and allows admin mediator assignment without escalation.
  assert.equal((await req('POST', `/api/disputes/${dOpenLegacy}/mediator`, ADMIN_SEPARATE, { mediatorId: ADMIN_MEDIATOR })).status, 200);
  // Legacy admin-assigned dispute still allows admin proposal and party resolution.
  assert.equal((await req('POST', `/api/disputes/${dAdmin}/proposals`, ADMIN_MEDIATOR, { text: 'Legacy admin proposal' })).status, 201);
  assert.equal((await req('POST', `/api/disputes/${dAdmin}/proposals/1/consent`, FARMER, {})).status, 200);
  assert.equal((await req('POST', `/api/disputes/${dAdmin}/proposals/1/consent`, PROVIDER, {})).body.dispute.status, 'RESOLVED');
});

test('F1 & F2: no silent promotion via API or DB; unassigned HTX rejects unresolved closure; A-03 triage stays usable without evidence leak', async () => {
  const { bookingId } = await setupClaimed({ coordinator: COOP_PROVIDER, provider: PROVIDER, machineId: MACHINE });
  const dispute = await openDispute(bookingId, FARMER);
  const ev = await uploadEvidence(dispute.id, FARMER);
  assert.equal(ev.status, 201);

  // Unassigned HTX cannot be silently promoted via API /mediator or SQL.
  const apiPromote = await post(`/api/disputes/${dispute.id}/mediator`, { mediatorId: ADMIN_MEDIATOR }, ADMIN_SEPARATE);
  assert.equal(apiPromote.status, 409);
  assert.equal(apiPromote.body.error.code, 'ESCALATION_REQUIRED');

  await assert.rejects(
    ctx.pool.query(
      "INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status, mediation_level) VALUES ($1, $2, $3, 'OTHER', 'OPEN', 'ADMIN')",
      [bookingId, FARMER, PROVIDER],
    ),
    { code: '23001' },
  );
  await assert.rejects(
    ctx.pool.query(
      "UPDATE dispatch.disputes SET mediation_level = 'ADMIN', mediator_id = $2 WHERE id = $1",
      [dispute.id, ADMIN_MEDIATOR],
    ),
    { code: '23001' },
  );
  const sqlClient = await ctx.pool.connect();
  try {
    await sqlClient.query('BEGIN');
    await assert.rejects(
      sqlClient.query('UPDATE dispatch.disputes SET mediator_id = $2 WHERE id = $1', [dispute.id, ADMIN_MEDIATOR]),
      { code: '23001' },
    );
  } finally {
    await sqlClient.query('ROLLBACK').catch(() => {});
    sqlClient.release();
  }

  // F2: unassigned HTX dispute also rejects CLOSED_UNRESOLVED in DB.
  const closeClient = await ctx.pool.connect();
  try {
    await closeClient.query('BEGIN');
    await closeClient.query(
      "INSERT INTO dispatch.remedy_events (dispute_id, actor_id, event_type, version, details) VALUES ($1, $2, 'CLOSED_UNRESOLVED', NULL, 'Bypass')",
      [dispute.id, ADMIN_SEPARATE],
    );
    await assert.rejects(
      closeClient.query(
        "UPDATE dispatch.disputes SET status = 'CLOSED_UNRESOLVED', closed_at = now(), closure_reason = 'Bypass' WHERE id = $1",
        [dispute.id],
      ),
      { code: '23001' },
    );
  } finally {
    await closeClient.query('ROLLBACK').catch(() => {});
    closeClient.release();
  }

  // F7: unrelated admin calling close-unresolved on HTX dispute gets 404 (not 403).
  assert.equal((await post(`/api/disputes/${dispute.id}/close-unresolved`, { reason: 'Premature close' }, ADMIN_SEPARATE)).status, 404);

  // Independent admin keeps A-03 triage access to open HTX case without evidence access, and can document escalation.
  const queue = await get('/api/dispute-review', ADMIN_SEPARATE);
  assert.ok(queue.body.items.some((i) => i.id === dispute.id && i.mediationLevel === 'HTX'));
  assert.equal((await get(`/api/disputes/${dispute.id}`, ADMIN_SEPARATE)).status, 200);
  assert.equal((await get(`/api/disputes/${dispute.id}/proposals`, ADMIN_SEPARATE)).status, 200);
  assert.equal((await get(`/api/dispute-review/${dispute.id}/mediators`, ADMIN_SEPARATE)).status, 200);
  assert.equal((await get(`/api/disputes/${dispute.id}/evidence`, ADMIN_SEPARATE)).status, 404);
  assert.equal((await get(`/api/evidence/${ev.body.evidence.id}/content`, ADMIN_SEPARATE)).status, 404);

  const esc = await post(`/api/disputes/${dispute.id}/escalate`, {
    reason: 'HTX co xung dot vai tro, chuyen cap admin',
    conflictType: 'ROLE_OVERLAP',
  }, ADMIN_SEPARATE);
  assert.equal(esc.status, 200);
  assert.equal(esc.body.dispute.mediationLevel, 'ADMIN');
  assert.equal((await post(`/api/disputes/${dispute.id}/mediator`, { mediatorId: ADMIN_MEDIATOR }, ADMIN_SEPARATE)).status, 200);
});

test('F3: involved admins cannot use admin authority to escalate; role-based party and HTX escalation still work', async () => {
  // 1. Operator holding admin role cannot escalate via admin authority.
  const opCase = await setupClaimed({ coordinator: COOP, operator: ADMIN_OPERATOR });
  const dOp = await openDispute(opCase.bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dOp.id}/escalate`, { reason: 'Involved operator admin' }, ADMIN_OPERATOR)).status, 404);

  // 2. Coordinator whose coop role was stripped (holds admin only) cannot escalate via admin authority.
  const strippedCase = await setupClaimed({ coordinator: COOP_ADMIN });
  const dStripped = await openDispute(strippedCase.bookingId, FARMER);
  await ctx.pool.query("DELETE FROM account.user_roles WHERE user_id = $1 AND role = 'coop'", [COOP_ADMIN]);
  const prevRoles = ACTORS[COOP_ADMIN];
  ACTORS[COOP_ADMIN] = ['admin'];
  try {
    assert.equal((await post(`/api/disputes/${dStripped.id}/escalate`, { reason: 'Stripped coop admin' }, COOP_ADMIN)).status, 404);
  } finally {
    ACTORS[COOP_ADMIN] = prevRoles;
    await ctx.pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'coop') ON CONFLICT DO NOTHING", [COOP_ADMIN]);
  }

  // 3. Legitimate HTX coordinator holding ['coop', 'admin'] CAN escalate.
  assert.equal((await post(`/api/disputes/${dStripped.id}/escalate`, { reason: 'Coop role overlap escalation', conflictType: 'ROLE_OVERLAP' }, COOP_ADMIN)).status, 200);

  // 4. Legitimate party holding ['farmer', 'admin'] CAN escalate.
  const partyCase = await setupClaimed({ owner: ADMIN_FARMER, coordinator: COOP });
  const dParty = await openDispute(partyCase.bookingId, ADMIN_FARMER);
  assert.equal((await post(`/api/disputes/${dParty.id}/escalate`, { reason: 'Party escalation' }, ADMIN_FARMER)).status, 200);
});

test('F4: personal dispute list excludes conflicted mediators and preserves dense pagination', async () => {
  // Two HTX cases assigned to COOP: grant COOP provider role -> personal list drops both.
  const htxCase = await setupClaimed({ coordinator: COOP });
  const dHtx = await openDispute(htxCase.bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${dHtx.id}/htx-mediator`, {}, COOP)).status, 200);
  assert.ok((await get('/api/disputes', COOP)).body.items.some((i) => i.id === dHtx.id));

  await ctx.pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'provider') ON CONFLICT DO NOTHING", [COOP]);
  try {
    assert.equal((await get('/api/disputes', COOP)).body.items.some((i) => i.id === dHtx.id), false);
  } finally {
    await ctx.pool.query("DELETE FROM account.user_roles WHERE user_id = $1 AND role = 'provider'", [COOP]);
  }

  // Two ADMIN-level cases for ADMIN_MEDIATOR, plus a clean third case; make the newest conflicted.
  const c1 = await setupClaimed({ coordinator: COOP });
  const c2 = await setupClaimed({ coordinator: COOP });
  const dOld = await openDispute(c1.bookingId, FARMER);
  const dNew = await openDispute(c2.bookingId, FARMER);
  for (const d of [dOld, dNew]) {
    assert.equal((await post(`/api/disputes/${d.id}/escalate`, { reason: 'Escalated' }, FARMER)).status, 200);
    assert.equal((await post(`/api/disputes/${d.id}/mediator`, { mediatorId: ADMIN_MEDIATOR }, ADMIN_SEPARATE)).status, 200);
  }
  const beforeAll = (await get('/api/disputes?limit=100&offset=0', ADMIN_MEDIATOR)).body.items.map((i) => i.id);
  assert.ok(beforeAll.includes(dNew.id));
  assert.ok(beforeAll.includes(dOld.id));

  await ctx.pool.query('UPDATE dispatch.packages SET operator_id = $2 WHERE id = $1', [c2.packageId, ADMIN_MEDIATOR]);
  try {
    const filteredAll = (await get('/api/disputes?limit=100&offset=0', ADMIN_MEDIATOR)).body.items.map((i) => i.id);
    assert.equal(filteredAll.includes(dNew.id), false);
    assert.ok(filteredAll.includes(dOld.id));
    assert.equal(filteredAll.length, beforeAll.length - 1);

    // Dense pagination: paging limit=1 across filtered list returns every non-conflicted item without holes.
    const paged = [];
    for (let offset = 0; offset < filteredAll.length; offset += 1) {
      const page = await get(`/api/disputes?limit=1&offset=${offset}`, ADMIN_MEDIATOR);
      assert.equal(page.status, 200);
      assert.equal(page.body.items.length, 1);
      paged.push(page.body.items[0].id);
    }
    assert.deepEqual(paged, filteredAll);
  } finally {
    await ctx.pool.query('UPDATE dispatch.packages SET operator_id = $2 WHERE id = $1', [c2.packageId, OPERATOR]);
  }
});

test('F6 H-08: escalation audit uniqueness and payload consistency enforced at DB level', async () => {
  const { bookingId } = await setupClaimed({ coordinator: COOP });
  const d = await openDispute(bookingId, FARMER);
  assert.equal((await post(`/api/disputes/${d.id}/htx-mediator`, {}, COOP)).status, 200);

  // Forged previousMediatorId (null when COOP is assigned) is rejected.
  await assert.rejects(
    ctx.pool.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATION_ESCALATED', $2, $3::jsonb)",
      [d.id, FARMER, JSON.stringify({ reason: 'Forged prev', conflictType: 'PARTY_REQUEST', previousMediatorId: null })],
    ),
    { code: '23001' },
  );

  // Mismatched escalation_conflict_type vs event data->>'conflictType' is rejected at commit.
  const mismatch = await ctx.pool.connect();
  try {
    await mismatch.query('BEGIN');
    await mismatch.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATION_ESCALATED', $2, $3::jsonb)",
      [d.id, FARMER, JSON.stringify({ reason: 'Mismatch', conflictType: 'PARTY_REQUEST', previousMediatorId: COOP })],
    );
    await mismatch.query(
      "UPDATE dispatch.disputes SET mediation_level = 'ADMIN', mediator_id = NULL, escalated_at = clock_timestamp(), escalated_by = $2, escalation_reason = 'Mismatch', escalation_conflict_type = 'RECUSAL_REQUEST' WHERE id = $1",
      [d.id, FARMER],
    );
    await assert.rejects(mismatch.query('COMMIT'), { code: '23001' });
  } finally {
    await mismatch.query('ROLLBACK').catch(() => {});
    mismatch.release();
  }

  // Valid escalation succeeds; duplicate MEDIATION_ESCALATED insert afterwards (while mediator_id IS NULL) is refused.
  assert.equal((await post(`/api/disputes/${d.id}/escalate`, { reason: 'Valid escalation', conflictType: 'PARTY_REQUEST' }, FARMER)).status, 200);
  await assert.rejects(
    ctx.pool.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATION_ESCALATED', $2, $3::jsonb)",
      [d.id, FARMER, JSON.stringify({ reason: 'Duplicate', conflictType: 'PARTY_REQUEST', previousMediatorId: null })],
    ),
    { code: '23001' },
  );
});
