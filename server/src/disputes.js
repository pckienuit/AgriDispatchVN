import express from 'express';
import { parsePagination } from './catalog.js';

// Booking disputes, append-only party responses, HTX first-level mediation (H-08),
// independent admin escalation, and mediator assignment.
// Negotiated remedies never execute refunds, debt, or money transfers here.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['AREA_MISMATCH', 'QUALITY', 'NO_SHOW', 'PAYMENT', 'OTHER'];
export const CONFLICT_TYPES = [
  'PARTY_CONFLICT',
  'ROLE_OVERLAP',
  'MACHINE_CONFLICT',
  'AFFILIATION_CONFLICT',
  'RECUSAL_REQUEST',
  'PARTY_REQUEST',
];
const MAX_TEXT = 2000;
const OPEN_ROLES = ['farmer', 'provider', 'coop'];
const RESPOND_ROLES = ['farmer', 'provider', 'coop'];
const DB_UNAVAILABLE_CODE = /^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/;
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';

// Parent slice (G8b, acceptance writes) uses this check to refuse proposals, consents and payments while a case is OPEN.
export const OPEN_DISPUTE_EXISTS_SQL = "SELECT 1 FROM dispatch.disputes WHERE booking_id = $1 AND status IN ('OPEN', 'CLOSED_UNRESOLVED') LIMIT 1";

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
  if (!trimmed || [...trimmed].length > MAX_TEXT || trimmed.includes('\0')) throw fail(400, 'VALIDATION_FAILED');
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

export function validateHtxMediatorInput(body) {
  if (body === undefined) return null;
  const input = plainBody(body, ['mediatorId']);
  if (input.mediatorId === undefined) return null;
  if (!isUuid(input.mediatorId)) throw fail(400, 'VALIDATION_FAILED');
  return input.mediatorId.toLowerCase();
}

