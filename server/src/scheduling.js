import express from 'express';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const machineTypes = { 'harvest-combine': 'harvester', 'tillage-tractor': 'tractor', 'drone-spray': 'drone' };
const fail = (status, code) => Object.assign(new Error(code), { status, code });
function body(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_BODY');
  if (Object.keys(input).some((key) => !keys.includes(key))) throw fail(400, 'UNKNOWN_FIELD');
  return input;
}
function identifier(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw fail(400, 'INVALID_ID');
  return value.toLowerCase();
}
async function transaction(pool, work) {
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
async function lockResources(client, keys) {
  for (const key of [...new Set(keys)].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
}
async function transitionBookings(client, packageId, state, actorId) {
  const members = await client.query('SELECT booking_id FROM dispatch.package_bookings WHERE package_id=$1 ORDER BY booking_id', [packageId]);
  const ids = members.rows.map((row) => row.booking_id);
  await client.query('SELECT id FROM dispatch.bookings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  await client.query('UPDATE dispatch.bookings SET state=$2 WHERE id=ANY($1::uuid[])', [ids, state]);
  await client.query('INSERT INTO dispatch.booking_events(booking_id,event_type,to_state,actor_id) SELECT unnest($1::uuid[]),$2,$3,$4',
    [ids, state === 'ASSIGNED' ? 'BOOKING_ASSIGNED' : 'BOOKING_CANCELLED', state, actorId]);
}
function dto(row) {
  return { id: row.id, status: row.status, machineId: row.machine_id, operatorId: row.operator_id,
    startAt: row.window_start_at.toISOString(), endAt: row.window_end_at.toISOString() };
}

export function createSchedulingRouter({ pool, authenticate }) {
  if (typeof pool?.connect !== 'function' || typeof authenticate !== 'function') throw new TypeError('Scheduling needs a pool and authenticate middleware');
  const router = express.Router();
  const handle = (roles, work) => async (req, res, next) => {
    try {
      if (!req.actor || !uuid.test(req.actor.id) || !Array.isArray(req.actor.roles)) throw fail(401, 'UNAUTHENTICATED');
      if (!req.actor.roles.some((role) => roles.includes(role))) throw fail(403, 'FORBIDDEN');
      res.json({ package: dto(await transaction(pool, (client) => work(client, req))) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: { code: error.code } });
      if (/^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND)/.test(error.code ?? '')) return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
      return next(error);
    }
  };
  router.post('/api/packages/:id/claim', authenticate, handle(['provider'], async (client, req) => {
    const packageId = identifier(req.params.id);
    const input = body(req.body, ['machineId', 'operatorId']);
    const machineId = identifier(input.machineId), operatorId = identifier(input.operatorId);
    const { rows } = await client.query('SELECT * FROM dispatch.packages WHERE id=$1 FOR UPDATE', [packageId]);
    const pkg = rows[0];
    if (!pkg) throw fail(404, 'NOT_FOUND');
    if (pkg.status === 'CLAIMED') {
      if (pkg.provider_id === req.actor.id && pkg.machine_id === machineId && pkg.operator_id === operatorId) return pkg;
      throw fail(409, 'PACKAGE_UNAVAILABLE');
    }
    if (pkg.status !== 'OPEN') throw fail(409, 'PACKAGE_UNAVAILABLE');
    const keys = [`machine:${machineId}`, `operator:${operatorId}`];
    await lockResources(client, keys);
    const machine = await client.query('SELECT machine_type,status FROM dispatch.machines WHERE id=$1 AND owner_id=$2 FOR SHARE', [machineId, req.actor.id]);
    if (!machine.rows[0]) throw fail(404, 'NOT_FOUND');
    const service = await client.query('SELECT code FROM dispatch.services WHERE id=$1', [pkg.service_id]);
    if (machine.rows[0].status !== 'available' || machine.rows[0].machine_type !== machineTypes[service.rows[0]?.code]) throw fail(409, 'MACHINE_UNAVAILABLE');
    // Single-DB demo: role and accepted recruitment commitment are verified from their owning schemas.
    const consent = await client.query(`SELECT 1 FROM dispatch.offers o JOIN dispatch.jobs j ON j.id=o.job_id
      JOIN account.user_roles r ON r.user_id=o.operator_id AND r.role='operator'
      WHERE o.operator_id=$1 AND o.status='ACCEPTED' AND j.provider_id=$2 AND j.start_at<=$3 AND j.end_at>=$4 LIMIT 1`,
    [operatorId, req.actor.id, pkg.window_start_at, pkg.window_end_at]);
    if (!consent.rowCount) throw fail(409, 'OPERATOR_NOT_AUTHORIZED');
    const conflicts = await client.query(`SELECT 1 FROM dispatch.allocations WHERE resource_key=ANY($1::text[]) AND released_at IS NULL
      AND start_at<$3 AND end_at>$2 LIMIT 1`, [keys, pkg.window_start_at, pkg.window_end_at]);
    if (conflicts.rowCount) throw fail(409, 'SCHEDULE_CONFLICT');
    for (const key of keys) await client.query('INSERT INTO dispatch.allocations(package_id,resource_key,start_at,end_at) VALUES($1,$2,$3,$4)', [packageId, key, pkg.window_start_at, pkg.window_end_at]);
    const updated = await client.query("UPDATE dispatch.packages SET status='CLAIMED',provider_id=$2,machine_id=$3,operator_id=$4 WHERE id=$1 RETURNING *", [packageId, req.actor.id, machineId, operatorId]);
    await transitionBookings(client, packageId, 'ASSIGNED', req.actor.id);
    return updated.rows[0];
  }));
  router.post('/api/packages/:id/cancel', authenticate, handle(['provider', 'coop'], async (client, req) => {
    const packageId = identifier(req.params.id);
    const input = body(req.body, ['reason']);
    if (typeof input.reason !== 'string' || !input.reason.trim() || [...input.reason.trim()].length > 500) throw fail(400, 'INVALID_REASON');
    const { rows } = await client.query('SELECT * FROM dispatch.packages WHERE id=$1 AND (coop_id=$2 OR provider_id=$2) FOR UPDATE', [packageId, req.actor.id]);
    const pkg = rows[0];
    if (!pkg) throw fail(404, 'NOT_FOUND');
    if (pkg.status === 'CANCELLED') return pkg;
    if (!['OPEN', 'CLAIMED'].includes(pkg.status)) throw fail(409, 'PACKAGE_UNAVAILABLE');
    if (pkg.machine_id) await lockResources(client, [`machine:${pkg.machine_id}`, `operator:${pkg.operator_id}`]);
    await client.query('UPDATE dispatch.allocations SET released_at=now() WHERE package_id=$1 AND released_at IS NULL', [packageId]);
    const updated = await client.query("UPDATE dispatch.packages SET status='CANCELLED',cancellation_reason=$2 WHERE id=$1 RETURNING *", [packageId, input.reason.trim()]);
    await transitionBookings(client, packageId, 'CANCELLED', req.actor.id);
    return updated.rows[0];
  }));
  return router;
}
