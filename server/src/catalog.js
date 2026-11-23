import express from 'express';

// Demo validation bound, not an agriculture or land-registry rule: 10,000,000 m2.
// ponytail: no update/delete routes and no coop-on-behalf-of-farmer. Ceiling: owners cannot edit or retire rows. Upgrade: add with the G3 booking and admin approval stage.
export const MAX_FIELD_AREA_M2 = 10000000;
export const MACHINE_TYPES = ['harvester', 'tractor', 'drone'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_PATTERN = /^\d{1,7}$/;
const DB_UNAVAILABLE_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH']);
const POOL_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlainObject(body) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY');
  return body;
}

function assertKnownKeys(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiError(400, 'UNKNOWN_FIELD');
  }
}

function boundedText(value, field, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || [...text].length > max) throw new ApiError(400, 'VALIDATION_FAILED', { field });
  return text;
}

function boundedInt(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !DIGITS_PATTERN.test(value)) throw new ApiError(400, 'INVALID_PAGINATION');
  const number = Number(value);
  if (number < min || number > max) throw new ApiError(400, 'INVALID_PAGINATION');
  return number;
}

export function parsePagination(query = {}) {
  // ponytail: offset paging, max offset 10000. Ceiling: deep pages scan and skip rows. Upgrade: keyset cursor on (created_at, id) when lists grow.
  return {
    limit: boundedInt(query.limit, 20, 1, 100),
    offset: boundedInt(query.offset, 0, 0, 10000),
  };
}

export function validateFieldInput(body) {
  assertPlainObject(body);
  assertKnownKeys(body, ['name', 'locality', 'areaM2']);
  const { areaM2 } = body;
  if (!Number.isSafeInteger(areaM2) || areaM2 <= 0 || areaM2 > MAX_FIELD_AREA_M2) {
    throw new ApiError(400, 'VALIDATION_FAILED', { field: 'areaM2' });
  }
  return {
    name: boundedText(body.name, 'name', 120),
    locality: boundedText(body.locality, 'locality', 200),
    areaM2,
  };
}

export function validateMachineInput(body) {
  assertPlainObject(body);
  assertKnownKeys(body, ['name', 'type']);
  if (!MACHINE_TYPES.includes(body.type)) throw new ApiError(400, 'VALIDATION_FAILED', { field: 'type' });
  return { name: boundedText(body.name, 'name', 120), type: body.type };
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDbUnavailable(error) {
  const code = typeof error.code === 'string' ? error.code : '';
  return DB_UNAVAILABLE_NODE_CODES.has(code)
    || /^08/.test(code)
    || code === '57P01'
    || code === '53300'
    || error.message === POOL_CONNECT_TIMEOUT_MESSAGE;
}

// Public service list cache (CL-12 optimisation). No route writes dispatch.services; it changes only through seed or
// migration, so a short TTL is the only invalidation. 0 disables the cache. Bounded so arbitrary offsets cannot grow it.
export const MAX_SERVICES_CACHE_MS = 300000;
const SERVICES_CACHE_ENTRIES = 32;

export function createCatalogRouter({ pool, authenticate, servicesCacheMs = 0, now = Date.now }) {
  if (typeof pool?.query !== 'function') throw new TypeError('createCatalogRouter requires a pool with query()');
  if (typeof authenticate !== 'function') throw new TypeError('createCatalogRouter requires an authenticate middleware');
  if (!Number.isInteger(servicesCacheMs) || servicesCacheMs < 0 || servicesCacheMs > MAX_SERVICES_CACHE_MS) {
    throw new TypeError(`servicesCacheMs must be an integer in [0, ${MAX_SERVICES_CACHE_MS}]`);
  }
  const servicesCache = new Map();

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

  function requireUuid(value) {
    if (!isUuid(value)) throw new ApiError(400, 'INVALID_ID');
    return value;
  }

  router.get('/api/services', handle(async (req, res) => {
    const { limit, offset } = parsePagination(req.query);
    const key = `${limit}:${offset}`;
    const cached = servicesCacheMs > 0 ? servicesCache.get(key) : undefined;
    if (cached && cached.expiresAt > now()) return res.json(cached.body);
    const { rows } = await pool.query(
      `SELECT id, code, name, price_per_ha_vnd::text AS price_per_ha_vnd, data_label
         FROM dispatch.services WHERE active ORDER BY code, id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const body = { items: rows.map(serviceDto), limit, offset };
    if (servicesCacheMs > 0) {
      if (!servicesCache.has(key) && servicesCache.size >= SERVICES_CACHE_ENTRIES) servicesCache.clear();
      servicesCache.set(key, { body, expiresAt: now() + servicesCacheMs });
    }
    return res.json(body);
  }));

  router.get('/api/services/:id', handle(async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query(
      'SELECT id, code, name, price_per_ha_vnd::text AS price_per_ha_vnd, data_label FROM dispatch.services WHERE id = $1 AND active',
      [id],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND');
    res.json({ service: serviceDto(rows[0]) });
  }));

  router.get('/api/fields', authenticate, requireRoles('farmer', 'coop'), handle(async (req, res) => {
    const { limit, offset } = parsePagination(req.query);
    const { rows } = await pool.query(
      `SELECT id, name, locality, area_m2, created_at FROM dispatch.fields
        WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.json({ items: rows.map(fieldDto), limit, offset });
  }));

  router.post('/api/fields', authenticate, requireRoles('farmer', 'coop'), handle(async (req, res) => {
    const input = validateFieldInput(req.body);
    const { rows } = await pool.query(
      `INSERT INTO dispatch.fields (owner_id, name, locality, area_m2) VALUES ($1, $2, $3, $4)
       RETURNING id, name, locality, area_m2, created_at`,
      [req.actor.id, input.name, input.locality, input.areaM2],
    );
    res.status(201).json({ field: fieldDto(rows[0]) });
  }));

  router.get('/api/machines', authenticate, requireRoles('provider'), handle(async (req, res) => {
    const { limit, offset } = parsePagination(req.query);
    const { rows } = await pool.query(
      `SELECT id, name, machine_type, status, created_at FROM dispatch.machines
        WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.json({ items: rows.map(machineDto), limit, offset });
  }));

  router.post('/api/machines', authenticate, requireRoles('provider'), handle(async (req, res) => {
    const input = validateMachineInput(req.body);
    const { rows } = await pool.query(
      `INSERT INTO dispatch.machines (owner_id, name, machine_type) VALUES ($1, $2, $3)
       RETURNING id, name, machine_type, status, created_at`,
      [req.actor.id, input.name, input.type],
    );
    res.status(201).json({ machine: machineDto(rows[0]) });
  }));

  return router;
}

function serviceDto(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    pricePerHaVnd: row.price_per_ha_vnd,
    dataLabel: row.data_label,
  };
}

function fieldDto(row) {
  return {
    id: row.id,
    name: row.name,
    locality: row.locality,
    areaM2: row.area_m2,
    createdAt: row.created_at.toISOString(),
  };
}

function machineDto(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.machine_type,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}
