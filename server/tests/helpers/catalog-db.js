import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Test-only helper: creates and drops one uniquely named database from a root admin URL.
// Only the database name it generated itself is ever dropped; the root database is never reset.
const DB_NAME_PATTERN = /^[a-z][a-z0-9_]*_test$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Local loopback or a single-label compose/service hostname (e.g. "test-db"). Dotted or IP hosts are refused.
const SERVICE_HOST_PATTERN = /^[a-z0-9-]+$/i;

export function parseRootDatabaseUrl(value) {
  const message = 'TEST_DATABASE_URL must be a PostgreSQL URL to a local host with a database name ending in _test';
  if (typeof value !== 'string' || value === '') throw new Error(message);
  let url;
  let database;
  try {
    url = new URL(value);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(message);
  }
  const hostOk = LOCAL_HOSTS.has(url.hostname) || SERVICE_HOST_PATTERN.test(url.hostname);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !hostOk || !DB_NAME_PATTERN.test(database) || url.search || url.hash) {
    throw new Error(message);
  }
  return { url, database };
}

export async function createDisposableDatabase(rootValue, { label = 'catalog' } = {}) {
  const { url } = parseRootDatabaseUrl(rootValue);
  const name = `agridispatch_${label}_${randomBytes(6).toString('hex')}_test`;
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const disposable = new URL(url.href);
  disposable.pathname = `/${name}`;
  return {
    name,
    url: disposable.href,
    async drop() {
      const cleanup = new pg.Client({ connectionString: url.href });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
