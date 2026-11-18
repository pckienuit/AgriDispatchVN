import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { createPool } from '../../src/db.js';
import { inspectEvidenceImage } from '../../src/evidence-image.js';
import { countEligiblePending, main, reconcileEvidence } from '../../scripts/reconcile-evidence.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

parseDisposableRoot(process.env.TEST_DATABASE_URL);

// Synthetic fixtures only. Real PostgreSQL per test (disposable *_test DB); storage is an explicit in-memory double.
const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../../scripts/reconcile-evidence.js', import.meta.url));
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(1), COOP = id(2), PROVIDER = id(3), OPERATOR = id(7);
const HASH = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
const ACTORS = { [OWNER]: ['farmer'], [COOP]: ['coop'], [PROVIDER]: ['provider'] };
const HOUR = 3600000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// Synthetic 3x2 RGB PNG. The seed varies pixel bytes so each evidence row gets a distinct SHA-256.
function syntheticPng(seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(2 * 10, seed);
  raw[0] = 0;
  raw[10] = 0;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND')]);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// In-memory storage double. Records reads/deletes and the DB status observed at each delete.
class MemoryStore {
  constructor(pool) {
    this.pool = pool;
    this.objects = new Map();
    this.gets = [];
    this.removes = [];
    this.statusAtRemove = [];
    this.failGets = new Set();
    this.failRemove = false;
  }
  async put(key, bytes, contentType) {
    const etag = `"${key.slice(-12)}"`;
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType, etag });
    return { etag, versionId: null };
  }
  async get(key) {
    this.gets.push(key);
    if (this.failGets.has(key)) throw new Error('synthetic storage unavailable');
    const object = this.objects.get(key);
    return object ? { bytes: Buffer.from(object.bytes), contentType: object.contentType, etag: object.etag } : null;
  }
  async remove(key) {
    this.removes.push(key);
    const row = (await this.pool.query('SELECT status FROM dispatch.evidence WHERE object_key=$1', [key])).rows[0];
    this.statusAtRemove.push(row?.status ?? null);
    if (this.failRemove) throw new Error('synthetic storage unavailable');
    return this.objects.delete(key);
  }
}

async function setup(t) {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url);
  t.after(async () => { await pool.end(); await db.drop(); });
  await migrate(pool);
  await seedCatalog(pool);
  for (const [user, roles] of Object.entries(ACTORS)) {
    await pool.query('INSERT INTO account.users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [user, `${user}@example.com`, 'Synthetic', HASH]);
    for (const role of roles) await pool.query('INSERT INTO account.user_roles(user_id,role) VALUES($1,$2)', [user, role]);
  }
  return { db, pool, store: new MemoryStore(pool) };
}

// Same assigned-booking chain as the remedies fixture. Each case gets its own service day.
async function openCase(pool, index) {
  const day = new Date(Date.UTC(2026, 10, 1) + index * 86400000).toISOString().slice(0, 10);
  const field = (await pool.query("INSERT INTO dispatch.fields(owner_id,name,locality,area_m2) VALUES($1,'Synthetic','Demo',10000) RETURNING id", [OWNER])).rows[0].id;
  const booking = (await pool.query(`INSERT INTO dispatch.bookings(owner_id,field_id,service_id,start_at,end_at,field_name,field_area_m2,service_code,service_name,service_data_label,price_per_ha_vnd,total_vnd,coordinator_id)
    SELECT $1,$2,id,$4::timestamptz,$5::timestamptz,'Synthetic',10000,code,name,data_label,price_per_ha_vnd,price_per_ha_vnd,$3 FROM dispatch.services WHERE code='tillage-tractor' RETURNING id`,
  [OWNER, field, COOP, `${day}T08:00Z`, `${day}T12:00Z`])).rows[0].id;
  const machine = (await pool.query("INSERT INTO dispatch.machines(owner_id,name,machine_type) VALUES($1,'Synthetic tractor','tractor') RETURNING id", [PROVIDER])).rows[0].id;
  const pkg = (await pool.query(`INSERT INTO dispatch.packages(coop_id,service_id,locality,window_start_at,window_end_at,provider_id,machine_id,operator_id,status)
    SELECT $1,service_id,'Demo',start_at,end_at,$2,$4,$5,'CLAIMED' FROM dispatch.bookings WHERE id=$3 RETURNING id`, [COOP, PROVIDER, booking, machine, OPERATOR])).rows[0].id;
  await pool.query('INSERT INTO dispatch.package_bookings(package_id,booking_id) VALUES($1,$2)', [pkg, booking]);
  await pool.query("UPDATE dispatch.bookings SET state='GROUPED' WHERE id=$1", [booking]);
  await pool.query("UPDATE dispatch.bookings SET state='ASSIGNED' WHERE id=$1", [booking]);
  return (await pool.query("INSERT INTO dispatch.disputes(booking_id,claimant_id,respondent_id,reason,status) VALUES($1,$2,$3,'QUALITY','OPEN') RETURNING id", [booking, OWNER, PROVIDER])).rows[0].id;
}

