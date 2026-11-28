import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createActivityRouter } from '../../src/activity.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

// Fail closed at load time: the root URL must be a loopback PostgreSQL URL naming a *_test database.
parseDisposableRoot(process.env.TEST_DATABASE_URL);

// All identities and rows below are synthetic fixtures inserted by SQL in this file.
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FARMER = id(1), COOP = id(2), PROVIDER = id(3), OTHER_PROVIDER = id(4), OPERATOR = id(5);
const OTHER_OPERATOR = id(6), OTHER_FARMER = id(7), MEDIATOR = id(8), ADMIN_SEPARATE = id(9);
const SERVICE = id(20), MACHINE = id(21), FIELD = id(22), BOOKING = id(23), PACKAGE = id(24);
const SHIFT = id(25), DISPUTE = id(26), JOB = id(27), OTHER_JOB = id(28), APPLICATION = id(29);
const OTHER_APPLICATION = id(30), OFFER = id(31);
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
const ACTORS = {
  [FARMER]: ['farmer'], [OTHER_FARMER]: ['farmer'], [COOP]: ['coop'], [PROVIDER]: ['provider'],
  [OTHER_PROVIDER]: ['provider'], [OPERATOR]: ['operator'], [OTHER_OPERATOR]: ['operator'],
  [MEDIATOR]: ['admin'], [ADMIN_SEPARATE]: ['admin'],
};

// Fixed labels, copied from the spec, not from fixture text. Each type the fixtures produce is checked.
const LABEL = {
  'booking.BOOKING_REQUESTED': 'Yêu cầu đặt dịch vụ đã được gửi',
  'booking.COORDINATOR_ASSIGNED': 'Đã gán điều phối viên cho yêu cầu',
  'booking.BOOKING_GROUPED': 'Yêu cầu đã được gom vào gói dịch vụ',
  'booking.BOOKING_ASSIGNED': 'Yêu cầu đã được phân công',
  'recruitment.job.created': 'Tin tuyển việc đã được đăng',
  'recruitment.application.created': 'Đơn ứng tuyển đã được nộp',
  'recruitment.application.offered': 'Đơn ứng tuyển đã nhận đề nghị công việc',
  'recruitment.application.withdrawn': 'Đơn ứng tuyển đã được rút',
  'recruitment.offer.created': 'Đề nghị công việc đã được gửi',
  'recruitment.offer.accepted': 'Đề nghị công việc đã được chấp nhận',
  'shift.SHIFT_STARTED': 'Ca làm việc đã bắt đầu',
  'shift.SHIFT_PAUSED': 'Ca làm việc đã tạm dừng',
  'dispute.DISPUTE_OPENED': 'Tranh chấp đã được mở',
  'dispute.RESPONSE_ADDED': 'Đã có phản hồi trong tranh chấp',
  'dispute.MEDIATOR_ASSIGNED': 'Người hòa giải đã được phân công',
  'dispute.MEDIATION_ESCALATED': 'Tranh chấp đã được chuyển cấp hòa giải',
  'remedy.PROPOSED': 'Phương án xử lý đã được đề xuất',
  'remedy.CONSENTED': 'Một bên đã đồng ý phương án xử lý',
};
const LEAK_MARKERS = ['SECRET-', '@example.com', 'Synthetic ', 'Ruộng giả lập', 'Tuyển giả lập', 'Máy giả lập', 'Dịch vụ giả lập'];

const B = `#booking/${BOOKING}`, D = `#dispute/${DISPUTE}`, S = `#shift/${SHIFT}`, J = `#job/${JOB}`;
const OJ = `#job/${OTHER_JOB}`;

