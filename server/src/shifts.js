import express from 'express';
import { parsePagination } from './catalog.js';

// G7a: field readiness confirmations and operator shift lifecycle.
// Readiness flags are user confirmations, not agronomic thresholds or legal validation.
// Shift states: RUNNING <-> PAUSED, RUNNING -> COMPLETED. Completion stores area and note only; no payment state.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ROLES = ['operator', 'coop', 'provider'];
const MAX_TEXT = 500;
const MAX_AREA_M2 = 2147483647;
const DB_UNAVAILABLE_CODE = /^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/;
const RESTRICT_VIOLATION = '23001';

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

// Strict bodies: plain object, known keys only. An absent body counts as empty only when allowed.
function plainBody(input, keys, { allowAbsent = false } = {}) {
  if (input === undefined && allowAbsent) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_BODY');
  if (Object.keys(input).some((key) => !keys.includes(key))) throw fail(400, 'UNKNOWN_FIELD');
  return input;
}

function flag(value) {
  if (typeof value !== 'boolean') throw fail(400, 'VALIDATION_FAILED');
  return value;
}

function text(value) {
  if (typeof value !== 'string') throw fail(400, 'VALIDATION_FAILED');
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > MAX_TEXT) throw fail(400, 'VALIDATION_FAILED');
  return trimmed;
}

function areaM2(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AREA_M2) throw fail(400, 'VALIDATION_FAILED');
  return value;
}

const READINESS_KEYS = ['drained', 'mature', 'intakeReady'];

export function validateReadinessInput(body) {
  const input = plainBody(body, READINESS_KEYS);
  return { drained: flag(input.drained), mature: flag(input.mature), intakeReady: flag(input.intakeReady) };
}

export function validatePauseInput(body) {
  return { reason: text(plainBody(body, ['reason']).reason) };
}

export function validateResumeInput(body) {
  plainBody(body, [], { allowAbsent: true });
  return {};
}

