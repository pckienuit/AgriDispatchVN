import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import express from 'express';
import { rejectNullBytes } from './reject-null-bytes.js';
import {
  deriveClientIdentityKey,
  normalizeIp,
  verifyClientIdentity,
} from './client-identity.js';
import { createRequestContext } from './observability.js';
import { hashPassword, verifyPassword } from './auth/password.js';
import {createRoleRequestRouter} from './role-requests.js';
import {
  clearRateLimit,
  createSession,
  createUser,
  digest,
  findSession,
  findUserByIdentifier,
  hitRateLimit,
  revokeSession,
  withTransaction,
} from './auth/store.js';

export const DEFAULT_SESSION_TTL_SECONDS = 28800;
// Demo throttle defaults (documented): 5 failed logins per email, 30 per source IP, 10 registrations per IP, per 900 s window.
// ponytail: source key is socket.remoteAddress; behind a reverse proxy all clients share one IP bucket. Ceiling: proxy deployments.
// Upgrade: trust X-Forwarded-For only from a configured proxy hop.
// ponytail: 5 failures lock that email for the window (victim lockout is possible). Upgrade: per-email+IP composite key.
const DEFAULT_THROTTLE = { windowSeconds: 900, loginEmailMax: 5, loginIpMax: 30, registerIpMax: 10 };
const THROTTLE_BOUNDS = {
  windowSeconds: [1, 86400],
  loginEmailMax: [1, 1000],
  loginIpMax: [1, 1000],
  registerIpMax: [1, 1000],
};
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
// Vietnamese mobile numbers in national format. Prefixes 03, 05, 07, 08, 09 per current numbering plan.
const PHONE = /^0[35789][0-9]{8}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

// Validates the service options once; shared with account-server so both entry points enforce the same rules.
export function checkAccountOptions({
  internalServiceToken,
  sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  throttle = {},
  requireSignedClientIdentity = false,
} = {}) {
  if (typeof internalServiceToken !== 'string' || internalServiceToken.length < 32 || /\s/.test(internalServiceToken)) {
    throw new Error('INTERNAL_SERVICE_TOKEN must be at least 32 characters without whitespace');
  }
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 86400) {
    throw new Error('SESSION_TTL_SECONDS must be an integer between 60 and 86400');
  }
  if (typeof requireSignedClientIdentity !== 'boolean') {
    throw new Error('requireSignedClientIdentity must be a boolean');
  }
  const merged = { ...DEFAULT_THROTTLE, ...throttle };
  for (const [key, [min, max]] of Object.entries(THROTTLE_BOUNDS)) {
    if (!Number.isInteger(merged[key]) || merged[key] < min || merged[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
  }
  return { internalServiceToken, sessionTtlSeconds, throttle: merged, requireSignedClientIdentity };
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const bad = () => new HttpError(400, 'INVALID_REQUEST');
const unauthorized = () => new HttpError(401, 'UNAUTHORIZED');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactFields(body, fields) {
  if (!isPlainObject(body)) throw bad();
  const keys = Object.keys(body);
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) throw bad();
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw bad();
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw bad();
  return email;
}

// Accepts "0901 234 567", "090.123.4567", "+84 901234567" and stores "0901234567".
export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 32) throw bad();
  let phone = value.trim().replace(/[\s.-]/g, '');
  if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
  else if (phone.startsWith('84') && phone.length === 11) phone = '0' + phone.slice(2);
  if (!PHONE.test(phone)) throw bad();
  return phone;
}

// Exactly one sign-in identifier: email (existing accounts) or phone (UI decision D4).
function identifierFrom(body, otherFields) {
  if (!isPlainObject(body)) throw bad();
  if (Object.hasOwn(body, 'phone')) {
    requireExactFields(body, ['phone', ...otherFields]);
    return { phone: normalizePhone(body.phone) };
  }
  requireExactFields(body, ['email', ...otherFields]);
  return { email: normalizeEmail(body.email) };
}

function normalizeName(value) {
  if (typeof value !== 'string') throw bad();
  const name = value.trim();
  if ([...name].length < 1 || [...name].length > 120 || /\p{Cc}/u.test(name)) throw bad();
  return name;
}

function passwordWithinBytes(value, minBytes) {
  if (typeof value !== 'string') throw bad();
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minBytes || bytes > 128) throw bad();
  return value;
}

function publicUser(user) {
  return { id: user.id, email: user.email ?? null, phone: user.phone ?? null, name: user.name, roles: user.roles };
}

function sendError(res, error) {
  if (error.status === 429) res.set('Retry-After', String(error.retryAfter));
  res.status(error.status).json({ error: { code: error.code } });
}

