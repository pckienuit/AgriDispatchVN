// H-03 advisory helpers (pure, no DOM). Area thresholds are assumption-labeled hints, never validation rules.
import assert from 'node:assert/strict';
import test from 'node:test';
import { groupAreaAdvice, groupCandidateHint } from '../../web/v2/screens/coop.js';

const T = { clusterMinHa: 15, clusterTargetHa: 20, clusterMaxHa: 50 };
const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 3600e3).toISOString();
const row = (id, areaM2, fromH, toH, extra = {}) => ({
  id,
  fieldName: `Thửa ${id}`,
  locality: 'Vĩnh Trạch',
  serviceId: 'svc-1',
  serviceName: 'Gặt',
  areaM2,
  startAt: at(fromH),
  endAt: at(toH),
  ...extra,
});

test('area advice maps m2 to ha hint level, no validation semantics', () => {
  assert.equal(groupAreaAdvice(14000, T).level, 'below_min');
  assert.match(groupAreaAdvice(14000, T).text, /Dưới ngưỡng gợi ý tối thiểu 15 ha/);
  assert.equal(groupAreaAdvice(150000, T).level, 'min_reached');
  assert.match(groupAreaAdvice(150000, T).text, /chưa đạt mục tiêu 20 ha/);
  assert.equal(groupAreaAdvice(200000, T).level, 'target_reached');
  assert.match(groupAreaAdvice(200000, T).text, /Đạt mục tiêu gợi ý 20 ha/);
  assert.equal(groupAreaAdvice(500000, T).level, 'target_reached');
  assert.equal(groupAreaAdvice(500001, T).level, 'above_max');
  for (const areaM2 of [0, 14000, 150000, 200000, 500001]) {
    assert.doesNotMatch(groupAreaAdvice(areaM2, T).text, /km|[\u2013\u2014]/);
  }
});

test('area advice returns null without complete server thresholds (no fallback values)', () => {
  assert.equal(groupAreaAdvice(200000, null), null);
  assert.equal(groupAreaAdvice(200000, { clusterMinHa: 15, clusterTargetHa: 20 }), null);
  assert.equal(groupAreaAdvice(200000, { ...T, clusterTargetHa: 'x' }), null);
});

test('candidate hint takes the smallest single booking that reaches target', () => {
  const selected = [row('a', 140000, 0, 10)];
  const pool = [
    row('b', 60000, 1, 11),
    row('c', 90000, 0, 10, { locality: 'Long Hữu' }),
    row('d', 120000, 20, 30),
    row('e', 80000, 0, 10),
    row('f', 30000, 0, 10, { serviceId: 'svc-2' }),
  ];
  const hint = groupCandidateHint(selected, pool, T);
  assert.deepEqual(hint.rows.map((r) => r.id), ['b']);
  assert.equal(hint.reachesGoal, true);
  assert.equal(hint.areaM2, 200000);
  // Deterministic: input order must not change the hint.
  assert.deepEqual(groupCandidateHint(selected, [...pool].reverse(), T).rows.map((r) => r.id), ['b']);
});

test('candidate hint adds largest compatible rows first when no single booking suffices', () => {
  const selected = [row('a', 140000, 0, 10)];
  const pool = [row('x', 30000, 0, 10), row('y', 40000, 0, 10), row('z', 50000, 0, 10)];
  const hint = groupCandidateHint(selected, pool, T);
  assert.deepEqual(hint.rows.map((r) => r.id), ['z', 'y']);
  assert.equal(hint.areaM2, 230000);
  assert.equal(hint.reachesGoal, true);
});

test('candidate hint is null when target unreachable, base invalid, or goal already met', () => {
  assert.equal(groupCandidateHint([row('a', 10000, 0, 10)], [row('e', 30000, 0, 10)], T), null);
  assert.equal(groupCandidateHint([row('a', 200000, 0, 10)], [row('e', 30000, 0, 10)], T), null);
  assert.equal(groupCandidateHint([row('a', 140000, 0, 10, { serviceId: 'svc-2' })], [row('e', 30000, 0, 10)], T), null);
  assert.equal(groupCandidateHint([row('a', 140000, 0, 10)], [], T), null);
  assert.equal(groupCandidateHint([], [row('e', 30000, 0, 10)], T), null);
  assert.equal(groupCandidateHint([row('a', 140000, 0, 10)], [row('e', 90000, 0, 10)], null), null);
});

test('candidate hint never offers a booking whose window does not overlap the common window', () => {
  const selected = [row('a', 140000, 0, 10)];
  assert.equal(groupCandidateHint(selected, [row('e', 90000, 10, 20)], T), null);
  assert.deepEqual(groupCandidateHint(selected, [row('e', 90000, 9, 20)], T).rows.map((r) => r.id), ['e']);
});
