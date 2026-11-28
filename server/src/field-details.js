import express from 'express';
import { measurePolygon } from './gis-geometry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSENT_VERSION = 'field-boundary-v1';
const SOILS = new Set(['firm', 'soft', 'boggy']);

class ApiError extends Error {
  constructor(status, code, field) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
  }

  body() {
    return { error: { code: this.code, ...(this.field ? { field: this.field } : {}) } };
  }
}

function invalid(field) {
  return new ApiError(400, 'VALIDATION_FAILED', field);
}

function assertObject(value, field = undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
  return value;
}

function assertKeys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ApiError(400, 'UNKNOWN_FIELD');
}

function measureRing(ring) {
  try { return measurePolygon({ type: 'Polygon', coordinates: [ring] }); }
  catch (error) {
    if (error.field === 'boundaryGeojson') throw invalid('coordinates');
    throw error;
  }
}

export function calculatePolygonAreaM2(ring) {
  return measureRing(ring).calculatedAreaM2;
}

export function validateFieldDetailsInput(body) {
  assertObject(body);
  assertKeys(body, ['coordinates', 'access']);
  const metrics = body.coordinates === undefined ? null : measureRing(body.coordinates);
  const areaM2 = metrics?.calculatedAreaM2 ?? null;
  if (body.access === undefined && metrics) return { coordinates: body.coordinates, areaM2, centroid: metrics.centroid, access: null };
  const access = assertObject(body.access, 'access');
  assertKeys(access, ['roadWidthM', 'bridgeLoadT', 'soil', 'hasBoatDock']);
  const { roadWidthM, bridgeLoadT, soil, hasBoatDock } = access;
  if (![2.5, 3.5, 4.5].includes(roadWidthM)) throw invalid('roadWidthM');
  if (![4, 8, 12, null].includes(bridgeLoadT)) throw invalid('bridgeLoadT');
  if (!SOILS.has(soil)) throw invalid('soil');
  if (typeof hasBoatDock !== 'boolean') throw invalid('hasBoatDock');
  return { coordinates: body.coordinates, areaM2, centroid: metrics?.centroid, access: { roadWidthM, bridgeLoadT, soil, hasBoatDock } };
}

export function validateLocationConsentInput(body) {
  assertObject(body);
  assertKeys(body, ['consent', 'version']);
  if (body.consent !== true || body.version !== CONSENT_VERSION) throw invalid('consent');
  return { version: CONSENT_VERSION };
}

