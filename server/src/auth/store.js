import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

// All queries take a pg Pool or Client. Authorization and validation happen in account-app.js.

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Destroying the connection below rolls back even when the server cannot answer.
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

export async function createUser(client, { email = null, phone = null, name, passwordHash }) {
  const { rows } = await client.query(
    'INSERT INTO account.users (email, phone, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, phone, name, passwordHash],
  );
  const id = rows[0].id;
  await client.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'farmer')", [id]);
  return { id, email, phone, name, roles: ['farmer'] };
}

// identifier is { email } or { phone }, already normalized by account-app.js.
export async function findUserByIdentifier(db, identifier) {
  const column = identifier.phone !== undefined ? 'phone' : 'email';
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.phone, u.name, u.password_hash,
            COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM account.users u
       LEFT JOIN account.user_roles r ON r.user_id = u.id
      WHERE u.${column} = $1
      GROUP BY u.id`,
    [identifier[column]],
  );
  if (!rows[0]) return null;
  const { id, name, password_hash: passwordHash, roles } = rows[0];
  return { id, email: rows[0].email, phone: rows[0].phone, name, passwordHash, roles };
}

export async function pruneSessions(db) {
  await db.query(`DELETE FROM account.sessions WHERE id IN (
    SELECT id FROM account.sessions WHERE expires_at <= now() - interval '24 hours'
    LIMIT 100 FOR UPDATE SKIP LOCKED
  )`);
}

export async function createSession(client, userId, ttlSeconds, { userAgent, ip }) {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await client.query(
    `INSERT INTO account.sessions (token_hash, user_id, expires_at, user_agent, ip_summary)
     VALUES ($1, $2, now() + $3::integer * interval '1 second', $4,
       CASE WHEN family($5::inet) = 4 THEN network(set_masklen($5::inet, 24))
            ELSE network(set_masklen($5::inet, 48)) END)
     RETURNING expires_at`,
    [digest(token), userId, ttlSeconds, userAgent, ip],
  );
  return { token, expiresAt: rows[0].expires_at.toISOString() };
}

export async function findSession(db, token) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.phone, u.name, s.id AS session_id, s.expires_at,
            COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM account.sessions s
       JOIN account.users u ON u.id = s.user_id
       LEFT JOIN account.user_roles r ON r.user_id = u.id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
      GROUP BY u.id, s.id, s.expires_at`,
    [digest(token)],
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    user: { id: row.id, email: row.email, phone: row.phone, name: row.name, roles: row.roles },
    expiresAt: row.expires_at.toISOString(),
    id: row.session_id,
  };
}

export async function listSessions(db, userId, currentId) {
  const { rows } = await db.query(`SELECT id, created_at, expires_at, revoked_at, user_agent, ip_summary::text AS ip
    FROM account.sessions WHERE user_id = $1 AND expires_at > now() - interval '24 hours'
    ORDER BY (id = $2) DESC, (revoked_at IS NULL AND expires_at > now()) DESC, created_at DESC, id
    LIMIT 20`, [userId, currentId]);
  return rows.map((row) => ({ id: row.id, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null, userAgent: row.user_agent, ip: row.ip, isCurrent: row.id === currentId }));
}

export async function revokeOwnedSession(db, userId, id) {
  const { rowCount } = await db.query(`UPDATE account.sessions SET revoked_at = clock_timestamp()
    WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp()`, [userId, id]);
  return rowCount === 1;
}

export async function revokeSession(db, token) {
  const { rowCount } = await db.query(
    'UPDATE account.sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()',
    [digest(token)],
  );
  return rowCount === 1;
}

async function lockResetUser(client, identifier) {
  const column = identifier.phone === undefined ? 'email' : 'phone';
  const { rows } = await client.query(`SELECT id, email FROM account.users WHERE ${column} = $1 FOR UPDATE`, [identifier[column]]);
  return rows[0];
}

export async function preparePasswordReset(pool, identifier, tokenHash) {
  await pool.query(`DELETE FROM account.password_reset_tokens WHERE user_id IN (
    SELECT user_id FROM account.password_reset_tokens WHERE expires_at <= now() LIMIT 100 FOR UPDATE SKIP LOCKED
  )`);
  return withTransaction(pool, async (client) => {
    const user = await lockResetUser(client, identifier);
    if (!user) return null;
    await client.query(`INSERT INTO account.password_reset_tokens (user_id, token_hash)
      VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at, used_at = NULL, attempts = 0`, [user.id, tokenHash]);
    return user;
  });
}

export function tryPasswordReset(pool, identifier, tokenHash, maxAttempts, hashNewPassword) {
  return withTransaction(pool, async (client) => {
    const user = await lockResetUser(client, identifier);
    if (!user) return false;
    const { rows: [reset] } = await client.query(`UPDATE account.password_reset_tokens SET attempts = attempts + 1
      WHERE user_id = $1 AND used_at IS NULL AND expires_at > clock_timestamp() AND attempts < $2
      RETURNING token_hash`, [user.id, maxAttempts]);
    if (!reset || !timingSafeEqual(Buffer.from(reset.token_hash, 'hex'), Buffer.from(tokenHash, 'hex'))) return false;
    await replacePassword(client, user.id, await hashNewPassword(), null);
    return true;
  });
}

// Caller holds the user lock shared by login, change and reset.
export async function replacePassword(client, userId, passwordHash, keepSessionId) {
  await client.query('UPDATE account.users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
  await client.query('UPDATE account.password_reset_tokens SET used_at = clock_timestamp() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  if (keepSessionId !== false) {
    await client.query(`UPDATE account.sessions SET revoked_at = clock_timestamp()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [userId, keepSessionId]);
  }
}

// One atomic upsert per attempt: concurrent instances serialize on the bucket row, so the count is exact.
// The counter saturates at max + 1 to stay bounded. Returns true while the attempt is within the limit.
export async function hitRateLimit(db, scope, value, max, windowSeconds) {
  await db.query('DELETE FROM account.rate_limits WHERE window_ends_at <= now()');
  const { rows } = await db.query(
    `INSERT INTO account.rate_limits (bucket, hits, window_ends_at)
     VALUES ($1, 1, now() + $2::integer * interval '1 second')
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN account.rate_limits.window_ends_at <= now() THEN 1
                   ELSE LEAST(account.rate_limits.hits + 1, $3::integer) END,
       window_ends_at = CASE WHEN account.rate_limits.window_ends_at <= now()
                             THEN now() + $2::integer * interval '1 second'
                             ELSE account.rate_limits.window_ends_at END
     RETURNING hits`,
    [digest(`${scope}\u0000${value}`), windowSeconds, max + 1],
  );
  return rows[0].hits <= max;
}

export async function clearRateLimit(db, scope, value) {
  await db.query('DELETE FROM account.rate_limits WHERE bucket = $1', [digest(`${scope}\u0000${value}`)]);
}
