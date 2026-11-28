import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_JOB_CAPACITY, validateJobInput } from '../src/recruitment.js';

const valid = {
  title: 'Gặt lúa bằng máy (giả lập)',
  locality: 'Châu Thành',
  capacity: 1,
  startAt: '2026-12-01T01:00:00Z',
  endAt: '2026-12-01T05:00:00Z',
};

test('job input accepts a valid window and normalises instants to UTC ISO', () => {
  assert.deepEqual(validateJobInput({ ...valid, capacity: MAX_JOB_CAPACITY }), { ...valid, capacity: MAX_JOB_CAPACITY, startAt: '2026-12-01T01:00:00.000Z', endAt: '2026-12-01T05:00:00.000Z', wageType: null, wageAmountVnd: null, machineType: null, requiredSkills: [] });
});

test('job input refuses unknown keys, bad capacity, non-UTC or impossible dates and empty windows', () => {
  const cases = [
    [{ ...valid, providerId: 'x' }, 'UNKNOWN_FIELD', undefined],
    [{ ...valid, capacity: 0 }, 'VALIDATION_FAILED', 'capacity'],
    [{ ...valid, capacity: '1' }, 'VALIDATION_FAILED', 'capacity'],
    [{ ...valid, capacity: 1.5 }, 'VALIDATION_FAILED', 'capacity'],
    [{ ...valid, startAt: '2026-12-01T01:00:00+07:00' }, 'VALIDATION_FAILED', 'startAt'],
    [{ ...valid, startAt: '2026-02-30T01:00:00Z' }, 'VALIDATION_FAILED', 'startAt'],
    [{ ...valid, endAt: valid.startAt }, 'VALIDATION_FAILED', 'endAt'],
    [{ ...valid, title: '   ' }, 'VALIDATION_FAILED', 'title'],
    [[], 'INVALID_BODY', undefined],
  ];
  for (const [body, code, field] of cases) {
    assert.throws(() => validateJobInput(body), (error) => error.code === code && error.field === field, JSON.stringify(body));
  }
});
