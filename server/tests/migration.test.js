import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPool } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';

test('migration pool allows bounded long queries without relaxing API timeout', async () => {
  const api = createPool('postgresql://localhost/app');
  const migration = createPool('postgresql://localhost/app', { statementTimeout: 60000 });
  assert.equal(api.options.statement_timeout, 5000);
  assert.equal(migration.options.statement_timeout, 60000);
  assert.equal(migration.options.query_timeout, 61000);
  await Promise.all([api.end(), migration.end()]);
});
test('connection failure preserves original migration error and destroys session', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '001_probe.sql'), 'SELECT 42');
  const original = new Error('Original connection failure');
  let released = false;
  const pool = { async connect() { return {
    async query(sql) {
      if (sql === 'SELECT 42') throw original;
      if (sql === 'ROLLBACK' || sql.includes('pg_advisory_unlock')) throw new Error('Connection closed');
      return { rows: [] };
    },
    release(destroy) { released = destroy; },
  }; } };
  await assert.rejects(migrate(pool, directory), (error) => error === original);
  assert.equal(released, true);
});
test('invalid migration filenames have a safe diagnostic code', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-name-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'bad.sql'), 'SELECT 1');
  await assert.rejects(migrate({}, directory), { code: 'INVALID_MIGRATION_NAME' });
});
