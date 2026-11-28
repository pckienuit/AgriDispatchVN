import express from 'express';
import { parsePagination } from './catalog.js';

// Demo capacity guard, not a labour or licensing rule. Applications never consume capacity.
export const MAX_JOB_CAPACITY = 100;
const TITLE_MAX = 120;
const LOCALITY_MAX = 200;
const NOTE_MAX = 500;
const JOB_SKILLS_MAX = 30;
const JOB_MACHINE_TYPES = ['harvester', 'tractor', 'drone'];
const JOB_WAGE_TYPES = ['PER_HA', 'PER_SHIFT', 'NEGOTIABLE'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DB_UNAVAILABLE_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH']);
const POOL_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

class ApiError extends Error {
  constructor(status, code, field) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
  }

  body() {
    return this.field ? { code: this.code, field: this.field } : { code: this.code };
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlainObject(body) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY');
  return body;
}

// Missing body is an empty action body. Anything else must be a plain object.
function optionalBody(body) {
  return body === undefined ? {} : assertPlainObject(body);
}

function assertKnownKeys(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiError(400, 'UNKNOWN_FIELD');
  }
}

function boundedText(value, field, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || [...text].length > max) throw new ApiError(400, 'VALIDATION_FAILED', field);
  return text;
}

function parseInstant(value, field) {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value)) throw new ApiError(400, 'VALIDATION_FAILED', field);
  const time = Date.parse(value);
  // Rejects calendar overflow such as 2026-02-30, which Date.parse normalises silently.
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new ApiError(400, 'VALIDATION_FAILED', field);
  }
  return new Date(time);
}

export function validateJobInput(body) {
  assertPlainObject(body);
  assertKnownKeys(body, ['title', 'locality', 'capacity', 'startAt', 'endAt', 'wageType', 'wageAmountVnd', 'machineType', 'requiredSkills']);
  const title = boundedText(body.title, 'title', TITLE_MAX);
  const locality = boundedText(body.locality, 'locality', LOCALITY_MAX);
  if (!Number.isSafeInteger(body.capacity) || body.capacity < 1 || body.capacity > MAX_JOB_CAPACITY) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'capacity');
  }
  const startAt = parseInstant(body.startAt, 'startAt');
  const endAt = parseInstant(body.endAt, 'endAt');
  if (endAt <= startAt) throw new ApiError(400, 'VALIDATION_FAILED', 'endAt');
  const wageType = body.wageType ?? null;
  if (wageType !== null && !JOB_WAGE_TYPES.includes(wageType)) throw new ApiError(400, 'VALIDATION_FAILED', 'wageType');
  const wageAmountVnd = body.wageAmountVnd ?? null;
  if (wageAmountVnd !== null && (!Number.isSafeInteger(wageAmountVnd) || wageAmountVnd < 1 || wageAmountVnd > 9007199254740991)) throw new ApiError(400, 'VALIDATION_FAILED', 'wageAmountVnd');
  if (wageAmountVnd !== null && !['PER_HA', 'PER_SHIFT'].includes(wageType)) throw new ApiError(400, 'VALIDATION_FAILED', 'wageType');
  const machineType = body.machineType ?? null;
  if (machineType !== null && !JOB_MACHINE_TYPES.includes(machineType)) throw new ApiError(400, 'VALIDATION_FAILED', 'machineType');
  const requiredSkills = body.requiredSkills ?? [];
  if (!Array.isArray(requiredSkills) || requiredSkills.length > JOB_SKILLS_MAX || requiredSkills.some((s) => typeof s !== 'string' || !s.trim() || [...s.trim()].length > 80)) throw new ApiError(400, 'VALIDATION_FAILED', 'requiredSkills');
  return { title, locality, capacity: body.capacity, startAt: startAt.toISOString(), endAt: endAt.toISOString(), wageType, wageAmountVnd, machineType, requiredSkills: [...new Set(requiredSkills.map((s) => s.trim()))] };
}