export function createFieldDetailsRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') throw new TypeError('createFieldDetailsRouter requires a pool with query() and connect()');
  if (typeof authenticate !== 'function') throw new TypeError('createFieldDetailsRouter requires an authenticate middleware');
  const router = express.Router();

  const protect = (allowCoop = false) => (req, res, next) => {
    if (!req.actor || !UUID.test(req.actor.id || '') || !Array.isArray(req.actor.roles)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
    if (!req.actor.roles.includes('farmer') && !(allowCoop && req.actor.roles.includes('coop'))) return res.status(403).json({ error: { code: 'FORBIDDEN' } });
    next();
  };
  const handle = (work) => async (req, res, next) => {
    try { await work(req, res); } catch (error) {
      if (error instanceof ApiError) return res.status(error.status).json(error.body());
      if (/^(08|23)/.test(error.code || '') || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
      return next(error);
    }
  };
  const owner = async (client, fieldId, userId, lock = false) => {
    if (!UUID.test(fieldId || '')) throw new ApiError(400, 'INVALID_ID');
    const result = await client.query(`SELECT id FROM dispatch.fields WHERE id = $1 AND owner_id = $2${lock ? ' FOR UPDATE' : ''}`, [fieldId, userId]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  };

  router.get('/api/location-consent', authenticate, protect(true), handle(async (req, res) => {
    const { rows } = await pool.query('SELECT version, granted_at, withdrawn_at FROM dispatch.location_consents WHERE owner_id = $1', [req.actor.id]);
    const row = rows[0];
    res.set('Cache-Control', 'no-store').json({ consent: row && !row.withdrawn_at ? { version: row.version, grantedAt: row.granted_at } : null });
  }));
  router.post('/api/location-consent', authenticate, protect(true), handle(async (req, res) => {
    const { version } = validateLocationConsentInput(req.body);
    const { rows } = await pool.query(`INSERT INTO dispatch.location_consents (owner_id, version, granted_at, withdrawn_at)
      VALUES ($1, $2, clock_timestamp(), NULL) ON CONFLICT (owner_id) DO UPDATE
      SET granted_at = CASE WHEN location_consents.withdrawn_at IS NULL THEN location_consents.granted_at ELSE clock_timestamp() END,
          withdrawn_at = NULL
      RETURNING version, granted_at`, [req.actor.id, version]);
    res.status(201).set('Cache-Control', 'no-store').json({ consent: { version: rows[0].version, grantedAt: rows[0].granted_at } });
  }));
  router.delete('/api/location-consent', authenticate, protect(true), handle(async (req, res) => {
    await pool.query('UPDATE dispatch.location_consents SET withdrawn_at = now() WHERE owner_id = $1 AND withdrawn_at IS NULL', [req.actor.id]);
    res.set('Cache-Control', 'no-store').json({ consent: null, withdrawn: true });
  }));
  router.get('/api/fields/:id/details', authenticate, protect(), handle(async (req, res) => {
    const fieldId = req.params.id;
    if (!UUID.test(fieldId || '')) throw new ApiError(400, 'INVALID_ID');
    const { rows: [row] } = await pool.query(`SELECT CASE WHEN c.owner_id IS NOT NULL THEN f.boundary END AS boundary,
      f.access_details, f.area_m2, c.owner_id IS NOT NULL AS consent
      FROM dispatch.fields f LEFT JOIN dispatch.location_consents c ON c.owner_id = f.owner_id AND c.withdrawn_at IS NULL
      WHERE f.id = $1 AND f.owner_id = $2`, [fieldId, req.actor.id]);
    if (!row) throw new ApiError(404, 'NOT_FOUND');
    res.set('Cache-Control', 'no-store').json({ details: { coordinates: row.boundary, access: row.access_details, areaM2: row.area_m2, locationConsent: row.consent } });

  }));
  router.put('/api/fields/:id/details', authenticate, protect(), handle(async (req, res) => {
    const fieldId = req.params.id;
    if (!UUID.test(fieldId || '')) throw new ApiError(400, 'INVALID_ID');
    const input = validateFieldDetailsInput(req.body);
    // Access-only edits leave the boundary and measured or manually entered area intact.
    if (input.coordinates === undefined) {
      const { rows } = await pool.query(`UPDATE dispatch.fields SET access_details = $3::jsonb, updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING id, area_m2`, [fieldId, req.actor.id, JSON.stringify(input.access)]);
      if (!rows.length) throw new ApiError(404, 'NOT_FOUND');
      return res.set('Cache-Control', 'no-store').json({ field: rows[0] });
    }
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      // Lock consent before the field, matching withdrawal's lock order.
      const { rows: grants } = await client.query('SELECT withdrawn_at FROM dispatch.location_consents WHERE owner_id = $1 FOR UPDATE', [req.actor.id]);
      await owner(client, fieldId, req.actor.id, true);
      if (!grants[0] || grants[0].withdrawn_at) throw new ApiError(403, 'LOCATION_CONSENT_REQUIRED');
      const { rows } = await client.query(`UPDATE dispatch.fields
        SET boundary = $3::jsonb, boundary_geojson = jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array($3::jsonb)),
          access_details = COALESCE($4::jsonb, access_details), area_m2 = $5, calculated_area_m2 = $5,
          centroid_lat = $6, centroid_lng = $7, updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING id, area_m2`,
      [fieldId, req.actor.id, JSON.stringify(input.coordinates), input.access ? JSON.stringify(input.access) : null,
        input.areaM2, input.centroid.lat, input.centroid.lng]);
      await client.query('COMMIT');
      res.set('Cache-Control', 'no-store').json({ field: rows[0] });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }));
  return router;
}
