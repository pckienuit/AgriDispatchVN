import express from 'express';
import { randomUUID } from 'node:crypto';
import { areaInLocalUnits, MAX_FIELD_AREA_M2, measurePolygon } from './gis-geometry.js';

export { MAX_FIELD_AREA_M2 } from './gis-geometry.js';
export const MACHINE_TYPES = ['harvester', 'tractor', 'drone'];
const FIELD_COLUMNS = `id, name, locality, area_m2, created_at, province_code, commune_code,
  boundary_geojson, centroid_lat, centroid_lng, calculated_area_m2`;
const TERRITORY_CODE = /^[A-Z0-9-]{2,32}$/;
const SERVICE_COLUMNS = `id, code, name, unit, machine_type, active, description,
  price_per_ha_vnd::text AS price_per_ha_vnd, data_label`;

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
  if (text === '' || [...text].length > max || text.includes('\0')) throw new ApiError(400, 'VALIDATION_FAILED', { field });
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

export function validateFieldInput(body, partial = false) {
  assertPlainObject(body);
  assertKnownKeys(body, ['name', 'locality', 'areaM2', 'boundaryGeojson', 'provinceCode', 'communeCode']);
  if (!Object.keys(body).length && partial) throw new ApiError(400, 'INVALID_BODY');
  const bad = (field) => new ApiError(400, 'VALIDATION_FAILED', { field });
  const { areaM2, boundaryGeojson, provinceCode, communeCode } = body;
  const hasBoundary = boundaryGeojson !== undefined && boundaryGeojson !== null;
  let metrics = null;
  if (hasBoundary) {
    try { metrics = measurePolygon(boundaryGeojson); }
    catch (error) {
      if (error.field === 'boundaryGeojson') throw bad(error.field);
      throw error;
    }
  }
  if ((areaM2 !== undefined || (!partial && !metrics))
    && (!Number.isSafeInteger(areaM2) || areaM2 <= 0 || areaM2 > MAX_FIELD_AREA_M2)) throw bad('areaM2');
  if (provinceCode !== undefined || communeCode !== undefined) {
    for (const [key, value] of Object.entries({ provinceCode, communeCode })) {
      if (!(provinceCode === null && communeCode === null) && (typeof value !== 'string' || !TERRITORY_CODE.test(value))) throw bad(key);
    }
  }
  return {
    ...(!partial || body.name !== undefined ? { name: boundedText(body.name, 'name', 120) } : {}),
    ...(!partial || body.locality !== undefined ? { locality: boundedText(body.locality, 'locality', 200) } : {}),
    ...(areaM2 !== undefined || metrics ? { areaM2: metrics?.calculatedAreaM2 ?? areaM2 } : {}),
    ...(boundaryGeojson !== undefined ? { boundaryGeojson, metrics } : {}),
    ...(provinceCode !== undefined ? { provinceCode, communeCode } : {}),
  };
}

