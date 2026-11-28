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
  if (!trimmed || [...trimmed].length > MAX_TEXT || trimmed.includes('\0')) throw fail(400, 'VALIDATION_FAILED');
  return trimmed;
}

function areaM2(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AREA_M2) throw fail(400, 'VALIDATION_FAILED');
  return value;
}

const READINESS_KEYS = ['drained', 'mature', 'intakeReady'];
const INSPECTION_RESULTS = ['PASSED', 'FAILED'];

export function validateReadinessInput(body) {
  const input = plainBody(body, READINESS_KEYS);
  return { drained: flag(input.drained), mature: flag(input.mature), intakeReady: flag(input.intakeReady) };
}

export function validateInspectionInput(body) {
  const input = plainBody(body, ['result', 'reason']);
  if (typeof input.result !== 'string' || !INSPECTION_RESULTS.includes(input.result)) {
    throw fail(400, 'VALIDATION_FAILED');
  }
  if (input.result === 'FAILED') return { result: 'FAILED', reason: text(input.reason) };
  if (input.reason !== undefined) throw fail(400, 'VALIDATION_FAILED');
  return { result: 'PASSED', reason: null };
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

function summaryDto(row, actorId) {
  return {
    id: row.id,
    packageId: row.package_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    areaM2: row.area_m2,
    note: row.note,
    canOperate: actorId !== undefined && row.operator_id === actorId,
  };
}

async function shiftView(client, row, actorId) {
  return { shift: { ...summaryDto(row, actorId), events: await loadEvents(client, row.id) } };
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

function inspectionDto(row, stale) {
  return {
    sequence: Number(row.sequence),
    bookingId: row.booking_id,
    packageId: row.package_id,
    result: row.result,
    reason: row.reason,
    reviewerName: row.reviewer_name ?? null,
    stale,
    createdAt: row.created_at.toISOString(),
  };
}

async function recordInspection(pool, actor, bookingId, input) {
  return transaction(pool, async (client) => {
    // Scope to the HTX actually assigned to this booking and its package; foreign/missing return 404.
    const scoped = await client.query(
      `SELECT pb.package_id, p.coop_id
         FROM dispatch.bookings b
         LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
         LEFT JOIN dispatch.packages p ON p.id = pb.package_id
        WHERE b.id = $1 AND b.coordinator_id = $2`,
      [bookingId, actor.id],
    );
    if (!scoped.rows[0]) throw fail(404, 'NOT_FOUND');
    const { package_id: packageId, coop_id: coopId } = scoped.rows[0];
    if (packageId && coopId !== actor.id) throw fail(404, 'NOT_FOUND');
    if (!packageId) throw fail(409, 'BOOKING_UNAVAILABLE');

    // Share the package lock with startShift, readiness and cancel, then verify every precondition under lock.
    const pkg = (await client.query(
      'SELECT status, coop_id, window_start_at, window_end_at FROM dispatch.packages WHERE id = $1 FOR UPDATE',
      [packageId],
    )).rows[0];
    if (!pkg || pkg.coop_id !== actor.id) throw fail(404, 'NOT_FOUND');
    const booking = (await client.query('SELECT state FROM dispatch.bookings WHERE id = $1', [bookingId])).rows[0];
    if (!['OPEN', 'CLAIMED'].includes(pkg.status) || !booking || !['GROUPED', 'ASSIGNED'].includes(booking.state)) {
      throw fail(409, 'BOOKING_UNAVAILABLE');
    }
    if (await hasShift(client, packageId)) throw fail(409, 'SHIFT_STARTED');

    const readiness = await client.query(
      'SELECT sequence FROM dispatch.readiness_events WHERE booking_id = $1 ORDER BY sequence DESC LIMIT 1',
      [bookingId],
    );
    if (!readiness.rows[0]) throw fail(409, 'READINESS_MISSING');

    const { rows } = await client.query(
      `INSERT INTO dispatch.field_inspections
         (booking_id, package_id, reviewer_id, result, reason, readiness_sequence, window_start_at, window_end_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING sequence, booking_id, package_id, result, reason, created_at`,
      [
        bookingId,
        packageId,
        actor.id,
        input.result,
        input.reason,
        readiness.rows[0].sequence,
        pkg.window_start_at,
        pkg.window_end_at,
      ],
    );
    const user = await client.query('SELECT name FROM account.users WHERE id = $1', [actor.id]);
    return {
      status: 201,
      body: { inspection: inspectionDto({ ...rows[0], reviewer_name: user.rows[0]?.name ?? null }, false) },
    };
  });
}

async function startShift(pool, actor, packageId) {
  return transaction(pool, async (client) => {
    const { rows } = await client.query(
      'SELECT status, operator_id, window_start_at, window_end_at FROM dispatch.packages WHERE id = $1 FOR UPDATE',
      [packageId],
    );
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
    // Latest HTX inspection per booking must be PASSED and still match current readiness and package window.
    const inspectionGaps = await client.query(
      `SELECT count(*)::int AS n FROM dispatch.package_bookings pb
         LEFT JOIN LATERAL (
           SELECT sequence FROM dispatch.readiness_events r
            WHERE r.booking_id = pb.booking_id ORDER BY r.sequence DESC LIMIT 1) lr ON true
         LEFT JOIN LATERAL (
           SELECT result, readiness_sequence, window_start_at, window_end_at
             FROM dispatch.field_inspections i
            WHERE i.booking_id = pb.booking_id ORDER BY i.sequence DESC LIMIT 1) li ON true
        WHERE pb.package_id = $1
          AND NOT COALESCE(
            li.result = 'PASSED'
            AND li.readiness_sequence = lr.sequence
            AND li.window_start_at = $2
            AND li.window_end_at = $3,
            false)`,
      [packageId, pkg.window_start_at, pkg.window_end_at],
    );
    if (inspectionGaps.rows[0].n > 0) throw fail(409, 'INSPECTION_INCOMPLETE');
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

  router.get('/api/bookings/:id/readiness', authenticate, route(['farmer'], async (req) => {
    const bookingId = identifier(req.params.id);
    const { rows } = await pool.query(`SELECT b.id,r.drained,r.mature,r.intake_ready,r.created_at,
      (b.state IN ('GROUPED','ASSIGNED') AND p.status IN ('OPEN','CLAIMED')
        AND NOT EXISTS (SELECT 1 FROM dispatch.shifts s WHERE s.package_id=p.id)) AS can_confirm
      FROM dispatch.bookings b
      LEFT JOIN dispatch.package_bookings pb ON pb.booking_id=b.id
      LEFT JOIN dispatch.packages p ON p.id=pb.package_id
      LEFT JOIN LATERAL (SELECT drained,mature,intake_ready,created_at FROM dispatch.readiness_events
        WHERE booking_id=b.id ORDER BY sequence DESC LIMIT 1) r ON true
      WHERE b.id=$1 AND b.owner_id=$2`, [bookingId, req.actor.id]);
    if (!rows[0]) throw fail(404, 'NOT_FOUND');
    const row = rows[0];
    return { body: { canConfirm: row.can_confirm === true, readiness: row.created_at ? {
      bookingId, drained:row.drained, mature:row.mature, intakeReady:row.intake_ready, confirmedAt:row.created_at.toISOString(),
    } : null } };
  }));

  router.post('/api/bookings/:id/readiness', authenticate, route(['farmer'], async (req) => {
    const bookingId = identifier(req.params.id);
    const flags = validateReadinessInput(req.body);
    return { body: await confirmReadiness(pool, req.actor, bookingId, flags) };
  }));

  router.get('/api/bookings/:id/inspections', authenticate, route(['farmer', 'coop'], async (req) => {
    const bookingId = identifier(req.params.id);
    const isFarmer = req.actor.roles.includes('farmer');
    const isCoop = req.actor.roles.includes('coop');
    const scoped = await pool.query(
      `SELECT b.state AS booking_state, b.coordinator_id,
              p.id AS package_id, p.coop_id, p.status AS package_status, p.window_start_at, p.window_end_at,
              EXISTS (SELECT 1 FROM dispatch.shifts s WHERE s.package_id = p.id) AS has_shift,
              (SELECT max(r.sequence) FROM dispatch.readiness_events r WHERE r.booking_id = b.id) AS latest_readiness_sequence
         FROM dispatch.bookings b
         LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
         LEFT JOIN dispatch.packages p ON p.id = pb.package_id
        WHERE b.id = $1
          AND (($3::boolean AND b.owner_id = $2)
            OR ($4::boolean AND b.coordinator_id = $2 AND (p.id IS NULL OR p.coop_id = $2)))`,
      [bookingId, req.actor.id, isFarmer, isCoop],
    );
    if (!scoped.rows[0]) throw fail(404, 'NOT_FOUND');
    const row = scoped.rows[0];
    const { rows } = await pool.query(
      `SELECT i.sequence, i.booking_id, i.package_id, i.result, i.reason, i.created_at, u.name AS reviewer_name,
              NOT COALESCE(
                i.readiness_sequence = $2 AND i.window_start_at = $3 AND i.window_end_at = $4,
                false) AS stale
         FROM dispatch.field_inspections i
         LEFT JOIN account.users u ON u.id = i.reviewer_id
        WHERE i.booking_id = $1
        ORDER BY i.sequence DESC
        LIMIT 20`,
      [bookingId, row.latest_readiness_sequence, row.window_start_at, row.window_end_at],
    );
    const history = rows.map((item) => inspectionDto(item, item.stale));
    const latest = history[0] ?? null;
    const canInspect = Boolean(
      isCoop && row.coordinator_id === req.actor.id && row.coop_id === req.actor.id
      && ['OPEN', 'CLAIMED'].includes(row.package_status)
      && ['GROUPED', 'ASSIGNED'].includes(row.booking_state)
      && !row.has_shift && row.latest_readiness_sequence !== null,
    );
    return { body: { canInspect, passed: Boolean(latest && latest.result === 'PASSED' && !latest.stale), latest, history } };
  }));

  router.post('/api/bookings/:id/inspections', authenticate, route(['coop'], async (req) => {
    const bookingId = identifier(req.params.id);
    const input = validateInspectionInput(req.body);
    return recordInspection(pool, req.actor, bookingId, input);
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

  router.get('/api/shift-packages', authenticate, route(['operator'], async (req) => {
    let window;
    try { window = parsePagination(req.query); } catch (error) { throw fail(error.status, error.code); }
    const { rows } = await pool.query(`SELECT p.id,p.locality,p.window_start_at,p.window_end_at,
      (SELECT count(*)::int FROM dispatch.package_bookings pb WHERE pb.package_id=p.id) AS booking_count,
      NOT EXISTS (SELECT 1 FROM dispatch.package_bookings pb
        LEFT JOIN LATERAL (SELECT drained,mature,intake_ready FROM dispatch.readiness_events r
          WHERE r.booking_id=pb.booking_id ORDER BY r.sequence DESC LIMIT 1) latest ON true
        WHERE pb.package_id=p.id AND NOT COALESCE(latest.drained AND latest.mature AND latest.intake_ready,false)) AS ready,
      NOT EXISTS (SELECT 1 FROM dispatch.package_bookings pb
        LEFT JOIN LATERAL (SELECT sequence FROM dispatch.readiness_events r
          WHERE r.booking_id=pb.booking_id ORDER BY r.sequence DESC LIMIT 1) lr ON true
        LEFT JOIN LATERAL (SELECT result,readiness_sequence,window_start_at,window_end_at FROM dispatch.field_inspections i
          WHERE i.booking_id=pb.booking_id ORDER BY i.sequence DESC LIMIT 1) li ON true
        WHERE pb.package_id=p.id AND NOT COALESCE(
          li.result='PASSED' AND li.readiness_sequence=lr.sequence
          AND li.window_start_at=p.window_start_at AND li.window_end_at=p.window_end_at,false)) AS inspected
      FROM dispatch.packages p WHERE p.operator_id=$1 AND p.status='CLAIMED'
        AND NOT EXISTS (SELECT 1 FROM dispatch.shifts s WHERE s.package_id=p.id)
      ORDER BY p.window_start_at,p.id LIMIT $2 OFFSET $3`, [req.actor.id, window.limit, window.offset]);
    return { body: { packages: rows.map((row) => ({ id:row.id,locality:row.locality,startAt:row.window_start_at.toISOString(),endAt:row.window_end_at.toISOString(),bookingCount:row.booking_count,ready:row.ready,inspected:row.inspected })) } };
  }));

  router.get('/api/shifts', authenticate, route(READ_ROLES, async (req) => {
    let window;
    try {
      window = parsePagination(req.query);
    } catch (error) {
      throw fail(error.status, error.code);
    }
    const [operator, coop, provider] = scopeFlags(req.actor);
    const { rows } = await pool.query(
      `SELECT s.*,p.operator_id FROM dispatch.shifts s JOIN dispatch.packages p ON p.id = s.package_id
        WHERE ($1::boolean AND p.operator_id = $4) OR ($2::boolean AND p.coop_id = $4) OR ($3::boolean AND p.provider_id = $4)
        ORDER BY s.started_at DESC, s.id DESC LIMIT $5 OFFSET $6`,
      [operator, coop, provider, req.actor.id, window.limit, window.offset],
    );
    return { body: { shifts: rows.map((row) => summaryDto(row, req.actor.id)) } };
  }));

  router.get('/api/shifts/:id', authenticate, route(READ_ROLES, async (req) => {
    const shiftId = identifier(req.params.id);
    const [operator, coop, provider] = scopeFlags(req.actor);
    const { rows } = await pool.query(
      `SELECT s.*,p.operator_id FROM dispatch.shifts s JOIN dispatch.packages p ON p.id = s.package_id
        WHERE s.id = $1 AND (($2::boolean AND p.operator_id = $5) OR ($3::boolean AND p.coop_id = $5) OR ($4::boolean AND p.provider_id = $5))`,
      [shiftId, operator, coop, provider, req.actor.id],
    );
    if (!rows[0]) throw fail(404, 'NOT_FOUND');
    return { body: await shiftView(pool, rows[0], req.actor.id) };
  }));

  return router;
}
