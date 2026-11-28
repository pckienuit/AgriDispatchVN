import express from 'express';
import { parsePagination } from './catalog.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PLATFORM_PARAMETER_DEFAULTS = { clusterMinHa: 15, clusterTargetHa: 20, clusterMaxHa: 50, droneMinHa: 20, radiusM: 1500, dtDays: 2, tier1Km: 30, tier2Km: 40, round1Hours: 2, basePerHa: 1500000, muddyPerHa: 300000, lodgedPerHa: 400000, lodgedThresholdPct: 30, dieselBase: 20000, dieselNow: 21500, dieselLitersPerHa: 14, depositPct: 10, depositHours: 12, disputeHours: 12, platformFeePct: 2.5, hubCommissionPct: 4 };
const PARAMS = {
  clusterMinHa: [0.1, 10000], clusterTargetHa: [0.1, 10000], clusterMaxHa: [0.1, 10000],
  droneMinHa: [0.1, 10000], radiusM: [1, 100000], dtDays: [0, 365], tier1Km: [0, 1000], tier2Km: [0, 1000],
  round1Hours: [0, 168], basePerHa: [0, 100000000], muddyPerHa: [0, 100000000], lodgedPerHa: [0, 100000000],
  lodgedThresholdPct: [0, 100], dieselBase: [0, 1000000], dieselNow: [0, 1000000], dieselLitersPerHa: [0, 1000],
  depositPct: [0, 100], depositHours: [0, 720], disputeHours: [0, 720], platformFeePct: [0, 100], hubCommissionPct: [0, 100],
};
const fail = (res, status, code) => res.status(status).json({ error: { code } });
const actorOk = (actor) => actor && UUID.test(actor.id || '') && Array.isArray(actor.roles);
const adminOnly = (req, res, next) => !actorOk(req.actor) ? fail(res, 401, 'UNAUTHENTICATED') : !req.actor.roles.includes('admin') ? fail(res, 403, 'FORBIDDEN') : next();
const authenticated = (req, res, next) => !actorOk(req.actor) ? fail(res, 401, 'UNAUTHENTICATED') : next();
const validValues = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length > 0 && Object.entries(value).every(([key, n]) => Object.hasOwn(PARAMS, key)
    && typeof n === 'number' && Number.isFinite(n) && n >= PARAMS[key][0] && n <= PARAMS[key][1]);

export function validatePlatformParameters(values) {
  if (!validValues(values)) throw Object.assign(new Error('VALIDATION_FAILED'), { status: 400, code: 'VALIDATION_FAILED' });
  return { ...values };
}

