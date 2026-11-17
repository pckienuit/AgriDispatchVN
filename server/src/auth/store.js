import { createHash, randomBytes } from 'node:crypto';

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

export async function createUser(client, { email, name, passwordHash }) {
  const { rows } = await client.query(
    'INSERT INTO account.users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [email, name, passwordHash],
  );
  const id = rows[0].id;
  await client.query("INSERT INTO account.user_roles (user_id, role) VALUES ($1, 'farmer')", [id]);
  return { id, email, name, roles: ['farmer'] };
}

export async function findUserByEmail(db, email) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.password_hash,
            COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM account.users u
       LEFT JOIN account.user_roles r ON r.user_id = u.id
      WHERE u.email = $1
      GROUP BY u.id`,
    [email],
  );
  if (!rows[0]) return null;
  const { id, name, password_hash: passwordHash, roles } = rows[0];
  return { id, email: rows[0].email, name, passwordHash, roles };
}

// Each login prunes a bounded batch of expired session rows, so the table stays near live-session size.
export async function createSession(client, userId, ttlSeconds) {
  await client.query(
    'DELETE FROM account.sessions WHERE token_hash IN (SELECT token_hash FROM account.sessions WHERE expires_at <= now() LIMIT 100)',
  );
  const token = randomBytes(32).toString('base64url');
  const { rows } = await client.query(
    `INSERT INTO account.sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + $3::integer * interval '1 second')
     RETURNING expires_at`,
    [digest(token), userId, ttlSeconds],
  );
  return { token, expiresAt: rows[0].expires_at.toISOString() };
}

export async function findSession(db, token) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, s.expires_at,
            COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM account.sessions s
       JOIN account.users u ON u.id = s.user_id
       LEFT JOIN account.user_roles r ON r.user_id = u.id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
      GROUP BY u.id, s.expires_at`,
    [digest(token)],
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    user: { id: row.id, email: row.email, name: row.name, roles: row.roles },
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function revokeSession(db, token) {
  const { rowCount } = await db.query(
    'UPDATE account.sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()',
    [digest(token)],
  );
  return rowCount === 1;
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
