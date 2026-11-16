import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

const defaultDirectory = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export async function migrate(pool, directory = defaultDirectory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (names.some((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name))) {
    throw Object.assign(new Error('Migration names must match NNN_description.sql'), { code: 'INVALID_MIGRATION_NAME' });
  }
  if (new Set(names.map((name) => name.slice(0, 3))).size !== names.length) {
    throw Object.assign(new Error('Migration numbers must be unique'), { code: 'DUPLICATE_MIGRATION_NUMBER' });
  }
  const files = await Promise.all(names.map(async (name) => {
    const sql = await readFile(resolve(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const client = await pool.connect();

  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock(62431875)');

    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
    for (const row of rows) {
      const file = files.find((item) => item.name === row.name);
      if (!file) throw Object.assign(new Error(`Applied migration missing: ${row.name}`), { code: 'MIGRATION_MISSING' });
      if (file.checksum !== row.checksum) throw Object.assign(new Error(`Applied migration changed: ${row.name}`), { code: 'MIGRATION_CHANGED' });
    }
    for (const file of files) {
      if (rows.some((row) => row.name === file.name)) continue;
      if (rows.some((row) => row.name > file.name)) throw Object.assign(new Error(`Migration inserted before applied history: ${file.name}`), { code: 'MIGRATION_OUT_OF_ORDER' });
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
        await client.query('COMMIT');
        applied.push(file.name);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Destroying the connection below rolls back even when it cannot answer.
        }
        throw error;
      }
    }
    return applied;
  } finally {
    // Closing the dedicated session releases its advisory lock without masking errors.
    client.release(true);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    pool = createPool(readConfig({ ...process.env, PORT: '3000' }).databaseUrl, { statementTimeout: 60000 });
    const names = await migrate(pool);
    console.log(JSON.stringify({ applied: names }));
  } catch (error) {
    console.error('Migration failed', { name: error.name, code: error.code });
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}
