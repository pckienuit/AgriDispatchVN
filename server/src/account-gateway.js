import { Buffer } from 'node:buffer';

const { AbortSignal } = globalThis;
const routes = new Set(['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/me']);

// Same-origin browser adapter, not a generic proxy. No internal endpoint or arbitrary target forwarding.
export function createAccountGateway({ accountServiceUrl, timeoutMs = 3000 }) {
  const origin = new URL(accountServiceUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid account service origin');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid identity timeout');
  return async (req, res, next) => {
    if (!routes.has(`${req.method} ${req.path}`)) return next();
    res.set('Cache-Control', 'no-store');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (req.get('Authorization')) headers.Authorization = req.get('Authorization');
      const response = await fetch(new URL(req.path, origin), {
        method: req.method, headers,
        ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
      if (response.status === 204) return res.status(204).end();
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) throw new Error('Oversized account response');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid account response');
      const retry = response.headers.get('Retry-After');
      if (retry && /^\d{1,6}$/.test(retry)) res.set('Retry-After', retry);
      return res.status(response.status).json(body);
    } catch {
      return res.status(503).json({ error: { code: 'IDENTITY_UNAVAILABLE' } });
    }
  };
}
