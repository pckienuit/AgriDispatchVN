import { randomUUID } from 'node:crypto';
import { METHODS } from 'node:http';
import { performance } from 'node:perf_hooks';

// G13: request ID and one structured access log line per request. Stdlib only.
// Log entries are built from fixed fields: no URL, query, body, IP, headers or cookies.
const SERVICES = new Set(['account-service', 'booking-service']);
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const BUILD_SHA = /^[0-9a-f]{7,40}$/;
const KNOWN_METHODS = new Set(METHODS);

export function sanitizeRequestId(value) {
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : null;
}

// ponytail: log sink is called synchronously per finished request, no buffering or sampling. Upgrade: async queue when the sink is a network call.
export function createRequestContext({ serviceName, buildSha = 'development', log = entry => console.info(JSON.stringify(entry)), ...rest } = {}) {
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  if (!SERVICES.has(serviceName)) throw new Error('Invalid serviceName');
  if (typeof buildSha !== 'string' || (buildSha !== 'development' && !BUILD_SHA.test(buildSha))) throw new Error('Invalid buildSha');
  if (typeof log !== 'function') throw new Error('Invalid log');
  return function requestContext(req, res, next) {
    const requestId = sanitizeRequestId(req.headers['x-request-id']) ?? randomUUID();
    const method = KNOWN_METHODS.has(req.method) ? req.method : 'OTHER';
    const started = performance.now();
    let logged = false;
    const emit = (status, aborted) => {
      if (logged) return;
      logged = true;
      const entry = { service: serviceName, buildSha, requestId, method, status, durationMs: Math.max(0, performance.now() - started) };
      if (aborted) entry.aborted = true;
      try { log(entry); } catch { /* a failing log sink must not break the response */ }
    };
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Build-SHA', buildSha);
    res.on('finish', () => emit(res.statusCode, false));
    res.on('close', () => { if (!res.writableFinished) emit(499, true); });
    next();
  };
}
