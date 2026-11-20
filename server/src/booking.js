import { createHash } from 'node:crypto';
import express from 'express';
import { parsePagination } from './catalog.js';

// Demo validation bound, not a business rule: a single request may span at most 30 days.
export const MAX_SCHEDULE_SPAN_MS = 30 * 24 * 60 * 60 * 1000;
const OPERATION = 'booking.create';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const BODY_KEYS = ['fieldId', 'serviceId', 'startAt', 'endAt', 'cropVariety', 'sowDate', 'harvestDate'];
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DB_UNAVAILABLE_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH']);
const POOL_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

// Every SELECT and RETURNING uses this list, so create and read responses share one shape.
const BOOKING_COLUMNS = `id, state, field_id, service_id, start_at, end_at, field_name, field_area_m2,
  service_code, service_name, service_data_label, price_per_ha_vnd::text AS price_per_ha_vnd,
  total_vnd::text AS total_vnd, crop_variety, sow_date::text AS sow_date, harvest_date::text AS harvest_date, created_at`;

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

// Accepts only UTC "YYYY-MM-DDTHH:mm:ss[.sss]Z" and rejects impossible dates such as Feb 30 or 24:00.
function parseInstant(value, field) {
  const match = typeof value === 'string' ? INSTANT_PATTERN.exec(value) : null;
  if (!match) throw fail(field);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  const roundTrip = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  if (!roundTrip) throw fail(field);
  return date;
}

export function validateBookingInput(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiError(400, 'INVALID_BODY');
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.includes(key)) throw new ApiError(400, 'UNKNOWN_FIELD');
  }
  const fieldId = parseUuid(body.fieldId, 'fieldId');
  const serviceId = parseUuid(body.serviceId, 'serviceId');
  const cropVariety = body.cropVariety === undefined ? null : typeof body.cropVariety === 'string' ? body.cropVariety.trim() : '';
  if (cropVariety !== null && (!cropVariety || [...cropVariety].length > 80)) throw fail('cropVariety');
  const parseDate = (value, field) => {
    if (value === undefined || value === null || value === '') return null;
    const match = typeof value === 'string' ? DATE_PATTERN.exec(value) : null;
    if (!match) throw fail(field);
    const [, year, month, day] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw fail(field);
    return value;
  };
  const sowDate = parseDate(body.sowDate, 'sowDate');
  const harvestDate = parseDate(body.harvestDate, 'harvestDate');
  if (sowDate && harvestDate && harvestDate < sowDate) throw fail('harvestDate');
  const start = parseInstant(body.startAt, 'startAt');
  const end = parseInstant(body.endAt, 'endAt');
  const span = end - start;
  if (span <= 0 || span > MAX_SCHEDULE_SPAN_MS) throw fail('endAt');
  return {
    fieldId, serviceId, startAt: start.toISOString(), endAt: end.toISOString(),
    ...(body.cropVariety !== undefined ? { cropVariety } : {}),
    ...(body.sowDate !== undefined ? { sowDate } : {}),
    ...(body.harvestDate !== undefined ? { harvestDate } : {}),
  };
}

export function parseIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw fail('Idempotency-Key');
  }
  return value;
}

