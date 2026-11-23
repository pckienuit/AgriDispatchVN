import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedRecruitment, findViolations, validateRecruitmentOptions } from '../scripts/benchmark-recruitment.js';
import { normalizeRun, summarizeCase, toSummaryCsv, toSummaryMarkdown, validateSuiteOptions } from '../scripts/benchmark-suite.js';

const ROOT = 'postgresql://u:p@127.0.0.1:55432/agridispatch_test';

test('recruitment options are bounded, capacity cannot exceed operators, root must be loopback *_test', () => {
  const base = { rootDatabaseUrl: ROOT, operators: 10, capacity: 3, concurrency: 10, timeoutMs: 3000 };
  assert.doesNotThrow(() => validateRecruitmentOptions(base));
  for (const bad of [{ operators: 1 }, { operators: 41 }, { capacity: 0 }, { capacity: 11 }, { concurrency: 0 }, { timeoutMs: 99 }]) {
    assert.throws(() => validateRecruitmentOptions({ ...base, ...bad }), { code: 'INVALID_OPTION' }, JSON.stringify(bad));
  }
  assert.throws(() => validateRecruitmentOptions({ ...base, rootDatabaseUrl: 'postgresql://u:p@db.example.com/x_test' }), { code: 'INVALID_ROOT' });
});

test('every recruitment invariant mismatch is one violation, including over-capacity', () => {
  const expected = expectedRecruitment({ operators: 5, capacity: 2 });
  assert.equal(expected.acceptCapacityFull, 3);
  assert.deepEqual(findViolations(expected, { ...expected }), []);
  const broken = findViolations(expected, { ...expected, acceptedOffers: 3, overCapacity: 1, acceptOk: 3, acceptCapacityFull: 2 });
  assert.deepEqual(broken.map((v) => v.invariant).sort(), ['acceptCapacityFull', 'acceptOk', 'acceptedOffers', 'overCapacity']);
  assert.equal(findViolations(expected, null).length, 1);
});

test('suite options require at least 30 runs, known cases and a safe label', () => {
  const base = { runs: 30, warmupRuns: 2, maxInvalid: 10, cases: ['read', 'recruitment'], label: 'local-before', location: 'Máy phát tải local' };
  assert.doesNotThrow(() => validateSuiteOptions(base));
  for (const bad of [{ runs: 29 }, { warmupRuns: 11 }, { cases: ['write'] }, { cases: [] }, { label: 'Bad Label' }, { location: ' ' }]) {
    assert.throws(() => validateSuiteOptions({ ...base, ...bad }), { code: 'INVALID_OPTION' }, JSON.stringify(bad));
  }
});

test('read runs with any request error are invalid; recruitment validity is separate from violations', () => {
  const agg = { attempted: 10, completed: 10, http4xx: 0, http5xx: 0, redirectRefused: 0, timeouts: 0, network: 0, bodyLimit: 0, p50Ms: 2, p95Ms: 5, throughputRps: 100 };
  assert.equal(normalizeRun('read', { aggregates: agg }).valid, true);
  assert.deepEqual(normalizeRun('read', { aggregates: { ...agg, timeouts: 1 } }).errorCode, 'REQUEST_ERRORS');
  const recruit = normalizeRun('recruitment', { measurementValid: true, violationCount: 2, error: null, aggregates: { attempted: 40, p50Ms: 3, p95Ms: 9 } });
  assert.equal(recruit.valid, true);
  assert.equal(recruit.violationCount, 2);
  const failed = normalizeRun('booking', { ok: false, error: { code: 'SETUP_FAILED' }, aggregates: null });
  assert.deepEqual([failed.valid, failed.errorCode, failed.violationCount], [false, 'SETUP_FAILED', null]);
});

test('a case short of valid runs is marked thiếu and the table never shows it as reached', () => {
  const line = (over) => ({ warmup: false, valid: true, errorCode: null, requests: 40, p50Ms: 3, p95Ms: 8, throughputRps: null, violationCount: 0, ...over });
  const lines = [line({ warmup: true }), ...Array.from({ length: 29 }, () => line()), line({ valid: false, errorCode: 'RUN_FAILED', violationCount: null })];
  const summary = summarizeCase('recruitment', 30, lines);
  assert.equal(summary.status, 'thiếu');
  assert.equal(summary.validRuns, 29);
  assert.equal(summary.warmupRuns, 1);
  assert.deepEqual(summary.invalidByCode, { RUN_FAILED: 1 });
  assert.equal(summary.violationsTotal, 0);
  const md = toSummaryMarkdown({
    label: 'local-before', startedAt: 'a', finishedAt: 'b', cases: [summary],
    conditions: { location: 'local', readTarget: 'x', writeTarget: 'y', buildSha: null, host: { platform: 'p', release: 'r', cpus: 1, cpuModel: 'c', node: 'v' } },
  });
  assert.match(md, /\| recruitment \| thiếu \| 29\/30 \|/);
  assert.doesNotMatch(md, /—/);
  assert.match(toSummaryCsv([{ case: 'read', run: 1, file: 'runs/a,b.json' }]), /"runs\/a,b.json"/);
});
