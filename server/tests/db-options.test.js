import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseOptions } from '../src/db.js';

test('remote PostgreSQL requires hostname-verified TLS without URL overrides', () => {
  const url = new URL('postgresql://runtime@synthetic.postgres.database.azure.com/dispatch?sslmode=verify-full');
  const options = databaseOptions(url.href);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(new URL(options.connectionString).search, '');
  for (const suffix of ['', '?sslmode=require', '?sslmode=no-verify', '?sslmode=disable', '?sslmode=verify-full&host=localhost', '?sslmode=verify-full&sslmode=disable', '?sslrootcert=/untrusted.pem', '#secret']) {
    assert.throws(() => databaseOptions(`postgresql://runtime@synthetic.postgres.database.azure.com/dispatch${suffix}`), /database connection configuration/);
  }
});

test('local PostgreSQL remains usable while query host and database overrides are rejected', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'db', 'test-db']) {
    const url = `postgresql://fixture@${host}/fixture_test`;
    assert.deepEqual(databaseOptions(url), { connectionString: url });
    assert.throws(() => databaseOptions(`${url}?host=external.example`), /database connection configuration/);
    assert.throws(() => databaseOptions(`${url}?dbname=live`), /database connection configuration/);
  }
});

test('database configuration failures never disclose credentials or source URL', () => {
  for (const value of ['https://user:synthetic-sensitive@example.org/db', 'postgresql://user:synthetic-sensitive@example.org/db?sslmode=disable', 'not-a-url', undefined]) {
    assert.throws(() => databaseOptions(value), (error) => !error.message.includes('synthetic-sensitive') && error.message === 'Invalid database connection configuration');
  }
});
