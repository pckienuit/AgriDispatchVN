import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { readConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { inspectEvidenceImage } from '../src/evidence-image.js';
import { configuredBlobStore } from '../src/blob-store.js';

// Trusted maintenance only. Not exposed through HTTP. Reconciles PENDING evidence left by a crash between
// the storage PUT and the finalizing commit. Lock order matches normal finalization: case, then evidence.
// ponytail: sequential rows, no concurrency, no storage retry. Ceiling: one slow blob delays the batch.
// Upgrade: bounded worker pool with per-row timeouts when backlogs exceed the cap.
// ponytail: blob_version stays NULL because BlobStore.get does not return a version id.
// ponytail: store.get uses the 5 MiB default cap, so an oversize object counts as error, not FAILED.

const MIN_AGE_MS = 900000;
const MAX_AGE_MS = 86400000;
const MAX_LIMIT = 100;
const SHA256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const AGE_SQL = "created_at < clock_timestamp() - ($2::bigint * interval '1 millisecond')";

function checkOptions({ limit = 20, minAgeMs = MIN_AGE_MS } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('limit must be an integer 1..100');
  if (!Number.isInteger(minAgeMs) || minAgeMs < MIN_AGE_MS || minAgeMs > MAX_AGE_MS) {
    throw new RangeError('minAgeMs must be an integer 900000..86400000');
  }
  return { limit, minAgeMs };
}

async function candidates(pool, { limit, minAgeMs }) {
  const { rows } = await pool.query(
    `SELECT id, dispute_id, uploader_id, content_type, byte_size, width, height, sha256, object_key FROM dispatch.evidence
     WHERE status='PENDING' AND ${AGE_SQL} ORDER BY created_at, id LIMIT $1`,
    [limit, minAgeMs],
  );
  return rows;
}

// Object state: 'missing' (404), 'valid' (size, hash, type and header inspection match), or 'invalid'.
// Storage exceptions propagate so the caller keeps the row PENDING and counts an error.
async function inspectObject(store, row) {
  const object = await store.get(row.object_key);
  if (object === null) return { state: 'missing' };
  if (typeof object?.etag !== 'string' || object.etag.length < 1 || object.etag.length > 256) {
    throw new Error('Invalid storage response');
  }
  let valid = Buffer.isBuffer(object.bytes) && object.bytes.length === row.byte_size && SHA256(object.bytes) === row.sha256
    && object.contentType === row.content_type;
  if (valid) {
    try {
      const size=inspectEvidenceImage(object.bytes, row.content_type);
      valid=size.width===row.width && size.height===row.height;
    } catch { valid = false; }
  }
  return { state: valid ? 'valid' : 'invalid', etag: object.etag };
}

// Returns 'uploaded' | 'failed' | 'skipped'. Throws on any DB error, including an unknown COMMIT outcome.
async function settle(pool, row, object, minAgeMs) {
  const db = await pool.connect();
  let broken = false;
  try {
    await db.query('BEGIN');
    const dispute = (await db.query('SELECT status FROM dispatch.disputes WHERE id=$1 FOR UPDATE', [row.dispute_id])).rows[0];
    const evidence = (await db.query(`SELECT status, ${AGE_SQL} AS old FROM dispatch.evidence WHERE id=$1 FOR UPDATE`, [row.id, minAgeMs])).rows[0];
    if (!dispute || !evidence || evidence.status !== 'PENDING' || !evidence.old) {
      await db.query('ROLLBACK');
      return 'skipped';
    }
    const upload = object.state === 'valid' && dispute.status === 'OPEN';
    if (upload) {
      await db.query("UPDATE dispatch.evidence SET status='UPLOADED', etag=$2, uploaded_at=clock_timestamp() WHERE id=$1 AND status='PENDING'", [row.id, object.etag]);
    } else {
      await db.query("UPDATE dispatch.evidence SET status='FAILED' WHERE id=$1 AND status='PENDING'", [row.id]);
    }
    await db.query('COMMIT');
    return upload ? 'uploaded' : 'failed';
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    db.release(broken);
  }
}

// Processes at most `limit` oldest PENDING rows. Options are checked before any DB or storage access.
// Each examined row lands in exactly one bucket: uploaded, failed, skipped or errors.
export async function reconcileEvidence(pool, store, options = {}) {
  const opts = checkOptions(options);
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') throw new TypeError('Reconcile requires a pool');
  if (typeof store?.get !== 'function' || typeof store?.remove !== 'function') throw new TypeError('Reconcile requires storage');
  const result = { examined: 0, uploaded: 0, failed: 0, skipped: 0, errors: 0 };
  for (const row of await candidates(pool, opts)) {
    result.examined += 1;
    let object;
    try {
      object = await inspectObject(store, row);
    } catch {
      result.errors += 1;
      continue;
    }
    let outcome;
    try {
      outcome = await settle(pool, row, object, opts.minAgeMs);
    } catch {
      // Unknown or failed commit: leave the private object in place and keep the row for a later run.
      result.errors += 1;
      continue;
    }
    if (outcome === 'skipped') {
      result.skipped += 1;
      continue;
    }
    if (outcome === 'uploaded') {
      result.uploaded += 1;
      continue;
    }
    // Definite FAILED commit. Remove a private object only after commit; a missing object has nothing to remove.
    if (object.state === 'missing') {
      result.failed += 1;
      continue;
    }
    try {
      await store.remove(row.object_key);
      result.failed += 1;
    } catch {
      // The row is FAILED; the orphan object stays private and is counted as an error, not success.
      result.errors += 1;
    }
  }
  return result;
}

// Read-only count for dry-run. Uses the same bounded selection as reconcileEvidence; touches no storage.
export async function countEligiblePending(pool, options = {}) {
  const opts = checkOptions(options);
  return (await candidates(pool, opts)).length;
}

const USAGE = 'Usage: reconcile-evidence [--dry-run] [--apply --confirm-storage-host <hostname>] [--limit N] [--min-age-ms N]';

function parseArgs(argv) {
  const out = { apply: false, dryRun: false, confirmHost: null, limit: 20, minAgeMs: MIN_AGE_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(USAGE);
      i += 1;
      return argv[i];
    };
    if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--confirm-storage-host') out.confirmHost = next();
    else if (arg === '--limit') out.limit = Number(next());
    else if (arg === '--min-age-ms') out.minAgeMs = Number(next());
    else throw new Error(USAGE);
  }
  if (out.apply && out.dryRun) throw new Error(USAGE);
  return out;
}

