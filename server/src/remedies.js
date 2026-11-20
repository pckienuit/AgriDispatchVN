import express from 'express';
import { canReviewDispute, isActiveMediatorIndependent } from './disputes.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
function identifier(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw fail(400, 'INVALID_ID');
  return value.toLowerCase();
}
function input(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'INVALID_BODY');
  if (Object.keys(value).some((key) => !keys.includes(key))) throw fail(400, 'UNKNOWN_FIELD');
  return value;
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 2000) throw fail(400, 'VALIDATION_FAILED');
  return value.trim();
}
async function transaction(pool, work) {
  const c = await pool.connect(); let broken = false;
  try { await c.query('BEGIN'); const result = await work(c); await c.query('COMMIT'); return result; }
  catch (error) { try { await c.query('ROLLBACK'); } catch { broken = true; } throw error; }
  finally { c.release(broken); }
}
async function lockedCase(c, disputeId) {
  const initial = (await c.query('SELECT booking_id FROM dispatch.disputes WHERE id=$1', [disputeId])).rows[0];
  if (!initial) throw fail(404, 'NOT_FOUND');
  // Same booking-first lock order as acceptance and opening a dispute.
  await c.query('SELECT id FROM dispatch.bookings WHERE id=$1 FOR UPDATE', [initial.booking_id]);
  return (await c.query('SELECT * FROM dispatch.disputes WHERE id=$1 FOR UPDATE', [disputeId])).rows[0];
}
async function independent(c, d, actor) {
  if (actor.id !== d.mediator_id) throw fail(404, 'NOT_FOUND');
  if (!(await isActiveMediatorIndependent(c, d, actor.id))) throw fail(403, 'RECUSAL_REQUIRED');
}
const current = async (c, id) => (await c.query('SELECT * FROM dispatch.remedy_proposals WHERE dispute_id=$1 ORDER BY version DESC LIMIT 1', [id])).rows[0];
const dto = (d) => ({ id: d.id, bookingId: d.booking_id, status: d.status, closedAt: d.closed_at?.toISOString() ?? null, closureReason: d.closure_reason, obligationsDisputed: d.status === 'CLOSED_UNRESOLVED' });
async function event(c, d, actor, type, version = null, details = null) {
  await c.query('INSERT INTO dispatch.remedy_events(dispute_id,actor_id,event_type,version,details) VALUES($1,$2,$3,$4,$5)', [d.id, actor.id, type, version, details]);
}
export function createRemedyRouter({ pool, authenticate }) {
  if (typeof pool?.connect !== 'function' || typeof authenticate !== 'function') throw new TypeError('Remedies require pool and authentication');
  const router = express.Router();
  const handle = (work) => async (req, res, next) => {
    try {
      if (!req.actor || !uuid.test(req.actor.id) || !Array.isArray(req.actor.roles)) throw fail(401, 'UNAUTHENTICATED');
      const result = await transaction(pool, (c) => work(c, req));
      res.status(result.status ?? 200).json(result.body);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: { code: error.code } });
      if (error.code === '23001') return res.status(409).json({ error: { code: 'STATE_CHANGED' } });
      return next(error);
    }
  };
  router.post('/api/disputes/:id/proposals', authenticate, handle(async (c, req) => {
    if (!req.actor.roles.some((role) => role === 'admin' || role === 'coop')) throw fail(403, 'FORBIDDEN');
    const proposalText = text(input(req.body, ['text']).text);
    const d = await lockedCase(c, identifier(req.params.id));
    await independent(c, d, req.actor);
    if (d.status !== 'OPEN') throw fail(409, 'DISPUTE_NOT_OPEN');
    const latest = await current(c, d.id);
    const version = (latest?.version ?? 0) + 1;
    await c.query('INSERT INTO dispatch.remedy_proposals(dispute_id,version,mediator_id,text) VALUES($1,$2,$3,$4)', [d.id, version, req.actor.id, proposalText]);
    await event(c, d, req.actor, 'PROPOSED', version);
    return { status: 201, body: { proposal: { version, text: proposalText }, dispute: dto(d) } };
  }));
  router.post('/api/disputes/:id/proposals/:version/consent', authenticate, handle(async (c, req) => {
    input(req.body ?? {}, []);
    if (!/^[1-9][0-9]{0,8}$/.test(req.params.version)) throw fail(400, 'INVALID_VERSION');
    const d = await lockedCase(c, identifier(req.params.id));
    if (![d.claimant_id, d.respondent_id].includes(req.actor.id)) {
      if (req.actor.id === d.mediator_id) throw fail(403, 'FORBIDDEN');
      throw fail(404, 'NOT_FOUND');
    }
    const latest = await current(c, d.id);
    const version = Number(req.params.version);
    if (!latest || version > latest.version) throw fail(404, 'NOT_FOUND');
    if (version !== latest.version) throw fail(409, 'STALE_VERSION');
    if (latest.mediator_id !== d.mediator_id) throw fail(409, 'MEDIATOR_CHANGED');
    await independent(c, d, { id: d.mediator_id });
    const existing = await c.query('SELECT 1 FROM dispatch.remedy_consents WHERE dispute_id=$1 AND version=$2 AND actor_id=$3', [d.id, version, req.actor.id]);
    if (d.status === 'RESOLVED' && existing.rowCount) return { body: { dispute: dto(d) } };
    if (d.status !== 'OPEN') throw fail(409, 'DISPUTE_NOT_OPEN');
    if (!existing.rowCount) {
      await c.query('INSERT INTO dispatch.remedy_consents(dispute_id,version,actor_id) VALUES($1,$2,$3)', [d.id, version, req.actor.id]);
      await event(c, d, req.actor, 'CONSENTED', version);
    }
    const consents = await c.query('SELECT actor_id FROM dispatch.remedy_consents WHERE dispute_id=$1 AND version=$2', [d.id, version]);
    if ([d.claimant_id, d.respondent_id].every((id) => consents.rows.some((row) => row.actor_id === id))) {
      await event(c, d, req.actor, 'RESOLVED', version);
      const updated = await c.query("UPDATE dispatch.disputes SET status='RESOLVED',closed_at=now(),closure_reason='Both parties consented to remedy version '||$2::text WHERE id=$1 RETURNING *", [d.id, version]);
      return { body: { dispute: dto(updated.rows[0]) } };
    }
    return { body: { dispute: dto(d) } };
  }));
  router.post('/api/disputes/:id/close-unresolved', authenticate, handle(async (c, req) => {
    if (!req.actor.roles.includes('admin')) throw fail(403, 'FORBIDDEN');
    const reason = text(input(req.body, ['reason']).reason);
    const d = await lockedCase(c, identifier(req.params.id));
    await independent(c, d, req.actor);
    if (d.mediation_level !== 'ADMIN') throw fail(403, 'FORBIDDEN');
    if (d.status !== 'OPEN') throw fail(409, 'DISPUTE_NOT_OPEN');
    await event(c, d, req.actor, 'CLOSED_UNRESOLVED', null, reason);
    const updated = await c.query("UPDATE dispatch.disputes SET status='CLOSED_UNRESOLVED',closed_at=now(),closure_reason=$2 WHERE id=$1 RETURNING *", [d.id, reason]);
    return { body: { dispute: dto(updated.rows[0]) } };
  }));
  router.get('/api/disputes/:id/proposals', authenticate, handle(async (c, req) => {
    const d = await lockedCase(c, identifier(req.params.id));
    const isParty = [d.claimant_id, d.respondent_id].includes(req.actor.id);
    if (!isParty && !(await isActiveMediatorIndependent(c, d, req.actor.id))
      && !await canReviewDispute(c, req.actor, d.id)) throw fail(404, 'NOT_FOUND');
    const proposals = await c.query(`SELECT p.version,p.text,p.mediator_id AS "mediatorId",p.created_at AS "createdAt",
      COALESCE((SELECT json_agg(json_build_object('actorId',s.actor_id,'at',s.created_at)) FROM dispatch.remedy_consents s WHERE s.dispute_id=p.dispute_id AND s.version=p.version),'[]') AS consents
      FROM dispatch.remedy_proposals p WHERE p.dispute_id=$1 ORDER BY p.version`, [d.id]);
    const events = await c.query('SELECT event_type,version,actor_id,details,created_at FROM dispatch.remedy_events WHERE dispute_id=$1 ORDER BY sequence', [d.id]);
    return { body: { dispute: dto(d), proposals: proposals.rows, events: events.rows } };
  }));
  return router;
}
