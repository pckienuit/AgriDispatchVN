import express from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9-]{2,32}$/;
const TEXT = (value, max = 120) => typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= max;

class TerritoryError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => new TerritoryError(status, code);

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(400, 'INVALID_ID');
  return value.toLowerCase();
}

function assignmentInput(body) {
  const keys = ['provinceCode', 'provinceName', 'communeCode', 'communeName'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !keys.includes(key))) throw fail(400, 'INVALID_BODY');
  const provinceCode = typeof body.provinceCode === 'string' ? body.provinceCode.trim().toUpperCase() : '';
  const communeCode = typeof body.communeCode === 'string' ? body.communeCode.trim().toUpperCase() : '';
  const provinceName = typeof body.provinceName === 'string' ? body.provinceName.trim() : '';
  const communeName = typeof body.communeName === 'string' ? body.communeName.trim() : '';
  if (!CODE.test(provinceCode) || !CODE.test(communeCode) || !TEXT(provinceName) || !TEXT(communeName)) throw fail(400, 'VALIDATION_FAILED');
  return { provinceCode, provinceName, communeCode, communeName };
}

export function createCoopTerritoriesRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') throw new TypeError('createCoopTerritoriesRouter requires a pool with query() and connect()');
  if (typeof authenticate !== 'function') throw new TypeError('createCoopTerritoriesRouter requires an authenticate middleware');
  const router = express.Router();
  const handle = (roles, work) => async (req, res, next) => {
    try {
      const actor = req.actor;
      if (!actor || !UUID.test(actor.id || '') || !Array.isArray(actor.roles)) throw fail(401, 'UNAUTHENTICATED');
      if (!roles.some((role) => actor.roles.includes(role))) throw fail(403, 'FORBIDDEN');
      const result = await work(req, actor);
      res.set('Cache-Control', 'no-store');
      return res.status(result.status || 200).json(result.body);
    } catch (error) {
      if (error instanceof TerritoryError) return res.status(error.status).json({ error: { code: error.code } });
      if (error.code === '23505') return res.status(409).json({ error: { code: 'TERRITORY_ALREADY_ASSIGNED' } });
      if (error.code === '23001') return res.status(409).json({ error: { code: 'STATE_CHANGED' } });
      if (/^(08|57P01|53300|ECONN|ETIMEDOUT)/.test(error.code || '')) return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
      return next(error);
    }
  };

  router.get('/api/admin/coops', authenticate, handle(['admin'], async () => {
    const { rows } = await pool.query(
      `SELECT u.id AS "userId", u.name AS "userName"
         FROM account.users u JOIN account.user_roles r ON r.user_id=u.id
        WHERE r.role='coop' ORDER BY u.name, u.id`);
    return { body: { items: rows } };
  }));

  router.get('/api/admin/coops/:coopId/territories', authenticate, handle(['admin'], async (req) => {
    const coopId = id(req.params.coopId);
    const { rows } = await pool.query(
      `SELECT id, coop_id AS "coopId", province_code AS "provinceCode", province_name AS "provinceName",
              commune_code AS "communeCode", commune_name AS "communeName", assigned_at AS "assignedAt"
         FROM dispatch.commune_territories WHERE coop_id=$1 AND removed_at IS NULL
        ORDER BY province_name, commune_name, id`, [coopId]);
    return { body: { items: rows } };
  }));

  router.post('/api/admin/coops/:coopId/territories', authenticate, handle(['admin'], async (req, actor) => {
    const coopId = id(req.params.coopId);
    const input = assignmentInput(req.body);
    const { rows: coopRows } = await pool.query("SELECT 1 FROM account.user_roles WHERE user_id=$1 AND role='coop'", [coopId]);
    if (!coopRows.length) throw fail(404, 'NOT_FOUND');
    const { rows } = await pool.query(
      `INSERT INTO dispatch.commune_territories (coop_id, province_code, province_name, commune_code, commune_name, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, coop_id AS "coopId", province_code AS "provinceCode", province_name AS "provinceName",
                 commune_code AS "communeCode", commune_name AS "communeName", assigned_at AS "assignedAt"`,
      [coopId, input.provinceCode, input.provinceName, input.communeCode, input.communeName, actor.id]);
    return { status: 201, body: { territory: rows[0] } };
  }));

  router.delete('/api/admin/coops/:coopId/territories/:id', authenticate, handle(['admin'], async (req, actor) => {
    const coopId = id(req.params.coopId);
    const assignmentId = id(req.params.id);
    const { rows } = await pool.query(
      `UPDATE dispatch.commune_territories SET removed_at=now(), removed_by=$3
        WHERE id=$1 AND coop_id=$2 AND removed_at IS NULL
        RETURNING id`, [assignmentId, coopId, actor.id]);
    if (!rows.length) throw fail(404, 'NOT_FOUND');
    return { body: { removed: true, id: rows[0].id } };
  }));

  router.get('/api/htx/territories/overview', authenticate, handle(['coop'], async (_req, actor) => {
    const { rows } = await pool.query(
      `SELECT province_code AS "provinceCode", province_name AS "provinceName",
              commune_code AS "communeCode", commune_name AS "communeName"
         FROM dispatch.commune_territories
        WHERE coop_id=$1 AND removed_at IS NULL
        ORDER BY province_name, commune_name`, [actor.id]);
    const explicit = await pool.query(
      `SELECT count(*)::int AS "bookingCount",
              count(*) FILTER (WHERE state='REQUESTED')::int AS "requestedCount",
              count(*) FILTER (WHERE state='GROUPED')::int AS "groupedCount",
              count(*) FILTER (WHERE state='ASSIGNED')::int AS "assignedCount",
              count(*) FILTER (WHERE state='CANCELLED')::int AS "cancelledCount"
         FROM dispatch.bookings WHERE coordinator_id=$1`, [actor.id]);
    return { body: { communes: rows, delegated: explicit.rows[0], scope: 'ASSIGNED_COMMUNES_AND_EXPLICIT_DELEGATIONS', directorySource: 'ADMIN_ENTERED' } };
  }));
  return router;
}
