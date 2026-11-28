import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDisposableRoot } from './helpers/test-db.js';

test('account disposable DB guard rejects connection-target overrides', () => {
  for (const suffix of ['?host=db.example.net', '?dbname=production', '#unvalidated']) {
    assert.throws(() => parseDisposableRoot('postgresql://app:p@127.0.0.1:55432/agridispatch_test' + suffix));
  }
});
import {
  assertBatchSize,
  assertCount,
  assertGenerateAllowed,
  assertSeed,
  assertSyntheticPassword,
  bookingPlan,
  expectedCounts,
  jobPlan,
  namespacePrefix,
  prngFor,
  seedDigest,
  syntheticUuid,
} from '../scripts/generate-data.js';

const LOOPBACK_URL = 'postgresql://agridispatch:synthetic_only@127.0.0.1:55432/agridispatch_test';

test('seed accepts only uint32 integers', () => {
  for (const ok of [0, 1, 42, 4294967295]) assert.equal(assertSeed(ok), ok);
  for (const bad of [-1, 1.5, '42', 4294967296, Number.NaN, undefined, null]) {
    assert.throws(() => assertSeed(bad), { code: 'SEED_INVALID' });
  }
});

test('count is bounded to 1..1000000 and batch size to 1..1000 with default 100', () => {
  assert.equal(assertCount(1), 1);
  assert.equal(assertCount(1000000), 1000000);
  for (const bad of [0, 1000001, 2.5, '5', undefined]) {
    assert.throws(() => assertCount(bad), { code: 'COUNT_INVALID' });
  }
  assert.equal(assertBatchSize(undefined), 100);
  assert.equal(assertBatchSize(1000), 1000);
  for (const bad of [0, 1001, 1.5, '7']) {
    assert.throws(() => assertBatchSize(bad), { code: 'BATCH_SIZE_INVALID' });
  }
});

test('synthetic UUIDs are deterministic, version 5 shaped, and differ by seed, kind and index', () => {
  const first = syntheticUuid(7, 'booking', 0);
  assert.equal(first, syntheticUuid(7, 'booking', 0));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const distinct = new Set([
    first,
    syntheticUuid(8, 'booking', 0),
    syntheticUuid(7, 'job', 0),
    syntheticUuid(7, 'booking', 1),
  ]);
  assert.equal(distinct.size, 4);
});

test('PRNG is reproducible per seed, kind and index and stays in [0, 1)', () => {
  const a = prngFor(7, 'booking', 3);
  const b = prngFor(7, 'booking', 3);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((value) => value >= 0 && value < 1));
  const other = prngFor(7, 'booking', 4);
  assert.notDeepEqual(seqA, Array.from({ length: 20 }, () => other()));
});

test('namespace prefix is fixed "syn" plus an 8 hex digest derived from the seed', () => {
  assert.match(namespacePrefix(7), /^syn[0-9a-f]{8}$/);
  assert.equal(seedDigest(7).length, 8);
  assert.notEqual(namespacePrefix(7), namespacePrefix(8));
});

test('expected row counts follow the documented formulas', () => {
  assert.deepEqual(expectedCounts(25), {
    accounts: 13,
    services: 4,
    fields: 12,
    bookings: 25,
    booking_events: 25,
    jobs: 3,
    applications: 12,
    offers: 9,
    recruitment_events: 33,
  });
  assert.deepEqual(expectedCounts(1), {
    accounts: 13,
    services: 4,
    fields: 12,
    bookings: 1,
    booking_events: 1,
    jobs: 1,
    applications: 4,
    offers: 3,
    recruitment_events: 11,
  });
});

test('synthetic password must be 12-128 characters and not a known sample secret', () => {
  assert.equal(assertSyntheticPassword('synthetic-only-2026'), 'synthetic-only-2026');
  for (const bad of [undefined, '', 'short', 'local_dev_only', 'disposable_test_only', 'x'.repeat(129)]) {
    assert.throws(() => assertSyntheticPassword(bad), { code: 'SYNTHETIC_PASSWORD_INVALID' });
  }
});

test('generation guard allows only confirmed loopback non-production targets', () => {
  assert.equal(assertGenerateAllowed({ databaseUrl: LOOPBACK_URL, confirmed: true, nodeEnv: undefined }), '127.0.0.1');
  assert.equal(assertGenerateAllowed({ databaseUrl: 'postgresql://u:p@[::1]:5432/agridispatch', confirmed: true }), '[::1]');
  assert.throws(() => assertGenerateAllowed({ databaseUrl: LOOPBACK_URL, confirmed: false }), { code: 'GENERATE_NOT_CONFIRMED' });
  assert.throws(
    () => assertGenerateAllowed({ databaseUrl: LOOPBACK_URL, confirmed: true, nodeEnv: 'production' }),
    { code: 'GENERATE_REFUSED' },
  );
  const refused = [
    'postgresql://u:p@db.example.com:5432/agridispatch',
    'postgresql://u:p@10.0.0.5:5432/agridispatch',
    'postgresql://u:p@agridispatch.postgres.database.azure.com:5432/app',
    'mysql://u:***@127.0.0.1/x',
    'postgresql://u:***@127.0.0.1/x?host=db.example.com',
    'postgresql://u:***@127.0.0.1/x?dbname=production',
    'not a url',
  ];
  for (const databaseUrl of refused) {
    assert.throws(() => assertGenerateAllowed({ databaseUrl, confirmed: true }), { code: 'GENERATE_REFUSED' });
  }
  assert.throws(() => assertGenerateAllowed({ databaseUrl: undefined, confirmed: true }), { code: 'GENERATE_REFUSED' });
});

test('created_at stays before the scheduled start at large counts (no future-dated history)', () => {
  for (const index of [0, 999, 1000, 125000, 999999]) {
    const booking = bookingPlan(7, index);
    assert.ok(booking.createdMs < booking.startMs, `booking ${index} created after start`);
    const job = jobPlan(7, index);
    assert.ok(job.createdMs < job.startMs, `job ${index} created after start`);
  }
});
