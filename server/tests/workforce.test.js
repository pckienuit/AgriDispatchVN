import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkforceProfile, validateWageReport } from '../src/workforce.js';
import { validateJobInput } from '../src/recruitment.js';

test('workforce profile validates self-reported skills and dated certification without claiming verification', () => {
  assert.deepEqual(validateWorkforceProfile({ skills: ['gặt lúa'], certifications: [{ name: 'Vận hành máy', expiresAt: '2027-01-01' }] }), {
    skills: ['gặt lúa'], certifications: [{ name: 'Vận hành máy', expiresAt: '2027-01-01' }],
  });
  assert.throws(() => validateWorkforceProfile({ skills: ['x'], verified: true }), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateWorkforceProfile({ skills: [], certifications: [{ name: 'A', expiresAt: 'bad' }] }), { code: 'VALIDATION_FAILED' });
});

test('recruitment details persist only explicit wage, machine, and skills choices', () => {
  const base = { title: 'Việc', locality: 'Xã A', capacity: 1, startAt: '2027-01-01T00:00:00Z', endAt: '2027-01-01T01:00:00Z' };
  const noHistoricDefaults = validateJobInput(base);
  assert.equal(noHistoricDefaults.wageType, null);
  assert.equal(noHistoricDefaults.wageAmountVnd, null);
  assert.equal(noHistoricDefaults.machineType, null);
  assert.deepEqual(noHistoricDefaults.requiredSkills, []);
  assert.deepEqual(validateJobInput({ ...base, wageType: 'PER_HA', wageAmountVnd: 250000, machineType: 'harvester', requiredSkills: ['gặt lúa'] }).requiredSkills, ['gặt lúa']);
  assert.throws(() => validateJobInput({ ...base, wageType: 'NEGOTIABLE', wageAmountVnd: 250000 }), { code: 'VALIDATION_FAILED' });
});

test('wage report requires positive VND and bounded text', () => {
  assert.deepEqual(validateWageReport({ amountVnd: '1250000', note: 'tiền mặt' }), { amountVnd: '1250000', note: 'tiền mặt' });
  assert.throws(() => validateWageReport({ amountVnd: '0' }), { code: 'VALIDATION_FAILED' });
  assert.throws(() => validateWageReport({ amountVnd: '100', note: 'ok', status: 'PAID' }), { code: 'UNKNOWN_FIELD' });
});
