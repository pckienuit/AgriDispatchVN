import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { createPool } from '../src/db.js';
import { readConfig } from '../src/config.js';

// Least-privilege runtime role bootstrapper. Run as the migrator/DB admin *after* `npm run db:migrate`
// on each deployment. Never prints URLs or passwords; writes SCRAM verifiers via a session-scoped
// pg_temp helper so plain-text passwords never enter PostgreSQL DDL statements or statement logs.

export const DEFAULT_ROLES = Object.freeze({ account: 'account_runtime', booking: 'booking_runtime' });
export const PASSWORD_ENVS = Object.freeze({ account: 'NEW_ACCOUNT_DB_PASSWORD', booking: 'NEW_BOOKING_DB_PASSWORD' });

// Unit tests enforce parity between these relation lists and the SQL migrations.
export const ACCOUNT_TABLES = Object.freeze([
  'users',
  'user_roles',
  'sessions',
  'rate_limits',
  'role_requests',
  'password_reset_tokens',
]);

export const DISPATCH_TABLES = Object.freeze([
  'services',
  'fields',
  'machines',
  'bookings',
  'booking_events',
  'idempotency_keys',
  'jobs',
  'applications',
  'offers',
  'recruitment_events',
  'packages',
  'package_bookings',
  'allocations',
  'shifts',
  'shift_events',
  'readiness_events',
  'field_inspections',
  'location_consents',
  'acceptances',
  'acceptance_consents',
  'payments',
  'payment_events',
  'disputes',
  'dispute_events',
  'remedy_proposals',
  'remedy_consents',
  'remedy_events',
  'postponement_proposals',
  'postponement_consents',
  'postponement_applications',
  'evidence',
  'operator_profiles',
  'operator_certifications',
  'shift_wage_reports',
  'shift_wage_acknowledgments',
  'package_call_confirmations',
  'deposits',
  'deposit_events',
  'platform_parameter_versions',
  'job_reports',
  'platform_control_events',
  'commune_territories',
  'coop_territory_audit',
]);

const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const SCRAM_ITERATIONS = 4096;
const SALT_BYTES = 16;
const MIN_PASSWORD_LEN = 32;
const MAX_PASSWORD_LEN = 256;
const USAGE = 'Usage: bootstrap-db [--dry-run] [--apply --confirm-host <hostname> --confirm-database <database>]';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertRoleName(name) {
  if (typeof name !== 'string' || !ROLE_NAME.test(name)) {
    throw fail('INVALID_ROLE_NAME', 'Role names must be lowercase PostgreSQL identifiers');
  }
  return name;
}

export function validateRolePassword(password, label = 'role') {
  if (typeof password !== 'string' || password.length === 0) {
    throw fail('PASSWORD_MISSING', `Missing password environment variable for ${label}`);
  }
  // ASCII graphic characters without whitespace avoid URL-encoding mismatches and control chars.
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN || !/^[\x21-\x7e]+$/.test(password)) {
    throw fail('PASSWORD_POLICY', `Password for ${label} must be ${MIN_PASSWORD_LEN}..${MAX_PASSWORD_LEN} printable ASCII characters without spaces`);
  }
  return password;
}

export function scramKeys(password, { salt = randomBytes(SALT_BYTES), iterations = SCRAM_ITERATIONS } = {}) {
  if (typeof password !== 'string' || password.length === 0) throw fail('PASSWORD_POLICY', 'Password required');
  if (!Buffer.isBuffer(salt) || salt.length < 8) throw fail('PASSWORD_POLICY', 'Salt must be at least 8 bytes');
  if (!Number.isInteger(iterations) || iterations < SCRAM_ITERATIONS) throw fail('PASSWORD_POLICY', 'Invalid SCRAM iteration count');
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return { salt, iterations, storedKey, serverKey };
}

export function scramVerifier(password, options = {}) {
  validateRolePassword(password);
  const { salt, iterations, storedKey, serverKey } = scramKeys(password, options);
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export function parseBootstrapArgs(argv = []) {
  const out = { apply: false, dryRun: false, confirmHost: null, confirmDatabase: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw fail('USAGE', USAGE);
      i += 1;
      return argv[i];
    };
    if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--confirm-host') out.confirmHost = next();
    else if (arg === '--confirm-database') out.confirmDatabase = next();
    else throw fail('USAGE', USAGE);
  }
  if (out.apply && out.dryRun) throw fail('USAGE', USAGE);
  return out;
}