export function validateCompleteInput(body) {
  const input = plainBody(body, ['areaM2', 'note']);
  return {
    areaM2: areaM2(input.areaM2),
    note: input.note === undefined ? null : text(input.note),
  };
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

async function hasShift(client, packageId) {
  const { rowCount } = await client.query('SELECT 1 FROM dispatch.shifts WHERE package_id = $1', [packageId]);
  return rowCount > 0;
}

// Scope: the shift must belong to a package whose assigned operator is the actor. Missing and foreign both return 404.
async function lockAssignedShift(client, shiftId, actorId) {
  const { rows } = await client.query(
    `SELECT s.* FROM dispatch.shifts s JOIN dispatch.packages p ON p.id = s.package_id
      WHERE s.id = $1 AND p.operator_id = $2 FOR UPDATE OF s`,
    [shiftId, actorId],
  );
  if (!rows[0]) throw fail(404, 'NOT_FOUND');
  return rows[0];
}

async function loadEvents(client, shiftId) {
  const { rows } = await client.query(
    `SELECT event_type, from_state, to_state, reason, area_m2, note, created_at
       FROM dispatch.shift_events WHERE shift_id = $1 ORDER BY sequence`,
    [shiftId],
  );
  return rows.map((row) => ({
    eventType: row.event_type,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    areaM2: row.area_m2,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  }));
}

function summaryDto(row) {
  return {
    id: row.id,
    packageId: row.package_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    areaM2: row.area_m2,
    note: row.note,
  };
}

async function shiftView(client, row) {
  return { shift: { ...summaryDto(row), events: await loadEvents(client, row.id) } };
}

async function confirmReadiness(pool, actor, bookingId, flags) {
  return transaction(pool, async (client) => {
    // Owner scope first: missing and foreign bookings both return 404.
    const owned = await client.query(
      `SELECT pb.package_id FROM dispatch.bookings b
         LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
        WHERE b.id = $1 AND b.owner_id = $2`,
      [bookingId, actor.id],
    );
    if (!owned.rows[0]) throw fail(404, 'NOT_FOUND');
    const packageId = owned.rows[0].package_id;
    if (!packageId) throw fail(409, 'BOOKING_UNAVAILABLE');
    // Same package lock as start and cancel, so readiness cannot slip in between a start check and its insert.
    const pkg = await client.query('SELECT status FROM dispatch.packages WHERE id = $1 FOR UPDATE', [packageId]);
    const booking = await client.query('SELECT state FROM dispatch.bookings WHERE id = $1', [bookingId]);
    // Readiness is open while the package is OPEN or CLAIMED and the booking is grouped or assigned. Cancelled packages refuse.
    if (!['OPEN', 'CLAIMED'].includes(pkg.rows[0].status) || !['GROUPED', 'ASSIGNED'].includes(booking.rows[0].state)) {
      throw fail(409, 'BOOKING_UNAVAILABLE');
    }
    if (await hasShift(client, packageId)) throw fail(409, 'SHIFT_STARTED');
    const { rows } = await client.query(
      `INSERT INTO dispatch.readiness_events (booking_id, actor_id, drained, mature, intake_ready)
       VALUES ($1, $2, $3, $4, $5) RETURNING drained, mature, intake_ready, created_at`,
      [bookingId, actor.id, flags.drained, flags.mature, flags.intakeReady],
    );
    const row = rows[0];
    return {
      readiness: {
        bookingId,
        drained: row.drained,
        mature: row.mature,
        intakeReady: row.intake_ready,
        confirmedAt: row.created_at.toISOString(),
      },
    };
  });
}

async function startShift(pool, actor, packageId) {
  return transaction(pool, async (client) => {
    const { rows } = await client.query('SELECT status, operator_id FROM dispatch.packages WHERE id = $1 FOR UPDATE', [packageId]);
    const pkg = rows[0];
    if (!pkg || pkg.operator_id !== actor.id) throw fail(404, 'NOT_FOUND');
    if (pkg.status !== 'CLAIMED') throw fail(409, 'PACKAGE_NOT_CLAIMED');
    if (await hasShift(client, packageId)) throw fail(409, 'SHIFT_ALREADY_STARTED');
    // Latest confirmation per booking decides. Any booking without all three true blocks the start.
    const gaps = await client.query(
      `SELECT count(*)::int AS n FROM dispatch.package_bookings pb
         LEFT JOIN LATERAL (
           SELECT drained, mature, intake_ready FROM dispatch.readiness_events r
            WHERE r.booking_id = pb.booking_id ORDER BY r.sequence DESC LIMIT 1) latest ON true
        WHERE pb.package_id = $1 AND NOT COALESCE(latest.drained AND latest.mature AND latest.intake_ready, false)`,
      [packageId],
    );
    if (gaps.rows[0].n > 0) throw fail(409, 'READINESS_INCOMPLETE');
    const shift = (await client.query(
      "INSERT INTO dispatch.shifts (package_id, status) VALUES ($1, 'RUNNING') RETURNING *",
      [packageId],
    )).rows[0];
    await client.query(
      "INSERT INTO dispatch.shift_events (shift_id, event_type, from_state, to_state, actor_id) VALUES ($1, 'SHIFT_STARTED', NULL, 'RUNNING', $2)",
      [shift.id, actor.id],
    );
    return { status: 201, body: await shiftView(client, shift) };
  });
}

async function pauseShift(pool, actor, shiftId, reason) {
  return transaction(pool, async (client) => {
    const shift = await lockAssignedShift(client, shiftId, actor.id);
    if (shift.status !== 'RUNNING') throw fail(409, 'INVALID_TRANSITION');
    const updated = (await client.query("UPDATE dispatch.shifts SET status = 'PAUSED' WHERE id = $1 RETURNING *", [shiftId])).rows[0];
    await client.query(
      "INSERT INTO dispatch.shift_events (shift_id, event_type, from_state, to_state, reason, actor_id) VALUES ($1, 'SHIFT_PAUSED', 'RUNNING', 'PAUSED', $2, $3)",
      [shiftId, reason, actor.id],
    );
    return { status: 200, body: await shiftView(client, updated) };
  });
}

async function resumeShift(pool, actor, shiftId) {
  return transaction(pool, async (client) => {
    const shift = await lockAssignedShift(client, shiftId, actor.id);
    if (shift.status !== 'PAUSED') throw fail(409, 'INVALID_TRANSITION');
    const updated = (await client.query("UPDATE dispatch.shifts SET status = 'RUNNING' WHERE id = $1 RETURNING *", [shiftId])).rows[0];
    await client.query(
      "INSERT INTO dispatch.shift_events (shift_id, event_type, from_state, to_state, actor_id) VALUES ($1, 'SHIFT_RESUMED', 'PAUSED', 'RUNNING', $2)",
      [shiftId, actor.id],
    );
    return { status: 200, body: await shiftView(client, updated) };
  });
}

async function completeShift(pool, actor, shiftId, input) {
  return transaction(pool, async (client) => {
    const shift = await lockAssignedShift(client, shiftId, actor.id);
    if (shift.status === 'COMPLETED') {
      // Same payload replays the stored result with no new event. A different payload is a conflict.
      if (shift.area_m2 === input.areaM2 && shift.note === input.note) return { status: 200, body: await shiftView(client, shift) };
      throw fail(409, 'SHIFT_ALREADY_COMPLETED');
    }
    if (shift.status !== 'RUNNING') throw fail(409, 'INVALID_TRANSITION');
    // Demo engineering guard: reported area cannot exceed the summed booking field areas of this package.
    const ceiling = await client.query(
      `SELECT COALESCE(SUM(b.field_area_m2), 0)::bigint AS total
         FROM dispatch.package_bookings pb JOIN dispatch.bookings b ON b.id = pb.booking_id
        WHERE pb.package_id = $1`,
      [shift.package_id],
    );
    if (input.areaM2 > Number(ceiling.rows[0].total)) throw fail(409, 'AREA_EXCEEDS_BOOKINGS');
    const updated = (await client.query(
      "UPDATE dispatch.shifts SET status = 'COMPLETED', completed_at = now(), area_m2 = $2, note = $3 WHERE id = $1 RETURNING *",
      [shiftId, input.areaM2, input.note],
    )).rows[0];
    await client.query(
      `INSERT INTO dispatch.shift_events (shift_id, event_type, from_state, to_state, area_m2, note, actor_id)
       VALUES ($1, 'SHIFT_COMPLETED', 'RUNNING', 'COMPLETED', $2, $3, $4)`,
      [shiftId, input.areaM2, input.note, actor.id],
    );
    return { status: 200, body: await shiftView(client, updated) };
  });
}

export function createShiftRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') {
    throw new TypeError('createShiftRouter requires a pool with query() and connect()');
  }
  if (typeof authenticate !== 'function') throw new TypeError('createShiftRouter requires an authenticate middleware');

  const router = express.Router();

  // Runs after the injected authenticate middleware. Fails closed when no verified actor is attached.
  function route(roles, work) {
    return async (req, res, next) => {
      try {
        const actor = req.actor;
        if (!actor || !isUuid(actor.id) || !Array.isArray(actor.roles)) throw fail(401, 'UNAUTHENTICATED');
        if (!actor.roles.some((role) => roles.includes(role))) throw fail(403, 'FORBIDDEN');
        const { status = 200, body } = await work(req);
        return res.status(status).json(body);
      } catch (error) {
        if (error instanceof ApiError) return res.status(error.status).json({ error: { code: error.code } });
        // Trigger-level refusal means a concurrent change beat this request.
        if (error.code === RESTRICT_VIOLATION) return res.status(409).json({ error: { code: 'STATE_CHANGED' } });
        if (isDbUnavailable(error)) return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
        return next(error);
      }
    };
  }

  router.post('/api/bookings/:id/readiness', authenticate, route(['farmer'], async (req) => {
    const bookingId = identifier(req.params.id);
    const flags = validateReadinessInput(req.body);
    return { body: await confirmReadiness(pool, req.actor, bookingId, flags) };
  }));

  router.post('/api/packages/:id/shifts/start', authenticate, route(['operator'], async (req) => {
    const packageId = identifier(req.params.id);
    plainBody(req.body, [], { allowAbsent: true });
    return startShift(pool, req.actor, packageId);
  }));

  router.post('/api/shifts/:id/pause', authenticate, route(['operator'], async (req) => {
    const shiftId = identifier(req.params.id);
    const { reason } = validatePauseInput(req.body);
    return pauseShift(pool, req.actor, shiftId, reason);
  }));

  router.post('/api/shifts/:id/resume', authenticate, route(['operator'], async (req) => {
    const shiftId = identifier(req.params.id);
    validateResumeInput(req.body);
    return resumeShift(pool, req.actor, shiftId);
  }));

  router.post('/api/shifts/:id/complete', authenticate, route(['operator'], async (req) => {
    const shiftId = identifier(req.params.id);
    const input = validateCompleteInput(req.body);
    return completeShift(pool, req.actor, shiftId, input);
  }));

  // Read scope mirrors the roles: operator sees own assigned packages, coop its packages, provider its claimed packages.
  function scopeFlags(actor) {
    return [actor.roles.includes('operator'), actor.roles.includes('coop'), actor.roles.includes('provider')];
  }

  router.get('/api/shifts', authenticate, route(READ_ROLES, async (req) => {
    let window;
    try {
      window = parsePagination(req.query);
    } catch (error) {
      throw fail(error.status, error.code);
    }
    const [operator, coop, provider] = scopeFlags(req.actor);
    const { rows } = await pool.query(
      `SELECT s.* FROM dispatch.shifts s JOIN dispatch.packages p ON p.id = s.package_id
        WHERE ($1::boolean AND p.operator_id = $4) OR ($2::boolean AND p.coop_id = $4) OR ($3::boolean AND p.provider_id = $4)
        ORDER BY s.started_at DESC, s.id DESC LIMIT $5 OFFSET $6`,
      [operator, coop, provider, req.actor.id, window.limit, window.offset],
    );
    return { body: { shifts: rows.map(summaryDto) } };
  }));

  router.get('/api/shifts/:id', authenticate, route(READ_ROLES, async (req) => {
    const shiftId = identifier(req.params.id);
    const [operator, coop, provider] = scopeFlags(req.actor);
    const { rows } = await pool.query(
      `SELECT s.* FROM dispatch.shifts s JOIN dispatch.packages p ON p.id = s.package_id
        WHERE s.id = $1 AND (($2::boolean AND p.operator_id = $5) OR ($3::boolean AND p.coop_id = $5) OR ($4::boolean AND p.provider_id = $5))`,
      [shiftId, operator, coop, provider, req.actor.id],
    );
    if (!rows[0]) throw fail(404, 'NOT_FOUND');
    return { body: await shiftView(pool, rows[0]) };
  }));

  return router;
}
