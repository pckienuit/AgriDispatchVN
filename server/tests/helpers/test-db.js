import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Disposable PostgreSQL databases for integration tests. Only loopback *_test roots are accepted, and only
// databases this module created (name pattern below) can be dropped. Never point this at shared or cloud data.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', 'test-db']);
const ROOT_NAME = /^[a-z0-9_]+_test$/;
const DISPOSABLE_NAME = /^agridispatch_acct_[0-9a-f]{12}_test$/;

export function parseDisposableRoot(rootUrl) {
  let url;
  try {
    url = new URL(rootUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL');
  if (!LOOPBACK.has(url.hostname)) throw new Error('TEST_DATABASE_URL must point to a loopback PostgreSQL instance');
  if (!ROOT_NAME.test(decodeURIComponent(url.pathname.slice(1)))) {
    throw new Error('TEST_DATABASE_URL must identify a dedicated *_test database');
  }
  return url;
}

async function adminQuery(rootUrl, text) {
  const client = new pg.Client({ connectionString: parseDisposableRoot(rootUrl).href });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

export async function createDisposableDatabase(rootUrl) {
  const root = parseDisposableRoot(rootUrl);
  const name = `agridispatch_acct_${randomBytes(6).toString('hex')}_test`;
  await adminQuery(rootUrl, `CREATE DATABASE "${name}"`);
  const url = new URL(root.href);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.href,
    drop: () => dropDisposableDatabase(rootUrl, name),
  };
}

export async function dropDisposableDatabase(rootUrl, name) {
  if (!DISPOSABLE_NAME.test(name)) throw new Error('Refusing to drop a database this helper did not create');
  await adminQuery(rootUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}