// Input is already normalized by validateBookingInput, so equivalent timestamp spellings hash the same.
// Crop facts join the hash only when present, so requests without them keep their stored hash.
// A retry under the same key with different crop facts therefore conflicts instead of replaying the first booking.
export function canonicalPayloadHash({ fieldId, serviceId, startAt, endAt, cropVariety = null, sowDate = null, harvestDate = null }) {
  const parts = [fieldId, serviceId, startAt, endAt];
  if (cropVariety !== null || sowDate !== null || harvestDate !== null) parts.push(cropVariety, sowDate, harvestDate);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// ponytail: demo engineering policy, not a legal or market rule. total = round-half-up(rate * m2 / 10000) VND.
// Ceiling: no VAT, fees, deposits or regional rounding rules. Upgrade: versioned pricing rule once the project agrees one.
// (rate * area + 5000) / 10000 with non-negative BigInt values is exactly round-half-up.
export function quoteTotalVnd(pricePerHaVnd, areaM2) {
  return (BigInt(pricePerHaVnd) * BigInt(areaM2) + 5000n) / 10000n;
}

function listWindow(query) {
  try {
    return parsePagination(query);
  } catch (error) {
    throw new ApiError(error.status, error.code);
  }
}

function bookingDto(row) {
  return {
    id: row.id,
    state: row.state,
    fieldId: row.field_id,
    serviceId: row.service_id,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    cropVariety: row.crop_variety,
    sowDate: row.sow_date,
    harvestDate: row.harvest_date,
    field: { name: row.field_name, areaM2: row.field_area_m2 },
    service: {
      code: row.service_code,
      name: row.service_name,
      dataLabel: row.service_data_label,
      pricePerHaVnd: row.price_per_ha_vnd,
    },
    totalVnd: row.total_vnd,
    createdAt: row.created_at.toISOString(),
  };
}

function eventDto(row) {
  return {
    sequence: Number(row.sequence),
    type: row.event_type,
    state: row.to_state,
    createdAt: row.created_at.toISOString(),
  };
}

// Same shape as catalog.js transaction helper: a failed COMMIT/ROLLBACK destroys the connection so no partial write survives.
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

// Idempotency design: the claim row is inserted in the same transaction as the booking. Concurrent requests with the
// same actor+operation+key block on the unique index until the first commits or rolls back. Failures roll back the claim,
// so the key is only consumed by a committed booking.
async function createBooking(pool, actor, input, key) {
  const payloadHash = canonicalPayloadHash(input);
  return inTransaction(pool, async (client) => {
    const claim = await client.query(
      `INSERT INTO dispatch.idempotency_keys (actor_id, operation, idempotency_key, payload_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING`,
      [actor.id, OPERATION, key, payloadHash],
    );
    if (claim.rowCount === 0) {
      const { rows } = await client.query(
        `SELECT payload_hash, response FROM dispatch.idempotency_keys
          WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3`,
        [actor.id, OPERATION, key],
      );
      if (!rows[0]) throw new Error('idempotency row missing after conflict');
      if (rows[0].payload_hash !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
      return { status: 201, body: rows[0].response };
    }

    // Ownership and active status are checked by the same owner-scoped and active-only queries used for reads.
    // Missing and foreign fields return the same 404 so ownership is not disclosed.
    const field = await client.query('SELECT name, area_m2 FROM dispatch.fields WHERE id = $1 AND owner_id = $2', [input.fieldId, actor.id]);
    if (!field.rows[0]) throw new ApiError(404, 'NOT_FOUND');
    const service = await client.query(
      `SELECT code, name, data_label, price_per_ha_vnd::text AS price_per_ha_vnd
         FROM dispatch.services WHERE id = $1 AND active`,
      [input.serviceId],
    );
    if (!service.rows[0]) throw new ApiError(404, 'NOT_FOUND');
    const { name: fieldName, area_m2: areaM2 } = field.rows[0];
    const { code, name: serviceName, data_label: dataLabel, price_per_ha_vnd: price } = service.rows[0];
    const total = quoteTotalVnd(price, areaM2);

    const inserted = await client.query(
      `INSERT INTO dispatch.bookings (owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
         service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, crop_variety, sow_date, harvest_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${BOOKING_COLUMNS}`,
      [actor.id, input.fieldId, input.serviceId, input.startAt, input.endAt, fieldName, areaM2,
        code, serviceName, dataLabel, price, total.toString(), input.cropVariety ?? null, input.sowDate ?? null, input.harvestDate ?? null],
    );
    const booking = inserted.rows[0];
    await client.query(
      `INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id)
       VALUES ($1, 'BOOKING_REQUESTED', 'REQUESTED', $2)`,
      [booking.id, actor.id],
    );
    const response = { booking: bookingDto(booking) };
    await client.query(
      `UPDATE dispatch.idempotency_keys SET booking_id = $4, response = $5::json
        WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [actor.id, OPERATION, key, booking.id, JSON.stringify(response)],
    );
    return { status: 201, body: response };
  });
}

function isDbUnavailable(error) {
  const code = typeof error.code === 'string' ? error.code : '';
  return DB_UNAVAILABLE_NODE_CODES.has(code)
    || /^08/.test(code)
    || code === '57P01'
    || code === '53300'
    || error.message === POOL_CONNECT_TIMEOUT_MESSAGE;
}

export function createBookingRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') {
    throw new TypeError('createBookingRouter requires a pool with query() and connect()');
  }
  if (typeof authenticate !== 'function') throw new TypeError('createBookingRouter requires an authenticate middleware');

  const router = express.Router();

  // Runs after the injected authenticate middleware. Fails closed when no verified actor is attached.
  function requireActor(roles) {
    return (req, res, next) => {
      const actor = req.actor;
      if (!actor || !isUuid(actor.id) || !Array.isArray(actor.roles)) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
      }
      if (roles && !actor.roles.some((role) => roles.includes(role))) {
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

  router.post('/api/bookings', authenticate, requireActor(['farmer', 'coop']), handle(async (req, res) => {
    const key = parseIdempotencyKey(req.get('Idempotency-Key'));
    const input = validateBookingInput(req.body);
    const { status, body } = await createBooking(pool, req.actor, input, key);
    res.status(status).json(body);
  }));

  // Initial slice: owners only. Assignment-based visibility is added by the later dispatch stage.
  router.get('/api/bookings', authenticate, requireActor(), handle(async (req, res) => {
    const { limit, offset } = listWindow(req.query);
    const { rows } = await pool.query(
      `SELECT ${BOOKING_COLUMNS} FROM dispatch.bookings
        WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.json({ items: rows.map(bookingDto), limit, offset });
  }));

  router.get('/api/bookings/:id', authenticate, requireActor(), handle(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(400, 'INVALID_ID');
    const { rows } = await pool.query(
      `SELECT ${BOOKING_COLUMNS} FROM dispatch.bookings WHERE id = $1 AND owner_id = $2`,
      [req.params.id.toLowerCase(), req.actor.id],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND');
    const events = await pool.query(
      `SELECT sequence, event_type, to_state, created_at FROM dispatch.booking_events
        WHERE booking_id = $1 ORDER BY sequence`,
      [rows[0].id],
    );
    res.json({ booking: bookingDto(rows[0]), events: events.rows.map(eventDto) });
  }));

  return router;
}
