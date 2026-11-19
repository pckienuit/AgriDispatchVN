import express from 'express';
import { parsePagination } from './catalog.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^[1-9][0-9]{0,14}$/;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
function body(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'INVALID_BODY');
  if (Object.keys(value).some((key) => !keys.includes(key))) throw fail(400, 'UNKNOWN_FIELD');
  return value;
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max) throw fail(400, 'VALIDATION_FAILED');
  return value.trim();
}
export function validateWorkforceProfile(input) {
  const value = body(input, ['skills', 'certifications']);
  if (!Array.isArray(value.skills) || value.skills.length > 30) throw fail(400, 'VALIDATION_FAILED');
  const skills = [...new Set(value.skills.map((skill) => text(skill, 80)))];
  if (!Array.isArray(value.certifications) || value.certifications.length > 30) throw fail(400, 'VALIDATION_FAILED');
  const certifications = value.certifications.map((item) => {
    body(item, ['name', 'expiresAt']);
    if (typeof item.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.expiresAt) || Number.isNaN(Date.parse(`${item.expiresAt}T00:00:00Z`)) || new Date(`${item.expiresAt}T00:00:00Z`).toISOString().slice(0, 10) !== item.expiresAt) throw fail(400, 'VALIDATION_FAILED');
    return { name: text(item.name, 120), expiresAt: item.expiresAt };
  });
  return { skills, certifications };
}
export function validateWageReport(input) {
  const value = body(input, ['amountVnd', 'note']);
  if (typeof value.amountVnd !== 'string' || !MONEY.test(value.amountVnd)) throw fail(400, 'VALIDATION_FAILED');
  return { amountVnd: value.amountVnd, note: value.note === undefined ? null : text(value.note, 500) };
}
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw fail(400, 'INVALID_ID'); return value.toLowerCase(); }
async function tx(pool, work) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}
export function createWorkforceRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function' || typeof authenticate !== 'function') throw new TypeError('Workforce router requires pool and authenticate');
  const router = express.Router();
  const handle = (roles, work) => async (req, res, next) => {
    try {
      if (!req.actor || !UUID.test(req.actor.id) || !req.actor.roles.some((r) => roles.includes(r))) throw fail(req.actor ? 403 : 401, req.actor ? 'FORBIDDEN' : 'UNAUTHENTICATED');
      res.json(await work(req));
    } catch (e) { if (e.status) res.status(e.status).json({ error: { code: e.code } }); else next(e); }
  };
  router.get('/api/workforce/profile', authenticate, handle(['operator'], async (req) => {
    const { rows } = await pool.query(`SELECT p.skills, c.id, c.name, c.expires_on::text AS expires_on, c.verification_status, c.reviewed_at, c.created_at FROM dispatch.operator_profiles p LEFT JOIN dispatch.operator_certifications c ON c.operator_id=p.operator_id WHERE p.operator_id=$1 ORDER BY c.created_at`, [req.actor.id]);
    const certifications = rows.filter((r) => r.id).map((r) => ({ id:r.id, name:r.name, expiresAt:r.expires_on, verificationStatus:r.verification_status, reviewedAt:r.reviewed_at?.toISOString() ?? null, createdAt:r.created_at.toISOString() }));
    return { profile: { skills: rows[0]?.skills ?? [], certifications } };
  }));
  router.put('/api/workforce/profile', authenticate, handle(['operator'], async (req) => {
    const profile = validateWorkforceProfile(req.body);
    await tx(pool, async (c) => {
      await c.query('INSERT INTO dispatch.operator_profiles(operator_id,skills) VALUES($1,$2) ON CONFLICT(operator_id) DO UPDATE SET skills=EXCLUDED.skills,updated_at=now()', [req.actor.id, profile.skills]);
      // ponytail: any prior row with same name+expiry (incl. REJECTED) blocks re-insert; a rejected cert cannot re-enter as UNVERIFIED via re-save. Upgrade path: explicit re-declare with new expiry.
      for (const cert of profile.certifications) await c.query('INSERT INTO dispatch.operator_certifications(operator_id,name,expires_on) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM dispatch.operator_certifications WHERE operator_id=$1 AND name=$2 AND expires_on=$3)', [req.actor.id, cert.name, cert.expiresAt]);
    });
    return { profile: { skills: profile.skills, certifications: [] } };
  }));
  router.get('/api/workforce/operators/:id', authenticate, handle(['provider'], async (req) => {
    const operatorId = id(req.params.id);
    const allowed = await pool.query(`SELECT 1 FROM dispatch.offers o JOIN dispatch.jobs j ON j.id=o.job_id WHERE o.operator_id=$1 AND j.provider_id=$2 AND o.status='ACCEPTED' LIMIT 1`, [operatorId, req.actor.id]);
    if (!allowed.rowCount) throw fail(404, 'NOT_FOUND');
    const { rows } = await pool.query(`SELECT p.skills,c.id,c.name,c.expires_on::text AS expires_on,c.verification_status,c.reviewed_at FROM dispatch.operator_profiles p LEFT JOIN dispatch.operator_certifications c ON c.operator_id=p.operator_id WHERE p.operator_id=$1 ORDER BY c.created_at`, [operatorId]);
    return { profile: { skills: rows[0]?.skills ?? [], certifications: rows.filter((r) => r.id).map((r) => ({ id:r.id, name:r.name, expiresAt:r.expires_on, verificationStatus:r.verification_status, reviewedAt:r.reviewed_at?.toISOString() ?? null })) } };
  }));
  router.get('/api/admin/workforce/certifications', authenticate, handle(['admin'], async (req) => {
    const { limit, offset } = parsePagination(req.query);
    const { rows } = await pool.query(`SELECT c.*,c.expires_on::text AS expires_on,p.skills FROM dispatch.operator_certifications c LEFT JOIN dispatch.operator_profiles p ON p.operator_id=c.operator_id ORDER BY c.created_at DESC,c.id LIMIT $1 OFFSET $2`, [limit, offset]);
    return { items: rows.map((r) => ({ id:r.id, operatorId:r.operator_id, name:r.name, expiresAt:r.expires_on, verificationStatus:r.verification_status, reviewedAt:r.reviewed_at?.toISOString() ?? null, skills:r.skills ?? [] })), limit, offset };
  }));
  router.post('/api/admin/workforce/certifications/:id/review', authenticate, handle(['admin'], async (req) => {
    const certId=id(req.params.id), { status }=body(req.body,['status']);
    if (!['VERIFIED','REJECTED'].includes(status)) throw fail(400,'VALIDATION_FAILED');
    const { rows }=await pool.query('UPDATE dispatch.operator_certifications SET verification_status=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1 AND verification_status=\'UNVERIFIED\' RETURNING id,verification_status,reviewed_at',[certId,status,req.actor.id]);
    if (!rows[0]) throw fail(404,'NOT_FOUND');
    return { certification: { id:rows[0].id, verificationStatus:rows[0].verification_status, reviewedAt:rows[0].reviewed_at.toISOString() } };
  }));
  router.get('/api/workforce/wages', authenticate, handle(['operator','provider'], async (req) => {
    const { limit, offset }=parsePagination(req.query);
    const { rows }=await pool.query(`SELECT r.*,s.status AS shift_status,(SELECT count(*) FROM dispatch.shift_wage_acknowledgments a WHERE a.report_id=r.id) AS acknowledgments FROM dispatch.shift_wage_reports r JOIN dispatch.shifts s ON s.id=r.shift_id WHERE $1 IN (r.operator_id,r.provider_id) ORDER BY r.reported_at DESC LIMIT $2 OFFSET $3`,[req.actor.id,limit,offset]);
    return { items:rows.map(r=>({id:r.id,shiftId:r.shift_id,reportedBy:r.reported_by,amountVnd:String(r.amount_vnd),note:r.note,reportedAt:r.reported_at.toISOString(),shiftStatus:r.shift_status,acknowledged:Number(r.acknowledgments)>0})),limit,offset };
  }));
  router.post('/api/shifts/:id/wage-report', authenticate, handle(['operator','provider'], async (req) => {
    if (!req.actor.roles.includes('provider')) throw fail(403, 'FORBIDDEN');
    const shiftId=id(req.params.id), wage=validateWageReport(req.body);
    return tx(pool,async c=>{
    const {rows}=await c.query(`SELECT s.status,p.operator_id,p.provider_id FROM dispatch.shifts s JOIN dispatch.packages p ON p.id=s.package_id WHERE s.id=$1 AND p.provider_id=$2 FOR UPDATE OF s`,[shiftId,req.actor.id]);
      if(!rows[0])throw fail(404,'NOT_FOUND'); if(rows[0].status!=='COMPLETED')throw fail(409,'SHIFT_NOT_COMPLETED');
      const prior=await c.query('SELECT id FROM dispatch.shift_wage_reports WHERE shift_id=$1',[shiftId]);if(prior.rows[0])throw fail(409,'WAGE_REPORT_EXISTS');
      const {rows:created}=await c.query('INSERT INTO dispatch.shift_wage_reports(shift_id,operator_id,provider_id,reported_by,amount_vnd,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,reported_at',[shiftId,rows[0].operator_id,rows[0].provider_id,req.actor.id,wage.amountVnd,wage.note]);
      return {report:{id:created[0].id,shiftId,reportedBy:req.actor.id,amountVnd:wage.amountVnd,note:wage.note,reportedAt:created[0].reported_at.toISOString(),acknowledged:false}};
    });
  }));
  router.post('/api/wage-reports/:id/acknowledge', authenticate, handle(['operator','provider'], async (req) => {
    const reportId=id(req.params.id); body(req.body,[]);
    const {rows}=await pool.query('INSERT INTO dispatch.shift_wage_acknowledgments(report_id,actor_id) SELECT r.id,$2 FROM dispatch.shift_wage_reports r WHERE r.id=$1 AND $2 IN (r.operator_id,r.provider_id) AND r.reported_by<>$2 ON CONFLICT DO NOTHING RETURNING report_id',[reportId,req.actor.id]);
    if(!rows.length)throw fail(404,'NOT_FOUND'); return { acknowledgment:{reportId,acknowledged:true} };
  }));
  return router;
}
