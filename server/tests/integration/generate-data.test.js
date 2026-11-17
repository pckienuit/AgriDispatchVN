import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import {
  checkGeneratedData,
  expectedCounts,
  generateData,
  namespacePrefix,
} from '../../scripts/generate-data.js';
import { createDisposableDatabase, parseRootDatabaseUrl } from '../helpers/catalog-db.js';

// Fail closed at load time: disposable loopback *_test root only.
const rootUrl = process.env.TEST_DATABASE_URL;
parseRootDatabaseUrl(rootUrl);

const PASSWORD = 'synthetic-only-test-2026';
const SCRIPT = fileURLToPath(new URL('../../scripts/generate-data.js', import.meta.url));
const execFileAsync = promisify(execFile);
const ZERO = Object.fromEntries(Object.keys(expectedCounts(1)).map((key) => [key, 0]));
const TABLES = ['users', 'user_roles', 'services', 'fields', 'bookings', 'booking_events', 'jobs', 'applications', 'offers', 'recruitment_events'];

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function freshDb() {
  const db = await createDisposableDatabase(rootUrl, { label: 'gendata' });
  const pool = createPool(db.url, { statementTimeout: 60000 });
  cleanups.push(async () => {
    await pool.end();
    await db.drop();
  });
  await migrate(pool);
  return { db, pool };
}

// Row-level snapshot of one seed's namespace. Timestamps are fixed by the generator, so rows compare exactly.
// password_hash is excluded because scrypt salts are random per run; sequence/id columns are excluded because
// identity values depend on insertion order.
async function snapshot(pool, seed) {
  const like = `${namespacePrefix(seed)}.%@example.invalid`;
  const codeLike = `${namespacePrefix(seed)}-%`;
  const sql = {
    users: `SELECT (to_jsonb(u) - 'password_hash')::text AS x FROM account.users u WHERE u.email LIKE $1`,
    user_roles: `SELECT to_jsonb(r)::text AS x FROM account.user_roles r JOIN account.users u ON u.id = r.user_id WHERE u.email LIKE $1`,
    services: `SELECT to_jsonb(s)::text AS x FROM dispatch.services s WHERE s.code LIKE $1`,
    fields: `SELECT to_jsonb(f)::text AS x FROM dispatch.fields f JOIN account.users u ON u.id = f.owner_id WHERE u.email LIKE $1`,
    bookings: `SELECT to_jsonb(b)::text AS x FROM dispatch.bookings b JOIN account.users u ON u.id = b.owner_id WHERE u.email LIKE $1`,
    booking_events: `SELECT (to_jsonb(e) - 'sequence')::text AS x FROM dispatch.booking_events e
      JOIN dispatch.bookings b ON b.id = e.booking_id JOIN account.users u ON u.id = b.owner_id WHERE u.email LIKE $1`,
    jobs: `SELECT to_jsonb(j)::text AS x FROM dispatch.jobs j JOIN account.users u ON u.id = j.provider_id WHERE u.email LIKE $1`,
    applications: `SELECT to_jsonb(a)::text AS x FROM dispatch.applications a
      JOIN dispatch.jobs j ON j.id = a.job_id JOIN account.users u ON u.id = j.provider_id WHERE u.email LIKE $1`,
    offers: `SELECT to_jsonb(o)::text AS x FROM dispatch.offers o
      JOIN dispatch.jobs j ON j.id = o.job_id JOIN account.users u ON u.id = j.provider_id WHERE u.email LIKE $1`,
    recruitment_events: `SELECT (to_jsonb(e) - 'id')::text AS x FROM dispatch.recruitment_events e WHERE e.entity_id IN (
      SELECT j.id FROM dispatch.jobs j JOIN account.users u ON u.id = j.provider_id WHERE u.email LIKE $1
      UNION SELECT a.id FROM dispatch.applications a JOIN dispatch.jobs j ON j.id = a.job_id
        JOIN account.users u ON u.id = j.provider_id WHERE u.email LIKE $1
      UNION SELECT o.id FROM dispatch.offers o JOIN dispatch.jobs j ON j.id = o.job_id
        JOIN account.users u ON u.id = j.provider_id WHERE u.email LIKE $1)`,
  };
  const out = {};
  for (const table of TABLES) {
    const { rows } = await pool.query(sql[table], [table === 'services' ? codeLike : like]);
    out[table] = rows.map((row) => row.x).sort();
  }
  return out;
}

