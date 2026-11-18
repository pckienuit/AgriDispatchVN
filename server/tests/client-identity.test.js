import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
  buildTrustedProxyBlockList,
  checkTrustedProxyHops,
  deriveClientIdentityKey,
  normalizeIp,
  resolveClientIp,
  signClientIdentity,
  verifyClientIdentity,
} from '../src/client-identity.js';

test('normalizeIp canonicalizes IPv4, IPv4-mapped IPv6 and RFC 5952 IPv6, and rejects malformed values', () => {
  assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('203.0.113.5'), '203.0.113.5');
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('::FFFF:203.0.113.5'), '203.0.113.5');
  assert.equal(normalizeIp('0:0:0:0:0:ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeIp('::ffff:c000:0201'), '192.0.2.1');
  assert.equal(normalizeIp('2001:0db8:0000:0000:0000:ff00:0042:8329'), '2001:db8::ff00:42:8329');
  assert.equal(normalizeIp('2001:DB8::1'), '2001:db8::1');
  assert.equal(normalizeIp('::1'), '::1');
  assert.equal(normalizeIp('fe80::1%eth0', { allowZone: true }), 'fe80::1');
  assert.equal(normalizeIp('203.0.113.5:54321', { allowPort: true }), '203.0.113.5');
  assert.equal(normalizeIp('[2001:DB8::1]:443', { allowPort: true }), '2001:db8::1');

  for (const bad of [
    '',
    'unknown',
    '0127.0.0.1',
    '127.0.0.1 ',
    ' 127.0.0.1',
    '127.0.0.1:8080',
    '[::1]:8080',
    'fe80::1%eth0',
    '127.0.0.1\nX-Evil: 1',
    '203.0.113.5:99999',
    '1'.repeat(101),
    null,
    123,
  ]) {
    assert.equal(normalizeIp(bad), null, String(bad));
  }
  assert.equal(normalizeIp('203.0.113.5:99999', { allowPort: true }), null);
  assert.equal(normalizeIp('203.0.113.5:0', { allowPort: true }), null);
});

test('checkTrustedProxyHops and buildTrustedProxyBlockList reject invalid proxy config', () => {
  assert.equal(checkTrustedProxyHops(undefined), 0);
  assert.equal(checkTrustedProxyHops(0), 0);
  assert.equal(checkTrustedProxyHops(1), 1);
  assert.equal(checkTrustedProxyHops(10), 10);
  for (const bad of [-1, 1.5, 11, '1', true, null, NaN]) {
    assert.throws(() => checkTrustedProxyHops(bad), /trustedProxyHops/);
  }
  assert.equal(buildTrustedProxyBlockList(undefined), null);
  const blockList = buildTrustedProxyBlockList(['10.0.0.0/8', '2001:db8::/32', '127.0.0.1']);
  assert.ok(blockList);
  for (const badCidrs of ['10.0.0.0/8', ['not-an-ip'], ['10.0.0.0/33'], ['2001:db8::/129'], ['10.0.0.0/-1'], []]) {
    assert.throws(() => buildTrustedProxyBlockList(badCidrs), /trustedProxyCidrs/);
  }
});

test('resolveClientIp ignores XFF by default and unwraps only configured rightmost trusted hops', () => {
  const req = (remoteAddress, xff) => ({
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });

  // Default trustedProxyHops=0 ignores XFF completely.
  assert.equal(resolveClientIp(req('::ffff:10.0.0.5', '198.51.100.99')), '10.0.0.5');

  // trustedProxyHops=1 takes rightmost XFF entry and ignores left-side client spoofs.
  assert.equal(resolveClientIp(req('10.0.0.5', '1.1.1.1, 203.0.113.10'), { trustedProxyHops: 1 }), '203.0.113.10');
  assert.equal(resolveClientIp(req('10.0.0.5', '1.1.1.1, 203.0.113.10:54321'), { trustedProxyHops: 1 }), '203.0.113.10');
  assert.equal(resolveClientIp(req('10.0.0.5', 'bad-entry, [2001:DB8::1]:443'), { trustedProxyHops: 1 }), '2001:db8::1');

  // Missing or insufficient or malformed trusted hops fall back safely to socket IP.
  assert.equal(resolveClientIp(req('10.0.0.5', undefined), { trustedProxyHops: 1 }), '10.0.0.5');
  assert.equal(resolveClientIp(req('10.0.0.5', '203.0.113.10'), { trustedProxyHops: 2 }), '10.0.0.5');
  assert.equal(resolveClientIp(req('10.0.0.5', '203.0.113.10, garbage'), { trustedProxyHops: 1 }), '10.0.0.5');
  assert.equal(resolveClientIp(req('10.0.0.5', '203.0.113.10, ' + '1.2.3.4, '.repeat(300)), { trustedProxyHops: 1 }), '10.0.0.5');

  // trustedProxyHops=2 unwraps two rightmost hops.
  assert.equal(resolveClientIp(req('10.0.0.5', '9.9.9.9, 203.0.113.10, 10.0.0.2'), { trustedProxyHops: 2 }), '203.0.113.10');

  // CIDR allowlist refuses XFF if connecting peer is not a trusted proxy.
  const trustedProxyList = buildTrustedProxyBlockList(['10.0.0.0/8']);
  assert.equal(resolveClientIp(req('198.51.100.7', '203.0.113.10'), { trustedProxyHops: 1, trustedProxyList }), '198.51.100.7');
  assert.equal(resolveClientIp(req('::ffff:10.0.0.5', '203.0.113.10'), { trustedProxyHops: 1, trustedProxyList }), '203.0.113.10');
  // With 2 hops + CIDR list, if hop-1 is not in CIDR list, stop at that untrusted hop.
  assert.equal(resolveClientIp(req('10.0.0.5', '203.0.113.10, 198.51.100.8'), { trustedProxyHops: 2, trustedProxyList }), '198.51.100.8');
});

