import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { createPool } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { migrate } from '../../scripts/migrate.js';

// Destructive tests require a dedicated database explicitly named *_test.
const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/missing');
assert.match(decodeURIComponent(url.pathname), /_test$/, 'TEST_DATABASE_URL must identify a dedicated *_test database');

test('real PostgreSQL readiness and transactional migration lifecycle', async (t) => {
  const pool = createPool(url.href, { statementTimeout: 60000 });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query('SELECT pg_sleep(5.1)');
  const directory = await mkdtemp(join(tmpdir(), 'agridispatch-migrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await migrate(pool, directory), []);
  await writeFile(join(directory, '001_probe.sql'), 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);');
  const concurrent = await Promise.all([migrate(pool, directory), migrate(pool, directory)]);
  assert.equal(concurrent.flat().filter((name) => name === '001_probe.sql').length, 1);
  assert.deepEqual(await migrate(pool, directory), []);
  assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, 1);
  await writeFile(join(directory, '001_probe.sql'), 'SELECT 1;');
  await assert.rejects(migrate(pool, directory), /changed/);
  await writeFile(join(directory, '001_probe.sql'), 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);');
  await writeFile(join(directory, '002_bad.sql'), 'CREATE TABLE rolled_back (id INTEGER); SELECT * FROM nonexistent_table;');
  await assert.rejects(migrate(pool, directory));
  assert.equal((await pool.query("SELECT to_regclass('rolled_back') AS table_name")).rows[0].table_name, null);
  assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, 1);
  await rm(join(directory, '002_bad.sql'));
  await rm(join(directory, '001_probe.sql'));
  await assert.rejects(migrate(pool, directory), /missing/);
  await writeFile(join(directory, '001_probe.sql'), 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);');
  await writeFile(join(directory, '002_next.sql'), 'INSERT INTO migration_probe VALUES (7);');
  assert.deepEqual(await migrate(pool, directory), ['002_next.sql']);
  assert.equal((await pool.query('SELECT id FROM migration_probe')).rows[0].id, 7);

  const server = createApp({ pool }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready' });
});