// Mirrors the close-unresolved statements in server/src/remedies.js inside one transaction.
async function closeCase(pool, dispute) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("INSERT INTO dispatch.remedy_events(dispute_id,actor_id,event_type,version,details) VALUES($1,$2,'CLOSED_UNRESOLVED',NULL,$3)", [dispute, OWNER, 'Synthetic closure']);
    await db.query("UPDATE dispatch.disputes SET status='CLOSED_UNRESOLVED',closed_at=now(),closure_reason=$2 WHERE id=$1", [dispute, 'Synthetic closure']);
    await db.query('COMMIT');
  } finally {
    db.release();
  }
}

// Inserts a PENDING row through the real insert guard (party, OPEN case, identity-bound key).
async function insertPending(pool, dispute, { bytes, ageMs = HOUR, digest, contentType = 'image/png' }) {
  const evidenceId = randomUUID();
  const hash = digest ?? sha256(bytes);
  const key = `${dispute}/${evidenceId}/${hash}`;
  await pool.query(`INSERT INTO dispatch.evidence(id,dispute_id,uploader_id,status,content_type,byte_size,width,height,sha256,object_key,created_at)
    VALUES($1,$2,$3,'PENDING',$4,$5,3,2,$6,$7,clock_timestamp()-($8::int*interval '1 millisecond'))`,
  [evidenceId, dispute, OWNER, contentType, bytes.length, hash, key, ageMs]);
  return { id: evidenceId, key };
}

const rowOf = async (pool, evidenceId) => (await pool.query('SELECT status,etag,blob_version,uploaded_at FROM dispatch.evidence WHERE id=$1', [evidenceId])).rows[0];
const zero = { examined: 0, uploaded: 0, failed: 0, skipped: 0, errors: 0 };

test('open case with valid old PENDING upload is marked UPLOADED with the storage etag', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const bytes = syntheticPng(1);
  assert.doesNotThrow(() => inspectEvidenceImage(bytes, 'image/png'));
  const row = await insertPending(pool, dispute, { bytes });
  await store.put(row.key, bytes, 'image/png');
  const result = await reconcileEvidence(pool, store, { limit: 20, minAgeMs: 900000 });
  assert.deepEqual(result, { examined: 1, uploaded: 1, failed: 0, skipped: 0, errors: 0 });
  const after = await rowOf(pool, row.id);
  assert.equal(after.status, 'UPLOADED');
  assert.equal(after.etag, store.objects.get(row.key).etag);
  assert.notEqual(after.uploaded_at, null);
  assert.equal(after.blob_version, null);
  assert.deepEqual(store.removes, []);
});

test('missing object marks FAILED and issues no delete', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const row = await insertPending(pool, dispute, { bytes: syntheticPng(2) });
  assert.deepEqual(await reconcileEvidence(pool, store, {}), { examined: 1, uploaded: 0, failed: 1, skipped: 0, errors: 0 });
  assert.equal((await rowOf(pool, row.id)).status, 'FAILED');
  assert.deepEqual(store.removes, []);
});

test('recorded dimensions must match original before recovering upload',async t=>{
 const {pool,store}=await setup(t),dispute=await openCase(pool,1),bytes=syntheticPng(83);
 const evidenceId=randomUUID(),digest=sha256(bytes),key=`${dispute}/${evidenceId}/${digest}`;
 await pool.query(`INSERT INTO dispatch.evidence(id,dispute_id,uploader_id,status,content_type,byte_size,width,height,sha256,object_key,created_at)
   VALUES($1,$2,$3,'PENDING','image/png',$4,4,2,$5,$6,clock_timestamp()-interval '1 hour')`,[evidenceId,dispute,OWNER,bytes.length,digest,key]);
 await store.put(key,bytes,'image/png');
 assert.deepEqual(await reconcileEvidence(pool,store),{examined:1,uploaded:0,failed:1,skipped:0,errors:0});
 assert.equal((await rowOf(pool,evidenceId)).status,'FAILED');
});

