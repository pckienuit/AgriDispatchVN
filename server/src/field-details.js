import express from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSENT_VERSION = 'field-boundary-v1';
const MAX_VERTICES = 100;
const MAX_AREA_M2 = 10000000;
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

function intersects(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const on = (p, q, r) => Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0])
    && Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
  const abC = orient(a, b, c); const abD = orient(a, b, d);
  const cdA = orient(c, d, a); const cdB = orient(c, d, b);
  if (abC === 0 && on(a, c, b)) return true;
  if (abD === 0 && on(a, d, b)) return true;
  if (cdA === 0 && on(c, a, d)) return true;
  if (cdB === 0 && on(c, b, d)) return true;
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0));
}

// Equirectangular projection around ring centroid; suitable for bounded field polygons, not surveying.
export function calculatePolygonAreaM2(ring) {
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > MAX_VERTICES + 1) throw invalid('coordinates');
  const points = ring.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
      || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) throw invalid('coordinates');
    return point;
  });
  if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) throw invalid('coordinates');
  const unique = new Set(points.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`));
  if (unique.size !== points.length - 1) throw invalid('coordinates');
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = i + 1; j < points.length - 1; j += 1) {
      if (j === i + 1 || (i === 0 && j === points.length - 2)) continue;
      if (intersects(points[i], points[i + 1], points[j], points[j + 1])) throw invalid('coordinates');
    }
  }
  const lat0 = points.slice(0, -1).reduce((sum, point) => sum + point[1], 0) / (points.length - 1) * Math.PI / 180;
  const xy = points.map(([lon, lat]) => [lon * Math.PI / 180 * 6371008.8 * Math.cos(lat0), lat * Math.PI / 180 * 6371008.8]);
  let area = 0;
  for (let i = 0; i < xy.length - 1; i += 1) area += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
  const areaM2 = Math.round(Math.abs(area) / 2);
  if (areaM2 < 1 || areaM2 > MAX_AREA_M2) throw invalid('coordinates');
  return areaM2;
}

export function validateFieldDetailsInput(body) {
  assertObject(body);
  assertKeys(body, ['coordinates', 'access']);
  const areaM2 = body.coordinates === undefined ? null : calculatePolygonAreaM2(body.coordinates);
  if (body.access === undefined && areaM2 !== null) return { coordinates: body.coordinates, areaM2, access: null };
  const access = assertObject(body.access, 'access');
  assertKeys(access, ['roadWidthM', 'bridgeLoadT', 'soil', 'hasBoatDock']);
  const { roadWidthM, bridgeLoadT, soil, hasBoatDock } = access;
  if (![2.5, 3.5, 4.5].includes(roadWidthM)) throw invalid('roadWidthM');
  if (![4, 8, 12, null].includes(bridgeLoadT)) throw invalid('bridgeLoadT');
  if (!SOILS.has(soil)) throw invalid('soil');
  if (typeof hasBoatDock !== 'boolean') throw invalid('hasBoatDock');
  return { coordinates: body.coordinates, areaM2, access: { roadWidthM, bridgeLoadT, soil, hasBoatDock } };
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

  function protect(req, res, next) {
    if (!req.actor || !UUID.test(req.actor.id || '') || !Array.isArray(req.actor.roles)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
    if (!req.actor.roles.includes('farmer')) return res.status(403).json({ error: { code: 'FORBIDDEN' } });
    next();
  }
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

  router.get('/api/location-consent', authenticate, protect, handle(async (req, res) => {
    const { rows } = await pool.query('SELECT version, granted_at, withdrawn_at FROM dispatch.location_consents WHERE owner_id = $1', [req.actor.id]);
    const row = rows[0];
    res.set('Cache-Control', 'no-store').json({ consent: row && !row.withdrawn_at ? { version: row.version, grantedAt: row.granted_at } : null });
  }));
  router.post('/api/location-consent', authenticate, protect, handle(async (req, res) => {
    const { version } = validateLocationConsentInput(req.body);
    const { rows } = await pool.query(`INSERT INTO dispatch.location_consents (owner_id, version, granted_at, withdrawn_at)
      VALUES ($1, $2, clock_timestamp(), NULL) ON CONFLICT (owner_id) DO UPDATE
      SET granted_at = CASE WHEN location_consents.withdrawn_at IS NULL THEN location_consents.granted_at ELSE clock_timestamp() END,
          withdrawn_at = NULL
      RETURNING version, granted_at`, [req.actor.id, version]);
    res.status(201).set('Cache-Control', 'no-store').json({ consent: { version: rows[0].version, grantedAt: rows[0].granted_at } });
  }));
  router.delete('/api/location-consent', authenticate, protect, handle(async (req, res) => {
    await pool.query('UPDATE dispatch.location_consents SET withdrawn_at = now() WHERE owner_id = $1 AND withdrawn_at IS NULL', [req.actor.id]);
    res.set('Cache-Control', 'no-store').json({ consent: null, withdrawn: true });
  }));
  router.get('/api/fields/:id/details', authenticate, protect, handle(async (req, res) => {
    const fieldId = req.params.id;
    if (!UUID.test(fieldId || '')) throw new ApiError(400, 'INVALID_ID');
    const { rows: [row] } = await pool.query(`SELECT CASE WHEN c.owner_id IS NOT NULL THEN f.boundary END AS boundary,
      f.access_details, f.area_m2, c.owner_id IS NOT NULL AS consent
      FROM dispatch.fields f LEFT JOIN dispatch.location_consents c ON c.owner_id = f.owner_id AND c.withdrawn_at IS NULL
      WHERE f.id = $1 AND f.owner_id = $2`, [fieldId, req.actor.id]);
    if (!row) throw new ApiError(404, 'NOT_FOUND');
    res.set('Cache-Control', 'no-store').json({ details: { coordinates: row.boundary, access: row.access_details, areaM2: row.area_m2, locationConsent: row.consent } });

  }));
  router.put('/api/fields/:id/details', authenticate, protect, handle(async (req, res) => {
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
      const { rows } = await client.query(`UPDATE dispatch.fields SET boundary = $3::jsonb, access_details = COALESCE($4::jsonb, access_details), area_m2 = $5, updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING id, area_m2`, [fieldId, req.actor.id, JSON.stringify(input.coordinates), input.access ? JSON.stringify(input.access) : null, input.areaM2]);
      await client.query('COMMIT');
      res.set('Cache-Control', 'no-store').json({ field: rows[0] });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }));
  return router;
}