// Expected newest-first order: createdAt DESC, then source prefix ASC, then sequence DESC.
// Ties are inserted on purpose: 08:50 booking vs dispute, 08:40 two recruitment rows, 08:30 recruitment vs shift.
const EXPECTED = {
  [FARMER]: [
    ['remedy.CONSENTED', D], ['remedy.PROPOSED', D], ['dispute.MEDIATOR_ASSIGNED', D], ['dispute.MEDIATION_ESCALATED', D],
    ['dispute.RESPONSE_ADDED', D], ['booking.BOOKING_ASSIGNED', B], ['dispute.DISPUTE_OPENED', D],
    ['booking.BOOKING_GROUPED', B], ['booking.COORDINATOR_ASSIGNED', B], ['booking.BOOKING_REQUESTED', B],
  ],
  [PROVIDER]: [
    ['remedy.CONSENTED', D], ['remedy.PROPOSED', D], ['dispute.MEDIATOR_ASSIGNED', D], ['dispute.MEDIATION_ESCALATED', D],
    ['dispute.RESPONSE_ADDED', D], ['shift.SHIFT_PAUSED', S], ['recruitment.offer.accepted', J],
    ['dispute.DISPUTE_OPENED', D], ['recruitment.offer.created', J], ['recruitment.application.offered', J],
    ['recruitment.application.created', J], ['shift.SHIFT_STARTED', S], ['recruitment.job.created', J],
  ],
  [OPERATOR]: [
    ['shift.SHIFT_PAUSED', S], ['recruitment.offer.accepted', J], ['recruitment.offer.created', J],
    ['recruitment.application.offered', J], ['recruitment.application.created', J], ['shift.SHIFT_STARTED', S],
  ],
  [COOP]: [['shift.SHIFT_PAUSED', S], ['shift.SHIFT_STARTED', S]],
  [MEDIATOR]: [
    ['remedy.CONSENTED', D], ['remedy.PROPOSED', D], ['dispute.MEDIATOR_ASSIGNED', D],
    ['dispute.MEDIATION_ESCALATED', D], ['dispute.RESPONSE_ADDED', D], ['dispute.DISPUTE_OPENED', D],
  ],
  [ADMIN_SEPARATE]: [],
  [OTHER_FARMER]: [],
  [OTHER_PROVIDER]: [['recruitment.application.withdrawn', OJ], ['recruitment.job.created', OJ]],
  [OTHER_OPERATOR]: [['recruitment.application.withdrawn', `#job/${OTHER_JOB}`]],
};

const ctx = {};
const servers = [];

// TEST SEAM ONLY: bearer token equals a synthetic user ID. The parent app supplies real authentication.
function testAuthenticate(req, res, next) {
  const user = req.get('authorization')?.slice(7);
  if (!ACTORS[user]) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  req.actor = { id: user, roles: ACTORS[user] };
  return next();
}

const at = (hhmm) => `2026-11-10T${hhmm}:00Z`;

