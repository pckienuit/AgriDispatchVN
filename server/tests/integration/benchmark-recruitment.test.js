import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRecruitmentBenchmark } from '../../scripts/benchmark-recruitment.js';

test('recruitment harness fills exactly capacity with more accounts than the default register throttle under concurrent accepts and cleans up', async () => {
  const report = await runRecruitmentBenchmark({ rootDatabaseUrl: process.env.TEST_DATABASE_URL, operators: 12, capacity: 4, concurrency: 12, timeoutMs: 5000 });
  assert.equal(report.error, null, JSON.stringify(report.error));
  assert.equal(report.measurementValid, true);
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.equal(report.observed.acceptedOffers, 4);
  assert.equal(report.observed.acceptCapacityFull, 8);
  assert.equal(report.observed.applyDuplicateRefused, 12);
  assert.equal(report.rows.length, 12 * 2 + 12 + 12);
  assert.equal(report.cleanup.childDropped, true);
  for (const row of report.rows) assert.ok(!('token' in row) && !String(row.path).includes('-'), 'rows keep path templates, no ids or tokens');
});
