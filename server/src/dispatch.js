import express from 'express';
import { parsePagination } from './catalog.js';

// Duplicated from booking.js on purpose: this slice owns only dispatch.js and must not edit the G3 module.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DB_UNAVAILABLE_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH']);
const POOL_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const MAX_PACKAGE_BOOKINGS = 100;

class ApiError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }

  body() {
    const { field } = this;
    return field ? { code: this.code, field } : { code: this.code };
  }
}

function fail(field) {
  return new ApiError(400, 'VALIDATION_FAILED', { field });
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function parseUuid(value, field) {
  if (!isUuid(value)) throw fail(field);
  return value.toLowerCase();
}

function plainObject(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiError(400, 'INVALID_BODY');
  return body;
}

export function validateCoordinatorInput(body) {
  const input = plainObject(body);
  for (const key of Object.keys(input)) {
    if (key !== 'coordinatorId') throw new ApiError(400, 'UNKNOWN_FIELD');
  }
  return { coordinatorId: parseUuid(input.coordinatorId, 'coordinatorId') };
}

export function validatePackageInput(body) {
  const input = plainObject(body);
  for (const key of Object.keys(input)) {
    if (key !== 'bookingIds') throw new ApiError(400, 'UNKNOWN_FIELD');
  }
  const { bookingIds } = input;
  if (!Array.isArray(bookingIds) || bookingIds.length < 1 || bookingIds.length > MAX_PACKAGE_BOOKINGS) throw fail('bookingIds');
  const ids = bookingIds.map((id) => parseUuid(id, 'bookingIds'));
  if (new Set(ids).size !== ids.length) throw fail('bookingIds');
  return { bookingIds: ids };
}

// Interval intersection of compatible bookings. Returns null when service, locality or the shared window is missing.
export function packageWindow(rows) {
  const [first] = rows;
  if (!rows.every((row) => row.serviceId === first.serviceId && row.locality === first.locality)) return null;
  const start = new Date(Math.max(...rows.map((row) => row.startAt.getTime())));
  const end = new Date(Math.min(...rows.map((row) => row.endAt.getTime())));
  return start < end ? { start, end } : null;
}

function listWindow(query) {
  try {
    return parsePagination(query);
  } catch (error) {
    throw new ApiError(error.status, error.code);
  }
}

function packageDto(row, bookingCount) {
  return {
    id: row.id,
    status: row.status,
    serviceId: row.service_id,
    locality: row.locality,
    window: { startAt: row.window_start_at.toISOString(), endAt: row.window_end_at.toISOString() },
    bookingCount,
    createdAt: row.created_at.toISOString(),
  };
}

function isDbUnavailable(error) {
  const code = typeof error.code === 'string' ? error.code : '';
  return DB_UNAVAILABLE_NODE_CODES.has(code)
    || /^08/.test(code)
    || code === '57P01'
    || code === '53300'
    || error.message === POOL_CONNECT_TIMEOUT_MESSAGE;
}

// Same shape as booking.js: a failed COMMIT/ROLLBACK destroys the connection so no partial write survives.
async function inTransaction(pool, work) {
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

// Coordinator is a verified account with the coop role. The DB lookup is a deliberate one-DB demo dependency.
async function assignCoordinator(pool, actor, bookingId, coordinatorId) {
  return inTransaction(pool, async (client) => {
    // Owner-scoped row lock: missing and foreign bookings return the same 404.
    const { rows } = await client.query(
      'SELECT id, state FROM dispatch.bookings WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [bookingId, actor.id],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND');
    if (rows[0].state !== 'REQUESTED') throw new ApiError(409, 'BOOKING_NOT_REQUESTED');
    const coop = await client.query(
      "SELECT 1 FROM account.user_roles WHERE user_id = $1 AND role = 'coop'",
      [coordinatorId],
    );
    if (coop.rowCount === 0) throw new ApiError(400, 'INVALID_COORDINATOR', { field: 'coordinatorId' });
    const updated = await client.query(
      'UPDATE dispatch.bookings SET coordinator_id = $2 WHERE id = $1 RETURNING id, state, coordinator_id',
      [bookingId, coordinatorId],
    );
    await client.query(
      `INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id)
       VALUES ($1, 'COORDINATOR_ASSIGNED', 'REQUESTED', $2)`,
      [bookingId, actor.id],
    );
    const row = updated.rows[0];
    return { booking: { id: row.id, state: row.state, coordinatorId: row.coordinator_id } };
  });
}

// Lock order: bookings are locked in sorted ID order. Hidden or foreign IDs and missing IDs both return 404.
async function createPackage(pool, actor, bookingIds) {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT b.id, b.state, b.service_id AS "serviceId", f.locality, b.start_at AS "startAt", b.end_at AS "endAt"
         FROM dispatch.bookings b
         JOIN dispatch.fields f ON f.id = b.field_id AND f.owner_id = b.owner_id
        WHERE b.id = ANY($1::uuid[]) AND b.coordinator_id = $2
        ORDER BY b.id
          FOR UPDATE OF b`,
      [bookingIds, actor.id],
    );
    if (rows.length !== bookingIds.length) throw new ApiError(404, 'NOT_FOUND');
    if (rows.some((row) => row.state !== 'REQUESTED')) throw new ApiError(409, 'BOOKING_NOT_REQUESTED');
    const window = packageWindow(rows);
    if (!window) throw new ApiError(409, 'PACKAGE_INCOMPATIBLE');

    // ponytail: locality comes from the live field row; the booking snapshot does not store it. Ceiling: a field
    // locality edit after request can change grouping eligibility. Upgrade: add a locality snapshot column.
    const created = await client.query(
      `INSERT INTO dispatch.packages (coop_id, service_id, locality, window_start_at, window_end_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status, service_id, locality, window_start_at, window_end_at, created_at`,
      [actor.id, rows[0].serviceId, rows[0].locality, window.start.toISOString(), window.end.toISOString()],
    );
    const pkg = created.rows[0];
    await client.query(
      'INSERT INTO dispatch.package_bookings (package_id, booking_id) SELECT $1, unnest($2::uuid[])',
      [pkg.id, bookingIds],
    );
    const grouped = await client.query(
      "UPDATE dispatch.bookings SET state = 'GROUPED' WHERE id = ANY($1::uuid[]) AND state = 'REQUESTED'",
      [bookingIds],
    );
    if (grouped.rowCount !== bookingIds.length) throw new ApiError(409, 'BOOKING_NOT_REQUESTED');
    await client.query(
      "INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id) SELECT unnest($1::uuid[]), 'BOOKING_GROUPED', 'GROUPED', $2",
      [bookingIds, actor.id],
    );
    return { status: 201, body: { package: packageDto(pkg, bookingIds.length) } };
  });
}

export function createDispatchRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') {
    throw new TypeError('createDispatchRouter requires a pool with query() and connect()');
  }
  if (typeof authenticate !== 'function') throw new TypeError('createDispatchRouter requires an authenticate middleware');

  const router = express.Router();

  // Runs after the injected authenticate middleware. Fails closed when no verified actor is attached.
  function requireActor(roles) {
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

  router.get('/api/coordinators', authenticate, requireActor(['farmer', 'coop']), handle(async (req, res) => {
    const { limit, offset } = listWindow(req.query);
    const { rows } = await pool.query(`SELECT u.id,u.name FROM account.users u
      WHERE EXISTS (SELECT 1 FROM account.user_roles r WHERE r.user_id=u.id AND r.role='coop')
      ORDER BY u.name,u.id LIMIT $1 OFFSET $2`, [limit, offset]);
    res.json({ items:rows, limit, offset });
  }));

  router.get('/api/bookings/:id/coordinator', authenticate, requireActor(['farmer', 'coop']), handle(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(400, 'INVALID_ID');
    const { rows } = await pool.query('SELECT coordinator_id,state FROM dispatch.bookings WHERE id=$1 AND owner_id=$2', [req.params.id.toLowerCase(), req.actor.id]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND');
    res.json({ coordinatorId:rows[0].coordinator_id, canAssign:rows[0].state==='REQUESTED' });
  }));

  router.post('/api/bookings/:id/coordinator', authenticate, requireActor(['farmer', 'coop']), handle(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(400, 'INVALID_ID');
    const input = validateCoordinatorInput(req.body);
    res.json(await assignCoordinator(pool, req.actor, req.params.id.toLowerCase(), input.coordinatorId));
  }));

  router.post('/api/packages', authenticate, requireActor(['coop']), handle(async (req, res) => {
    const input = validatePackageInput(req.body);
    const { status, body } = await createPackage(pool, req.actor, input.bookingIds);
    res.status(status).json(body);
  }));

  // Coops see their own packages in any status. Providers see OPEN packages only. Neither gets personal identities.
  router.get('/api/packages', authenticate, requireActor(['coop', 'provider']), handle(async (req, res) => {
    const { limit, offset } = listWindow(req.query);
    const isCoop = req.actor.roles.includes('coop');
    const columns = `p.id, p.status, p.service_id, p.locality, p.window_start_at, p.window_end_at, p.created_at,
      (SELECT count(*)::int FROM dispatch.package_bookings pb WHERE pb.package_id = p.id) AS booking_count`;
    const { rows } = isCoop
      ? await pool.query(
        `SELECT ${columns} FROM dispatch.packages p WHERE p.coop_id = $1
          ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
        [req.actor.id, limit, offset],
      )
      : await pool.query(
        `SELECT ${columns} FROM dispatch.packages p WHERE p.status = 'OPEN' OR p.provider_id = $3
          ORDER BY p.created_at DESC, p.id DESC LIMIT $1 OFFSET $2`,
        [limit, offset, req.actor.id],
      );
    res.json({ items: rows.map((row) => packageDto(row, row.booking_count)), limit, offset });
  }));

  router.get('/api/packages/:id', authenticate, requireActor(['coop', 'provider']), handle(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(400, 'INVALID_ID');
    const id = req.params.id.toLowerCase();
    const isCoop = req.actor.roles.includes('coop');
    const { rows } = isCoop
      ? await pool.query(
        `SELECT id, status, service_id, locality, window_start_at, window_end_at, created_at
           FROM dispatch.packages WHERE id = $1 AND coop_id = $2`,
        [id, req.actor.id],
      )
      : await pool.query(
        `SELECT id, status, service_id, locality, window_start_at, window_end_at, created_at
           FROM dispatch.packages WHERE id = $1 AND (status = 'OPEN' OR provider_id = $2)`,
        [id, req.actor.id],
      );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND');
    const members = await pool.query(
      'SELECT booking_id FROM dispatch.package_bookings WHERE package_id = $1 ORDER BY booking_id',
      [rows[0].id],
    );
    const bookingIds = members.rows.map((row) => row.booking_id);
    res.json({ package: { ...packageDto(rows[0], bookingIds.length), bookingIds } });
  }));

  // Coop lists its own delegated REQUESTED bookings. Snapshot name/area/service; locality comes from the live field row.
  router.get('/api/dispatch/bookings', authenticate, requireActor(['coop']), handle(async (req, res) => {
    const { limit, offset } = listWindow(req.query);
    const { rows } = await pool.query(
      `SELECT b.id, b.field_name, f.locality, b.service_id, b.service_name, b.field_area_m2, b.start_at, b.end_at
         FROM dispatch.bookings b
         JOIN dispatch.fields f ON f.id = b.field_id AND f.owner_id = b.owner_id
        WHERE b.coordinator_id = $1 AND b.state = 'REQUESTED'
        ORDER BY b.created_at DESC, b.id DESC LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        fieldName: row.field_name,
        locality: row.locality,
        serviceId: row.service_id,
        serviceName: row.service_name,
        areaM2: row.field_area_m2,
        startAt: row.start_at.toISOString(),
        endAt: row.end_at.toISOString(),
      })),
      limit,
      offset,
    });
  }));

  // Provider lists operators whose offer on its jobs is ACCEPTED. One application per job/operator and one live offer
  // per application (migration 004), so each row is one distinct commitment. Operator role is re-checked live.
  // Read-only: this lists choices for a later claim UI and grants no authority; claim checks the window and conflicts.
  router.get('/api/dispatch/operators', authenticate, requireActor(['provider']), handle(async (req, res) => {
    const { limit, offset } = listWindow(req.query);
    const { rows } = await pool.query(
      `SELECT o.operator_id AS id, u.name, j.start_at, j.end_at, j.id AS job_id
         FROM dispatch.offers o
         JOIN dispatch.jobs j ON j.id = o.job_id
         JOIN account.users u ON u.id = o.operator_id
        WHERE j.provider_id = $1 AND o.status = 'ACCEPTED'
          AND EXISTS (SELECT 1 FROM account.user_roles r WHERE r.user_id = o.operator_id AND r.role = 'operator')
        ORDER BY j.start_at, j.id, o.id LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        startAt: row.start_at.toISOString(),
        endAt: row.end_at.toISOString(),
        jobId: row.job_id,
      })),
      limit,
      offset,
    });
  }));

  return router;
}
