import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { sanitizeRequestId } from './observability.js';

export const CLIENT_ADDRESS_HEADER = 'x-client-address';
export const CLIENT_TIMESTAMP_HEADER = 'x-client-timestamp';
export const CLIENT_SIGNATURE_HEADER = 'x-client-signature';
export const MAX_CLIENT_IDENTITY_HEADER_LENGTH = 100;
export const DEFAULT_CLIENT_IDENTITY_TTL_MS = 60_000;
export const MAX_TRUSTED_PROXY_HOPS = 10;
const MAX_XFF_HEADER_LENGTH = 2048;

const IPV4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const IPV4_PORT = /^([^:]+):(\d{1,5})$/;
const BRACKET_IPV6_PORT = /^\[([^\]]+)\]:(\d{1,5})$/;
const ZONE_SUFFIX = /%[A-Za-z0-9._-]+$/;

function validPort(portText) {
  if (!/^\d{1,5}$/.test(portText)) return false;
  if (portText.length > 1 && portText.startsWith('0')) return false;
  const port = Number(portText);
  return port >= 1 && port <= 65535;
}

export function normalizeIp(value, { allowZone = false, allowPort = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CLIENT_IDENTITY_HEADER_LENGTH) {
    return null;
  }
  if (/[\s\p{Cc}]/u.test(value)) return null;

  let candidate = value;
  if (allowPort) {
    const bracketed = BRACKET_IPV6_PORT.exec(candidate);
    if (bracketed) {
      if (!validPort(bracketed[2]) || isIP(bracketed[1]) !== 6) return null;
      candidate = bracketed[1];
    } else {
      const v4Port = IPV4_PORT.exec(candidate);
      if (v4Port) {
        if (!validPort(v4Port[2]) || isIP(v4Port[1]) !== 4) return null;
        candidate = v4Port[1];
      }
    }
  }

  if (allowZone && candidate.includes('%')) {
    if (!ZONE_SUFFIX.test(candidate)) return null;
    candidate = candidate.replace(ZONE_SUFFIX, '');
  } else if (candidate.includes('%')) {
    return null;
  }

  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family !== 6) return null;

  let canonical;
  try {
    canonical = new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = IPV4_MAPPED_HEX.exec(canonical);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return canonical;
}

export function checkTrustedProxyHops(value = 0) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TRUSTED_PROXY_HOPS) {
    throw new Error(`trustedProxyHops must be an integer between 0 and ${MAX_TRUSTED_PROXY_HOPS}`);
  }
  return value;
}