test('count 25 batch 7 writes exactly the expected rows and passes invariants', async () => {
  const { pool } = await freshDb();
  const result = await generateData(pool, { seed: 7, count: 25, batchSize: 7, password: PASSWORD });
  assert.deepEqual(result.inserted, expectedCounts(25));
  assert.deepEqual(result.existing, ZERO);
  assert.equal(result.batches > 1, true);
  const check = await checkGeneratedData(pool, { seed: 7, count: 25 });
  assert.deepEqual(check.violations, []);
  assert.equal(check.ok, true);
  assert.deepEqual(check.counts, expectedCounts(25));
});

test('rerun with the same seed and count inserts nothing and reports every row as existing', async () => {
  const { pool } = await freshDb();
  await generateData(pool, { seed: 7, count: 25, batchSize: 7, password: PASSWORD });
  const before = await snapshot(pool, 7);
  const again = await generateData(pool, { seed: 7, count: 25, batchSize: 7, password: PASSWORD });
  assert.deepEqual(again.inserted, ZERO);
  assert.deepEqual(again.existing, expectedCounts(25));
  assert.deepEqual(await snapshot(pool, 7), before);
});

test('changing count to 40 extends the dataset and never mutates existing rows', async () => {
  const { pool } = await freshDb();
  await generateData(pool, { seed: 7, count: 25, batchSize: 7, password: PASSWORD });
  const before = await snapshot(pool, 7);
  const extended = await generateData(pool, { seed: 7, count: 40, batchSize: 7, password: PASSWORD });
  assert.equal(extended.inserted.bookings, 15);
  assert.equal(extended.existing.bookings, 25);
  const after = await snapshot(pool, 7);
  for (const table of TABLES) {
    const present = new Set(after[table]);
    for (const row of before[table]) assert.ok(present.has(row), `${table} row changed or removed on extend`);
  }
  assert.deepEqual(await checkGeneratedData(pool, { seed: 7, count: 40 }).then((r) => r.counts), expectedCounts(40));
});

test('a batch fault rolls back that batch, reports failure and resumes to the exact dataset', async () => {
  const { pool } = await freshDb();
  // Wrap connect() only: generateData must do every write through a client it obtains from the pool.
  // booking_events is inserted once per batch (one UNNEST statement), so the 2nd statement is batch 2.
  // Batch 1 (7 bookings) must commit; batch 2 must roll back completely.
  let eventInserts = 0;
  const faulty = {
    connect: async () => {
      const client = await pool.connect();
      // Proxy per checkout: never mutate the pooled client, so wrappers cannot stack across connections.
      return {
        query: (text, ...rest) => {
          if (/INSERT INTO dispatch\.booking_events/.test(text) && ++eventInserts === 2) {
            return Promise.reject(Object.assign(new Error('injected batch fault'), { code: 'INJECTED' }));
          }
          return client.query(text, ...rest);
        },
        release: (...args) => client.release(...args),
      };
    },
  };
  await assert.rejects(generateData(faulty, { seed: 7, count: 25, batchSize: 7, password: PASSWORD }), { code: 'INJECTED' });
  const partial = await pool.query(`SELECT
    (SELECT count(*)::int FROM dispatch.bookings) AS bookings,
    (SELECT count(*)::int FROM dispatch.booking_events) AS events,
    (SELECT count(*)::int FROM dispatch.bookings b WHERE NOT EXISTS
      (SELECT 1 FROM dispatch.booking_events e WHERE e.booking_id = b.id)) AS orphans`);
  assert.deepEqual(partial.rows[0], { bookings: 7, events: 7, orphans: 0 });

  const resumed = await generateData(pool, { seed: 7, count: 25, batchSize: 7, password: PASSWORD });
  assert.equal(resumed.inserted.bookings, 18);
  assert.equal(resumed.existing.bookings, 7);
  assert.deepEqual((await checkGeneratedData(pool, { seed: 7, count: 25 })).violations, []);
});