async function get(path, actor) {
  const headers = actor ? { authorization: `Bearer ${actor}` } : {};
  const res = await fetch(`${ctx.url}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const feed = (actor, query = '') => get(`/api/activity${query}`, actor);
const pairs = (items) => items.map((item) => [item.type, item.href]);

async function fixtures(pool) {
  for (const [user, roles] of Object.entries(ACTORS)) {
    await pool.query('INSERT INTO account.users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [user, `${user}@example.com`, `Synthetic ${user.slice(-2)}`, HASH]);
    for (const role of roles) await pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1, $2)', [user, role]);
  }
  await pool.query(`INSERT INTO dispatch.services (id, code, name, price_per_ha_vnd, data_label)
    VALUES ($1, 'tillage-tractor', 'Dịch vụ giả lập', 900000, 'synthetic')`, [SERVICE]);
  await pool.query("INSERT INTO dispatch.machines (id, owner_id, name, machine_type) VALUES ($1, $2, 'Máy giả lập', 'tractor')", [MACHINE, PROVIDER]);
  await pool.query("INSERT INTO dispatch.fields (id, owner_id, name, locality, area_m2) VALUES ($1, $2, 'Ruộng giả lập', 'Demo', 10000)", [FIELD, FARMER]);
  await pool.query(`INSERT INTO dispatch.bookings (id, owner_id, field_id, service_id, state, coordinator_id, start_at, end_at,
      field_name, field_area_m2, service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd)
    VALUES ($1, $2, $3, $4, 'ASSIGNED', $5, $6, $7, 'Ruộng giả lập', 10000, 'tillage-tractor', 'Dịch vụ giả lập', 'synthetic', 900000, 900000)`,
  [BOOKING, FARMER, FIELD, SERVICE, COOP, at('08:00'), at('12:00')]);
  for (const [type, state, when] of [
    ['BOOKING_REQUESTED', 'REQUESTED', '08:00'], ['COORDINATOR_ASSIGNED', 'REQUESTED', '08:10'],
    ['BOOKING_GROUPED', 'GROUPED', '08:20'], ['BOOKING_ASSIGNED', 'ASSIGNED', '08:50'],
  ]) {
    await pool.query('INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id, created_at) VALUES ($1, $2, $3, $4, $5)',
      [BOOKING, type, state, FARMER, at(when)]);
  }

  await pool.query(`INSERT INTO dispatch.packages (id, coop_id, service_id, locality, window_start_at, window_end_at, status, provider_id, machine_id, operator_id)
    VALUES ($1, $2, $3, 'Demo', $4, $5, 'CLAIMED', $6, $7, $8)`, [PACKAGE, COOP, SERVICE, at('08:00'), at('12:00'), PROVIDER, MACHINE, OPERATOR]);
  await pool.query('INSERT INTO dispatch.package_bookings (package_id, booking_id) VALUES ($1, $2)', [PACKAGE, BOOKING]);
  const readiness = await pool.query(
    'INSERT INTO dispatch.readiness_events (booking_id, actor_id, drained, mature, intake_ready, created_at) VALUES ($1, $2, true, true, true, $3) RETURNING sequence',
    [BOOKING, FARMER, at('08:25')],
  );
  await pool.query(
    `INSERT INTO dispatch.field_inspections (booking_id, package_id, reviewer_id, result, readiness_sequence, window_start_at, window_end_at, created_at)
     VALUES ($1, $2, $3, 'PASSED', $4, $5, $6, $7)`,
    [BOOKING, PACKAGE, COOP, readiness.rows[0].sequence, at('08:00'), at('12:00'), at('08:28')],
  );
  await pool.query("INSERT INTO dispatch.shifts (id, package_id, status, started_at) VALUES ($1, $2, 'PAUSED', $3)", [SHIFT, PACKAGE, at('08:30')]);
  await pool.query(`INSERT INTO dispatch.shift_events (shift_id, event_type, from_state, to_state, actor_id, created_at)
    VALUES ($1, 'SHIFT_STARTED', NULL, 'RUNNING', $2, $3)`, [SHIFT, OPERATOR, at('08:30')]);
  await pool.query(`INSERT INTO dispatch.shift_events (shift_id, event_type, from_state, to_state, reason, actor_id, created_at)
    VALUES ($1, 'SHIFT_PAUSED', 'RUNNING', 'PAUSED', 'SECRET-PAUSE-REASON', $2, $3)`, [SHIFT, OPERATOR, at('09:00')]);

  await pool.query(`INSERT INTO dispatch.disputes (id, booking_id, claimant_id, respondent_id, reason, status)
    VALUES ($1, $2, $3, $4, 'QUALITY', 'OPEN')`, [DISPUTE, BOOKING, FARMER, PROVIDER]);
  await pool.query(`INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data, created_at)
    VALUES ($1, 'DISPUTE_OPENED', $2, $3::jsonb, $4)`,
  [DISPUTE, FARMER, JSON.stringify({ reason: 'QUALITY', details: 'SECRET-CLAIM-DETAILS' }), at('08:50')]);
  await pool.query(`INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data, created_at)
    VALUES ($1, 'RESPONSE_ADDED', $2, $3::jsonb, $4)`, [DISPUTE, PROVIDER, JSON.stringify({ text: 'SECRET-RESPONSE-TEXT' }), at('09:20')]);
  // Explicit escalation followed by mediator assignment and audit events commit together.
  // ADMIN_SEPARATE records the assignment but is neither party nor mediator, so must not see the dispute.
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      `INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data, created_at)
       VALUES ($1, 'MEDIATION_ESCALATED', $2, $3::jsonb, $4)`,
      [DISPUTE, FARMER, JSON.stringify({ reason: 'SECRET-ESCALATION-REASON', conflictType: null, previousMediatorId: null }), at('09:25')],
    );
    await tx.query(
      `UPDATE dispatch.disputes
          SET mediation_level = 'ADMIN', mediator_id = NULL, escalated_at = $2, escalated_by = $3, escalation_reason = 'SECRET-ESCALATION-REASON'
        WHERE id = $1`,
      [DISPUTE, at('09:25'), FARMER],
    );
    await tx.query('UPDATE dispatch.disputes SET mediator_id = $2 WHERE id = $1', [DISPUTE, MEDIATOR]);
    await tx.query(`INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data, created_at)
      VALUES ($1, 'MEDIATOR_ASSIGNED', $2, $3::jsonb, $4)`,
    [DISPUTE, ADMIN_SEPARATE, JSON.stringify({ mediatorId: MEDIATOR, previousMediatorId: null }), at('09:30')]);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  await pool.query('INSERT INTO dispatch.remedy_proposals (dispute_id, version, mediator_id, text) VALUES ($1, 1, $2, $3)',
    [DISPUTE, MEDIATOR, 'SECRET-REMEDY-TEXT']);
  await pool.query(`INSERT INTO dispatch.remedy_events (dispute_id, actor_id, event_type, version, details, created_at)
    VALUES ($1, $2, 'PROPOSED', 1, 'SECRET-REMEDY-DETAILS', $3)`, [DISPUTE, MEDIATOR, at('09:40')]);
  await pool.query('INSERT INTO dispatch.remedy_consents (dispute_id, version, actor_id) VALUES ($1, 1, $2)', [DISPUTE, FARMER]);
  await pool.query(`INSERT INTO dispatch.remedy_events (dispute_id, actor_id, event_type, version, created_at)
    VALUES ($1, $2, 'CONSENTED', 1, $3)`, [DISPUTE, FARMER, at('09:50')]);

  await pool.query(`INSERT INTO dispatch.jobs (id, provider_id, title, locality, capacity, start_at, end_at)
    VALUES ($1, $2, 'Tuyển giả lập', 'Demo', 2, $3, $4), ($5, $6, 'Tuyển giả lập khác', 'Demo', 2, $3, $4)`,
  [JOB, PROVIDER, at('08:00'), at('12:00'), OTHER_JOB, OTHER_PROVIDER]);
  await pool.query(`INSERT INTO dispatch.applications (id, job_id, operator_id, status) VALUES ($1, $2, $3, 'OFFERED'), ($4, $5, $6, 'WITHDRAWN')`,
    [APPLICATION, JOB, OPERATOR, OTHER_APPLICATION, OTHER_JOB, OTHER_OPERATOR]);
  await pool.query(`INSERT INTO dispatch.offers (id, application_id, job_id, operator_id, status, responded_at)
    VALUES ($1, $2, $3, $4, 'ACCEPTED', $5)`, [OFFER, APPLICATION, JOB, OPERATOR, at('08:55')]);
  // Insertion order sets sequence, which breaks ties: A2 is inserted before O1 on purpose.
  const recruitment = [
    ['job', JOB, 'job.created', PROVIDER, null, 'OPEN', '08:05'],
    ['job', OTHER_JOB, 'job.created', OTHER_PROVIDER, null, 'OPEN', '08:06'],
    ['application', APPLICATION, 'application.created', OPERATOR, null, 'APPLIED', '08:30'],
    ['application', APPLICATION, 'application.offered', PROVIDER, 'APPLIED', 'OFFERED', '08:40'],
    ['offer', OFFER, 'offer.created', PROVIDER, null, 'OFFERED', '08:40'],
    ['offer', OFFER, 'offer.accepted', OPERATOR, 'OFFERED', 'ACCEPTED', '08:55'],
    ['application', OTHER_APPLICATION, 'application.withdrawn', OTHER_OPERATOR, 'APPLIED', 'WITHDRAWN', '08:32'],
  ];
  for (const [entityType, entityId, action, actor, from, to, when] of recruitment) {
    await pool.query(`INSERT INTO dispatch.recruitment_events (entity_type, entity_id, action, actor_id, from_status, to_status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [entityType, entityId, action, actor, from, to, at(when)]);
  }
}