// createStore and the log sinks are test seams; production uses configuredBlobStore and console.
export async function main(argv, env, { createStore = configuredBlobStore, log = console.log, logError = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
    checkOptions(args);
  } catch (error) {
    logError(error.message === USAGE ? USAGE : 'Refused: invalid options');
    return 2;
  }
  let config;
  try {
    config = readConfig({ ...env, PORT: env.PORT ?? '3000' });
  } catch {
    logError('Refused: DATABASE_URL is missing or invalid');
    return 2;
  }
  let store = null;
  if (args.apply) {
    // Exact hostname confirmation. Storage config comes from the environment only; no .env file is read here.
    let accountHost;
    try {
      accountHost = new URL(env.EVIDENCE_BLOB_ACCOUNT_URL ?? '').hostname;
    } catch {
      logError('Refused: evidence storage is not configured');
      return 2;
    }
    if (args.confirmHost !== accountHost) {
      logError('Refused: --apply requires --confirm-storage-host equal to the configured account hostname');
      return 2;
    }
    try {
      store = createStore(env);
    } catch {
      logError('Refused: evidence storage configuration is invalid');
      return 2;
    }
    if (!store) {
      logError('Refused: evidence storage is not configured');
      return 2;
    }
  }
  let pool;
  try {
    pool = createPool(config.databaseUrl);
    if (args.apply) {
      const result = await reconcileEvidence(pool, store, args);
      log(JSON.stringify({ mode: 'apply', ...result }));
      return result.errors > 0 ? 1 : 0;
    }
    const examined = await countEligiblePending(pool, args);
    log(JSON.stringify({ mode: 'dry-run', examined, uploaded: 0, failed: 0, skipped: 0, errors: 0 }));
    return 0;
  } catch (error) {
    logError('Reconcile failed', { name: error.name, code: error.code });
    return 1;
  } finally {
    if (pool) await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
