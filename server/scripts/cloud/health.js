// Readiness probe shared by the AKS and Web Apps helpers. Stdlib only.
// Passes only when /ready returns 200 JSON {status:"ready"} AND X-Build-SHA equals the expected full SHA.
// Response bodies and headers other than X-Build-SHA are never printed.
import { SHA_PATTERN, coded, delay } from './lib.js';
const { AbortSignal, TextDecoder } = globalThis;

export function validateProbeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw coded('INVALID_PROBE_URL', 'probe URL is not a valid URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw coded('INVALID_PROBE_URL', 'probe URL must be an http(s) origin without credentials, query or fragment');
  }
  return url;
}

// One attempt. Returns { ok, reason } with a stable reason code. fetchImpl is injectable for tests.
export async function probeOnce(baseUrl, expectedSha, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!SHA_PATTERN.test(expectedSha)) throw coded('INVALID_SHA', 'expected build SHA must be a full 40-char commit SHA');
  const url = new URL('/ready', validateProbeUrl(baseUrl));
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
  } catch {
    return { ok: false, reason: 'UNREACHABLE' };
  }
  if (response.status !== 200) { await response.body?.cancel(); return { ok: false, reason: 'NOT_READY' }; }
  if (response.headers.get('x-build-sha') !== expectedSha) { await response.body?.cancel(); return { ok: false, reason: 'SHA_MISMATCH' }; }
  let body;
  try {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) throw new Error('Oversized readiness response');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: 'BAD_BODY' };
  }
  if (body?.status !== 'ready') return { ok: false, reason: 'NOT_READY' };
  return { ok: true, reason: 'READY' };
}

// Bounded poll: a fixed deadline and interval. Never loops forever.
export async function waitReady(baseUrl, expectedSha, { timeoutSeconds = 120, intervalMs = 3000, now = Date.now, sleep = delay, ...io } = {}) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 900) throw coded('INVALID_TIMEOUT', 'timeoutSeconds must be 5 to 900');
  const deadline = now() + timeoutSeconds * 1000;
  for (;;) {
    const last = await probeOnce(baseUrl, expectedSha, io);
    if (last.ok) return last;
    if (now() + intervalMs > deadline) return { ...last, timedOut: true };
    await sleep(intervalMs);
  }
}