test('unknown COMMIT outcome never deletes a potentially committed upload',async t=>{
 const {pool,store}=await setup(t),dispute=await openCase(pool,1),bytes=syntheticPng(84);
 const row=await insertPending(pool,dispute,{bytes});await store.put(row.key,bytes,'image/png');
 const uncertain={query:(...a)=>pool.query(...a),connect:async()=>{
   const db=await pool.connect();return {query:async(sql,...a)=>{const r=await db.query(sql,...a);if(sql==='COMMIT')throw new Error('Synthetic lost commit response');return r;},release:bad=>db.release(bad)};
 }};
 assert.deepEqual(await reconcileEvidence(uncertain,store),{examined:1,uploaded:0,failed:0,skipped:0,errors:1});
 assert.equal((await rowOf(pool,row.id)).status,'UPLOADED');assert.deepEqual(store.removes,[]);
 assert.deepEqual(await reconcileEvidence(pool,store),zero);
});

test('corrupt or mismatched objects mark FAILED and are removed only after the commit', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  // Hash matches garbage bytes, so only image inspection rejects it.
  const garbage = Buffer.from('synthetic not-an-image payload');
  const inspectFail = await insertPending(pool, dispute, { bytes: garbage });
  await store.put(inspectFail.key, garbage, 'image/png');
  // Recorded hash belongs to a different PNG than the stored bytes.
  const mismatch = await insertPending(pool, dispute, { bytes: syntheticPng(3), digest: sha256(syntheticPng(4)) });
  await store.put(mismatch.key, syntheticPng(3), 'image/png');
  const result = await reconcileEvidence(pool, store, {});
  assert.deepEqual(result, { examined: 2, uploaded: 0, failed: 2, skipped: 0, errors: 0 });
  assert.equal((await rowOf(pool, inspectFail.id)).status, 'FAILED');
  assert.equal((await rowOf(pool, mismatch.id)).status, 'FAILED');
  assert.deepEqual(store.removes.sort(), [inspectFail.key, mismatch.key].sort());
  assert.deepEqual(store.statusAtRemove, ['FAILED', 'FAILED']);
  assert.equal(store.objects.size, 0);
});

test('closed case with a valid object marks FAILED and removes the private object after commit', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const bytes = syntheticPng(5);
  const row = await insertPending(pool, dispute, { bytes });
  await store.put(row.key, bytes, 'image/png');
  await closeCase(pool, dispute);
  assert.deepEqual(await reconcileEvidence(pool, store, {}), { examined: 1, uploaded: 0, failed: 1, skipped: 0, errors: 0 });
  assert.equal((await rowOf(pool, row.id)).status, 'FAILED');
  assert.deepEqual(store.removes, [row.key]);
  assert.deepEqual(store.statusAtRemove, ['FAILED']);
  assert.equal(store.objects.has(row.key), false);
});

test('storage read failure leaves PENDING untouched and a later run recovers', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const bytes = syntheticPng(6);
  const row = await insertPending(pool, dispute, { bytes });
  await store.put(row.key, bytes, 'image/png');
  store.failGets.add(row.key);
  assert.deepEqual(await reconcileEvidence(pool, store, {}), { examined: 1, uploaded: 0, failed: 0, skipped: 0, errors: 1 });
  const pending = await rowOf(pool, row.id);
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.etag, null);
  assert.deepEqual(store.removes, []);
  assert.equal(store.objects.has(row.key), true);
  store.failGets.clear();
  assert.deepEqual(await reconcileEvidence(pool, store, {}), { examined: 1, uploaded: 1, failed: 0, skipped: 0, errors: 0 });
  assert.equal((await rowOf(pool, row.id)).status, 'UPLOADED');
});

