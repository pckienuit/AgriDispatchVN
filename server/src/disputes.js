import express from 'express';
import { parsePagination } from './catalog.js';

// G8a: booking disputes, append-only party responses, and independent mediator assignment.
// A dispute records a claim between the booking owner and the assigned provider. It is not an arbitration decision.
// No remedy, refund, debt, settlement, consent or timeout closure here. Those belong to G8b.
// Evidence references are deferred to G9. Arbitrary URLs and fake uploads are refused.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['AREA_MISMATCH', 'QUALITY', 'NO_SHOW', 'PAYMENT', 'OTHER'];
const MAX_TEXT = 2000;
const OPEN_ROLES = ['farmer', 'provider', 'coop'];
const RESPOND_ROLES = ['farmer', 'provider'];
const DB_UNAVAILABLE_CODE = /^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/;
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';

// Parent slice (G8b, acceptance writes) uses this check to refuse proposals, consents and payments while a case is OPEN.
export const OPEN_DISPUTE_EXISTS_SQL = "SELECT 1 FROM dispatch.disputes WHERE booking_id = $1 AND status = 'OPEN' LIMIT 1";

export async function hasOpenDispute(db, bookingId) {
  const { rowCount } = await db.query(OPEN_DISPUTE_EXISTS_SQL, [bookingId]);
  return rowCount > 0;
}

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code) => new ApiError(status, code);

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function identifier(value) {
  if (!isUuid(value)) throw fail(400, 'INVALID_ID');
  return value.toLowerCase();
}

function plainBody(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_BODY');
  if (Object.keys(input).some((key) => !keys.includes(key))) throw fail(400, 'UNKNOWN_FIELD');
  return input;
}

// Length counts code points, matching PostgreSQL char_length in the trigger.
function boundedText(value) {
  if (typeof value !== 'string') throw fail(400, 'VALIDATION_FAILED');
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > MAX_TEXT) throw fail(400, 'VALIDATION_FAILED');
  return trimmed;
}

export function validateOpenInput(body) {
  const input = plainBody(body, ['reason', 'details']);
  if (!REASONS.includes(input.reason)) throw fail(400, 'VALIDATION_FAILED');
  return { reason: input.reason, details: boundedText(input.details) };
}

export function validateResponseInput(body) {
  const input = plainBody(body, ['text']);
  return { text: boundedText(input.text) };
}

export function validateMediatorInput(body) {
  const input = plainBody(body, ['mediatorId']);
  if (!isUuid(input.mediatorId)) throw fail(400, 'VALIDATION_FAILED');
  return input.mediatorId.toLowerCase();
}

function isDbUnavailable(error) {
  return DB_UNAVAILABLE_CODE.test(typeof error.code === 'string' ? error.code : '');
}

// A failed COMMIT or ROLLBACK destroys the connection so no partial write survives.
async function transaction(pool, work) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

const DISPUTE_COLUMNS = 'id, booking_id, claimant_id, respondent_id, reason, status, mediator_id, created_at';

function disputeDto(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    claimantId: row.claimant_id,
    respondentId: row.respondent_id,
    reason: row.reason,
    status: row.status,
    mediatorId: row.mediator_id,
    createdAt: row.created_at.toISOString(),
  };
}

function eventDto(row) {
  return {
    sequence: Number(row.sequence),
    type: row.event_type,
    actorId: row.actor_id,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  };
}

// Booking scope for opening: owner or claimed provider. Missing and foreign bookings both return 404.
// Locks the booking row so concurrent opens on one booking serialize.
async function lockOpeningParty(client, bookingId, actorId) {
  const { rows } = await client.query(
    `SELECT b.owner_id, b.state, pk.provider_id
       FROM dispatch.bookings b
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       LEFT JOIN dispatch.packages pk ON pk.id = pb.package_id
      WHERE b.id = $1 AND (b.owner_id = $2 OR pk.provider_id = $2) FOR UPDATE OF b`,
    [bookingId, actorId],
  );
  if (!rows[0]) throw fail(404, 'NOT_FOUND');
  return rows[0];
}