test('same seed gives identical rows in another database and across batch sizes; other seeds differ', async () => {
  const a = await freshDb();
  const b = await freshDb();
  await generateData(a.pool, { seed: 7, count: 25, batchSize: 7, password: PASSWORD });
  await generateData(b.pool, { seed: 7, count: 25, batchSize: 25, password: PASSWORD });
  const snapA = await snapshot(a.pool, 7);
  assert.deepEqual(snapA, await snapshot(b.pool, 7));
  await generateData(b.pool, { seed: 8, count: 25, batchSize: 25, password: PASSWORD });
  assert.notDeepEqual(await snapshot(b.pool, 8), snapA);
});

test('two seeds coexist in one database and each checker counts only its own namespace', async () => {
  const { pool } = await freshDb();
  await generateData(pool, { seed: 1, count: 25, batchSize: 10, password: PASSWORD });
  await generateData(pool, { seed: 2, count: 25, batchSize: 10, password: PASSWORD });
  for (const seed of [1, 2]) {
    const check = await checkGeneratedData(pool, { seed, count: 25 });
    assert.deepEqual(check.violations, []);
    assert.deepEqual(check.counts, expectedCounts(25));
  }
});

test('seeded scenario is designed-skewed: hot field, all services, all three seasons', async () => {
  const { pool } = await freshDb();
  await generateData(pool, { seed: 11, count: 200, batchSize: 50, password: PASSWORD });
  const top = await pool.query(`SELECT count(*)::int AS n FROM dispatch.bookings GROUP BY field_id ORDER BY n DESC LIMIT 1`);
  const fields = await pool.query('SELECT count(*)::int AS n FROM dispatch.fields');
  const average = 200 / fields.rows[0].n;
  assert.ok(top.rows[0].n >= 2 * average, `top field ${top.rows[0].n} vs average ${average}`);
  const services = await pool.query('SELECT count(DISTINCT service_id)::int AS n FROM dispatch.bookings');
  assert.equal(services.rows[0].n, 4);
  const seasons = await pool.query(`SELECT
      count(*) FILTER (WHERE start_at >= '2027-02-01T00:00:00Z' AND start_at < '2027-05-01T00:00:00Z')::int AS winter_spring,
      count(*) FILTER (WHERE start_at >= '2027-06-01T00:00:00Z' AND start_at < '2027-09-01T00:00:00Z')::int AS summer_autumn,
      count(*) FILTER (WHERE start_at >= '2027-10-01T00:00:00Z' AND start_at < '2027-12-16T00:00:00Z')::int AS autumn_winter
    FROM dispatch.bookings`);
  assert.deepEqual(Object.values(seasons.rows[0]).every((n) => n > 0), true);
  assert.deepEqual(Object.values(seasons.rows[0]).reduce((s, n) => s + n, 0), 200);
});

test('invariant checker flags snapshot drift and non-OFFERED accepted offers, then passes after restore', async () => {
  const { pool } = await freshDb();
  await generateData(pool, { seed: 9, count: 5, batchSize: 5, password: PASSWORD });
  const field = await pool.query('SELECT f.id, f.area_m2 FROM dispatch.fields f JOIN dispatch.bookings b ON b.field_id = f.id LIMIT 1');
  await pool.query('UPDATE dispatch.fields SET area_m2 = area_m2 + 1 WHERE id = $1', [field.rows[0].id]);
  const drift = await checkGeneratedData(pool, { seed: 9, count: 5 });
  assert.equal(drift.ok, false);
  assert.ok(drift.violations.some((v) => /snapshot/.test(v)), JSON.stringify(drift.violations));
  await pool.query('UPDATE dispatch.fields SET area_m2 = area_m2 - 1 WHERE id = $1', [field.rows[0].id]);

  const offer = await pool.query('SELECT id FROM dispatch.offers LIMIT 1');
  await pool.query("UPDATE dispatch.offers SET status = 'ACCEPTED', responded_at = now() WHERE id = $1", [offer.rows[0].id]);
  const accepted = await checkGeneratedData(pool, { seed: 9, count: 5 });
  assert.ok(accepted.violations.some((v) => /offer/.test(v)), JSON.stringify(accepted.violations));
  await pool.query("UPDATE dispatch.offers SET status = 'OFFERED', responded_at = NULL WHERE id = $1", [offer.rows[0].id]);
  assert.deepEqual((await checkGeneratedData(pool, { seed: 9, count: 5 })).violations, []);
});

