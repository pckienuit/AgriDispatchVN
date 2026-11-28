import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  buildTrustedProxyBlockList,
  checkTrustedProxyHops,
  deriveClientIdentityKey,
  resolveClientIp,
  signClientIdentity,
} from './client-identity.js';
import { sanitizeRequestId } from './observability.js';
import { crossOriginWrite, isSecure, sessionCookie, SESSION_COOKIE, SESSION_ID } from './auth/session-cookie.js';

const { AbortSignal } = globalThis;
const routes = new Set(['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/me',
  'GET /api/auth/sessions', 'POST /api/auth/change-password', 'POST /api/auth/forgot-password', 'POST /api/auth/reset-password']);

// Same-origin browser adapter, not a generic proxy. No internal endpoint or arbitrary target forwarding.
export function createAccountGateway({
  accountServiceUrl,
  internalServiceToken,
  trustedProxyHops = 0,
  trustedProxyCidrs = null,
  timeoutMs = 3000,
}) {
  const origin = new URL(accountServiceUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid account service origin');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid identity timeout');
  const hops = checkTrustedProxyHops(trustedProxyHops);
  const trustedProxyList = buildTrustedProxyBlockList(trustedProxyCidrs);
  const signingKey = internalServiceToken === undefined ? null : deriveClientIdentityKey(internalServiceToken);
  return async (req, res, next) => {
    const roleList=req.method==='GET'&&['/api/role-requests','/api/admin/role-requests'].includes(req.path);
    const roleWrite=req.method==='POST'&&(req.path==='/api/role-requests'||/^\/api\/admin\/role-requests\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(approve|reject)$/i.test(req.path));
    const sessionDelete = req.method === 'DELETE' && /^\/api\/auth\/sessions\/[^/]+$/.test(req.path);
    if (!routes.has(`${req.method} ${req.path}`)&&!roleList&&!roleWrite&&!sessionDelete) return next();
    res.set('Cache-Control', 'no-store');
    if ((req.get('Authorization') === undefined || ['/api/auth/login', '/api/auth/register'].includes(req.path)) && crossOriginWrite(req)) {
      return res.status(403).json({ error: { code: 'CROSS_ORIGIN_REQUEST' } });
    }
    if (sessionDelete && !SESSION_ID.test(req.path.slice('/api/auth/sessions/'.length))) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST' } });
    }
    const target=new URL(req.path,origin);
    if(roleList){
      const query=new URL(req.originalUrl,'http://gateway.invalid').searchParams;
      for(const [key,value] of query){
        if(!['limit','offset'].includes(key)||query.getAll(key).length!==1||!/^\d{1,5}$/.test(value)||Number(value)>(key==='limit'?20:10000)||(key==='limit'&&Number(value)<1))return res.status(400).json({error:{code:'INVALID_PAGINATION'}});
        target.searchParams.set(key,value);
      }
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      const requestId = sanitizeRequestId(req.requestId) ?? sanitizeRequestId(req.get('X-Request-ID')) ?? (signingKey ? randomUUID() : null);
      if (requestId) headers['X-Request-ID'] = requestId;
      const authorization = req.get('Authorization');
      if (authorization !== undefined) headers.Authorization = authorization;
      const cookie = sessionCookie(req.get('Cookie'));
      if (cookie) headers.Cookie = `${SESSION_COOKIE}=${cookie}`;
      if (isSecure(req)) headers['X-Forwarded-Proto'] = 'https';
      if (req.path === '/api/auth/login' && req.get('Prefer') === 'session-cookie') headers.Prefer = 'session-cookie';
      const userAgent = req.get('User-Agent');
      if (userAgent) headers['User-Agent'] = userAgent;
      if (signingKey) {
        const clientIp = resolveClientIp(req, { trustedProxyHops: hops, trustedProxyList });
        if (clientIp) {
          Object.assign(headers, signClientIdentity({
            key: signingKey,
            address: clientIp,
            method: req.method,
            path: req.path,
            requestId: requestId ?? '',
          }));
        }
      }
      const response = await fetch(target, {
        method: req.method, headers,
        ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
      const cookies = response.headers.getSetCookie().filter((value) => value.startsWith(`${SESSION_COOKIE}=`));
      if (cookies.length) res.set('Set-Cookie', cookies);
      if (response.status === 204) return res.status(204).end();
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > (roleList?65536:16384)) throw new Error('Oversized account response');
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