test('failed cleanup after a FAILED commit is counted as error and keeps the row FAILED', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const bytes = syntheticPng(7);
  const row = await insertPending(pool, dispute, { bytes });
  await store.put(row.key, bytes, 'image/png');
  await closeCase(pool, dispute);
  store.failRemove = true;
  assert.deepEqual(await reconcileEvidence(pool, store, {}), { examined: 1, uploaded: 0, failed: 0, skipped: 0, errors: 1 });
  assert.equal((await rowOf(pool, row.id)).status, 'FAILED');
  assert.deepEqual(store.removes, [row.key]);
});

test('young PENDING rows are ignored', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const bytes = syntheticPng(8);
  const row = await insertPending(pool, dispute, { bytes, ageMs: 0 });
  await store.put(row.key, bytes, 'image/png');
  assert.deepEqual(await reconcileEvidence(pool, store, {}), zero);
  assert.deepEqual(store.gets, []);
  assert.equal((await rowOf(pool, row.id)).status, 'PENDING');
});

test('UPLOADED rows are never re-read, deleted or rewritten', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const bytes = syntheticPng(9);
  const row = await insertPending(pool, dispute, { bytes });
  await store.put(row.key, bytes, 'image/png');
  await reconcileEvidence(pool, store, {});
  const before = await rowOf(pool, row.id);
  store.objects.delete(row.key);
  store.gets = [];
  assert.deepEqual(await reconcileEvidence(pool, store, {}), zero);
  assert.deepEqual(store.gets, []);
  assert.deepEqual(store.removes, []);
  assert.deepEqual(await rowOf(pool, row.id), before);
});

test('concurrent runs settle each pending row exactly once', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const rows = [];
  for (const seed of [10, 11, 12]) {
    const bytes = syntheticPng(seed);
    const row = await insertPending(pool, dispute, { bytes, ageMs: HOUR + seed });
    await store.put(row.key, bytes, 'image/png');
    rows.push(row);
  }
  const runs = await Promise.all([reconcileEvidence(pool, store, {}), reconcileEvidence(pool, store, {})]);
  for (const run of runs) assert.equal(run.examined, run.uploaded + run.failed + run.skipped + run.errors);
  assert.equal(runs.reduce((sum, run) => sum + run.uploaded, 0), 3);
  assert.equal(runs.reduce((sum, run) => sum + run.failed, 0), 0);
  for (const row of rows) assert.equal((await rowOf(pool, row.id)).status, 'UPLOADED');
  assert.equal((await pool.query("SELECT count(*)::int n FROM dispatch.evidence WHERE status='UPLOADED'")).rows[0].n, 3);
});

test('batch is bounded by limit and takes the oldest rows first', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const ages = [3 * HOUR, 2 * HOUR, HOUR];
  const rows = [];
  for (const [index, ageMs] of ages.entries()) {
    const bytes = syntheticPng(20 + index);
    const row = await insertPending(pool, dispute, { bytes, ageMs });
    await store.put(row.key, bytes, 'image/png');
    rows.push(row);
  }
  assert.deepEqual(await reconcileEvidence(pool, store, { limit: 2 }), { examined: 2, uploaded: 2, failed: 0, skipped: 0, errors: 0 });
  assert.equal((await rowOf(pool, rows[0].id)).status, 'UPLOADED');
  assert.equal((await rowOf(pool, rows[1].id)).status, 'UPLOADED');
  assert.equal((await rowOf(pool, rows[2].id)).status, 'PENDING');
  assert.equal(store.gets.length, 2);
});

test('out-of-range options are refused before any database or storage access', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const bytes = syntheticPng(30);
  const row = await insertPending(pool, dispute, { bytes });
  await store.put(row.key, bytes, 'image/png');
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { minAgeMs: 899999 }, { minAgeMs: 86400001 }, { minAgeMs: 900000.5 }]) {
    await assert.rejects(reconcileEvidence(pool, store, options), RangeError);
  }
  assert.deepEqual(store.gets, []);
  assert.equal((await rowOf(pool, row.id)).status, 'PENDING');
});