export function validateEscalateInput(body) {
  const input = plainBody(body, ['reason', 'conflictType']);
  const reason = boundedText(input.reason);
  let conflictType = null;
  if (input.conflictType !== undefined) {
    if (typeof input.conflictType !== 'string' || !CONFLICT_TYPES.includes(input.conflictType)) {
      throw fail(400, 'VALIDATION_FAILED');
    }
    conflictType = input.conflictType;
  }
  return { reason, conflictType };
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

const DISPUTE_COLUMNS = 'id, booking_id, claimant_id, respondent_id, reason, status, mediator_id, mediation_level, escalated_at, escalated_by, escalation_reason, escalation_conflict_type, created_at';

function disputeDto(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    claimantId: row.claimant_id,
    respondentId: row.respondent_id,
    reason: row.reason,
    status: row.status,
    mediatorId: row.mediator_id,
    mediationLevel: row.mediation_level ?? 'HTX',
    escalatedAt: row.escalated_at ? row.escalated_at.toISOString() : null,
    escalatedBy: row.escalated_by ?? null,
    escalationReason: row.escalation_reason ?? null,
    escalationConflictType: row.escalation_conflict_type ?? null,
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

function escalationDto(row) {
  return {
    sequence: Number(row.sequence),
    actorId: row.actor_id,
    reason: row.data.reason,
    conflictType: row.data.conflictType ?? null,
    previousMediatorId: row.data.previousMediatorId ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

async function caseParticipants(db, bookingId) {
  const { rows } = await db.query(
    `SELECT bk.owner_id, bk.coordinator_id, pk.coop_id, pk.provider_id, pk.operator_id
       FROM dispatch.bookings bk
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = bk.id
       LEFT JOIN dispatch.packages pk ON pk.id = pb.package_id
      WHERE bk.id = $1`,
    [bookingId],
  );
  return rows[0] ?? {};
}

export async function assessHtxEligibility(db, dispute, candidateId) {
  const rolesRes = await db.query('SELECT role FROM account.user_roles WHERE user_id = $1', [candidateId]);
  const roles = new Set(rolesRes.rows.map((r) => r.role));
  if (!roles.has('coop')) return { eligible: false, related: false, conflictCode: 'INVALID_MEDIATOR' };

  const p = await caseParticipants(db, dispute.booking_id);
  const related = candidateId === p.coordinator_id || candidateId === p.coop_id;
  if (!related) return { eligible: false, related: false, conflictCode: 'HTX_NOT_RELATED' };

  const parties = new Set([dispute.claimant_id, dispute.respondent_id, p.owner_id, p.provider_id, p.operator_id].filter(Boolean));
  if (parties.has(candidateId)) return { eligible: false, related: true, conflictCode: 'PARTY_CONFLICT' };

  if (roles.has('provider') || roles.has('operator') || roles.has('admin')) {
    return { eligible: false, related: true, conflictCode: 'ROLE_OVERLAP' };
  }

  const ownedMachine = await db.query('SELECT 1 FROM dispatch.machines WHERE owner_id = $1 LIMIT 1', [candidateId]);
  if (ownedMachine.rowCount) return { eligible: false, related: true, conflictCode: 'MACHINE_CONFLICT' };

  return { eligible: true, related: true, conflictCode: null };
}

// Single source of truth for active mediator eligibility & independence across disputes, remedies, and evidence.
export async function isActiveMediatorIndependent(db, dispute, actorId) {
  if (!dispute.mediator_id || actorId !== dispute.mediator_id) return false;
  if (dispute.mediation_level === 'HTX') {
    const check = await assessHtxEligibility(db, dispute, actorId);
    return check.eligible;
  }
  const valid = await db.query(
    `SELECT 1 FROM account.user_roles r WHERE r.user_id = $1 AND r.role = 'admin'
      AND $1 NOT IN ($2::uuid, $3::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM dispatch.bookings b
          LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
          LEFT JOIN dispatch.packages p ON p.id = pb.package_id
         WHERE b.id = $4
           AND $1 IN (b.owner_id, b.coordinator_id, p.coop_id, p.provider_id, p.operator_id)
      )`,
    [actorId, dispute.claimant_id, dispute.respondent_id, dispute.booking_id],
  );
  return valid.rowCount > 0;
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
      "SELECT 1 FROM account.user_roles WHERE user_id = $1 AND role IN ('farmer', 'provider', 'coop')",
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

// Lock the dispute row so a concurrent response, assignment, or escalation serializes cleanly.
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

async function lastAssignedMediatorId(client, disputeId) {
  const { rows } = await client.query(
    `SELECT data->>'mediatorId' AS mediator_id FROM dispatch.dispute_events
      WHERE dispute_id = $1 AND event_type = 'MEDIATOR_ASSIGNED'
      ORDER BY sequence DESC LIMIT 1`,
    [disputeId],
  );
  return rows[0]?.mediator_id ?? null;
}

// Recusal: a party (owner, coordinator, coop, provider, operator, claimant, respondent) cannot act as admin mediator.
// HTX disputes (assigned or unassigned) must be explicitly escalated before an admin mediator can take over.
async function assignMediator(pool, actor, disputeId, mediatorId) {
  return transaction(pool, async (client) => {
    const dispute = await lockDispute(client, disputeId);
    if (dispute.status !== 'OPEN') throw fail(409, 'DISPUTE_NOT_OPEN');
    const participants = await caseParticipants(client, dispute.booking_id);
    const involved = new Set([dispute.claimant_id, dispute.respondent_id, ...Object.values(participants)].filter(Boolean));
    if (involved.has(actor.id)) throw fail(403, 'RECUSAL_REQUIRED');
    if (dispute.mediation_level !== 'ADMIN') throw fail(409, 'ESCALATION_REQUIRED');
    const admin = await client.query("SELECT 1 FROM account.user_roles WHERE user_id = $1 AND role = 'admin'", [mediatorId]);
    if (!admin.rowCount) throw fail(400, 'INVALID_MEDIATOR');
    if (involved.has(mediatorId)) throw fail(409, 'PARTY_CONFLICT');
    const previousMediatorId = await lastAssignedMediatorId(client, disputeId);
    const updated = await client.query(
      `UPDATE dispatch.disputes SET mediator_id = $2 WHERE id = $1 RETURNING ${DISPUTE_COLUMNS}`,
      [disputeId, mediatorId],
    );
    await client.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATOR_ASSIGNED', $2, $3::jsonb)",
      [disputeId, actor.id, JSON.stringify({ mediatorId, previousMediatorId })],
    );
    return { status: 200, body: { dispute: disputeDto(updated.rows[0]) } };
  });
}

async function assignHtxMediator(pool, actor, disputeId, requestedMediatorId) {
  const isAdmin = actor.roles.includes('admin');
  const isCoop = actor.roles.includes('coop');
  if (requestedMediatorId === null && !isCoop) throw fail(400, 'VALIDATION_FAILED');
  const targetId = requestedMediatorId ?? actor.id;
  if (!isAdmin && targetId !== actor.id) throw fail(403, 'FORBIDDEN');

  return transaction(pool, async (client) => {
    const dispute = await lockDispute(client, disputeId);
    const elig = await assessHtxEligibility(client, dispute, targetId);
    if (targetId === actor.id && !elig.related) throw fail(404, 'NOT_FOUND');

    if (dispute.status !== 'OPEN') throw fail(409, 'DISPUTE_NOT_OPEN');
    if (dispute.mediation_level !== 'HTX') throw fail(409, 'ESCALATED_TO_ADMIN');

    if (isAdmin && targetId !== actor.id) {
      const participants = await caseParticipants(client, dispute.booking_id);
      const involved = new Set([dispute.claimant_id, dispute.respondent_id, ...Object.values(participants)].filter(Boolean));
      if (involved.has(actor.id)) throw fail(403, 'RECUSAL_REQUIRED');
    }

    if (!elig.eligible) {
      if (elig.conflictCode === 'INVALID_MEDIATOR') throw fail(400, 'INVALID_MEDIATOR');
      if (elig.conflictCode === 'HTX_NOT_RELATED') throw fail(409, 'HTX_NOT_RELATED');
      if (targetId === actor.id) throw fail(403, 'RECUSAL_REQUIRED');
      throw fail(409, elig.conflictCode);
    }

    if (dispute.mediator_id === targetId) {
      return { status: 200, body: { dispute: disputeDto(dispute) } };
    }
    if (dispute.mediator_id !== null) throw fail(409, 'STATE_CHANGED');

    const updated = await client.query(
      `UPDATE dispatch.disputes SET mediator_id = $2 WHERE id = $1 RETURNING ${DISPUTE_COLUMNS}`,
      [disputeId, targetId],
    );
    await client.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATOR_ASSIGNED', $2, $3::jsonb)",
      [disputeId, actor.id, JSON.stringify({ mediatorId: targetId, previousMediatorId: null })],
    );
    return { status: 200, body: { dispute: disputeDto(updated.rows[0]) } };
  });
}

async function escalateDispute(pool, actor, disputeId, input) {
  return transaction(pool, async (client) => {
    const dispute = await lockDispute(client, disputeId);
    const p = await caseParticipants(client, dispute.booking_id);
    const isParty = [dispute.claimant_id, dispute.respondent_id].includes(actor.id)
      && actor.roles.some((role) => OPEN_ROLES.includes(role));
    const isHtx = actor.roles.includes('coop') && (
      [p.coordinator_id, p.coop_id].includes(actor.id)
      || (dispute.mediation_level === 'HTX' && actor.id === dispute.mediator_id)
    );
    const involved = new Set([
      dispute.claimant_id,
      dispute.respondent_id,
      p.owner_id,
      p.coordinator_id,
      p.coop_id,
      p.provider_id,
      p.operator_id,
    ].filter(Boolean));
    const isIndependentAdmin = actor.roles.includes('admin') && !involved.has(actor.id);
    if (!isParty && !isHtx && !isIndependentAdmin) throw fail(404, 'NOT_FOUND');

    if (dispute.status !== 'OPEN') throw fail(409, 'DISPUTE_NOT_OPEN');
    if (dispute.mediation_level !== 'HTX') throw fail(409, 'ALREADY_ESCALATED');

    const previousMediatorId = dispute.mediator_id;
    await client.query(
      "INSERT INTO dispatch.dispute_events (dispute_id, event_type, actor_id, data) VALUES ($1, 'MEDIATION_ESCALATED', $2, $3::jsonb)",
      [disputeId, actor.id, JSON.stringify({
        reason: input.reason,
        conflictType: input.conflictType,
        previousMediatorId,
      })],
    );
    const updated = await client.query(
      `UPDATE dispatch.disputes
          SET mediation_level = 'ADMIN',
              mediator_id = NULL,
              escalated_at = clock_timestamp(),
              escalated_by = $2,
              escalation_reason = $3,
              escalation_conflict_type = $4
        WHERE id = $1 RETURNING ${DISPUTE_COLUMNS}`,
      [disputeId, actor.id, input.reason, input.conflictType],
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

// Personal lists stay party/conflict-free-mediator scoped; eligible OPEN triage is a separate admin queue.
export const DISPUTE_PERSONAL_SCOPE_SQL = `(
  $1::uuid IN (d.claimant_id, d.respondent_id)
  OR (
    d.mediator_id = $1::uuid
    AND (
      (
        d.mediation_level = 'ADMIN'
        AND EXISTS (SELECT 1 FROM account.user_roles r WHERE r.user_id = $1::uuid AND r.role = 'admin')
        AND NOT EXISTS (
          SELECT 1 FROM dispatch.bookings b
            LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
            LEFT JOIN dispatch.packages p ON p.id = pb.package_id
           WHERE b.id = d.booking_id
             AND $1::uuid IN (b.owner_id, b.coordinator_id, p.coop_id, p.provider_id, p.operator_id)
        )
      )
      OR (
        d.mediation_level = 'HTX'
        AND EXISTS (SELECT 1 FROM account.user_roles r WHERE r.user_id = $1::uuid AND r.role = 'coop')
        AND NOT EXISTS (SELECT 1 FROM account.user_roles r WHERE r.user_id = $1::uuid AND r.role IN ('provider', 'operator', 'admin'))
        AND NOT EXISTS (SELECT 1 FROM dispatch.machines m WHERE m.owner_id = $1::uuid)
        AND EXISTS (
          SELECT 1 FROM dispatch.bookings b
            LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
            LEFT JOIN dispatch.packages p ON p.id = pb.package_id
           WHERE b.id = d.booking_id
             AND $1::uuid IN (b.coordinator_id, p.coop_id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM dispatch.bookings b
            LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
            LEFT JOIN dispatch.packages p ON p.id = pb.package_id
           WHERE b.id = d.booking_id
             AND $1::uuid IN (b.owner_id, p.provider_id, p.operator_id)
        )
      )
    )
  )
)`;

// A current uninvolved admin may triage OPEN cases; this is not mediator authority.
export const DISPUTE_REVIEW_ELIGIBLE_SQL = `d.status='OPEN'
  AND EXISTS (SELECT 1 FROM account.user_roles r WHERE r.user_id=$1 AND r.role='admin')
  AND $1 NOT IN (d.claimant_id,d.respondent_id)
  AND NOT EXISTS (SELECT 1 FROM dispatch.bookings b
    LEFT JOIN dispatch.package_bookings pb ON pb.booking_id=b.id
    LEFT JOIN dispatch.packages p ON p.id=pb.package_id
    WHERE b.id=d.booking_id AND $1 IN (b.owner_id,b.coordinator_id,p.coop_id,p.provider_id,p.operator_id))`;

export async function canReviewDispute(db, actor, disputeId) {
  if (!actor.roles.includes('admin')) return false;
  const result = await db.query(`SELECT 1 FROM dispatch.disputes d WHERE d.id=$2 AND ${DISPUTE_REVIEW_ELIGIBLE_SQL}`, [actor.id, disputeId]);
  return result.rowCount > 0;
}

async function listDisputes(pool, actor, query) {
  const { limit, offset } = listWindow(query);
  const { rows } = await pool.query(
    `SELECT ${DISPUTE_COLUMNS} FROM dispatch.disputes d WHERE ${DISPUTE_PERSONAL_SCOPE_SQL}
      ORDER BY d.created_at DESC, d.id DESC LIMIT $2 OFFSET $3`,
    [actor.id, limit, offset],
  );
  return { status: 200, body: { items: rows.map(disputeDto), limit, offset } };
}

async function listHtxDisputes(pool, actor, query) {
  const { limit, offset } = listWindow(query);
  const { rows } = await pool.query(
    `SELECT d.id, d.booking_id, d.claimant_id, d.respondent_id, d.reason, d.status,
            d.mediator_id, d.mediation_level, d.created_at,
            CASE
              WHEN $1 IN (d.claimant_id, d.respondent_id, b.owner_id, p.provider_id, p.operator_id) THEN 'PARTY_CONFLICT'
              WHEN EXISTS (SELECT 1 FROM account.user_roles r WHERE r.user_id = $1 AND r.role IN ('provider', 'operator', 'admin')) THEN 'ROLE_OVERLAP'
              WHEN EXISTS (SELECT 1 FROM dispatch.machines m WHERE m.owner_id = $1) THEN 'MACHINE_CONFLICT'
              ELSE NULL
            END AS conflict_code
       FROM dispatch.disputes d
       JOIN dispatch.bookings b ON b.id = d.booking_id
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       LEFT JOIN dispatch.packages p ON p.id = pb.package_id
      WHERE d.status = 'OPEN'
        AND d.mediation_level = 'HTX'
        AND ($1 = b.coordinator_id OR $1 = p.coop_id)
        AND (d.mediator_id IS NULL OR d.mediator_id = $1)
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $2 OFFSET $3`,
    [actor.id, limit, offset],
  );
  return {
    status: 200,
    body: {
      items: rows.map((row) => ({
        id: row.id,
        bookingId: row.booking_id,
        claimantId: row.claimant_id,
        respondentId: row.respondent_id,
        reason: row.reason,
        status: row.status,
        mediationLevel: row.mediation_level,
        mediatorId: row.mediator_id,
        createdAt: row.created_at.toISOString(),
        eligible: row.conflict_code === null,
        conflictCode: row.conflict_code,
        canMediate: row.conflict_code === null && (row.mediator_id === null || row.mediator_id === actor.id),
      })),
      limit,
      offset,
    },
  };
}

async function readDispute(pool, actor, disputeId) {
  const { rows } = await pool.query(`SELECT ${DISPUTE_COLUMNS} FROM dispatch.disputes d WHERE id = $2
    AND ((${DISPUTE_PERSONAL_SCOPE_SQL}) OR ($3::boolean AND ${DISPUTE_REVIEW_ELIGIBLE_SQL}))`, [actor.id, disputeId, actor.roles.includes('admin')]);
  const row = rows[0];
  if (!row) throw fail(404, 'NOT_FOUND');
  const isParty = actor.id === row.claimant_id || actor.id === row.respondent_id;
  if (!isParty && !(await canReviewDispute(pool, actor, disputeId))) {
    if (!(await isActiveMediatorIndependent(pool, row, actor.id))) throw fail(404, 'NOT_FOUND');
  }
  const events = await pool.query(
    `SELECT sequence, event_type, actor_id, data, created_at
       FROM dispatch.dispute_events
      WHERE dispute_id = $1 AND event_type <> 'MEDIATION_ESCALATED'
      ORDER BY sequence`,
    [disputeId],
  );
  const escalations = await pool.query(
    `SELECT sequence, actor_id, data, created_at
       FROM dispatch.dispute_events
      WHERE dispute_id = $1 AND event_type = 'MEDIATION_ESCALATED'
      ORDER BY sequence`,
    [disputeId],
  );
  return {
    status: 200,
    body: {
      dispute: disputeDto(row),
      events: events.rows.map(eventDto),
      escalations: escalations.rows.map(escalationDto),
    },
  };
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

  router.get('/api/dispute-review', authenticate, handle(['admin'], async (req) => {
    const { limit, offset } = listWindow(req.query);
    const { rows } = await pool.query(
      `SELECT d.id, d.booking_id AS "bookingId", d.reason, d.status, d.mediation_level AS "mediationLevel"
         FROM dispatch.disputes d WHERE ${DISPUTE_REVIEW_ELIGIBLE_SQL}
         ORDER BY d.created_at, d.id LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    return { body: { items: rows, limit, offset } };
  }));

  router.get('/api/dispute-review/:id/mediators', authenticate, handle(['admin'], async (req) => {
    const disputeId = identifier(req.params.id);
    if (!await canReviewDispute(pool, req.actor, disputeId)) throw fail(404, 'NOT_FOUND');
    const { limit, offset } = listWindow(req.query);
    const { rows } = await pool.query(
      `SELECT u.id, u.name FROM account.users u
        WHERE EXISTS (SELECT 1 FROM account.user_roles r WHERE r.user_id = u.id AND r.role = 'admin')
          AND NOT EXISTS (
            SELECT 1 FROM dispatch.disputes d JOIN dispatch.bookings b ON b.id = d.booking_id
              LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
              LEFT JOIN dispatch.packages p ON p.id = pb.package_id
             WHERE d.id = $1 AND u.id IN (d.claimant_id, d.respondent_id, b.owner_id, b.coordinator_id, p.coop_id, p.provider_id, p.operator_id)
          )
        ORDER BY u.name, u.id LIMIT $2 OFFSET $3`,
      [disputeId, limit, offset],
    );
    return { body: { items: rows, limit, offset } };
  }));

  router.get('/api/htx/disputes', authenticate, handle(['coop'], async (req) => listHtxDisputes(pool, req.actor, req.query)));

  router.get('/api/disputes', authenticate, handle(null, async (req) => listDisputes(pool, req.actor, req.query)));

  router.get('/api/disputes/:id', authenticate, handle(null, async (req) => {
    return readDispute(pool, req.actor, identifier(req.params.id));
  }));

  router.post('/api/disputes/:id/responses', authenticate, handle(RESPOND_ROLES, async (req) => {
    const disputeId = identifier(req.params.id);
    const input = validateResponseInput(req.body);
    return respondToDispute(pool, req.actor, disputeId, input);
  }));

  router.post('/api/disputes/:id/htx-mediator', authenticate, handle(['coop', 'admin'], async (req) => {
    const disputeId = identifier(req.params.id);
    const mediatorId = validateHtxMediatorInput(req.body);
    return assignHtxMediator(pool, req.actor, disputeId, mediatorId);
  }));

  router.post('/api/disputes/:id/escalate', authenticate, handle(null, async (req) => {
    const disputeId = identifier(req.params.id);
    const input = validateEscalateInput(req.body);
    return escalateDispute(pool, req.actor, disputeId, input);
  }));

  router.post('/api/disputes/:id/mediator', authenticate, handle(['admin'], async (req) => {
    const disputeId = identifier(req.params.id);
    const mediatorId = validateMediatorInput(req.body);
    return assignMediator(pool, req.actor, disputeId, mediatorId);
  }));

  return router;
}
