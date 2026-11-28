import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, readBookingConfig } from '../src/config.js';

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

test('booking runtime refuses missing identity configuration before opening HTTP', () => {
  for (const env of [base, { ...base, ACCOUNT_SERVICE_URL: 'http://account:3001' }, { ...base, INTERNAL_SERVICE_TOKEN: 'x'.repeat(32) }, { ...base, ACCOUNT_SERVICE_URL: 'https://user:secret@account.example', INTERNAL_SERVICE_TOKEN: 'x'.repeat(32) }]) {
    assert.throws(() => readBookingConfig(env), /identity configuration/);
  }
  const config = readBookingConfig({ ...base, ACCOUNT_SERVICE_URL: 'http://account:3001', INTERNAL_SERVICE_TOKEN: 'x'.repeat(32) });
  assert.equal(config.accountServiceUrl, 'http://account:3001');
  assert.equal(config.internalServiceToken.length, 32);
  assert.equal(config.depositExpiryHours, 24);
  assert.equal(config.depositExpirySweepIntervalMs, 300000);
  const env = { ...base, ACCOUNT_SERVICE_URL: config.accountServiceUrl, INTERNAL_SERVICE_TOKEN: config.internalServiceToken };
  assert.equal(readBookingConfig({ ...env, DEPOSIT_EXPIRY_HOURS: '2' }).depositExpiryHours, 2);
  assert.equal(readBookingConfig({ ...env, DEPOSIT_EXPIRY_SWEEP_INTERVAL_MS: '0' }).depositExpirySweepIntervalMs, 0);
  for (const DEPOSIT_EXPIRY_SWEEP_INTERVAL_MS of ['-1', '', '1.5', '2147483648']) {
    assert.throws(() => readBookingConfig({ ...env, DEPOSIT_EXPIRY_SWEEP_INTERVAL_MS }), /DEPOSIT_EXPIRY_SWEEP_INTERVAL_MS/);
  }
  for (const DEPOSIT_EXPIRY_HOURS of ['0', '-1', '1.5', '721', '24h', '']) {
    assert.throws(() => readBookingConfig({ ...env, DEPOSIT_EXPIRY_HOURS }), /DEPOSIT_EXPIRY_HOURS/);
  }
});

test('booking process exits before listening when identity configuration is absent', async () => {
  const env = { ...process.env, DATABASE_URL: 'postgresql://fixture@127.0.0.1/synthetic_test' };
  delete env.ACCOUNT_SERVICE_URL;
  delete env.INTERNAL_SERVICE_TOKEN;
  await assert.rejects(promisify(execFile)(process.execPath, ['server/src/server.js'], { env, timeout: 3000 }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Startup failed/);
    assert.ok(!error.stdout.includes('Listening'));
    return true;
  });
});

test('SERVICES_CACHE_MS is optional, defaults to off and is bounded', () => {
  const env = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/app', ACCOUNT_SERVICE_URL: 'http://account:3001', INTERNAL_SERVICE_TOKEN: 'x'.repeat(32) };
  assert.equal(readBookingConfig(env).servicesCacheMs, 0);
  assert.equal(readBookingConfig({ ...env, SERVICES_CACHE_MS: '30000' }).servicesCacheMs, 30000);
  for (const SERVICES_CACHE_MS of ['-1', '1.5', '300001', 'abc', '']) {
    assert.throws(() => readBookingConfig({ ...env, SERVICES_CACHE_MS }), /SERVICES_CACHE_MS/, SERVICES_CACHE_MS);
  }
});