test('dry-run counts eligible PENDING rows without storage access or mutation', async (t) => {
  const { pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const old = [await insertPending(pool, dispute, { bytes: syntheticPng(40) }), await insertPending(pool, dispute, { bytes: syntheticPng(41), ageMs: 2 * HOUR })];
  const young = await insertPending(pool, dispute, { bytes: syntheticPng(42), ageMs: 0 });
  assert.equal(await countEligiblePending(pool, { limit: 20, minAgeMs: 900000 }), 2);
  assert.equal(await countEligiblePending(pool, { limit: 1, minAgeMs: 900000 }), 1);
  assert.deepEqual(store.gets, []);
  for (const row of [...old, young]) assert.equal((await rowOf(pool, row.id)).status, 'PENDING');
});

test('CLI defaults to dry-run and prints aggregate counts only', async (t) => {
  const { db, pool } = await setup(t);
  const dispute = await openCase(pool, 1);
  await insertPending(pool, dispute, { bytes: syntheticPng(50) });
  await insertPending(pool, dispute, { bytes: syntheticPng(51), ageMs: 0 });
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI], { env: { DATABASE_URL: db.url }, timeout: 20000 });
  assert.deepEqual(JSON.parse(stdout), { mode: 'dry-run', examined: 1, uploaded: 0, failed: 0, skipped: 0, errors: 0 });
  assert.equal(stderr, '');
  assert.equal(stdout.includes(db.url), false);
  assert.equal(/https?:|[0-9a-f]{64}|blob\.core/i.test(stdout), false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM dispatch.evidence WHERE status='PENDING'")).rows[0].n, 2);
});

test('apply exits 0 on clean run and 1 when any row errors, via injected storage double', async (t) => {
  const { db, pool, store } = await setup(t);
  const dispute = await openCase(pool, 1);
  const good = syntheticPng(70), bad = syntheticPng(71);
  const okRow = await insertPending(pool, dispute, { bytes: good });
  await store.put(okRow.key, good, 'image/png');
  const errRow = await insertPending(pool, dispute, { bytes: bad, ageMs: HOUR + 1 });
  await store.put(errRow.key, bad, 'image/png');
  store.failGets.add(errRow.key);
  const env = { DATABASE_URL: db.url, EVIDENCE_BLOB_ACCOUNT_URL: 'https://synthetic.blob.core.windows.net', IDENTITY_ENDPOINT: 'http://127.0.0.1:9/token', IDENTITY_HEADER: 'synthetic' };
  const lines = [];
  const createStore = () => store;
  const code = await main(['--apply', '--confirm-storage-host', 'synthetic.blob.core.windows.net'], env, { createStore, log: (line) => lines.push(line), logError: () => {} });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(lines[0]), { mode: 'apply', examined: 2, uploaded: 1, failed: 0, skipped: 0, errors: 1 });
  assert.equal((await rowOf(pool, okRow.id)).status, 'UPLOADED');
  assert.equal((await rowOf(pool, errRow.id)).status, 'PENDING');
  store.failGets.clear();
  const clean = [];
  assert.equal(await main(['--apply', '--confirm-storage-host', 'synthetic.blob.core.windows.net'], env, { createStore, log: (line) => clean.push(line), logError: () => {} }), 0);
  assert.deepEqual(JSON.parse(clean[0]), { mode: 'apply', examined: 1, uploaded: 1, failed: 0, skipped: 0, errors: 0 });
  assert.equal((await rowOf(pool, errRow.id)).status, 'UPLOADED');
});

test('CLI apply requires exact storage host confirmation and refuses before any work', async (t) => {
  const { db, pool } = await setup(t);
  const dispute = await openCase(pool, 1);
  const row = await insertPending(pool, dispute, { bytes: syntheticPng(60) });
  const storage = {
    DATABASE_URL: db.url,
    EVIDENCE_BLOB_ACCOUNT_URL: 'https://synthetic.blob.core.windows.net',
    IDENTITY_ENDPOINT: 'http://127.0.0.1:9/token',
    IDENTITY_HEADER: 'synthetic-test-header',
  };
  const attempts = [
    { args: ['--apply'], env: storage },
    { args: ['--apply', '--confirm-storage-host', 'other.blob.core.windows.net'], env: storage },
    { args: ['--apply', '--confirm-storage-host', 'synthetic.blob.core.windows.net'], env: { DATABASE_URL: db.url } },
    { args: ['--apply', '--dry-run', '--confirm-storage-host', 'synthetic.blob.core.windows.net'], env: storage },
  ];
  for (const { args, env } of attempts) {
    await assert.rejects(execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 20000 }), (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr.includes(db.url), false);
      return true;
    });
  }
  assert.equal((await rowOf(pool, row.id)).status, 'PENDING');
});
