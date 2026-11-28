import express from 'express';
import { withTransaction } from './auth/store.js';

// Role requests: a signed-in user asks for provider, operator or coop; an administrator decides.
// Admin is never requestable. Admin status is re-read from account.user_roles on every call, never taken from the caller's claims.
const REQUESTABLE = new Set(['provider', 'operator', 'coop']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code) => new HttpError(status, code);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactFields(body, allowed) {
  if (!isPlainObject(body)) throw fail(400, 'INVALID_REQUEST');
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw fail(400, 'UNKNOWN_FIELD');
  return body;
}

function decisionReason(value) {
  if (typeof value !== 'string') throw fail(400, 'INVALID_REQUEST');
  const reason = value.trim();
  const length = [...reason].length;
  if (length < 1 || length > 500 || /\p{Cc}/u.test(reason)) throw fail(400, 'INVALID_REQUEST');
  return reason;
}

function requestId(value) {
  if (!UUID.test(value)) throw fail(400, 'INVALID_ID');
  return value;
}

function bounded(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) throw fail(400, 'INVALID_PAGINATION');
  const number = Number(value);
  if (number < min || number > max) throw fail(400, 'INVALID_PAGINATION');
  return number;
}

// Strict paging: default limit 20, max 20; offset 0 to 10000. Repeated or unknown parameters are refused.
function page(query) {
  for (const key of Object.keys(query)) {
    if (key !== 'limit' && key !== 'offset') throw fail(400, 'INVALID_PAGINATION');
  }
  return { limit: bounded(query.limit, 20, 1, 20), offset: bounded(query.offset, 0, 0, 10000) };
}

// One DTO for own and admin lists. canDecide is true only for a pending row that belongs to someone else.
const DTO = `r.id, r.user_id AS "userId", u.name AS "userName", r.requested_role AS role, r.status,
  r.created_at AS "createdAt", r.decided_at AS "decidedAt", r.decision_reason AS "decisionReason",
  (r.status = 'PENDING' AND r.user_id <> $1) AS "canDecide"`;
const FROM = 'FROM account.role_requests r JOIN account.users u ON u.id = r.user_id';

async function requireAdmin(db, actorId) {
  const { rowCount } = await db.query("SELECT 1 FROM account.user_roles WHERE user_id = $1 AND role = 'admin'", [actorId]);
  if (rowCount !== 1) throw fail(403, 'FORBIDDEN');
}

// Approve and reject share one transaction. The request row lock serializes competing decisions,
// so exactly one commits. The admin row is locked FOR SHARE so a concurrent admin removal waits.
async function decide(pool, actorId, id, { approve, reason }) {
  return withTransaction(pool, async (client) => {
    const admin = await client.query("SELECT 1 FROM account.user_roles WHERE user_id = $1 AND role = 'admin' FOR SHARE", [actorId]);
    if (admin.rowCount !== 1) throw fail(403, 'FORBIDDEN');
    const found = (await client.query(
      'SELECT user_id, requested_role, status FROM account.role_requests WHERE id = $1 FOR UPDATE',
      [id],
    )).rows[0];
    if (!found) throw fail(404, 'NOT_FOUND');
    if (found.user_id === actorId) throw fail(403, 'SELF_APPROVAL_FORBIDDEN');
    if (found.status !== 'PENDING') throw fail(409, 'REQUEST_DECIDED');
    // ON CONFLICT keeps an existing grant row unchanged, including its original granted_by.
    if (approve) {
      await client.query(
        'INSERT INTO account.user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT (user_id, role) DO NOTHING',
        [found.user_id, found.requested_role, actorId],
      );
    }
    await client.query(
      'UPDATE account.role_requests SET status = $2, decided_at = now(), decided_by = $3, decision_reason = $4 WHERE id = $1',
      [id, approve ? 'APPROVED' : 'REJECTED', actorId, approve ? null : reason],
    );
    return (await client.query(`SELECT ${DTO} ${FROM} WHERE r.id = $2`, [actorId, id])).rows[0];
  });
}