function optionalNote(body) {
  assertKnownKeys(body, ['note']);
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== 'string' || [...body.note.trim()].length > NOTE_MAX) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'note');
  }
  const text = body.note.trim();
  return text === '' ? null : text;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireUuid(value) {
  if (!isUuid(value)) throw new ApiError(400, 'INVALID_ID');
  return value;
}

function pageOf(query) {
  try {
    return parsePagination(query);
  } catch {
    throw new ApiError(400, 'INVALID_PAGINATION');
  }
}

function isDbUnavailable(error) {
  const code = typeof error.code === 'string' ? error.code : '';
  return DB_UNAVAILABLE_NODE_CODES.has(code)
    || /^08/.test(code)
    || code === '57P01'
    || code === '53300'
    || error.message === POOL_CONNECT_TIMEOUT_MESSAGE;
}

// Runs work in one transaction. Any throw rolls back, so a refused action leaves no event or row behind.
async function withTx(pool, work) {
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await work(client);
    await client.query('COMMIT');
  } catch (error) {
    // Destroy the connection if rollback itself fails, so a broken session never returns to the pool.
    await client.query('ROLLBACK').then(() => client.release(), () => client.release(true));
    throw error;
  }
  client.release();
  return result;
}

async function recordEvent(client, { entityType, entityId, action, actorId, fromStatus = null, toStatus }) {
  await client.query(
    `INSERT INTO dispatch.recruitment_events (entity_type, entity_id, action, actor_id, from_status, to_status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entityType, entityId, action, actorId, fromStatus, toStatus],
  );
}

// Lock order for every write is: job row, then application row, then offer row. Serialises capacity and close.
async function lockJob(client, jobId) {
  const { rows } = await client.query('SELECT id, status, capacity FROM dispatch.jobs WHERE id = $1 FOR UPDATE', [jobId]);
  return rows[0];
}

const JOB_COLUMNS = `j.id, j.title, j.locality, j.capacity, j.start_at, j.end_at, j.status, j.closed_at, j.created_at,
  j.wage_type, j.wage_amount_vnd, j.machine_type, j.required_skills,
  (SELECT count(*) FROM dispatch.applications a WHERE a.job_id = j.id)::int AS application_count,
  (SELECT count(*) FROM dispatch.offers o WHERE o.job_id = j.id AND o.status = 'ACCEPTED')::int AS accepted_count`;

async function loadJob(pool, jobId) {
  const { rows } = await pool.query(`SELECT ${JOB_COLUMNS} FROM dispatch.jobs j WHERE j.id = $1`, [jobId]);
  return rows[0] ? jobDto(rows[0]) : null;
}

const OFFER_COLUMNS = `o.id, o.application_id, o.job_id, o.status, o.created_at, o.responded_at,
  j.title, j.locality, j.start_at, j.end_at, j.status AS job_status`;

async function loadOffer(pool, offerId) {
  const { rows } = await pool.query(`SELECT ${OFFER_COLUMNS} FROM dispatch.offers o JOIN dispatch.jobs j ON j.id = o.job_id WHERE o.id = $1`, [offerId]);
  return offerDto(rows[0]);
}

export function createRecruitmentRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function') throw new TypeError('createRecruitmentRouter requires a pool with query()');
  if (typeof authenticate !== 'function') throw new TypeError('createRecruitmentRouter requires an authenticate middleware');

  const router = express.Router();

  // Runs after the injected authenticate middleware. Fails closed when no verified actor is attached.
  function requireRoles(...roles) {
    return (req, res, next) => {
      const actor = req.actor;
      if (!actor || !isUuid(actor.id) || !Array.isArray(actor.roles)) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
      }
      if (!actor.roles.some((role) => roles.includes(role))) {
        return res.status(403).json({ error: { code: 'FORBIDDEN' } });
      }
      return next();
    };
  }

  function handle(work) {
    return async (req, res, next) => {
      try {
        await work(req, res);
      } catch (error) {
        if (error instanceof ApiError) return res.status(error.status).json({ error: error.body() });
        if (isDbUnavailable(error)) return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
        return next(error);
      }
      return undefined;
    };
  }

  // Public job board: no applicants, no provider identity.
  router.get('/api/jobs', handle(async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    const { rows } = await pool.query(
      `SELECT ${JOB_COLUMNS} FROM dispatch.jobs j ORDER BY j.created_at DESC, j.id DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    res.json({ items: rows.map(jobDto), limit, offset });
  }));

  router.get('/api/jobs/mine', authenticate, requireRoles('provider'), handle(async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    const { rows } = await pool.query(`SELECT ${JOB_COLUMNS} FROM dispatch.jobs j WHERE j.provider_id=$1 ORDER BY j.created_at DESC,j.id DESC LIMIT $2 OFFSET $3`, [req.actor.id, limit, offset]);
    res.json({ items: rows.map(jobDto), limit, offset });
  }));

  router.get('/api/applications/mine', authenticate, requireRoles('operator'), handle(async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    const { rows } = await pool.query(`SELECT a.id,a.job_id,a.operator_id,a.note,a.status,a.created_at,j.title,j.locality,j.start_at,j.end_at,j.status AS job_status
      FROM dispatch.applications a JOIN dispatch.jobs j ON j.id=a.job_id WHERE a.operator_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3`, [req.actor.id, limit, offset]);
    res.json({ items: rows.map((row) => ({ ...applicationDto(row), job: { title: row.title, locality: row.locality, startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString(), status: row.job_status } })), limit, offset });
  }));

  router.get('/api/jobs/:id', handle(async (req, res) => {
    const job = await loadJob(pool, requireUuid(req.params.id));
    if (!job) throw new ApiError(404, 'NOT_FOUND');
    res.json({ job });
  }));

  router.post('/api/jobs', authenticate, requireRoles('provider'), handle(async (req, res) => {
    const input = validateJobInput(req.body);
    const jobId = await withTx(pool, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO dispatch.jobs (provider_id, title, locality, capacity, start_at, end_at, wage_type, wage_amount_vnd, machine_type, required_skills)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [req.actor.id, input.title, input.locality, input.capacity, input.startAt, input.endAt, input.wageType, input.wageAmountVnd, input.machineType, input.requiredSkills],
      );
      await recordEvent(client, { entityType: 'job', entityId: rows[0].id, action: 'job.created', actorId: req.actor.id, toStatus: 'OPEN' });
      return rows[0].id;
    });
    res.status(201).json({ job: await loadJob(pool, jobId) });
  }));

  router.post('/api/jobs/:id/close', authenticate, requireRoles('provider'), handle(async (req, res) => {
    const jobId = requireUuid(req.params.id);
    assertKnownKeys(optionalBody(req.body), []);
    await withTx(pool, async (client) => {
      const { rows } = await client.query('SELECT id, status FROM dispatch.jobs WHERE id = $1 AND provider_id = $2 FOR UPDATE', [jobId, req.actor.id]);
      if (!rows[0]) throw new ApiError(404, 'NOT_FOUND');
      if (rows[0].status === 'CLOSED') return;
      await client.query("UPDATE dispatch.jobs SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE id = $1", [jobId]);
      await recordEvent(client, { entityType: 'job', entityId: jobId, action: 'job.closed', actorId: req.actor.id, fromStatus: 'OPEN', toStatus: 'CLOSED' });
    });
    res.json({ job: await loadJob(pool, jobId) });
  }));

  router.post('/api/jobs/:id/applications', authenticate, requireRoles('operator'), handle(async (req, res) => {
    const jobId = requireUuid(req.params.id);
    const note = optionalNote(optionalBody(req.body));
    const applicationId = await withTx(pool, async (client) => {
      // FOR SHARE conflicts with close's FOR UPDATE, so an application cannot slip in after the job closes.
      const { rows: jobRows } = await client.query('SELECT status FROM dispatch.jobs WHERE id = $1 FOR SHARE', [jobId]);
      if (!jobRows[0]) throw new ApiError(404, 'NOT_FOUND');
      if (jobRows[0].status !== 'OPEN') throw new ApiError(409, 'JOB_CLOSED');
      let inserted;
      try {
        inserted = await client.query(
          'INSERT INTO dispatch.applications (job_id, operator_id, note) VALUES ($1, $2, $3) RETURNING id',
          [jobId, req.actor.id, note],
        );
      } catch (error) {
        if (error.code === '23505') throw new ApiError(409, 'DUPLICATE_APPLICATION');
        throw error;
      }
      await recordEvent(client, { entityType: 'application', entityId: inserted.rows[0].id, action: 'application.created', actorId: req.actor.id, toStatus: 'APPLIED' });
      return inserted.rows[0].id;
    });
    const { rows } = await pool.query(
      'SELECT id, job_id, operator_id, note, status, created_at FROM dispatch.applications WHERE id = $1',
      [applicationId],
    );
    res.status(201).json({ application: applicationDto(rows[0]) });
  }));

  router.get('/api/jobs/:id/applications', authenticate, requireRoles('provider'), handle(async (req, res) => {
    const jobId = requireUuid(req.params.id);
    const { limit, offset } = pageOf(req.query);
    const owned = await pool.query('SELECT 1 FROM dispatch.jobs WHERE id = $1 AND provider_id = $2', [jobId, req.actor.id]);
    if (!owned.rows[0]) throw new ApiError(404, 'NOT_FOUND');
    const { rows } = await pool.query(
      `SELECT a.id, a.job_id, a.operator_id, a.note, a.status, a.created_at,
              (SELECT json_build_object('id', o.id, 'status', o.status) FROM dispatch.offers o
                WHERE o.application_id = a.id AND o.status IN ('OFFERED', 'ACCEPTED') LIMIT 1) AS active_offer
         FROM dispatch.applications a WHERE a.job_id = $1
        ORDER BY a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`,
      [jobId, limit, offset],
    );
    res.json({ items: rows.map((row) => ({ ...applicationDto(row), activeOffer: row.active_offer })), limit, offset });
  }));

  router.post('/api/applications/:id/offers', authenticate, requireRoles('provider'), handle(async (req, res) => {
    const applicationId = requireUuid(req.params.id);
    assertKnownKeys(optionalBody(req.body), []);
    const result = await withTx(pool, async (client) => {
      const { rows: owned } = await client.query(
        `SELECT a.job_id FROM dispatch.applications a JOIN dispatch.jobs j ON j.id = a.job_id
          WHERE a.id = $1 AND j.provider_id = $2`,
        [applicationId, req.actor.id],
      );
      if (!owned[0]) throw new ApiError(404, 'NOT_FOUND');
      const job = await lockJob(client, owned[0].job_id);
      const { rows: appRows } = await client.query('SELECT id, job_id, operator_id, status FROM dispatch.applications WHERE id = $1 FOR UPDATE', [applicationId]);
      const application = appRows[0];
      if (job.status !== 'OPEN') throw new ApiError(409, 'JOB_CLOSED');
      if (application.status === 'WITHDRAWN') throw new ApiError(409, 'APPLICATION_WITHDRAWN');
      const { rows: live } = await client.query(
        "SELECT id FROM dispatch.offers WHERE application_id = $1 AND status IN ('OFFERED', 'ACCEPTED')",
        [applicationId],
      );
      if (live[0]) return { offerId: live[0].id, created: false };
      const { rows: inserted } = await client.query(
        'INSERT INTO dispatch.offers (application_id, job_id, operator_id) VALUES ($1, $2, $3) RETURNING id',
        [applicationId, application.job_id, application.operator_id],
      );
      await client.query("UPDATE dispatch.applications SET status = 'OFFERED', updated_at = now() WHERE id = $1", [applicationId]);
      await recordEvent(client, { entityType: 'offer', entityId: inserted[0].id, action: 'offer.created', actorId: req.actor.id, toStatus: 'OFFERED' });
      await recordEvent(client, { entityType: 'application', entityId: applicationId, action: 'application.offered', actorId: req.actor.id, fromStatus: application.status, toStatus: 'OFFERED' });
      return { offerId: inserted[0].id, created: true };
    });
    const offer = await loadOffer(pool, result.offerId);
    res.status(result.created ? 201 : 200).json({ offer });
  }));

  router.post('/api/applications/:id/withdraw', authenticate, requireRoles('operator'), handle(async (req, res) => {
    const applicationId = requireUuid(req.params.id);
    assertKnownKeys(optionalBody(req.body), []);
    await withTx(pool, async (client) => {
      const { rows: owned } = await client.query('SELECT job_id FROM dispatch.applications WHERE id = $1 AND operator_id = $2', [applicationId, req.actor.id]);
      if (!owned[0]) throw new ApiError(404, 'NOT_FOUND');
      await lockJob(client, owned[0].job_id);
      const { rows } = await client.query('SELECT id, status FROM dispatch.applications WHERE id = $1 AND operator_id = $2 FOR UPDATE', [applicationId, req.actor.id]);
      const application = rows[0];
      if (!application) throw new ApiError(404, 'NOT_FOUND');
      if (application.status === 'WITHDRAWN') return;
      const { rows: accepted } = await client.query("SELECT id FROM dispatch.offers WHERE application_id = $1 AND status = 'ACCEPTED'", [applicationId]);
      // Accepted slot is a commitment; undoing it needs an explicit dispute or provider action, not a silent withdraw.
      if (accepted[0]) throw new ApiError(409, 'OFFER_ACCEPTED');
      await client.query("UPDATE dispatch.applications SET status = 'WITHDRAWN', updated_at = now() WHERE id = $1", [applicationId]);
      await recordEvent(client, { entityType: 'application', entityId: applicationId, action: 'application.withdrawn', actorId: req.actor.id, fromStatus: application.status, toStatus: 'WITHDRAWN' });
      const { rows: withdrawn } = await client.query(
        "UPDATE dispatch.offers SET status = 'WITHDRAWN', responded_at = now(), updated_at = now() WHERE application_id = $1 AND status = 'OFFERED' RETURNING id",
        [applicationId],
      );
      for (const row of withdrawn) {
        await recordEvent(client, { entityType: 'offer', entityId: row.id, action: 'offer.withdrawn', actorId: req.actor.id, fromStatus: 'OFFERED', toStatus: 'WITHDRAWN' });
      }
    });
    const { rows } = await pool.query('SELECT id, job_id, operator_id, note, status, created_at FROM dispatch.applications WHERE id = $1', [applicationId]);
    res.json({ application: applicationDto(rows[0]) });
  }));

  router.get('/api/offers', authenticate, requireRoles('operator'), handle(async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    const { rows } = await pool.query(
      `SELECT ${OFFER_COLUMNS} FROM dispatch.offers o JOIN dispatch.jobs j ON j.id = o.job_id
        WHERE o.operator_id = $1 ORDER BY o.created_at DESC, o.id DESC LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.json({ items: rows.map(offerDto), limit, offset });
  }));

  router.post('/api/offers/:id/accept', authenticate, requireRoles('operator'), handle(async (req, res) => {
    const offerId = requireUuid(req.params.id);
    assertKnownKeys(optionalBody(req.body), []);
    await withTx(pool, async (client) => {
      const { rows: owned } = await client.query('SELECT job_id FROM dispatch.offers WHERE id = $1 AND operator_id = $2', [offerId, req.actor.id]);
      if (!owned[0]) throw new ApiError(404, 'NOT_FOUND');
      // Job lock first: concurrent accepts and close on this job queue here, so the capacity count below is exact.
      const job = await lockJob(client, owned[0].job_id);
      const { rows } = await client.query('SELECT id, status FROM dispatch.offers WHERE id = $1 AND operator_id = $2 FOR UPDATE', [offerId, req.actor.id]);
      const offer = rows[0];
      if (!offer) throw new ApiError(404, 'NOT_FOUND');
      // Repeat accept returns success without taking a second slot, even when the job is now full or closed.
      if (offer.status === 'ACCEPTED') return;
      if (offer.status === 'DECLINED') throw new ApiError(409, 'OFFER_DECLINED');
      if (offer.status === 'WITHDRAWN') throw new ApiError(409, 'OFFER_WITHDRAWN');
      if (job.status !== 'OPEN') throw new ApiError(409, 'JOB_CLOSED');
      const { rows: [{ n }] } = await client.query("SELECT count(*)::int AS n FROM dispatch.offers WHERE job_id = $1 AND status = 'ACCEPTED'", [job.id]);
      if (n >= job.capacity) throw new ApiError(409, 'CAPACITY_FULL');
      await client.query("UPDATE dispatch.offers SET status = 'ACCEPTED', responded_at = now(), updated_at = now() WHERE id = $1", [offerId]);
      await recordEvent(client, { entityType: 'offer', entityId: offerId, action: 'offer.accepted', actorId: req.actor.id, fromStatus: 'OFFERED', toStatus: 'ACCEPTED' });
    });
    res.json({ offer: await loadOffer(pool, offerId) });
  }));

  router.post('/api/offers/:id/decline', authenticate, requireRoles('operator'), handle(async (req, res) => {
    const offerId = requireUuid(req.params.id);
    assertKnownKeys(optionalBody(req.body), []);
    await withTx(pool, async (client) => {
      const { rows: owned } = await client.query('SELECT job_id FROM dispatch.offers WHERE id = $1 AND operator_id = $2', [offerId, req.actor.id]);
      if (!owned[0]) throw new ApiError(404, 'NOT_FOUND');
      await lockJob(client, owned[0].job_id);
      const { rows } = await client.query('SELECT id, application_id, status FROM dispatch.offers WHERE id = $1 AND operator_id = $2 FOR UPDATE', [offerId, req.actor.id]);
      const offer = rows[0];
      if (!offer) throw new ApiError(404, 'NOT_FOUND');
      if (offer.status === 'DECLINED') return;
      if (offer.status === 'ACCEPTED') throw new ApiError(409, 'OFFER_ACCEPTED');
      if (offer.status === 'WITHDRAWN') throw new ApiError(409, 'OFFER_WITHDRAWN');
      await client.query("UPDATE dispatch.offers SET status = 'DECLINED', responded_at = now(), updated_at = now() WHERE id = $1", [offerId]);
      await client.query("UPDATE dispatch.applications SET status = 'APPLIED', updated_at = now() WHERE id = $1 AND status = 'OFFERED'", [offer.application_id]);
      await recordEvent(client, { entityType: 'offer', entityId: offerId, action: 'offer.declined', actorId: req.actor.id, fromStatus: 'OFFERED', toStatus: 'DECLINED' });
      await recordEvent(client, { entityType: 'application', entityId: offer.application_id, action: 'application.offer_declined', actorId: req.actor.id, fromStatus: 'OFFERED', toStatus: 'APPLIED' });
    });
    res.json({ offer: await loadOffer(pool, offerId) });
  }));

  return router;
}

function jobDto(row) {
  return {
    id: row.id,
    title: row.title,
    locality: row.locality,
    capacity: row.capacity,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    status: row.status,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    applicationCount: row.application_count,
    acceptedCount: row.accepted_count,
    wageType: row.wage_type ?? null,
    wageAmountVnd: row.wage_amount_vnd === null || row.wage_amount_vnd === undefined ? null : String(row.wage_amount_vnd),
    machineType: row.machine_type ?? null,
    requiredSkills: row.required_skills ?? [],
  };
}

function applicationDto(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    operatorId: row.operator_id,
    note: row.note,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function offerDto(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    jobId: row.job_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
    job: {
      title: row.title,
      locality: row.locality,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at.toISOString(),
      status: row.job_status,
    },
  };
}