function listen(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(createActivityRouter({ pool, authenticate: testAuthenticate }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  app.use((error, req, res, _next) => res.status(500).json({ error: { code: 'INTERNAL_ERROR' } }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  return once(server, 'listening').then(() => `http://127.0.0.1:${server.address().port}`);
}

before(async () => {
  ctx.disposable = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  ctx.pool = createPool(ctx.disposable.url, { statementTimeout: 60000 });
  await migrate(ctx.pool);
  await fixtures(ctx.pool);
  ctx.url = await listen(ctx.pool);
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (ctx.pool) await ctx.pool.end();
  if (ctx.disposable) await ctx.disposable.drop();
});

for (const [actor, expected] of Object.entries(EXPECTED)) {
  test(`activity feed is actor-scoped for ${ACTORS[actor].join('+')} ${actor.slice(-2)}`, async () => {
    const res = await feed(actor);
    assert.equal(res.status, 200);
    assert.deepEqual(pairs(res.body.items), expected);
  });
}

test('party sees the other party response and mediator, but admin not assigned sees nothing', async () => {
  const farmer = (await feed(FARMER)).body.items.map((item) => item.type);
  assert.ok(farmer.includes('dispute.RESPONSE_ADDED'));
  assert.ok(farmer.includes('dispute.MEDIATOR_ASSIGNED'));
  assert.equal((await feed(ADMIN_SEPARATE)).body.items.length, 0);
});

test('items carry exact keys, ISO timestamps, fixed labels and stable ids', async () => {
  const seen = new Set();
  for (const actor of [FARMER, PROVIDER, OPERATOR, COOP, MEDIATOR, OTHER_PROVIDER, OTHER_OPERATOR]) {
    const res = await feed(actor);
    for (const item of res.body.items) {
      assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'href', 'id', 'text', 'type']);
      assert.match(item.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(item.text, LABEL[item.type], item.type);
      assert.match(item.id, /^[a-z]+:\d+$/);
      assert.ok(!item.text.includes('—'));
      seen.add(item.id);
    }
  }
  assert.ok(seen.size > 0);
});

test('feed never leaks private text, contact data or party names', async () => {
  for (const actor of [FARMER, PROVIDER, OPERATOR, COOP, MEDIATOR, OTHER_PROVIDER, OTHER_OPERATOR]) {
    const res = await feed(actor);
    for (const marker of LEAK_MARKERS) assert.ok(!res.text.includes(marker), `${marker} leaked`);
  }
});

test('pages the global feed in order without overlap or gaps', async () => {
  const full = await feed(FARMER);
  assert.equal(full.body.limit, 20);
  assert.equal(full.body.offset, 0);
  assert.equal(full.body.items.length, 10);
  const seen = [];
  for (const offset of [0, 4, 8]) {
    const page = await feed(FARMER, `?limit=4&offset=${offset}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.limit, 4);
    assert.equal(page.body.offset, offset);
    seen.push(...page.body.items);
  }
  assert.deepEqual(seen.map((item) => item.id), full.body.items.map((item) => item.id));
  assert.equal((await feed(FARMER, '?limit=100&offset=10000')).body.items.length, 0);
});

test('conflicted mediator is excluded from dispute and remedy activity items without pagination holes', async () => {
  const initial = await feed(MEDIATOR);
  assert.equal(initial.body.items.length, 6);
  assert.ok(initial.body.items.every((i) => i.type.startsWith('dispute.') || i.type.startsWith('remedy.')));

  await ctx.pool.query('UPDATE dispatch.packages SET operator_id = $2 WHERE id = $1', [PACKAGE, MEDIATOR]);
  try {
    const duringConflict = await feed(MEDIATOR);
    // Dispute and remedy items must be completely absent while conflicted.
    assert.ok(!duringConflict.body.items.some((i) => i.type.startsWith('dispute.') || i.type.startsWith('remedy.')));
  } finally {
    await ctx.pool.query('UPDATE dispatch.packages SET operator_id = $2 WHERE id = $1', [PACKAGE, OPERATOR]);
  }
  await ctx.pool.query("DELETE FROM account.user_roles WHERE user_id = $1 AND role = 'admin'", [MEDIATOR]);
  try {
    assert.deepEqual((await feed(MEDIATOR)).body.items, []);
  } finally {
    await ctx.pool.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [MEDIATOR]);
  }
  assert.equal((await feed(MEDIATOR)).body.items.length, 6);
});

test('rejects invalid paging with INVALID_PAGINATION', async () => {
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=-1', '?limit=abc', '?offset=-1', '?offset=10001', '?limit=1&limit=2']) {
    const res = await feed(FARMER, query);
    assert.equal(res.status, 400, query);
    assert.deepEqual(res.body, { error: { code: 'INVALID_PAGINATION' } }, query);
  }
});

test('rejects missing and unknown identities', async () => {
  assert.equal((await get('/api/activity')).status, 401);
  assert.equal((await feed(id(99))).status, 401);
});