const route = (handler) => async (req, res) => {
  try {
    if(!req.actor||typeof req.actor.id!=='string'||!UUID.test(req.actor.id)||!Array.isArray(req.actor.roles))throw fail(401,'UNAUTHENTICATED');
    await handler(req, res);
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: { code: error.code } });
    if (error.code === '23505' && error.constraint === 'role_requests_one_pending') {
      return res.status(409).json({ error: { code: 'REQUEST_PENDING' } });
    }
    console.error('Role request failed', { name: error.name, code: error.code });
    return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE' } });
  }
};

// authenticate(req, res, next) must set req.actor = { id, roles } from a live session.
export function createRoleRequestRouter({ pool, authenticate }) {
  if(typeof pool?.connect!=='function'||typeof pool?.query!=='function'||typeof authenticate!=='function')throw new TypeError('Role requests require pool and authentication');
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/api/role-requests', authenticate, route(async (req, res) => {
    const { limit, offset } = page(req.query);
    const { rows } = await pool.query(
      `SELECT ${DTO} ${FROM} WHERE r.user_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.json({ items: rows,limit,offset });
  }));

  router.post('/api/role-requests', authenticate, route(async (req, res) => {
    const body = exactFields(req.body, ['role']);
    if (typeof body.role !== 'string' || !REQUESTABLE.has(body.role)) throw fail(400, 'INVALID_ROLE');
    const actorId = req.actor.id;
    const request = await withTransaction(pool, async (client) => {
      // Locking the requester serializes concurrent creates; the partial unique index is the backstop.
      const locked = await client.query('SELECT 1 FROM account.users WHERE id = $1 FOR UPDATE', [actorId]);
      if (locked.rowCount !== 1) throw fail(401, 'UNAUTHENTICATED');
      const granted = await client.query('SELECT 1 FROM account.user_roles WHERE user_id = $1 AND role = $2', [actorId, body.role]);
      if (granted.rowCount === 1) throw fail(409, 'ROLE_ALREADY_GRANTED');
      const open = await client.query(
        "SELECT 1 FROM account.role_requests WHERE user_id = $1 AND requested_role = $2 AND status = 'PENDING'",
        [actorId, body.role],
      );
      if (open.rowCount === 1) throw fail(409, 'REQUEST_PENDING');
      const { rows } = await client.query(
        'INSERT INTO account.role_requests (user_id, requested_role) VALUES ($1, $2) RETURNING id',
        [actorId, body.role],
      );
      return (await client.query(`SELECT ${DTO} ${FROM} WHERE r.id = $2`, [actorId, rows[0].id])).rows[0];
    });
    res.status(201).json({ request });
  }));

  router.get('/api/admin/role-requests', authenticate, route(async (req, res) => {
    await requireAdmin(pool, req.actor.id);
    const { limit, offset } = page(req.query);
    // Pending rows first, oldest first (queue order); then decided history, newest decision first.
    const { rows } = await pool.query(
      `SELECT ${DTO} ${FROM}
        ORDER BY (r.status = 'PENDING') DESC,
                 CASE WHEN r.status = 'PENDING' THEN r.created_at END ASC,
                 r.decided_at DESC NULLS LAST,
                 r.id ASC
        LIMIT $2 OFFSET $3`,
      [req.actor.id, limit, offset],
    );
    res.json({ items: rows,limit,offset });
  }));

  router.post('/api/admin/role-requests/:id/approve', authenticate, route(async (req, res) => {
    const id = requestId(req.params.id);
    exactFields(req.body, []);
    const request = await decide(pool, req.actor.id, id, { approve: true });
    res.json({ request });
  }));

  router.post('/api/admin/role-requests/:id/reject', authenticate, route(async (req, res) => {
    const id = requestId(req.params.id);
    const body = exactFields(req.body, ['reason']);
    const reason = decisionReason(body.reason);
    const request = await decide(pool, req.actor.id, id, { approve: false, reason });
    res.json({ request });
  }));

  return router;
}
