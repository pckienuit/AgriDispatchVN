import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgresql://user:pass@localhost/app' };
test('config accepts defaults without modifying input', () => {
  assert.deepEqual(readConfig(base), { port: 3000, databaseUrl: base.DATABASE_URL });
  assert.equal(base.PORT, undefined);
});
test('PORT must be an integer between 1 and 65535', () => {
  for (const PORT of ['0', '-1', '65536', '12abc', '1.2', '']) {
    assert.throws(() => readConfig({ ...base, PORT }), /PORT/);
  }
  assert.equal(readConfig({ ...base, PORT: '8080' }).port, 8080);
});
test('database URL must use PostgreSQL and have a host and database', () => {
  for (const DATABASE_URL of [undefined, '', 'https://example.org/app', 'postgresql://localhost', 'secret-invalid']) {
    assert.throws(() => readConfig({ DATABASE_URL }), /DATABASE_URL/);
  }
  assert.throws(() => readConfig({ DATABASE_URL: 'secret-invalid' }), (error) => !error.message.includes('secret-invalid'));
});
