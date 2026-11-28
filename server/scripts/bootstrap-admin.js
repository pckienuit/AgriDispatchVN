import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db.js';

// Guarded first-admin maintenance CLI. Grants `admin` to one existing registered user ONLY when
// zero admins currently exist (table-locked to prevent concurrent races). Idempotent when the
// target user is already the sole admin; refuses if any other user already holds admin.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'Usage: bootstrap-admin --user-id <uuid> [--dry-run] [--apply --confirm-user-id <uuid> --confirm-host <hostname> --confirm-database <database>]';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseAdminArgs(argv = []) {
  const out = { userId: null, apply: false, dryRun: false, confirmUserId: null, confirmHost: null, confirmDatabase: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw fail('USAGE', USAGE);
      i += 1;
      return argv[i];
    };
    if (arg === '--user-id') {
      if (out.userId !== null) throw fail('USAGE', USAGE);
      const raw = next();
      if (!UUID.test(raw)) throw fail('USAGE', USAGE);
      out.userId = raw.toLowerCase();
    } else if (arg === '--apply') {
      out.apply = true;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--confirm-user-id') {
      const raw = next();
      if (!UUID.test(raw)) throw fail('CONFIRMATION_MISMATCH', 'Invalid --confirm-user-id');
      out.confirmUserId = raw.toLowerCase();
    } else if (arg === '--confirm-host') {
      out.confirmHost = next();
    } else if (arg === '--confirm-database') {
      out.confirmDatabase = next();
    } else {
      throw fail('USAGE', USAGE);
    }
  }
  if (!out.userId || (out.apply && out.dryRun)) throw fail('USAGE', USAGE);
  return out;
}

function targetFromEnv(env) {
  const pool = createPool(env.DATABASE_URL);
  pool.end().catch(() => {});
  const url = new URL(env.DATABASE_URL);
  return {
    databaseUrl: env.DATABASE_URL,
    hostname: url.hostname,
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

export function planAdmin(argv = [], env = process.env) {
  const args = parseAdminArgs(argv);
  const target = targetFromEnv(env);
  if (!args.apply) {
    return { mode: 'dry-run', userId: args.userId, target: { hostname: target.hostname, database: target.database } };
  }
  if (args.confirmUserId !== args.userId || args.confirmHost !== target.hostname || args.confirmDatabase !== target.database) {
    throw fail('CONFIRMATION_MISMATCH', 'Apply requires matching --confirm-user-id, --confirm-host and --confirm-database');
  }
  return { mode: 'apply', userId: args.userId, target };
}

export async function bootstrapFirstAdmin(pool, userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw fail('USAGE', 'Valid UUID required');
  const normalized = userId.toLowerCase();
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    // Exclusive lock prevents two bootstrap invocations from creating two initial admins concurrently.
    await client.query('LOCK TABLE account.user_roles IN EXCLUSIVE MODE');
    const userRes = await client.query('SELECT id FROM account.users WHERE id = $1', [normalized]);
    if (userRes.rowCount !== 1) throw fail('USER_NOT_FOUND', 'Target user does not exist');

    const admins = await client.query("SELECT user_id FROM account.user_roles WHERE role = 'admin'");
    if (admins.rowCount > 0) {
      const otherAdmin = admins.rows.some((row) => row.user_id !== normalized);
      if (otherAdmin) throw fail('ADMIN_ALREADY_EXISTS', 'An admin already exists; refuse to grant another via bootstrap');
      await client.query('COMMIT');
      return { userId: normalized, status: 'already-admin' };
    }

    await client.query("INSERT INTO account.user_roles (user_id, role, granted_by) VALUES ($1, 'admin', NULL)", [normalized]);
    await client.query('COMMIT');
    return { userId: normalized, status: 'granted' };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  { log = console.log, logError = console.error, createPoolFn = createPool } = {},
) {
  let plan;
  try {
    plan = planAdmin(argv, env);
  } catch (error) {
    logError(JSON.stringify({ status: 'refused', code: error.code ?? 'INVALID_CONFIG' }));
    return 2;
  }
  if (plan.mode === 'dry-run') {
    log(JSON.stringify({
      mode: 'dry-run',
      userId: plan.userId,
      target: plan.target,
      actions: ['lock-user-roles', 'verify-user-exists', 'verify-zero-admins', 'grant-admin-null-grantor'],
    }));
    return 0;
  }
  const pool = createPoolFn(plan.target.databaseUrl, { statementTimeout: 30000 });
  try {
    const result = await bootstrapFirstAdmin(pool, plan.userId);
    log(JSON.stringify({ mode: 'apply', target: { hostname: plan.target.hostname, database: plan.target.database }, ...result }));
    return 0;
  } catch (error) {
    const code = error.code ?? error.name ?? 'BOOTSTRAP_ADMIN_FAILED';
    logError(JSON.stringify({ status: 'error', code }));
    return ['USER_NOT_FOUND', 'ADMIN_ALREADY_EXISTS'].includes(code) ? 2 : 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