export function buildTrustedProxyBlockList(cidrs) {
  if (cidrs === undefined || cidrs === null) return null;
  if (!Array.isArray(cidrs) || cidrs.length === 0) {
    throw new Error('trustedProxyCidrs must be a non-empty array of IP or CIDR strings');
  }
  const list = new BlockList();
  for (const raw of cidrs) {
    if (typeof raw !== 'string') throw new Error('trustedProxyCidrs entries must be strings');
    const slash = raw.indexOf('/');
    if (slash === -1) {
      const ip = normalizeIp(raw);
      if (!ip) throw new Error('trustedProxyCidrs contains an invalid IP');
      list.addAddress(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
      continue;
    }
    const addr = normalizeIp(raw.slice(0, slash));
    const prefixText = raw.slice(slash + 1);
    if (!addr || !/^\d{1,3}$/.test(prefixText)) throw new Error('trustedProxyCidrs contains an invalid CIDR');
    const prefix = Number(prefixText);
    const family = isIP(addr);
    const maxPrefix = family === 6 ? 128 : 32;
    if (prefix < 0 || prefix > maxPrefix) throw new Error('trustedProxyCidrs prefix out of range');
    list.addSubnet(addr, prefix, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

function isTrustedProxyIp(blockList, ip) {
  if (!blockList) return true;
  return blockList.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export function resolveClientIp(req, { trustedProxyHops = 0, trustedProxyList = null } = {}) {
  const socketIp = normalizeIp(req?.socket?.remoteAddress, { allowZone: true });
  if (!socketIp) return null;
  if (trustedProxyHops === 0) return socketIp;
  if (trustedProxyList && !isTrustedProxyIp(trustedProxyList, socketIp)) return socketIp;

  const rawXff = req?.headers?.['x-forwarded-for'];
  if (typeof rawXff !== 'string' || rawXff.length === 0 || rawXff.length > MAX_XFF_HEADER_LENGTH) {
    return socketIp;
  }
  const entries = rawXff.split(',');
  if (entries.length < trustedProxyHops) return socketIp;

  const stopIndex = entries.length - trustedProxyHops;
  for (let i = entries.length - 1; i >= stopIndex; i -= 1) {
    const hopIp = normalizeIp(entries[i].trim(), { allowPort: true });
    if (!hopIp) return socketIp;
    if (i === stopIndex) return hopIp;
    if (trustedProxyList && !isTrustedProxyIp(trustedProxyList, hopIp)) return hopIp;
  }
  return socketIp;
}

const SIGNATURE_HEX = /^[0-9a-f]{64}$/;
const TIMESTAMP_DIGITS = /^\d{1,15}$/;
const HTTP_METHOD = /^[A-Z]+$/;

function validSignedComponent(value) {
  return typeof value === 'string' && !/[\r\n\0]/.test(value);
}

function clientIdentityPayload({ address, timestamp, requestId, method, path }) {
  return `v1\n${address}\n${timestamp}\n${requestId}\n${method}\n${path}`;
}

export function deriveClientIdentityKey(internalServiceToken) {
  if (
    typeof internalServiceToken !== 'string' ||
    internalServiceToken.length < 32 ||
    internalServiceToken.length > 256 ||
    /\s/.test(internalServiceToken)
  ) {
    throw new Error('INTERNAL_SERVICE_TOKEN must be 32 to 256 characters without whitespace');
  }
  return createHmac('sha256', internalServiceToken).update('agridispatch-client-identity-v1').digest();
}

export function signClientIdentity({ key, address, method, path, requestId = '', timestampMs = Date.now() }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Client identity signing key must be a 32-byte Buffer');
  }
  const canonicalAddress = normalizeIp(address);
  if (!canonicalAddress) throw new Error('Invalid client address');
  const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : '';
  const normalizedRequestId = sanitizeRequestId(requestId) ?? '';
  if (!HTTP_METHOD.test(normalizedMethod) || !validSignedComponent(path) || !path.startsWith('/') || /[\s\p{Cc}]/u.test(path)) {
    throw new Error('Invalid signed request target');
  }
  if (!Number.isSafeInteger(Math.trunc(timestampMs)) || timestampMs < 0) {
    throw new Error('Invalid client identity timestamp');
  }
  const timestamp = String(Math.trunc(timestampMs));
  if (
    canonicalAddress.length > MAX_CLIENT_IDENTITY_HEADER_LENGTH ||
    timestamp.length > MAX_CLIENT_IDENTITY_HEADER_LENGTH
  ) {
    throw new Error('Client identity header exceeds maximum length');
  }
  const signature = createHmac('sha256', key)
    .update(clientIdentityPayload({
      address: canonicalAddress,
      timestamp,
      requestId: normalizedRequestId,
      method: normalizedMethod,
      path,
    }))
    .digest('hex');
  return {
    'X-Client-Address': canonicalAddress,
    'X-Client-Timestamp': timestamp,
    'X-Client-Signature': signature,
  };
}

export function verifyClientIdentity(req, { key, nowMs = Date.now(), maxAgeMs = DEFAULT_CLIENT_IDENTITY_TTL_MS } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Client identity verification key must be a 32-byte Buffer');
  }
  const headers = req?.headers ?? {};
  const rawAddress = headers[CLIENT_ADDRESS_HEADER];
  const rawTimestamp = headers[CLIENT_TIMESTAMP_HEADER];
  const rawSignature = headers[CLIENT_SIGNATURE_HEADER];

  if (rawAddress === undefined && rawTimestamp === undefined && rawSignature === undefined) {
    return { present: false, ok: false, address: null };
  }
  if (
    typeof rawAddress !== 'string' ||
    typeof rawTimestamp !== 'string' ||
    typeof rawSignature !== 'string' ||
    rawAddress.length === 0 ||
    rawAddress.length > MAX_CLIENT_IDENTITY_HEADER_LENGTH ||
    rawTimestamp.length === 0 ||
    rawTimestamp.length > MAX_CLIENT_IDENTITY_HEADER_LENGTH ||
    rawSignature.length === 0 ||
    rawSignature.length > MAX_CLIENT_IDENTITY_HEADER_LENGTH
  ) {
    return { present: true, ok: false, address: null };
  }

  const address = normalizeIp(rawAddress);
  if (!address || address !== rawAddress) {
    return { present: true, ok: false, address: null };
  }
  if (!TIMESTAMP_DIGITS.test(rawTimestamp)) {
    return { present: true, ok: false, address: null };
  }
  const timestampMs = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > maxAgeMs) {
    return { present: true, ok: false, address: null };
  }
  if (!SIGNATURE_HEX.test(rawSignature)) {
    return { present: true, ok: false, address: null };
  }

  const method = typeof req.method === 'string' ? req.method.toUpperCase() : '';
  const path = typeof req.path === 'string' ? req.path : '';
  if (!HTTP_METHOD.test(method) || !validSignedComponent(path) || !path.startsWith('/') || /[\s\p{Cc}]/u.test(path)) {
    return { present: true, ok: false, address: null };
  }
  const requestId = sanitizeRequestId(req.requestId) ?? sanitizeRequestId(headers['x-request-id']) ?? '';

  const expected = createHmac('sha256', key)
    .update(clientIdentityPayload({
      address,
      timestamp: rawTimestamp,
      requestId,
      method,
      path,
    }))
    .digest();
  const provided = Buffer.from(rawSignature, 'hex');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { present: true, ok: false, address: null };
  }
  return { present: true, ok: true, address };
}
