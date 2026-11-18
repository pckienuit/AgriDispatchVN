# Database role bootstrap and first-admin setup

Trusted maintenance procedures for PostgreSQL 17 deployments. Neither script loads `.env`; both read `DATABASE_URL` from the process environment and enforce the connection TLS rules in `server/src/db.js` (`sslmode=verify-full` required for any non-local host).

## Deployment order

1. Provision PostgreSQL 17 with a migrator/admin login role (`CREATEROLE` on Azure Database for PostgreSQL Flexible Server; `SUPERUSER` is not required).
2. Run schema migrations as the migrator role:
   ```
   DATABASE_URL='postgresql://<migrator>:<password>@<host>/<db>?sslmode=verify-full' npm run db:migrate
   ```
3. Preview runtime role bootstrap (default is `--dry-run`; requires no runtime passwords):
   ```
   DATABASE_URL='postgresql://<migrator>:<password>@<host>/<db>?sslmode=verify-full' node server/scripts/bootstrap-db.js --dry-run
   ```
4. Apply runtime roles and least-privilege grants **after every migration run**:
   ```
   NEW_ACCOUNT_DB_PASSWORD='<32..256 printable ASCII, no spaces>' \
   NEW_BOOKING_DB_PASSWORD='<32..256 distinct printable ASCII, no spaces>' \
   DATABASE_URL='postgresql://<migrator>:<password>@<host>/<db>?sslmode=verify-full' \
   node server/scripts/bootstrap-db.js --apply --confirm-host <host> --confirm-database <db>
   ```
5. Start services with separate runtime credentials:
   - `account-service`: `account_runtime` with `NEW_ACCOUNT_DB_PASSWORD`.
   - `booking-service`: `booking_runtime` with `NEW_BOOKING_DB_PASSWORD`.

## First-admin bootstrap

No live admin account is created by SQL migrations. After the initial admin user registers via `/api/auth/register`:

1. Preview:
   ```
   DATABASE_URL='postgresql://<migrator>:<password>@<host>/<db>?sslmode=verify-full' \
   node server/scripts/bootstrap-admin.js --user-id <uuid> --dry-run
   ```
2. Apply (succeeds only when zero `admin` rows exist in `account.user_roles`, or idempotently when the same `<uuid>` is already the sole admin):
   ```
   DATABASE_URL='postgresql://<migrator>:<password>@<host>/<db>?sslmode=verify-full' \
   node server/scripts/bootstrap-admin.js --user-id <uuid> --apply --confirm-user-id <uuid> --confirm-host <host> --confirm-database <db>
   ```

Subsequent role grants (`coop`, `provider`, `operator`) are approved through `/api/admin/role-requests` on `account-service`. `bootstrap-admin.js` refuses with exit code 2 once any other user holds `admin`.

## Privilege model

- `account_runtime` (`LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS`):
  - `SELECT, INSERT, UPDATE, DELETE` on `account.users`, `account.user_roles`, `account.sessions`, `account.rate_limits`, `account.role_requests`, plus `USAGE, SELECT` on sequences and `EXECUTE` on functions in `account`.
  - No access to `dispatch.*` or `public.schema_migrations`; no `TRUNCATE` or DDL.
- `booking_runtime` (`LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS`):
  - `SELECT, INSERT, UPDATE, DELETE` on all `dispatch.*` tables, plus `USAGE, SELECT` on sequences and `EXECUTE` on functions in `dispatch`.
  - Cross-schema read-only access required by booking/dispute queries and trigger checks: `SELECT (id, name)` on `account.users` and `SELECT` on `account.user_roles`.
  - No access to `account.users.email`, `account.users.password_hash`, `account.sessions`, `account.rate_limits`, `account.role_requests`, or `public.schema_migrations`; no `TRUNCATE` or DDL.
- `PUBLIC` cannot `CREATE` in schema `public` or `EXECUTE` functions in `account`/`dispatch`. Default privileges for the migrator revoke `PUBLIC` table/function grants on future objects in `account` and `dispatch`.

## Operational and PostgreSQL 16/17 notes

- Role creation, credential rotation and grants run in one transaction under the bootstrap advisory lock. Failure preserves prior credentials/grants; re-run after resolving the reported failure. This is DB atomicity, not coordinated Key Vault rotation: publish new runtime URLs and restart services only after bootstrap succeeds, and plan credential cutover separately.
- `bootstrap-db.js` derives `SCRAM-SHA-256` verifiers (4096 iterations) in Node and applies them via a session-local `pg_temp` helper, keeping raw passwords out of SQL strings. Treat DB statement logs as sensitive anyway because bound parameter values (including SCRAM verifiers) may still be recorded when `log_statement = 'all'` is enabled.
- On PostgreSQL 16/17 with non-superuser `CREATEROLE` (such as Azure Flexible Server), the migrator role must retain `ADMIN OPTION` on `account_runtime` and `booking_runtime` (automatic when that same migrator creates them) to rotate passwords later.
- Existing roles with `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `INHERIT`, `REPLICATION`, `BYPASSRLS`, or unexpected role memberships cause `bootstrap-db.js` to refuse (`UNSAFE_EXISTING_ROLE`) instead of silently modifying privileges.

## Verification

- Unit tests (`server/tests/bootstrap-db.test.js`, `server/tests/bootstrap-admin.test.js`) verify RFC 7677 SCRAM-SHA-256 key derivation, password policy, relation list parity with `db/migrations/*.sql`, TLS URL rejection via `server/src/db.js`, confirmation guards, and secret-free output.
- Integration tests (`server/tests/integration/runtime-roles.test.js`) exercise real disposable PostgreSQL 17: pre-migration refusal, non-superuser `CREATEROLE` migrator execution, SCRAM authentication, password rotation, negative privilege denials across schemas/PII/DDL/`TRUNCATE`, first-admin concurrency/idempotency, and an end-to-end two-service HTTP workflow running under `account_runtime` and `booking_runtime`. Live Azure execution has not been run here.