async function openDispute(pool, actor, bookingId, input) {
  return transaction(pool, async (client) => {
    const party = await lockOpeningParty(client, bookingId, actor.id);
    if (party.provider_id && party.provider_id === party.owner_id) throw fail(409, 'PARTY_CONFLICT');
    if (party.state !== 'ASSIGNED' || !party.provider_id) throw fail(409, 'BOOKING_UNAVAILABLE');
    const respondentId = party.owner_id === actor.id ? party.provider_id : party.owner_id;
    const respondentRole = await client.query(
      "SELECT 1 FROM account.user_roles WHERE user_id = $1 AND role IN ('farmer', 'provider')",
      [respondentId],
    );
    if (!respondentRole.rowCount) throw fail(409, 'RESPONDENT_ROLE_MISSING');
    const existing = await client.query("SELECT 1 FROM dispatch.disputes WHERE booking_id = $1 AND status = 'OPEN'", [bookingId]);
    if (existing.rowCount) throw fail(409, 'DISPUTE_OPEN');
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO dispatch.disputes (booking_id, claimant_id, respondent_id, reason, status)
         VALUES ($1, $2, $3, $4, 'OPEN') RETURNING ${DISPUTE_COLUMNS}`,
        [bookingId, actor.id, respondentId, input.reason],
      );
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION) throw fail(409, 'DISPUTE_OPEN');
      throw error;
    }
    const row = inserted.rows[0];
    await client.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'DISPUTE_OPENED', $2, $3::jsonb)",
      [row.id, actor.id, JSON.stringify({ reason: input.reason, details: input.details })],
    );
    return { status: 201, body: { dispute: disputeDto(row) } };
  });
}

// Lock the dispute row so a concurrent response or reassignment serializes against this one.
async function lockDispute(client, disputeId) {
  const { rows } = await client.query(`SELECT ${DISPUTE_COLUMNS} FROM dispatch.disputes WHERE id = $1 FOR UPDATE`, [disputeId]);
  if (!rows[0]) throw fail(404, 'NOT_FOUND');
  return rows[0];
}

async function respondToDispute(pool, actor, disputeId, input) {
  return transaction(pool, async (client) => {
    const dispute = await lockDispute(client, disputeId);
    if (actor.id !== dispute.claimant_id && actor.id !== dispute.respondent_id) throw fail(404, 'NOT_FOUND');
    // The claimant cannot answer its own claim. Only the respondent party may append a response.
    if (actor.id !== dispute.respondent_id) throw fail(403, 'FORBIDDEN');
    if (dispute.status !== 'OPEN') throw fail(409, 'DISPUTE_NOT_OPEN');
    const { rows } = await client.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'RESPONSE_ADDED', $2, $3::jsonb) RETURNING sequence, event_type, actor_id, data, created_at",
      [disputeId, actor.id, JSON.stringify({ text: input.text })],
    );
    return { status: 201, body: { event: eventDto(rows[0]) } };
  });
}

// Recusal: a party (owner, coordinator, coop, provider, operator, claimant, respondent) cannot act as mediator here.
// Targets must hold admin role and must not be a party. Current actor involved gets RECUSAL_REQUIRED.
async function assignMediator(pool, actor, disputeId, mediatorId) {
  return transaction(pool, async (client) => {
    const dispute = await lockDispute(client, disputeId);
    if (dispute.status !== 'OPEN') throw fail(409, 'DISPUTE_NOT_OPEN');
    const { rows } = await client.query(
      `SELECT bk.owner_id, bk.coordinator_id, pk.coop_id, pk.provider_id, pk.operator_id
         FROM dispatch.bookings bk
         LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = bk.id
         LEFT JOIN dispatch.packages pk ON pk.id = pb.package_id
        WHERE bk.id = $1`,
      [dispute.booking_id],
    );
    const involved = new Set([dispute.claimant_id, dispute.respondent_id, ...Object.values(rows[0] ?? {})].filter(Boolean));
    if (involved.has(actor.id)) throw fail(403, 'RECUSAL_REQUIRED');
    const admin = await client.query("SELECT 1 FROM account.user_roles WHERE user_id = $1 AND role = 'admin'", [mediatorId]);
    if (!admin.rowCount) throw fail(400, 'INVALID_MEDIATOR');
    if (involved.has(mediatorId)) throw fail(409, 'PARTY_CONFLICT');
    const updated = await client.query(
      `UPDATE dispatch.disputes SET mediator_id = $2 WHERE id = $1 RETURNING ${DISPUTE_COLUMNS}`,
      [disputeId, mediatorId],
    );
    await client.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATOR_ASSIGNED', $2, $3::jsonb)",
      [disputeId, actor.id, JSON.stringify({ mediatorId, previousMediatorId: dispute.mediator_id })],
    );
    return { status: 200, body: { dispute: disputeDto(updated.rows[0]) } };
  });
}

// catalog.js throws its own error class for bad paging. Re-map it so the router answers 400, not 500.
function listWindow(query) {
  try {
    return parsePagination(query);
  } catch (error) {
    throw fail(error.status, error.code);
  }
}

// Visibility: claimant, respondent or assigned mediator. Anyone else, including coops and admins, gets 404.
const VISIBLE = 'claimant_id = $1 OR respondent_id = $1 OR mediator_id = $1';

async function listDisputes(pool, actor, query) {
  const { limit, offset } = listWindow(query);
  const { rows } = await pool.query(
    `SELECT ${DISPUTE_COLUMNS} FROM dispatch.disputes WHERE ${VISIBLE}
      ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [actor.id, limit, offset],
  );
  return { status: 200, body: { items: rows.map(disputeDto), limit, offset } };
}

async function readDispute(pool, actor, disputeId) {
  const { rows } = await pool.query(`SELECT ${DISPUTE_COLUMNS} FROM dispatch.disputes WHERE id = $2 AND (${VISIBLE})`, [actor.id, disputeId]);
  if (!rows[0]) throw fail(404, 'NOT_FOUND');
  const events = await pool.query(
    'SELECT sequence, event_type, actor_id, data, created_at FROM dispatch.dispute_events WHERE dispute_id = $1 ORDER BY sequence',
    [disputeId],
  );
  return { status: 200, body: { dispute: disputeDto(rows[0]), events: events.rows.map(eventDto) } };
}

export function createDisputeRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') {
    throw new TypeError('createDisputeRouter requires a pool with query() and connect()');
  }
  if (typeof authenticate !== 'function') throw new TypeError('createDisputeRouter requires an authenticate middleware');

  const router = express.Router();

  // Runs after the injected authenticate middleware. Fails closed when no verified actor is attached.
  function handle(roles, work) {
    return async (req, res, next) => {
      try {
        const actor = req.actor;
        if (!actor || !isUuid(actor.id) || !Array.isArray(actor.roles)) throw fail(401, 'UNAUTHENTICATED');
        if (roles && !actor.roles.some((role) => roles.includes(role))) throw fail(403, 'FORBIDDEN');
        const { status = 200, body } = await work(req);
        return res.status(status).json(body);
      } catch (error) {
        if (error instanceof ApiError) return res.status(error.status).json({ error: { code: error.code } });
        if (error.code === RESTRICT_VIOLATION) return res.status(409).json({ error: { code: 'STATE_CHANGED' } });
        if (isDbUnavailable(error)) return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
        return next(error);
      }
    };
  }

  router.post('/api/bookings/:id/disputes', authenticate, handle(OPEN_ROLES, async (req) => {
    const bookingId = identifier(req.params.id);
    const input = validateOpenInput(req.body);
    return openDispute(pool, req.actor, bookingId, input);
  }));

  router.get('/api/disputes', authenticate, handle(null, async (req) => listDisputes(pool, req.actor, req.query)));

  router.get('/api/disputes/:id', authenticate, handle(null, async (req) => {
    return readDispute(pool, req.actor, identifier(req.params.id));
  }));

  router.post('/api/disputes/:id/responses', authenticate, handle(RESPOND_ROLES, async (req) => {
    const disputeId = identifier(req.params.id);
    const input = validateResponseInput(req.body);
    return respondToDispute(pool, req.actor, disputeId, input);
  }));

  router.post('/api/disputes/:id/mediator', authenticate, handle(['admin'], async (req) => {
    const disputeId = identifier(req.params.id);
    const mediatorId = validateMediatorInput(req.body);
    return assignMediator(pool, req.actor, disputeId, mediatorId);
  }));

  return router;
}