test('deriveClientIdentityKey rejects weak tokens without echoing them', () => {
  const short = 'weak-secret-token';
  assert.throws(
    () => deriveClientIdentityKey(short),
    (err) => /INTERNAL_SERVICE_TOKEN/.test(err.message) && !err.message.includes(short),
  );
  assert.throws(() => deriveClientIdentityKey('x'.repeat(31) + ' '), /INTERNAL_SERVICE_TOKEN/);
  assert.throws(() => deriveClientIdentityKey('x'.repeat(257)), /INTERNAL_SERVICE_TOKEN/);
  const key = deriveClientIdentityKey('x'.repeat(32));
  assert.equal(Buffer.isBuffer(key), true);
  assert.equal(key.length, 32);
});

test('signClientIdentity and verifyClientIdentity bind IP, timestamp, requestId, method and path within 60s', () => {
  const key = deriveClientIdentityKey('shared-gateway-secret-0123456789abcdef');
  const nowMs = 1_795_000_000_000;
  const headers = signClientIdentity({
    key,
    address: '::ffff:203.0.113.5',
    method: 'post',
    path: '/api/auth/login',
    requestId: 'req-trace-0001',
    timestampMs: nowMs,
  });
  assert.equal(headers['X-Client-Address'], '203.0.113.5');
  assert.equal(headers['X-Client-Timestamp'], String(nowMs));
  assert.match(headers['X-Client-Signature'], /^[0-9a-f]{64}$/);
  for (const val of Object.values(headers)) assert.ok(val.length <= 100);

  const makeReq = (hdrs, overrides = {}) => ({
    method: 'POST',
    path: '/api/auth/login',
    requestId: 'req-trace-0001',
    headers: Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v])),
    ...overrides,
  });

  // Exact match and boundary freshness (60s inclusive).
  assert.deepEqual(verifyClientIdentity(makeReq(headers), { key, nowMs }), { present: true, ok: true, address: '203.0.113.5' });
  assert.deepEqual(verifyClientIdentity(makeReq(headers), { key, nowMs: nowMs + 60_000 }), { present: true, ok: true, address: '203.0.113.5' });
  assert.deepEqual(verifyClientIdentity(makeReq(headers), { key, nowMs: nowMs - 60_000 }), { present: true, ok: true, address: '203.0.113.5' });

  // Absent headers -> present: false.
  assert.deepEqual(verifyClientIdentity(makeReq({}), { key, nowMs }), { present: false, ok: false, address: null });

  // Expired (>60s past or future) -> rejected.
  assert.equal(verifyClientIdentity(makeReq(headers), { key, nowMs: nowMs + 60_001 }).ok, false);
  assert.equal(verifyClientIdentity(makeReq(headers), { key, nowMs: nowMs - 60_001 }).ok, false);

  // Method, path, requestId, address, or key mismatch -> rejected.
  assert.equal(verifyClientIdentity(makeReq(headers, { method: 'GET' }), { key, nowMs }).ok, false);
  assert.equal(verifyClientIdentity(makeReq(headers, { path: '/api/auth/register' }), { key, nowMs }).ok, false);
  assert.equal(verifyClientIdentity(makeReq(headers, { requestId: 'other-req-0001' }), { key, nowMs }).ok, false);
  assert.equal(verifyClientIdentity(makeReq({ ...headers, 'X-Client-Address': '203.0.113.6' }), { key, nowMs }).ok, false);
  const otherKey = deriveClientIdentityKey('other-gateway-secret-0123456789abcdef');
  assert.equal(verifyClientIdentity(makeReq(headers), { key: otherKey, nowMs }).ok, false);

  // Partial, oversized (>100), non-canonical IP, or array headers -> present: true, ok: false.
  for (const badHeaders of [
    { 'X-Client-Address': '203.0.113.5' },
    { 'X-Client-Timestamp': String(nowMs) },
    { 'X-Client-Signature': headers['X-Client-Signature'] },
    { ...headers, 'X-Client-Address': '2001:0db8::1' },
    { ...headers, 'X-Client-Address': '1'.repeat(101) },
    { ...headers, 'X-Client-Signature': '0'.repeat(63) },
    { ...headers, 'X-Client-Signature': 'g'.repeat(64) },
    { ...headers, 'X-Client-Address': ['203.0.113.5'] },
  ]) {
    const result = verifyClientIdentity(makeReq(badHeaders), { key, nowMs });
    assert.equal(result.present, true);
    assert.equal(result.ok, false);
  }
});
