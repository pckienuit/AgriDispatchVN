import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import {
  ACCOUNT_TABLES,
  DEFAULT_ROLES,
  DISPATCH_TABLES,
  PASSWORD_ENVS,
  main,
  planBootstrap,
  scramKeys,
  scramVerifier,
} from '../scripts/bootstrap-db.js';

// Synthetic, test-only passwords. Never used outside this file.
const ACCOUNT_PW = 'synthetic-account-pw-0123456789ABCDEFGHIJ';
const BOOKING_PW = 'synthetic-booking-pw-0123456789ABCDEFGHIJ';
const DEAD_URL = 'postgresql://admin_user:synthetic-admin-pw@127.0.0.1:1/agridispatch_test';

const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

test('SCRAM verifier matches RFC 7677 worked example', () => {
  // RFC 7677 section 3: user "user", password "pencil", salt and iterations below.
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  // Policy-free derivation: the RFC vector password is intentionally short.
  const { storedKey, serverKey } = scramKeys('pencil', { salt, iterations: 4096 });

  const authMessage = [
    'n=user,r=rOprNGfwEbeRWgbNEkqO',
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096',
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
  ].join(',');
  const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
  const signature = hmac(storedKey, authMessage);
  const recoveredClientKey = Buffer.from(proof.map((byte, i) => byte ^ signature[i]));
  assert.deepEqual(sha256(recoveredClientKey), storedKey, 'RFC client proof must verify against stored key');
  assert.equal(hmac(serverKey, authMessage).toString('base64'), '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
});

test('SCRAM verifier has the PostgreSQL stored format and rejects weak or non-ASCII passwords', () => {
  assert.match(scramVerifier(ACCOUNT_PW), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(scramVerifier(ACCOUNT_PW), scramVerifier(ACCOUNT_PW), 'fresh salt per call');
  for (const bad of ['short', 'x'.repeat(31), 'has space '.padEnd(40, 'a'), 'ünicode-password-'.padEnd(40, 'a'), 'ctrl\nchar'.padEnd(40, 'a'), 'x'.repeat(257)]) {
    assert.throws(() => scramVerifier(bad), { code: 'PASSWORD_POLICY' });
  }
});

test('fixed runtime role names and per-role password variables are the contract', () => {
  assert.deepEqual(DEFAULT_ROLES, { account: 'account_runtime', booking: 'booking_runtime' });
  assert.deepEqual(PASSWORD_ENVS, { account: 'NEW_ACCOUNT_DB_PASSWORD', booking: 'NEW_BOOKING_DB_PASSWORD' });
});

test('relation inventory constants match every CREATE TABLE in the real migrations', () => {
  const dir = new URL('../../db/migrations/', import.meta.url);
  const found = { account: new Set(), dispatch: new Set() };
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql'))) {
    for (const match of readFileSync(new URL(name, dir), 'utf8').matchAll(/CREATE TABLE (account|dispatch)\.([a-z_]+)/g)) {
      found[match[1]].add(match[2]);
    }
  }
  assert.deepEqual([...ACCOUNT_TABLES].sort(), [...found.account].sort());
  assert.deepEqual([...DISPATCH_TABLES].sort(), [...found.dispatch].sort());
});

test('dry-run is the default, needs no passwords and reports only safe names', () => {
  const plan = planBootstrap([], { DATABASE_URL: DEAD_URL });
  assert.deepEqual(plan, { mode: 'dry-run', target: { hostname: '127.0.0.1', database: 'agridispatch_test' } });
});

test('apply requires exact hostname and database confirmation before any password is read', () => {
  const env = { DATABASE_URL: DEAD_URL, NEW_ACCOUNT_DB_PASSWORD: ACCOUNT_PW, NEW_BOOKING_DB_PASSWORD: BOOKING_PW };
  assert.throws(() => planBootstrap(['--apply'], env), { code: 'CONFIRMATION_MISMATCH' });
  assert.throws(() => planBootstrap(['--apply', '--confirm-host', 'localhost', '--confirm-database', 'agridispatch_test'], env), { code: 'CONFIRMATION_MISMATCH' });
  assert.throws(() => planBootstrap(['--apply', '--confirm-host', '127.0.0.1', '--confirm-database', 'agridispatch'], env), { code: 'CONFIRMATION_MISMATCH' });
});

test('apply refuses missing, identical or weak role passwords', () => {
  const confirm = ['--apply', '--confirm-host', '127.0.0.1', '--confirm-database', 'agridispatch_test'];
  assert.throws(() => planBootstrap(confirm, { DATABASE_URL: DEAD_URL, NEW_BOOKING_DB_PASSWORD: BOOKING_PW }), { code: 'PASSWORD_MISSING' });
  assert.throws(() => planBootstrap(confirm, { DATABASE_URL: DEAD_URL, NEW_ACCOUNT_DB_PASSWORD: ACCOUNT_PW, NEW_BOOKING_DB_PASSWORD: ACCOUNT_PW }), { code: 'PASSWORDS_NOT_DISTINCT' });
  assert.throws(() => planBootstrap(confirm, { DATABASE_URL: DEAD_URL, NEW_ACCOUNT_DB_PASSWORD: 'short', NEW_BOOKING_DB_PASSWORD: BOOKING_PW }), { code: 'PASSWORD_POLICY' });
});

test('remote runtime URL without verify-full is refused by the parent TLS policy', () => {
  assert.throws(
    () => planBootstrap([], { DATABASE_URL: 'postgresql://admin:x@db.example.net/agridispatch' }),
    /Invalid database connection configuration/,
  );
  assert.throws(
    () => planBootstrap([], { DATABASE_URL: 'postgresql://admin:x@db.example.net/agridispatch?sslmode=require' }),
    /Invalid database connection configuration/,
  );
});

test('unknown flags, dry-run with apply and extra positional values are usage refusals', () => {
  for (const argv of [['--frobnicate'], ['--apply', '--dry-run'], ['--confirm-host']]) {
    assert.throws(() => planBootstrap(argv, { DATABASE_URL: DEAD_URL }), { code: 'USAGE' }, argv.join(' '));
  }
});

test('CLI dry-run prints the plan and never echoes credentials or the URL', async () => {
  const out = [];
  const err = [];
  const code = await main([], { DATABASE_URL: DEAD_URL, NEW_ACCOUNT_DB_PASSWORD: ACCOUNT_PW }, { log: (line) => out.push(line), logError: (line) => err.push(line) });
  assert.equal(code, 0);
  const text = out.join('\n') + err.join('\n');
  for (const secret of [DEAD_URL, 'synthetic-admin-pw', ACCOUNT_PW, 'admin_user']) assert.ok(!text.includes(secret), 'no secret echoed');
  const body = JSON.parse(out[0]);
  assert.equal(body.mode, 'dry-run');
  assert.deepEqual(body.roles, DEFAULT_ROLES);
});

test('CLI apply refusals exit 2 without connecting', async () => {
  const err = [];
  const code = await main(['--apply'], { DATABASE_URL: DEAD_URL }, { log: () => {}, logError: (line) => err.push(line), createPoolFn: () => { throw new Error('must not connect'); } });
  assert.equal(code, 2);
  assert.match(err.join('\n'), /CONFIRMATION_MISMATCH/);
});

test('CLI apply with a closed port exits 1 and prints only a safe code', async () => {
  const out = [];
  const err = [];
  const code = await main(
    ['--apply', '--confirm-host', '127.0.0.1', '--confirm-database', 'agridispatch_test'],
    { DATABASE_URL: DEAD_URL, NEW_ACCOUNT_DB_PASSWORD: ACCOUNT_PW, NEW_BOOKING_DB_PASSWORD: BOOKING_PW },
    { log: (line) => out.push(line), logError: (line) => err.push(line) },
  );
  assert.equal(code, 1);
  const text = out.join('\n') + err.join('\n');
  for (const secret of [DEAD_URL, 'synthetic-admin-pw', ACCOUNT_PW, BOOKING_PW]) assert.ok(!text.includes(secret));
});