function targetFromEnv(env) {
  const config = readConfig({ ...env, PORT: '3000' });
  const pool = createPool(config.databaseUrl);
  // End immediately; createPool synchronously ran databaseOptions() TLS policy validation.
  pool.end().catch(() => {});
  const url = new URL(config.databaseUrl);
  return {
    databaseUrl: config.databaseUrl,
    hostname: url.hostname,
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

export function planBootstrap(argv = [], env = process.env) {
  const args = parseBootstrapArgs(argv);
  const target = targetFromEnv(env);
  if (!args.apply) {
    return { mode: 'dry-run', target: { hostname: target.hostname, database: target.database } };
  }
  if (args.confirmHost !== target.hostname || args.confirmDatabase !== target.database) {
    throw fail('CONFIRMATION_MISMATCH', 'Apply requires --confirm-host and --confirm-database matching DATABASE_URL');
  }
  const accountPassword = validateRolePassword(env[PASSWORD_ENVS.account], PASSWORD_ENVS.account);
  const bookingPassword = validateRolePassword(env[PASSWORD_ENVS.booking], PASSWORD_ENVS.booking);
  if (accountPassword === bookingPassword) {
    throw fail('PASSWORDS_NOT_DISTINCT', 'Account and booking runtime passwords must differ');
  }
  return {
    mode: 'apply',
    target,
    passwords: { account: accountPassword, booking: bookingPassword },
  };
}

function qIdent(name) {
  return `"${assertRoleName(name)}"`;
}

// Rejects an existing role if it has elevated attributes or unexpected memberships (never silently demotes).
async function ensureLoginRole(client, roleName, verifier) {
  const role = assertRoleName(roleName);
  const existing = await client.query(
    `SELECT oid, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  if (existing.rowCount === 0) {
    await client.query('SELECT pg_temp.ensure_runtime_role($1::name, $2::text)', [role, verifier]);
    return 'created';
  }
  const row = existing.rows[0];
  if (row.rolsuper || row.rolcreaterole || row.rolcreatedb || row.rolreplication || row.rolbypassrls || row.rolinherit || !row.rolcanlogin) {
    throw fail('UNSAFE_EXISTING_ROLE', `Existing role ${role} has unexpected attributes`);
  }
  const memberships = await client.query('SELECT 1 FROM pg_auth_members WHERE member = $1 LIMIT 1', [row.oid]);
  if (memberships.rowCount > 0) {
    throw fail('UNSAFE_EXISTING_ROLE', `Existing role ${role} belongs to another role`);
  }
  await client.query('SELECT pg_temp.set_role_verifier($1::name, $2::text)', [role, verifier]);
  return 'updated';
}

// Applies least-privilege runtime grants for the current database and schemas.
// Optional `roles` override allows integration tests to run with unique disposable role names on shared clusters.
export async function bootstrapDatabase(pool, { roles = DEFAULT_ROLES, passwords }) {
  const accountRole = assertRoleName(roles.account);
  const bookingRole = assertRoleName(roles.booking);
  if (accountRole === bookingRole) throw fail('INVALID_ROLE_NAME', 'Runtime roles must be distinct');
  validateRolePassword(passwords?.account, PASSWORD_ENVS.account);
  validateRolePassword(passwords?.booking, PASSWORD_ENVS.booking);
  if (passwords.account === passwords.booking) {
    throw fail('PASSWORDS_NOT_DISTINCT', 'Account and booking runtime passwords must differ');
  }

  const accountVerifier = scramVerifier(passwords.account);
  const bookingVerifier = scramVerifier(passwords.booking);

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(62431876)');
    await client.query('BEGIN');
    const { rows: dbRows } = await client.query('SELECT current_database() AS db, current_user AS migrator');
    const database = dbRows[0].db;
    const migrator = dbRows[0].migrator;

    // Verify all expected schemas and tables exist (bootstrap must run *after* db:migrate).
    const { rows: foundTables } = await client.query(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_schema IN ('account', 'dispatch') AND table_type = 'BASE TABLE'`,
    );
    const have = new Set(foundTables.map((row) => `${row.table_schema}.${row.table_name}`));
    for (const table of ACCOUNT_TABLES) {
      if (!have.has(`account.${table}`)) throw fail('SCHEMA_NOT_MIGRATED', `Missing account.${table}; run db:migrate first`);
    }
    for (const table of DISPATCH_TABLES) {
      if (!have.has(`dispatch.${table}`)) throw fail('SCHEMA_NOT_MIGRATED', `Missing dispatch.${table}; run db:migrate first`);
    }

    // Session-local helper functions keep dynamic role DDL away from plain-text password literals.
    await client.query(`
      CREATE OR REPLACE FUNCTION pg_temp.ensure_runtime_role(role_name name, verifier text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        EXECUTE format(
          'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          role_name, verifier
        );
      END;
      $$;
      CREATE OR REPLACE FUNCTION pg_temp.set_role_verifier(role_name name, verifier text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        EXECUTE format('ALTER ROLE %I PASSWORD %L', role_name, verifier);
      END;
      $$;
    `);

    const accountState = await ensureLoginRole(client, accountRole, accountVerifier);
    const bookingState = await ensureLoginRole(client, bookingRole, bookingVerifier);

    const qAcc = qIdent(accountRole);
    const qBook = qIdent(bookingRole);
    const qDb = `"${database.replace(/"/g, '""')}"`;

    // Harden database/schema/routine defaults without touching extension functions in public.
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query(`REVOKE ALL ON DATABASE ${qDb} FROM ${qAcc}, ${qBook}`);
    await client.query(`GRANT CONNECT ON DATABASE ${qDb} TO ${qAcc}, ${qBook}`);
    await client.query(`REVOKE ALL ON SCHEMA public, account, dispatch FROM ${qAcc}, ${qBook}`);
    await client.query('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA account, dispatch FROM PUBLIC');

    // Account service: CRUD (no TRUNCATE, no DDL, no schema_migrations) on account.*, no access to dispatch.*.
    await client.query(`GRANT USAGE ON SCHEMA account TO ${qAcc}`);
    for (const table of ACCOUNT_TABLES) {
      await client.query(`REVOKE ALL ON TABLE account.${qIdent(table)} FROM ${qAcc}, ${qBook}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.${qIdent(table)} TO ${qAcc}`);
    }
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account TO ${qAcc}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA account TO ${qAcc}`);

    // Booking/dispatch service: CRUD on dispatch.*, plus narrow cross-schema account reads needed by queries/triggers.
    await client.query(`GRANT USAGE ON SCHEMA dispatch TO ${qBook}`);
    for (const table of DISPATCH_TABLES) {
      await client.query(`REVOKE ALL ON TABLE dispatch.${qIdent(table)} FROM ${qAcc}, ${qBook}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE dispatch.${qIdent(table)} TO ${qBook}`);
    }
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dispatch TO ${qBook}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA dispatch TO ${qBook}`);

    // Cross-schema reads in dispatch/disputes/evidence/postponement/remedies:
    // - account.users: id and name only (never email or password_hash).
    // - account.user_roles: SELECT for EXISTS / role checks and trigger guards.
    await client.query(`GRANT USAGE ON SCHEMA account TO ${qBook}`);
    await client.query(`GRANT SELECT (id, name) ON TABLE account.users TO ${qBook}`);
    await client.query(`GRANT SELECT ON TABLE account.user_roles TO ${qBook}`);

    // Ensure future tables/sequences/functions created by this migrator do not silently grant wide access.
    const qMigrator = `"${migrator.replace(/"/g, '""')}"`;
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qMigrator} IN SCHEMA account REVOKE ALL ON TABLES FROM PUBLIC`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qMigrator} IN SCHEMA dispatch REVOKE ALL ON TABLES FROM PUBLIC`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qMigrator} IN SCHEMA account REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qMigrator} IN SCHEMA dispatch REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);

    const migTable = await client.query("SELECT to_regclass('public.schema_migrations') AS reg");
    if (migTable.rows[0]?.reg) {
      await client.query(`REVOKE ALL ON TABLE public.schema_migrations FROM ${qAcc}, ${qBook}`);
    }

    await client.query('COMMIT');
    return {
      database,
      roles: {
        [accountRole]: accountState,
        [bookingRole]: bookingState,
      },
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Closing the session below rolls it back. */ }
    throw error;
  } finally {
    // Releasing with destroy=true closes the session cleanly and releases any session advisory lock.
    client.release(true);
  }
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  {
    log = console.log,
    logError = console.error,
    createPoolFn = createPool,
    roles = DEFAULT_ROLES,
  } = {},
) {
  let plan;
  try {
    plan = planBootstrap(argv, env);
  } catch (error) {
    logError(JSON.stringify({ status: 'refused', code: error.code ?? 'INVALID_CONFIG' }));
    return 2;
  }
  if (plan.mode === 'dry-run') {
    log(JSON.stringify({
      mode: 'dry-run',
      target: plan.target,
      roles,
      passwordEnvs: PASSWORD_ENVS,
      actions: [
        'ensure-login-roles',
        'revoke-public-schema-create',
        'grant-db-connect',
        'grant-account-schema-crud',
        'grant-dispatch-schema-crud',
        'grant-booking-account-narrow-reads',
        'revoke-schema-migrations-and-public-execute',
      ],
    }));
    return 0;
  }
  const pool = createPoolFn(plan.target.databaseUrl, { statementTimeout: 60000 });
  try {
    const applied = await bootstrapDatabase(pool, { roles, passwords: plan.passwords });
    log(JSON.stringify({ mode: 'apply', target: { hostname: plan.target.hostname, database: applied.database }, roles: applied.roles }));
    return 0;
  } catch (error) {
    logError(JSON.stringify({ status: 'error', code: error.code ?? error.name ?? 'BOOTSTRAP_FAILED' }));
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
