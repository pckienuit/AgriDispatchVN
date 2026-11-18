import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, parseAdminArgs, planAdmin } from '../scripts/bootstrap-admin.js';

const USER = '9a2f1c3e-4b5d-4e6f-8a7b-0c1d2e3f4a5b';
const DEAD_URL = 'postgresql://admin_user:synthetic-admin-pw@127.0.0.1:1/agridispatch_test';
const APPLY = ['--user-id', USER, '--apply', '--confirm-user-id', USER, '--confirm-host', '127.0.0.1', '--confirm-database', 'agridispatch_test'];

test('user id must be exactly one UUID and is lowercased', () => {
  assert.equal(parseAdminArgs(['--user-id', USER.toUpperCase()]).userId, USER);
  for (const bad of ['', 'not-a-uuid', `${USER},${USER}`, `${USER}\n`, '00000000-0000-0000-0000-00000000000']) {
    assert.throws(() => parseAdminArgs(['--user-id', bad]), { code: 'USAGE' }, JSON.stringify(bad));
  }
  assert.throws(() => parseAdminArgs([]), { code: 'USAGE' });
});

test('apply requires user, host and database confirmations that match exactly', () => {
  const env = { DATABASE_URL: DEAD_URL };
  assert.equal(planAdmin(APPLY, env).mode, 'apply');
  const swapped = [...APPLY];
  swapped[swapped.indexOf('--confirm-user-id') + 1] = '11111111-1111-4111-8111-111111111111';
  assert.throws(() => planAdmin(swapped, env), { code: 'CONFIRMATION_MISMATCH' });
  assert.throws(() => planAdmin(APPLY.map((item) => (item === '127.0.0.1' ? 'localhost' : item)), env), { code: 'CONFIRMATION_MISMATCH' });
  assert.throws(() => planAdmin(APPLY.map((item) => (item === 'agridispatch_test' ? 'agridispatch' : item)), env), { code: 'CONFIRMATION_MISMATCH' });
  assert.throws(() => planAdmin(['--user-id', USER, '--apply'], env), { code: 'CONFIRMATION_MISMATCH' });
});

test('dry-run is the default and prints no URL or credentials', async () => {
  const out = [];
  const code = await main(['--user-id', USER], { DATABASE_URL: DEAD_URL }, { log: (line) => out.push(line), logError: () => {}, createPoolFn: () => { throw new Error('must not connect'); } });
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.ok(!text.includes('synthetic-admin-pw') && !text.includes(DEAD_URL));
  assert.equal(JSON.parse(text).mode, 'dry-run');
});

test('apply refusal exits 2 before connecting; closed port exits 1 with safe output', async () => {
  const err = [];
  assert.equal(await main(['--user-id', USER, '--apply'], { DATABASE_URL: DEAD_URL }, { log: () => {}, logError: (line) => err.push(line), createPoolFn: () => { throw new Error('must not connect'); } }), 2);
  const out = [];
  const errs = [];
  assert.equal(await main(APPLY, { DATABASE_URL: DEAD_URL }, { log: (line) => out.push(line), logError: (line) => errs.push(line) }), 1);
  assert.ok(!(out.join('') + errs.join('')).includes('synthetic-admin-pw'));
});