export function createPlatformControlsRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function') throw new TypeError('createPlatformControlsRouter requires pool.query()');
  if (typeof authenticate !== 'function') throw new TypeError('createPlatformControlsRouter requires authenticate middleware');
  const router = express.Router();
  const handle = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { if (e.status) fail(res, e.status, e.code); else next(e); } };
  const event = (client, actorId, type, entityId, details) => client.query(
    'INSERT INTO dispatch.platform_control_events(actor_id,event_type,entity_id,details) VALUES($1,$2,$3,$4)',
    [actorId, type, entityId, JSON.stringify(details)],
  );
  const loadEffective = async () => {
    const { rows } = await pool.query('SELECT version, parameters, changed_by, note, created_at FROM dispatch.platform_parameter_versions ORDER BY version DESC LIMIT 1');
    return rows[0] ? { version: rows[0].version, values: { ...PLATFORM_PARAMETER_DEFAULTS, ...rows[0].parameters }, changedBy: rows[0].changed_by, note: rows[0].note, createdAt: rows[0].created_at, assumptions: true } : { version: 0, values: PLATFORM_PARAMETER_DEFAULTS, changedBy: null, note: 'Mặc định giả định, chưa được quản trị viên lưu.', createdAt: null, assumptions: true };
  };
  // Effective read contract for clustering/quote clients. No fees are charged by this endpoint.
  router.get('/api/platform-parameters', handle(async (_req, res) => res.set('Cache-Control', 'no-store').json({ effective: await loadEffective() })));
  router.get('/api/admin/platform-parameters', authenticate, adminOnly, handle(async (_req, res) => {
    const [effective, { rows: history }] = await Promise.all([
      loadEffective(),
      pool.query('SELECT version, parameters, changed_by, note, created_at FROM dispatch.platform_parameter_versions ORDER BY version DESC LIMIT 100'),
    ]);
    res.set('Cache-Control', 'no-store').json({ effective, history });
  }));

  router.put('/api/admin/platform-parameters', authenticate, adminOnly, handle(async (req, res) => {
    const values = validatePlatformParameters(req.body?.values);
    if (typeof req.body.note !== 'string' || !req.body.note.trim() || [...req.body.note.trim()].length > 500) return fail(res, 400, 'VALIDATION_FAILED');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('INSERT INTO dispatch.platform_parameter_versions(parameters,changed_by,note) VALUES($1,$2,$3) RETURNING version,parameters,changed_by,note,created_at', [JSON.stringify(values), req.actor.id, req.body.note.trim()]);
      await event(client, req.actor.id, 'PARAMETERS_CHANGED', null, { version: rows[0].version, keys: Object.keys(values) });
      await client.query('COMMIT');
      res.status(201).json({ effective: { ...rows[0], values: { ...PLATFORM_PARAMETER_DEFAULTS, ...values } } });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));
  // Operator report action contract for O-04: POST /api/jobs/:id/reports {reason}; report does not change job or actor status.
  router.post('/api/jobs/:id/reports', authenticate, authenticated, handle(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 400, 'INVALID_ID');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || [...reason].length > 1000) return fail(res, 400, 'VALIDATION_FAILED');
    if (!req.actor.roles.includes('operator') || req.actor.roles.includes('admin')) return fail(res, 403, 'REPORTER_NOT_ALLOWED');
    if (!UUID.test(req.actor.id)) return fail(res, 401, 'UNAUTHENTICATED');
    if (!UUID.test(req.params.id)) return fail(res, 400, 'INVALID_ID');
    if (!req.body || Object.keys(req.body).some((key) => key !== 'reason')) return fail(res, 400, 'UNKNOWN_FIELD');
    if (typeof req.body.reason !== 'string') return fail(res, 400, 'VALIDATION_FAILED');
    const { rows: reportRows } = await pool.query(`INSERT INTO dispatch.job_reports(job_id,reporter_id,reason)
      SELECT id,$2,$3 FROM dispatch.jobs WHERE id=$1 AND status='OPEN' AND provider_id<>$2
      RETURNING id,job_id,reporter_id,reason,status,created_at`, [req.params.id, req.actor.id, reason]);
    if (!reportRows.length) return fail(res, 409, 'JOB_NOT_REPORTABLE');
    res.status(201).json({ report: reportRows[0] });
  }));
  router.get('/api/admin/job-reports', authenticate, adminOnly, handle(async (req, res) => {
    let page; try { page = parsePagination(req.query); } catch (e) { return fail(res, e.status || 400, e.code || 'INVALID_PAGINATION'); }
    const { rows } = await pool.query(`SELECT r.id,r.job_id,r.reporter_id,r.reason,r.status,r.reviewed_by,r.review_note,r.reviewed_at,r.created_at,j.title,j.status AS job_status
      FROM dispatch.job_reports r JOIN dispatch.jobs j ON j.id=r.job_id ORDER BY (r.status='OPEN') DESC,r.created_at DESC,r.id DESC LIMIT $1 OFFSET $2`, [page.limit,page.offset]);
    res.set('Cache-Control','no-store').json({ items: rows, limit: page.limit, offset: page.offset });
  }));
  router.post('/api/admin/job-reports/:id/review', authenticate, adminOnly, handle(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 400, 'INVALID_ID');
    const { status, note } = req.body || {};
    if (!['REVIEWED','DISMISSED'].includes(status) || typeof note !== 'string' || [...note.trim()].length > 1000) return fail(res, 400, 'VALIDATION_FAILED');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`UPDATE dispatch.job_reports r SET status=$2,reviewed_by=$3,review_note=NULLIF($4,''),reviewed_at=now()
        WHERE r.id=$1 AND r.status='OPEN' AND r.reporter_id<>$3 AND EXISTS (SELECT 1 FROM dispatch.jobs j WHERE j.id=r.job_id AND j.provider_id<>$3) RETURNING r.id`, [req.params.id,status,req.actor.id,note.trim()]);
      if (!result.rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'REPORT_NOT_REVIEWABLE_OR_CONFLICT'); }
      await client.query('INSERT INTO dispatch.platform_control_events(actor_id,event_type,entity_id,details) VALUES($1,$2,$3,$4)', [req.actor.id,'JOB_REPORT_REVIEWED',req.params.id,JSON.stringify({ status })]);
      await client.query('COMMIT');
      res.json({ id: req.params.id, status });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));
  router.post('/api/admin/jobs/:id/close', authenticate, adminOnly, handle(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 400, 'INVALID_ID');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || [...reason].length > 1000) return fail(res, 400, 'VALIDATION_FAILED');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query("UPDATE dispatch.jobs SET status='CLOSED',closed_at=now(),updated_at=now() WHERE id=$1 AND status='OPEN' RETURNING id,status,closed_at", [req.params.id]);
      if (!rows.length) { await client.query('ROLLBACK'); return fail(res, 409, 'JOB_NOT_OPEN'); }
      await client.query("INSERT INTO dispatch.recruitment_events(entity_type,entity_id,action,actor_id,from_status,to_status) VALUES('job',$1,'job.closed',$2,'OPEN','CLOSED')", [req.params.id,req.actor.id]);
      await event(client,req.actor.id,'JOB_CLOSED',req.params.id,{ reason });
      await client.query('COMMIT');
      res.json({ job: rows[0] });
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));
  router.get('/api/admin/compliance-status', authenticate, adminOnly, handle(async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM (
      SELECT 'recruitment' AS source, entity_type, entity_id, action, actor_id, from_status, to_status, created_at FROM dispatch.recruitment_events
      UNION ALL SELECT 'control',event_type,entity_id,event_type,actor_id,NULL,event_type,created_at FROM dispatch.platform_control_events
      UNION ALL SELECT 'job_report', 'job_report', id, status, reporter_id, 'OPEN', status, created_at FROM dispatch.job_reports
    ) events ORDER BY created_at DESC LIMIT 200`);
    res.set('Cache-Control','no-store').json({ status: 'OBSERVATIONAL_ONLY', legalCertification: false, items: rows });
  }));
  return router;
}
