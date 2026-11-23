import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCredentials, findViolations, loadCredentials, runCloudBookingBenchmark, runCloudRecruitmentBenchmark, validateCredentials,
} from '../scripts/benchmark-cloud-writes.js';

const ORIGIN = 'https://staging.example.test';

test('generated credentials are synthetic, unique and bound to one origin', () => {
  const creds = createCredentials(ORIGIN, 10);
  const accounts = [creds.farmer, creds.provider, ...creds.operators];
  assert.equal(creds.operators.length, 10);
  assert.equal(new Set(accounts.map((a) => a.email)).size, 12);
  assert.ok(accounts.every((a) => a.email.startsWith('cl12-bench-') && a.email.endsWith('@bench.example.test') && a.password.length >= 20 && a.registered === false));
  assert.doesNotThrow(() => validateCredentials(creds, ORIGIN));
  assert.throws(() => validateCredentials(creds, 'https://other.example.test'), { code: 'INVALID_CREDENTIALS' });
  assert.throws(() => validateCredentials({ ...creds, operators: creds.operators.slice(0, 1) }, ORIGIN), { code: 'INVALID_CREDENTIALS' });
  assert.throws(() => validateCredentials({ ...creds, farmer: { ...creds.farmer, email: 'real@gmail.com' } }, ORIGIN), { code: 'INVALID_CREDENTIALS' });
});

test('credentials file must live outside the repo', async () => {
  await assert.rejects(loadCredentials('./bench-creds.json', ORIGIN), { code: 'CREDENTIALS_IN_REPO' });
  await assert.rejects(loadCredentials(undefined, ORIGIN), { code: 'CREDENTIALS_REQUIRED' });
});

test('remote targets need allowRemote, HTTPS and an approved host before any request', async () => {
  const creds = createCredentials(ORIGIN, 2);
  await assert.rejects(runCloudBookingBenchmark({ baseUrl: ORIGIN, creds }), { code: 'REMOTE_NOT_ALLOWED' });
  await assert.rejects(runCloudBookingBenchmark({ baseUrl: 'http://staging.example.test', allowRemote: true, allowedHosts: ['staging.example.test'], creds }), { code: 'INSECURE_REMOTE' });
  await assert.rejects(runCloudRecruitmentBenchmark({ baseUrl: ORIGIN, allowRemote: true, allowedHosts: ['other.example.test'], creds }), { code: 'REMOTE_HOST_NOT_APPROVED' });
  await assert.rejects(runCloudRecruitmentBenchmark({ baseUrl: ORIGIN, allowRemote: true, allowedHosts: ['staging.example.test'], creds, capacity: 3 }), { code: 'INVALID_OPTION' });
});

test('each invariant mismatch is one violation', () => {
  const expected = { acceptedOffers: 3, overCapacity: 0, unauthorizedProbe: 401 };
  assert.deepEqual(findViolations(expected, { ...expected }), []);
  assert.deepEqual(findViolations(expected, { ...expected, acceptedOffers: 4, overCapacity: 1 }).map((v) => v.invariant), ['acceptedOffers', 'overCapacity']);
  assert.equal(findViolations(expected, null).length, 1);
});
