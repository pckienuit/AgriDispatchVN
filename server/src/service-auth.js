import { Buffer } from 'node:buffer';
import { sanitizeRequestId } from './observability.js';
import { crossOriginWrite, requestToken } from './auth/session-cookie.js';

const { AbortSignal } = globalThis;
const roles = new Set(['farmer', 'provider', 'operator', 'coop', 'admin']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAccountAuth({ accountServiceUrl, internalServiceToken, timeoutMs = 3000 }) {
  const url = new URL(accountServiceUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ACCOUNT_SERVICE_URL must be an HTTP origin without credentials');
  }
  if (typeof internalServiceToken !== 'string' || internalServiceToken.length < 32 || internalServiceToken.length > 256 || /[\r\n]/.test(internalServiceToken)) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain 32 to 256 characters');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid identity timeout');
  return async function authenticate(req, res, next) {
    const token = requestToken(req, /^Bearer ([A-Za-z0-9_-]{16,256})$/);
    if (req.get('Authorization') === undefined && token && crossOriginWrite(req)) {
      return res.status(403).json({ error: { code: 'CROSS_ORIGIN_REQUEST' } });
    }
    if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
    try {
      const response = await fetch(new URL('/internal/introspect', url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Token': internalServiceToken,
          ...(sanitizeRequestId(req.requestId) ? {'X-Request-ID':req.requestId} : {}) },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (response.status === 401) {
        await response.body?.cancel();
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Identity unavailable'); }
      // Bound the response before parsing; an unhealthy peer must not exhaust app memory.
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192) throw new Error('Identity response too large');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const { user } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!user || !uuid.test(user.id) || typeof user.name !== 'string' || [...user.name].length > 120 || !Array.isArray(user.roles) || user.roles.length === 0 || user.roles.length > roles.size || user.roles.some((role) => !roles.has(role))) {
        throw new Error('Malformed identity');
      }
      req.actor = { id: user.id, name: user.name, roles: [...new Set(user.roles)] };
      return next();
    } catch {
      return res.status(503).json({ error: { code: 'IDENTITY_UNAVAILABLE' } });
    }
  };
}
