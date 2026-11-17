import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import express from 'express';
import { hashPassword, verifyPassword } from './auth/password.js';
import {
  clearRateLimit,
  createSession,
  createUser,
  findSession,
  findUserByEmail,
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
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

// Validates the service options once; shared with account-server so both entry points enforce the same rules.
export function checkAccountOptions({ internalServiceToken, sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS, throttle = {} } = {}) {
  if (typeof internalServiceToken !== 'string' || internalServiceToken.length < 32 || /\s/.test(internalServiceToken)) {
    throw new Error('INTERNAL_SERVICE_TOKEN must be at least 32 characters without whitespace');
  }
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 86400) {
    throw new Error('SESSION_TTL_SECONDS must be an integer between 60 and 86400');
  }
  const merged = { ...DEFAULT_THROTTLE, ...throttle };
  for (const [key, [min, max]] of Object.entries(THROTTLE_BOUNDS)) {
    if (!Number.isInteger(merged[key]) || merged[key] < min || merged[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
  }
  return { internalServiceToken, sessionTtlSeconds, throttle: merged };
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
  return { id: user.id, email: user.email, name: user.name, roles: user.roles };
}

function sendError(res, error) {
  if (error.status === 429) res.set('Retry-After', String(error.retryAfter));
  res.status(error.status).json({ error: { code: error.code } });
}

export function createAccountApp({ pool, ...options }) {
  const { internalServiceToken, sessionTtlSeconds, throttle } = checkAccountOptions(options);
  const serviceDigest = createHash('sha256').update(internalServiceToken).digest();
  let dummyHash;
  // Unknown emails still pay one scrypt verification, so response time does not reveal account existence.
  const missingUserHash = () => {
    dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
    return dummyHash;
  };
  const allowed = (scope, value, max) => hitRateLimit(pool, scope, value, max, throttle.windowSeconds);
  const rateLimited = () => Object.assign(new HttpError(429, 'RATE_LIMITED'), { retryAfter: throttle.windowSeconds });
  const clientKey = (req) => req.socket.remoteAddress ?? 'unknown';
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
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
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
    requireExactFields(req.body, ['email', 'password', 'name']);
    const email = normalizeEmail(req.body.email);
    const name = normalizeName(req.body.name);
    const password = passwordWithinBytes(req.body.password, 12);
    if (!(await allowed('register-ip', clientKey(req), throttle.registerIpMax))) throw rateLimited();
    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await withTransaction(pool, (client) => createUser(client, { email, name, passwordHash }));
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'users_email_key') throw new HttpError(409, 'CONFLICT');
      throw error;
    }
    res.status(201).json({ user: publicUser(user) });
  }));

  app.post('/api/auth/login', route(async (req, res) => {
    requireExactFields(req.body, ['email', 'password']);
    const email = normalizeEmail(req.body.email);
    const password = passwordWithinBytes(req.body.password, 1);
    // Both counters run before any scrypt work, so throttled traffic cannot consume CPU.
    const emailAllowed = await allowed('login-email', email, throttle.loginEmailMax);
    const ipAllowed = await allowed('login-ip', clientKey(req), throttle.loginIpMax);
    if (!emailAllowed || !ipAllowed) throw rateLimited();
    const user = await findUserByEmail(pool, email);
    const valid = await verifyPassword(password, user ? user.passwordHash : await missingUserHash());
    if (!user || !valid) throw new HttpError(401, 'INVALID_CREDENTIALS');
    await clearRateLimit(pool, 'login-email', email);
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