test('CLI dry-run writes nothing and never connects, even with an unreachable URL', async () => {
  const env = { ...process.env, DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/agridispatch_test' };
  delete env.NODE_ENV;
  delete env.SYNTHETIC_PASSWORD;
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--seed', '7', '--count', '25', '--batch-size', '7'], { env });
  const plan = JSON.parse(stdout);
  assert.equal(plan.mode, 'dry-run');
  assert.deepEqual(plan.expected, expectedCounts(25));
  assert.equal(plan.batches, 5);
});

test('a smaller count than the existing namespace is refused before any write', async () => {
  const { pool } = await freshDb();
  await generateData(pool, { seed: 7, count: 25, batchSize: 7, password: PASSWORD });
  const before = await snapshot(pool, 7);
  await assert.rejects(generateData(pool, { seed: 7, count: 10, batchSize: 7, password: PASSWORD }), { code: 'COUNT_BELOW_EXISTING' });
  assert.deepEqual(await snapshot(pool, 7), before);
});

test('CLI refuses remote, production, unconfirmed and missing-password runs with exit 1', async () => {
  const { db } = await freshDb();
  const base = ['--seed', '7', '--count', '5', '--confirm-synthetic'];
  const cases = [
    { name: 'remote', url: 'postgresql://u:***@db.example.com:5432/agridispatch_test', nodeEnv: undefined, password: PASSWORD, code: 'GENERATE_REFUSED' },
    { name: 'override', url: 'postgresql://u:***@127.0.0.1:1/agridispatch_test?host=db.example.com', nodeEnv: undefined, password: PASSWORD, code: 'GENERATE_REFUSED' },
    { name: 'production', url: db.url, nodeEnv: 'production', password: PASSWORD, code: 'GENERATE_REFUSED' },
    { name: 'password', url: db.url, nodeEnv: undefined, password: 'local_dev_only', code: 'SYNTHETIC_PASSWORD_INVALID' },
  ];
  for (const item of cases) {
    const env = { ...process.env, DATABASE_URL: item.url, SYNTHETIC_PASSWORD: item.password };
    if (item.nodeEnv) env.NODE_ENV = item.nodeEnv;
    else delete env.NODE_ENV;
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT, ...base], { env }), (error) => {
      assert.equal(error.code, 1, item.name);
      assert.match(error.stderr, new RegExp(item.code), item.name);
      assert.doesNotMatch(error.stderr, /synthetic-only|local_dev_only|db\.example\.com/, item.name);
      return true;
    });
  }
});

test('CLI confirmed run on a disposable loopback DB writes the planned rows and self-checks', async () => {
  const { db, pool } = await freshDb();
  const env = { ...process.env, DATABASE_URL: db.url, SYNTHETIC_PASSWORD: PASSWORD };
  delete env.NODE_ENV;
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--seed', '7', '--count', '5', '--batch-size', '2', '--confirm-synthetic'], { env });
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'write');
  assert.equal(report.inserted.bookings, 5);
  assert.equal(report.check.ok, true);
  assert.deepEqual((await checkGeneratedData(pool, { seed: 7, count: 5 })).violations, []);
  assert.doesNotMatch(stdout, /synthetic-only|postgresql:\/\//);
});