async function withFieldConsent(pool, actorId, input, save) {
  if (!input.metrics) return save(pool);
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(`SELECT 1 FROM dispatch.location_consents
      WHERE owner_id = $1 AND withdrawn_at IS NULL FOR SHARE`, [actorId]);
    if (!rowCount) throw new ApiError(403, 'LOCATION_CONSENT_REQUIRED');
    const result = await save(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

function fieldParams(input) {
  const shape = input.boundaryGeojson;
  return [input.name, input.locality, input.areaM2, input.provinceCode, input.communeCode,
    shape ? JSON.stringify(shape) : null, shape ? JSON.stringify(shape.coordinates[0]) : null,
    input.metrics?.centroid.lat, input.metrics?.centroid.lng, input.metrics?.calculatedAreaM2];
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

function validateServiceInput(body, partial = false) {
  assertPlainObject(body);
  assertKnownKeys(body, ['name', 'unit', 'pricePerHaVnd', 'active', 'description', ...(partial ? [] : ['machineType'])]);
  if (!Object.keys(body).length && partial) throw new ApiError(400, 'INVALID_BODY');
  const bad = (field) => new ApiError(400, 'VALIDATION_FAILED', { field });
  const input = {};
  if (!partial || body.name !== undefined) input.name = boundedText(body.name, 'name', 160);
  if (!partial || body.unit !== undefined) {
    if (body.unit !== 'ha') throw bad('unit');
    input.unit = body.unit;
  }
  if (!partial || body.pricePerHaVnd !== undefined) {
    const value = body.pricePerHaVnd;
    const text = Number.isSafeInteger(value) ? String(value) : value;
    // At most 1000 ha per booking. Keep rate * area / 10000 in PostgreSQL BIGINT range.
    if (typeof text !== 'string' || !/^[1-9]\d{0,15}$/.test(text) || BigInt(text) > 9223372036854775n) throw bad('pricePerHaVnd');
    input.pricePerHaVnd = text;
  }
  if (!partial) {
    if (!MACHINE_TYPES.includes(body.machineType)) throw bad('machineType');
    input.machineType = body.machineType;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw bad('active');
    input.active = body.active;
  }
  if (body.description !== undefined) input.description = body.description === null ? null : boundedText(body.description, 'description', 1000);
  return input;
}

// Public service list cache (CL-12 optimisation). 0 disables it. API writes clear all cached pages in this process.
export const MAX_SERVICES_CACHE_MS = 300000;
const SERVICES_CACHE_ENTRIES = 32;

export function createCatalogRouter({ pool, authenticate, servicesCacheMs = 0, now = Date.now }) {
  if (typeof pool?.query !== 'function') throw new TypeError('createCatalogRouter requires a pool with query()');
  if (typeof authenticate !== 'function') throw new TypeError('createCatalogRouter requires an authenticate middleware');
  if (!Number.isInteger(servicesCacheMs) || servicesCacheMs < 0 || servicesCacheMs > MAX_SERVICES_CACHE_MS) {
    throw new TypeError(`servicesCacheMs must be an integer in [0, ${MAX_SERVICES_CACHE_MS}]`);
  }
  const servicesCache = new Map();
  let servicesGeneration = 0;
  function invalidateServices() {
    servicesGeneration += 1;
    servicesCache.clear();
  }

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
    const generation = servicesGeneration;
    const { rows } = await pool.query(
      `SELECT ${SERVICE_COLUMNS} FROM dispatch.services WHERE active ORDER BY code, id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const body = { items: rows.map(serviceDto), limit, offset };
    if (servicesCacheMs > 0 && generation === servicesGeneration) {
      if (!servicesCache.has(key) && servicesCache.size >= SERVICES_CACHE_ENTRIES) servicesCache.clear();
      servicesCache.set(key, { body, expiresAt: now() + servicesCacheMs });
    }
    return res.json(body);
  }));

  router.get('/api/services/:id', handle(async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query(
      `SELECT ${SERVICE_COLUMNS} FROM dispatch.services WHERE id = $1 AND active`,
      [id],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND');
    res.json({ service: serviceDto(rows[0]) });
  }));

  router.post('/api/services', authenticate, requireRoles('admin', 'provider'), handle(async (req, res) => {
    const input = validateServiceInput(req.body);
    const id = randomUUID();
    const code = `svc-${id.replaceAll('-', '')}`;
    const { rows: [row] } = await pool.query(`INSERT INTO dispatch.services
      (id, code, name, unit, price_per_ha_vnd, machine_type, active, description, data_label, created_by_user_id, updated_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'real-labelled', $9, $9) RETURNING ${SERVICE_COLUMNS}`,
    [id, code, input.name, input.unit, input.pricePerHaVnd, input.machineType, input.active ?? true, input.description, req.actor.id]);
    invalidateServices();
    res.status(201).json({ service: serviceDto(row) });
  }));

  function editService(deactivate) {
    return handle(async (req, res) => {
      const id = requireUuid(req.params.id);
      const input = deactivate ? { active: false } : validateServiceInput(req.body, true);
      const { rows: [row] } = await pool.query(`UPDATE dispatch.services SET name = COALESCE($4, name),
        unit = COALESCE($5, unit), price_per_ha_vnd = COALESCE($6, price_per_ha_vnd), active = COALESCE($7, active),
        description = CASE WHEN $8 THEN $9 ELSE description END, updated_at = now(), updated_by_user_id = $2
        WHERE id = $1 AND ($3 OR created_by_user_id = $2) RETURNING ${SERVICE_COLUMNS}`,
      [id, req.actor.id, req.actor.roles.includes('admin'), input.name, input.unit, input.pricePerHaVnd, input.active,
        input.description !== undefined, input.description]);
      if (!row) throw new ApiError(404, 'NOT_FOUND');
      invalidateServices();
      res.json({ service: serviceDto(row) });
    });
  }
  router.patch('/api/services/:id', authenticate, requireRoles('admin', 'provider'), editService(false));
  router.delete('/api/services/:id', authenticate, requireRoles('admin', 'provider'), editService(true));

  router.get('/api/fields', authenticate, requireRoles('farmer', 'coop'), handle(async (req, res) => {
    const { limit, offset } = parsePagination(req.query);
    const { rows } = await pool.query(
      `SELECT ${FIELD_COLUMNS} FROM dispatch.fields
        WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.set('Cache-Control', 'no-store').json({ items: rows.map(fieldDto), limit, offset });
  }));

  router.get('/api/fields/:id', authenticate, requireRoles('farmer', 'coop'), handle(async (req, res) => {
    const { rows: [row] } = await pool.query(`SELECT ${FIELD_COLUMNS} FROM dispatch.fields WHERE id = $1 AND owner_id = $2`,
      [requireUuid(req.params.id), req.actor.id]);
    if (!row) throw new ApiError(404, 'NOT_FOUND');
    res.set('Cache-Control', 'no-store').json({ field: fieldDto(row) });
  }));

  router.post('/api/fields', authenticate, requireRoles('farmer', 'coop'), handle(async (req, res) => {
    const input = validateFieldInput(req.body);
    const { rows: [row] } = await withFieldConsent(pool, req.actor.id, input, (db) => db.query(
      `INSERT INTO dispatch.fields (owner_id, name, locality, area_m2, province_code, commune_code,
        boundary_geojson, boundary, centroid_lat, centroid_lng, calculated_area_m2)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${FIELD_COLUMNS}`,
      [req.actor.id, ...fieldParams(input)],
    ));
    res.status(201).set('Cache-Control', 'no-store').json({ field: fieldDto(row) });
  }));

  router.patch('/api/fields/:id', authenticate, requireRoles('farmer', 'coop'), handle(async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = validateFieldInput(req.body, true);
    const { rows: [row] } = await withFieldConsent(pool, req.actor.id, input, (db) => db.query(
      `UPDATE dispatch.fields SET name = COALESCE($3, name), locality = COALESCE($4, locality),
        area_m2 = CASE WHEN $13 OR calculated_area_m2 IS NULL THEN COALESCE($5, area_m2) ELSE area_m2 END,
        province_code = CASE WHEN $14 THEN $6 ELSE province_code END,
        commune_code = CASE WHEN $14 THEN $7 ELSE commune_code END,
        boundary_geojson = CASE WHEN $13 THEN $8 ELSE boundary_geojson END,
        boundary = CASE WHEN $13 THEN $9 ELSE boundary END,
        centroid_lat = CASE WHEN $13 THEN $10 ELSE centroid_lat END,
        centroid_lng = CASE WHEN $13 THEN $11 ELSE centroid_lng END,
        calculated_area_m2 = CASE WHEN $13 THEN $12 ELSE calculated_area_m2 END, updated_at = now()
       WHERE id = $1 AND owner_id = $2 RETURNING ${FIELD_COLUMNS}`,
      [id, req.actor.id, ...fieldParams(input), input.boundaryGeojson !== undefined, input.provinceCode !== undefined],
    ));
    if (!row) throw new ApiError(404, 'NOT_FOUND');
    res.set('Cache-Control', 'no-store').json({ field: fieldDto(row) });
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
    unit: row.unit ?? 'ha',
    machineType: row.machine_type ?? null,
    active: row.active ?? true,
    description: row.description ?? null,
  };
}

function fieldDto(row) {
  return {
    id: row.id,
    name: row.name,
    locality: row.locality,
    areaM2: row.area_m2,
    ...areaInLocalUnits(row.area_m2),
    provinceCode: row.province_code ?? null,
    communeCode: row.commune_code ?? null,
    boundaryGeojson: row.boundary_geojson ?? null,
    centroid: Number.isFinite(row.centroid_lat) ? { lat: row.centroid_lat, lng: row.centroid_lng } : null,
    calculatedAreaM2: row.calculated_area_m2 ?? null,
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