export function createAccountApp({ pool, buildSha = 'development', log, ...options }) {
  const { internalServiceToken, sessionTtlSeconds, throttle, requireSignedClientIdentity } = checkAccountOptions(options);
  const serviceDigest = createHash('sha256').update(internalServiceToken).digest();
  const clientIdentityKey = deriveClientIdentityKey(internalServiceToken);
  let dummyHash;
  // Unknown emails still pay one scrypt verification, so response time does not reveal account existence.
  const missingUserHash = () => {
    dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
    return dummyHash;
  };
  const allowed = (scope, value, max) => hitRateLimit(pool, scope, value, max, throttle.windowSeconds);
  const rateLimited = () => Object.assign(new HttpError(429, 'RATE_LIMITED'), { retryAfter: throttle.windowSeconds });
  const clientKey = (req) => req.verifiedClientIp ?? normalizeIp(req.socket.remoteAddress, { allowZone: true }) ?? 'unknown';
  const bearer = (req) => {
    const match = BEARER.exec(req.get('authorization') ?? '');
    if (!match) throw unauthorized();
    return match[1];
  };

  // Routes run inside this wrapper: expected HttpErrors keep their status; anything else is a dependency failure.
  const route = (handler) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof HttpError) return sendError(res, error);
      console.error('Account request failed', { name: error.name, code: error.code });
      return sendError(res, new HttpError(503, 'SERVICE_UNAVAILABLE'));
    }
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(createRequestContext({serviceName:'account-service',buildSha,log}));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use(rejectNullBytes);
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const identity = verifyClientIdentity(req, { key: clientIdentityKey });
    if ((identity.present && !identity.ok) || (!identity.present && requireSignedClientIdentity)) {
      res.set('Cache-Control', 'no-store');
      return sendError(res, new HttpError(400, 'INVALID_CLIENT_IDENTITY'));
    }
    req.verifiedClientIp = identity.ok ? identity.address : null;
    return next();
  });
  app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
  app.get('/ready', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await pool.query('SELECT 1 FROM account.users LIMIT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.post('/api/auth/register', route(async (req, res) => {
    const identifier = identifierFrom(req.body, ['password', 'name']);
    const name = normalizeName(req.body.name);
    const password = passwordWithinBytes(req.body.password, 12);
    if (!(await allowed('register-ip', clientKey(req), throttle.registerIpMax))) throw rateLimited();
    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await withTransaction(pool, (client) => createUser(client, { ...identifier, name, passwordHash }));
    } catch (error) {
      if (error.code === '23505' && ['users_email_key', 'users_phone_key'].includes(error.constraint)) throw new HttpError(409, 'CONFLICT');
      throw error;
    }
    res.status(201).json({ user: publicUser(user) });
  }));

  app.post('/api/auth/login', route(async (req, res) => {
    const identifier = identifierFrom(req.body, ['password']);
    const password = passwordWithinBytes(req.body.password, 1);
    const clientIp = clientKey(req);
    // Email keys keep their original bucket format; phone keys are prefixed so the two namespaces cannot collide.
    const accountKey = identifier.phone !== undefined ? `phone:${identifier.phone}` : identifier.email;
    const emailClientKey = JSON.stringify([accountKey, clientIp]);
    // Both counters run before any scrypt work, so throttled traffic cannot consume CPU.
    const emailAllowed = await allowed('login-email', emailClientKey, throttle.loginEmailMax);
    const ipAllowed = await allowed('login-ip', clientIp, throttle.loginIpMax);
    if (!emailAllowed || !ipAllowed) throw rateLimited();
    const user = await findUserByIdentifier(pool, identifier);
    const valid = await verifyPassword(password, user ? user.passwordHash : await missingUserHash());
    if (!user || !valid) throw new HttpError(401, 'INVALID_CREDENTIALS');
    await clearRateLimit(pool, 'login-email', emailClientKey);
    // Successful authentication must not consume the per-IP failure budget used for NAT brute-force protection.
    await pool.query(
      `WITH dec AS (
         UPDATE account.rate_limits
            SET hits = hits - 1
          WHERE bucket = $1 AND hits > 1 AND window_ends_at > now()
         RETURNING 1
       )
       DELETE FROM account.rate_limits
        WHERE bucket = $1 AND hits <= 1 AND NOT EXISTS (SELECT 1 FROM dec)`,
      [digest(`login-ip\u0000${clientIp}`)],
    );
    const session = await withTransaction(pool, (client) => createSession(client, user.id, sessionTtlSeconds));
    res.json({ token: session.token, expiresAt: session.expiresAt, user: publicUser(user) });
  }));

  app.post('/api/auth/logout', route(async (req, res) => {
    if (!(await revokeSession(pool, bearer(req)))) throw unauthorized();
    res.status(204).end();
  }));

  app.get('/api/me', route(async (req, res) => {
    const found = await findSession(pool, bearer(req));
    if (!found) throw unauthorized();
    res.json({ user: found.user });
  }));

  app.post('/internal/introspect', route(async (req, res) => {
    const provided = createHash('sha256').update(req.get('x-service-token') ?? '').digest();
    if (!timingSafeEqual(provided, serviceDigest)) throw new HttpError(403, 'SERVICE_FORBIDDEN');
    requireExactFields(req.body, ['token']);
    if (typeof req.body.token !== 'string' || !SESSION_TOKEN.test(req.body.token)) throw unauthorized();
    const found = await findSession(pool, req.body.token);
    if (!found) throw unauthorized();
    res.json({ user: found.user, expiresAt: found.expiresAt });
  }));

  app.use(createRoleRequestRouter({pool,authenticate:async(req,res,next)=>{
    try{
      const found=await findSession(pool,bearer(req));
      if(!found)return res.status(401).json({error:{code:'UNAUTHENTICATED'}});
      req.actor=found.user;next();
    }catch(error){
      res.status(error instanceof HttpError?401:503).json({error:{code:error instanceof HttpError?'UNAUTHENTICATED':'SERVICE_UNAVAILABLE'}});
    }
  }}));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: { code: 'INVALID_REQUEST' } });
    console.error('Request failed', { name: error.name, code: error.code });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  return app;
}
