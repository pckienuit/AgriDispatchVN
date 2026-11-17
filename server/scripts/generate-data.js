import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth/password.js';
import { createPool } from '../src/db.js';

// Synthetic relational workload for local or disposable PostgreSQL only. Every row is labelled synthetic:
// services carry data_label 'synthetic', accounts use *.example.invalid emails, and IDs/timestamps derive from
// (seed, kind, index). Distributions are designed demo scenarios, not survey, market or measured seasonal data.
// ponytail: fixed role pool and 4 services, 12 fields. Upgrade: configurable pool once load targets are agreed.

const DEFAULT_BATCH = 100;
const MAX_COUNT = 1000000;
const MAX_BATCH = 1000;
const MAX_SEED = 4294967295;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 128;
const PASSWORD_DENYLIST = new Set(['local_dev_only', 'disposable_test_only']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const EPOCH_MS = Date.UTC(2026, 10, 18);
const DAY_MS = 86400000;
const CREATED_WINDOW_DAYS = 60;
const HOUR_MS = 3600000;
const EPOCH_ISO = new Date(EPOCH_MS).toISOString();

const ROLE_COUNTS = [['farmer', 4], ['provider', 2], ['operator', 5], ['coop', 1], ['admin', 1]];
const ACCOUNTS = ROLE_COUNTS.flatMap(([role, n]) => Array.from({ length: n }, (_, i) => ({ role, n: i + 1 })))
  .map((account, index) => ({ ...account, index }));
const byRole = (role) => ACCOUNTS.filter((account) => account.role === role);
const FARMERS = byRole('farmer');
const PROVIDERS = byRole('provider');
const OPERATORS = byRole('operator');

const SERVICE_SPECS = [
  { slug: 'tillage', name: 'Cày xới đất (giả lập)', price: 900000 },
  { slug: 'harvest', name: 'Gặt đập liên hợp (giả lập)', price: 1200000 },
  { slug: 'drone-spray', name: 'Phun thuốc drone (giả lập)', price: 350000 },
  { slug: 'transport', name: 'Vận chuyển nông sản (giả lập)', price: 500000 },
];
const FIELDS = 12;
const LOCALITIES = ['Cần Thơ', 'Đồng Tháp', 'An Giang', 'Long An', 'Sóc Trăng', 'Kiên Giang'];
const HOT_FIELD_SHARE = 0.3;
const JOB_CAPACITY = 3;
const APPLICANTS_PER_JOB = 4;
const OFFERS_PER_JOB = 3;
const EVENTS_PER_JOB = 1 + APPLICANTS_PER_JOB + 2 * OFFERS_PER_JOB;
const BOOKINGS_PER_JOB = 8;
// Designed scenario windows (UTC). Weights are demo choices, not measured seasonality.
const SEASONS = [
  { startMs: Date.UTC(2027, 1, 1), days: 88 },
  { startMs: Date.UTC(2027, 5, 1), days: 92 },
  { startMs: Date.UTC(2027, 9, 1), days: 76 },
];

const fail = (code, message) => Object.assign(new Error(message), { code });

export function assertSeed(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SEED) {
    throw fail('SEED_INVALID', 'seed must be an integer from 0 to 4294967295');
  }
  return value;
}

export function assertCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COUNT) {
    throw fail('COUNT_INVALID', 'count must be an integer from 1 to 1000000');
  }
  return value;
}

export function assertBatchSize(value = DEFAULT_BATCH) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH) {
    throw fail('BATCH_SIZE_INVALID', 'batch size must be an integer from 1 to 1000');
  }
  return value;
}

export function assertSyntheticPassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD || value.length > MAX_PASSWORD || PASSWORD_DENYLIST.has(value)) {
    throw fail('SYNTHETIC_PASSWORD_INVALID', 'SYNTHETIC_PASSWORD must be 12 to 128 characters and not a sample secret');
  }
  return value;
}

// Loopback, non-production, explicitly confirmed. No environment bypass exists; remote use needs a separate approval.
export function assertGenerateAllowed({ databaseUrl, confirmed, nodeEnv }) {
  if (confirmed !== true) throw fail('GENERATE_NOT_CONFIRMED', 'pass --confirm-synthetic to write synthetic rows');
  if (nodeEnv === 'production') throw fail('GENERATE_REFUSED', 'generation refused in production');
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw fail('GENERATE_REFUSED', 'DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw fail('GENERATE_REFUSED', 'DATABASE_URL must be a PostgreSQL URL');
  if (!LOOPBACK.has(url.hostname)) throw fail('GENERATE_REFUSED', 'generation allowed only for loopback hosts');
  // pg accepts connection parameters from the query string, including a replacement host/database.
  if (url.search || url.hash) throw fail('GENERATE_REFUSED', 'generation URL must not contain query parameters or fragments');
  return url.hostname;
}

const sha256 = (text) => createHash('sha256').update(text).digest();

export function seedDigest(seed) {
  return sha256(`agridispatch-g11-synthetic:${seed}`).toString('hex').slice(0, 8);
}

export function namespacePrefix(seed) {
  return `syn${seedDigest(seed)}`;
}

// Version-5 shaped UUID from SHA-256 of (seed, kind, index). Stable across runs and databases.
export function syntheticUuid(seed, kind, index) {
  const bytes = sha256(`agridispatch-g11:${seed}:${kind}:${index}`).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// mulberry32 seeded from SHA-256 of (seed, kind, index). Returns values in [0, 1).
export function prngFor(seed, kind, index) {
  let state = sha256(`agridispatch-g11-prng:${seed}:${kind}:${index}`).readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function jobCount(count) {
  return Math.max(1, Math.floor(count / BOOKINGS_PER_JOB));
}

export function expectedCounts(count) {
  const jobs = jobCount(count);
  return {
    accounts: ACCOUNTS.length,
    services: SERVICE_SPECS.length,
    fields: FIELDS,
    bookings: count,
    booking_events: count,
    jobs,
    applications: jobs * APPLICANTS_PER_JOB,
    offers: jobs * OFFERS_PER_JOB,
    recruitment_events: jobs * EVENTS_PER_JOB,
  };
}

export function buildPlan({ seed, count, batchSize }) {
  assertSeed(seed);
  assertCount(count);
  const size = assertBatchSize(batchSize);
  return {
    mode: 'dry-run',
    seed,
    count,
    batchSize: size,
    prefix: namespacePrefix(seed),
    expected: expectedCounts(count),
    batches: Math.ceil(count / size) + Math.ceil(jobCount(count) / size),
  };
}

// created_at is drawn inside CREATED_WINDOW_DAYS after the epoch, which ends before the earliest season, so
// history never postdates a scheduled start at any count.
function createdWithin(seed, kind, index) {
  const rng = prngFor(seed, kind, index);
  const dayDraw = rng();
  const hourDraw = rng();
  return EPOCH_MS + Math.floor(dayDraw * CREATED_WINDOW_DAYS) * DAY_MS + Math.floor(hourDraw * 24) * HOUR_MS;
}

// One primary booking. Hot field gets HOT_FIELD_SHARE of requests; seasons are weighted 45/30/25.
export function bookingPlan(seed, index) {
  const rng = prngFor(seed, 'booking', index);
  const hotDraw = rng();
  const fieldDraw = rng();
  const serviceDraw = rng();
  const seasonDraw = rng();
  const dayDraw = rng();
  const hourDraw = rng();
  const durationDraw = rng();
  const season = seasonDraw < 0.45 ? SEASONS[0] : seasonDraw < 0.75 ? SEASONS[1] : SEASONS[2];
  const startMs = season.startMs + Math.floor(dayDraw * season.days) * DAY_MS + (1 + Math.floor(hourDraw * 8)) * HOUR_MS;
  return {
    index,
    fieldIndex: hotDraw < HOT_FIELD_SHARE ? 0 : Math.floor(fieldDraw * FIELDS),
    serviceIndex: Math.floor(serviceDraw * SERVICE_SPECS.length),
    startMs,
    endMs: startMs + (2 + Math.floor(durationDraw * 9)) * HOUR_MS,
    createdMs: createdWithin(seed, 'booking-created', index),
  };
}

// One recruitment job: capacity 3, four applicants (more than capacity), three OFFERED, one APPLIED.
export function jobPlan(seed, index) {
  const rng = prngFor(seed, 'job', index);
  const season = SEASONS[index % SEASONS.length];
  const dayDraw = rng();
  const durationDraw = rng();
  const startMs = season.startMs + Math.floor(dayDraw * season.days) * DAY_MS;
  return {
    index,
    providerIndex: index % PROVIDERS.length,
    localityIndex: index % LOCALITIES.length,
    startMs,
    endMs: startMs + (3 + Math.floor(durationDraw * 8)) * DAY_MS,
    createdMs: createdWithin(seed, 'job-created', index),
  };
}

const accountId = (seed, account) => syntheticUuid(seed, 'account', account.index);
const serviceId = (seed, index) => syntheticUuid(seed, 'service', index);
const fieldId = (seed, index) => syntheticUuid(seed, 'field', index);
const bookingId = (seed, index) => syntheticUuid(seed, 'booking', index);
const jobId = (seed, index) => syntheticUuid(seed, 'job', index);
const applicationId = (seed, job, k) => syntheticUuid(seed, 'application', job * APPLICANTS_PER_JOB + k);
const offerId = (seed, job, k) => syntheticUuid(seed, 'offer', job * OFFERS_PER_JOB + k);
const operatorFor = (job, k) => OPERATORS[(job + k) % OPERATORS.length];

const isoAt = (ms) => new Date(ms).toISOString();
const zeroTally = () => Object.fromEntries(Object.keys(expectedCounts(1)).map((key) => [key, 0]));
const likeUsers = (prefix) => `${prefix}.%@example.invalid`;
const NS_USERS = 'SELECT id FROM account.users WHERE email LIKE $1';

// Every write runs in one transaction per batch. A failed COMMIT/ROLLBACK destroys the connection.
async function inBatch(pool, work) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

async function presentIds(client, sql, ids) {
  const { rows } = await client.query(sql, [ids]);
  return rows.map((row) => row.id);
}

async function countWhere(client, sql, params) {
  return (await client.query(sql, params)).rows[0].n;
}

async function writeSetup(client, seed, password, tally) {
  const prefix = namespacePrefix(seed);
  const accountIds = ACCOUNTS.map((account) => accountId(seed, account));
  const existingAccounts = new Set(await presentIds(client, 'SELECT id FROM account.users WHERE id = ANY($1::uuid[])', accountIds));
  tally.existing.accounts += existingAccounts.size;
  const missing = ACCOUNTS.filter((account) => !existingAccounts.has(accountId(seed, account)));
  if (missing.length > 0) {
    // One salted hash for every missing fixture, generated outside the per-account loop.
    const hash = await hashPassword(password);
    const ids = missing.map((account) => accountId(seed, account));
    const emails = missing.map((account) => `${prefix}.${account.role}${account.n}@example.invalid`);
    const names = missing.map((account) => `Synthetic ${account.role} ${account.n}`);
    const users = await client.query(
      `INSERT INTO account.users (id, email, name, password_hash, created_at)
       SELECT u.id, u.email, u.name, $4::text, $5::timestamptz
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS u(id, email, name)`,
      [ids, emails, names, hash, EPOCH_ISO],
    );
    tally.inserted.accounts += users.rowCount;
    const roles = await client.query(
      `INSERT INTO account.user_roles (user_id, role, granted_at)
       SELECT r.user_id, r.role, $3::timestamptz FROM unnest($1::uuid[], $2::text[]) AS r(user_id, role)`,
      [ids, missing.map((account) => account.role), EPOCH_ISO],
    );
    if (roles.rowCount !== missing.length) throw fail('ROLE_INSERT_MISMATCH', 'role rows do not match new accounts');
  }

  const serviceIds = SERVICE_SPECS.map((_, i) => serviceId(seed, i));
  const existingServices = new Set(await presentIds(client, 'SELECT id FROM dispatch.services WHERE id = ANY($1::uuid[])', serviceIds));
  tally.existing.services += existingServices.size;
  const newServices = SERVICE_SPECS.map((spec, i) => ({ spec, i })).filter(({ i }) => !existingServices.has(serviceIds[i]));
  if (newServices.length > 0) {
    const result = await client.query(
      `INSERT INTO dispatch.services (id, code, name, price_per_ha_vnd, data_label, active, created_at, updated_at)
       SELECT s.id, s.code, s.name, s.price, 'synthetic', true, $5::timestamptz, $5::timestamptz
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::bigint[]) AS s(id, code, name, price)`,
      [
        newServices.map(({ i }) => serviceIds[i]),
        newServices.map(({ spec }) => `${prefix}-${spec.slug}`),
        newServices.map(({ spec }) => spec.name),
        newServices.map(({ spec }) => spec.price),
        EPOCH_ISO,
      ],
    );
    tally.inserted.services += result.rowCount;
  }

  const fieldIds = Array.from({ length: FIELDS }, (_, f) => fieldId(seed, f));
  const existingFields = new Set(await presentIds(client, 'SELECT id FROM dispatch.fields WHERE id = ANY($1::uuid[])', fieldIds));
  tally.existing.fields += existingFields.size;
  const newFields = fieldIds.map((id, f) => ({ id, f })).filter(({ id }) => !existingFields.has(id));
  if (newFields.length > 0) {
    const result = await client.query(
      `INSERT INTO dispatch.fields (id, owner_id, name, locality, area_m2, created_at, updated_at)
       SELECT f.id, f.owner_id, f.name, f.locality, f.area, $6::timestamptz, $6::timestamptz
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::int[]) AS f(id, owner_id, name, locality, area)`,
      [
        newFields.map(({ id }) => id),
        newFields.map(({ f }) => accountId(seed, FARMERS[f % FARMERS.length])),
        newFields.map(({ f }) => `Thửa ${f + 1} (giả lập)`),
        newFields.map(({ f }) => LOCALITIES[f % LOCALITIES.length]),
        newFields.map(({ f }) => 5000 + Math.floor(prngFor(seed, 'field', f)() * 45000)),
        EPOCH_ISO,
      ],
    );
    tally.inserted.fields += result.rowCount;
  }
}

async function writeBookings(client, seed, start, end, tally) {
  const plans = [];
  for (let i = start; i < end; i += 1) plans.push(bookingPlan(seed, i));
  const ids = plans.map((plan) => bookingId(seed, plan.index));
  const existing = await presentIds(client, 'SELECT id FROM dispatch.bookings WHERE id = ANY($1::uuid[])', ids);
  const existingSet = new Set(existing);
  tally.existing.bookings += existing.length;
  if (existing.length > 0) {
    tally.existing.booking_events += await countWhere(
      client,
      'SELECT count(*)::int AS n FROM dispatch.booking_events WHERE booking_id = ANY($1::uuid[])',
      [existing],
    );
  }
  const fresh = plans.filter((plan) => !existingSet.has(bookingId(seed, plan.index)));
  if (fresh.length === 0) return;
  const freshIds = fresh.map((plan) => bookingId(seed, plan.index));
  const inserted = await client.query(
    `INSERT INTO dispatch.bookings (id, owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, created_at)
     SELECT d.id, f.owner_id, f.id, s.id, d.start_at, d.end_at, f.name, f.area_m2,
       s.code, s.name, s.data_label, s.price_per_ha_vnd,
       floor((s.price_per_ha_vnd::numeric * f.area_m2 + 5000) / 10000)::bigint, d.created_at
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::timestamptz[], $5::timestamptz[], $6::timestamptz[])
       AS d(id, field_id, service_id, start_at, end_at, created_at)
     JOIN dispatch.fields f ON f.id = d.field_id
     JOIN dispatch.services s ON s.id = d.service_id`,
    [
      freshIds,
      fresh.map((plan) => fieldId(seed, plan.fieldIndex)),
      fresh.map((plan) => serviceId(seed, plan.serviceIndex)),
      fresh.map((plan) => isoAt(plan.startMs)),
      fresh.map((plan) => isoAt(plan.endMs)),
      fresh.map((plan) => isoAt(plan.createdMs)),
    ],
  );
  tally.inserted.bookings += inserted.rowCount;
  if (inserted.rowCount !== fresh.length) throw fail('BOOKING_INSERT_MISMATCH', 'booking rows do not match planned fields and services');
  const events = await client.query(
    `INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, actor_id, created_at)
     SELECT b.id, 'BOOKING_REQUESTED', 'REQUESTED', b.owner_id, b.created_at
     FROM dispatch.bookings b WHERE b.id = ANY($1::uuid[])`,
    [freshIds],
  );
  tally.inserted.booking_events += events.rowCount;
}

async function writeJobs(client, seed, first, last, tally) {
  const plans = [];
  for (let j = first; j < last; j += 1) plans.push(jobPlan(seed, j));
  const jobIds = plans.map((plan) => jobId(seed, plan.index));
  const existingJobs = await presentIds(client, 'SELECT id FROM dispatch.jobs WHERE id = ANY($1::uuid[])', jobIds);
  const existingSet = new Set(existingJobs);
  tally.existing.jobs += existingJobs.length;
  if (existingJobs.length > 0) {
    tally.existing.applications += await countWhere(
      client,
      'SELECT count(*)::int AS n FROM dispatch.applications WHERE job_id = ANY($1::uuid[])',
      [existingJobs],
    );
    tally.existing.offers += await countWhere(client, 'SELECT count(*)::int AS n FROM dispatch.offers WHERE job_id = ANY($1::uuid[])', [existingJobs]);
    tally.existing.recruitment_events += await countWhere(
      client,
      `SELECT count(*)::int AS n FROM dispatch.recruitment_events WHERE entity_id IN (
         SELECT id FROM dispatch.jobs WHERE id = ANY($1::uuid[])
         UNION ALL SELECT id FROM dispatch.applications WHERE job_id = ANY($1::uuid[])
         UNION ALL SELECT id FROM dispatch.offers WHERE job_id = ANY($1::uuid[]))`,
      [existingJobs],
    );
  }
  const fresh = plans.filter((plan) => !existingSet.has(jobId(seed, plan.index)));
  if (fresh.length === 0) return;

  const job = { id: [], provider: [], title: [], locality: [], start: [], end: [], created: [] };
  const app = { id: [], job: [], operator: [], status: [], created: [] };
  const offer = { id: [], application: [], job: [], operator: [], created: [] };
  const event = { type: [], entity: [], action: [], actor: [], from: [], to: [], created: [] };
  const pushEvent = (type, entity, action, actor, from, to, created) => {
    event.type.push(type);
    event.entity.push(entity);
    event.action.push(action);
    event.actor.push(actor);
    event.from.push(from);
    event.to.push(to);
    event.created.push(created);
  };
  for (const plan of fresh) {
    const provider = accountId(seed, PROVIDERS[plan.providerIndex]);
    const created = isoAt(plan.createdMs);
    const id = jobId(seed, plan.index);
    job.id.push(id);
    job.provider.push(provider);
    job.title.push(`Đợt tuyển ${plan.index + 1} (giả lập)`);
    job.locality.push(LOCALITIES[plan.localityIndex]);
    job.start.push(isoAt(plan.startMs));
    job.end.push(isoAt(plan.endMs));
    job.created.push(created);
    pushEvent('job', id, 'job.created', provider, null, 'OPEN', created);
    for (let k = 0; k < APPLICANTS_PER_JOB; k += 1) {
      const appId = applicationId(seed, plan.index, k);
      const operator = accountId(seed, operatorFor(plan.index, k));
      const offered = k < OFFERS_PER_JOB;
      app.id.push(appId);
      app.job.push(id);
      app.operator.push(operator);
      app.status.push(offered ? 'OFFERED' : 'APPLIED');
      app.created.push(created);
      pushEvent('application', appId, 'application.created', operator, null, 'APPLIED', created);
      if (offered) {
        const oId = offerId(seed, plan.index, k);
        offer.id.push(oId);
        offer.application.push(appId);
        offer.job.push(id);
        offer.operator.push(operator);
        offer.created.push(created);
        pushEvent('offer', oId, 'offer.created', provider, null, 'OFFERED', created);
        pushEvent('application', appId, 'application.offered', provider, 'APPLIED', 'OFFERED', created);
      }
    }
  }
  const jobs = await client.query(
    `INSERT INTO dispatch.jobs (id, provider_id, title, locality, capacity, start_at, end_at, status, closed_at, created_at, updated_at)
     SELECT j.id, j.provider_id, j.title, j.locality, $8::int, j.start_at, j.end_at, 'OPEN', NULL::timestamptz, j.created_at, j.created_at
     FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[], $7::timestamptz[])
       AS j(id, provider_id, title, locality, start_at, end_at, created_at)`,
    [job.id, job.provider, job.title, job.locality, job.start, job.end, job.created, JOB_CAPACITY],
  );
  tally.inserted.jobs += jobs.rowCount;
  const applications = await client.query(
    `INSERT INTO dispatch.applications (id, job_id, operator_id, note, status, created_at, updated_at)
     SELECT a.id, a.job_id, a.operator_id, NULL::text, a.status, a.created_at, a.created_at
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[])
       AS a(id, job_id, operator_id, status, created_at)`,
    [app.id, app.job, app.operator, app.status, app.created],
  );
  tally.inserted.applications += applications.rowCount;
  const offers = await client.query(
    `INSERT INTO dispatch.offers (id, application_id, job_id, operator_id, status, responded_at, created_at, updated_at)
     SELECT o.id, o.application_id, o.job_id, o.operator_id, 'OFFERED', NULL::timestamptz, o.created_at, o.created_at
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::timestamptz[])
       AS o(id, application_id, job_id, operator_id, created_at)`,
    [offer.id, offer.application, offer.job, offer.operator, offer.created],
  );
  tally.inserted.offers += offers.rowCount;
  const events = await client.query(
    `INSERT INTO dispatch.recruitment_events (entity_type, entity_id, action, actor_id, from_status, to_status, created_at)
     SELECT e.entity_type, e.entity_id, e.action, e.actor_id, e.from_status, e.to_status, e.created_at
     FROM unnest($1::text[], $2::uuid[], $3::text[], $4::uuid[], $5::text[], $6::text[], $7::timestamptz[])
       AS e(entity_type, entity_id, action, actor_id, from_status, to_status, created_at)`,
    [event.type, event.entity, event.action, event.actor, event.from, event.to, event.created],
  );
  tally.inserted.recruitment_events += events.rowCount;
}

// Writes primary bookings, recruitment and seed fixtures. Existing rows are detected by deterministic ID and skipped;
// nothing is updated or deleted. Counts come from SQL: rowCount for inserts, SELECTs for rows already present.
export async function generateData(pool, { seed, count, batchSize = DEFAULT_BATCH, password } = {}) {
  assertSeed(seed);
  assertCount(count);
  const size = assertBatchSize(batchSize);
  const secret = assertSyntheticPassword(password);
  const prefix = namespacePrefix(seed);
  const tally = { inserted: zeroTally(), existing: zeroTally() };

  // Refuse before any write when the namespace already holds more bookings than requested.
  await inBatch(pool, async (client) => {
    const present = await countWhere(
      client,
      `SELECT count(*)::int AS n FROM dispatch.bookings WHERE owner_id IN (${NS_USERS})`,
      [likeUsers(prefix)],
    );
    if (present > count) throw fail('COUNT_BELOW_EXISTING', 'count is below the bookings already present for this seed');
  });

  await inBatch(pool, (client) => writeSetup(client, seed, secret, tally));
  let batches = 0;
  for (let start = 0; start < count; start += size) {
    const end = Math.min(count, start + size);
    await inBatch(pool, (client) => writeBookings(client, seed, start, end, tally));
    batches += 1;
  }
  const jobs = jobCount(count);
  for (let first = 0; first < jobs; first += size) {
    const last = Math.min(jobs, first + size);
    await inBatch(pool, (client) => writeJobs(client, seed, first, last, tally));
    batches += 1;
  }
  return { inserted: tally.inserted, existing: tally.existing, batches };
}

// Read-only invariant check for one seed namespace. Counts and violations use only rows with this prefix.
export async function checkGeneratedData(pool, { seed, count }) {
  assertSeed(seed);
  assertCount(count);
  const prefix = namespacePrefix(seed);
  // Each query binds exactly the parameters it references: $1 = account email pattern, $1 in service queries = code pattern.
  const usersLike = likeUsers(prefix);
  const codeLike = `${prefix}-%`;
  const n = async (sql, params = [usersLike]) => Number((await pool.query(sql, params)).rows[0].n);

  const counts = {
    accounts: await n('SELECT count(*)::int AS n FROM account.users WHERE email LIKE $1'),
    services: await n('SELECT count(*)::int AS n FROM dispatch.services WHERE code LIKE $1', [codeLike]),
    fields: await n(`SELECT count(*)::int AS n FROM dispatch.fields WHERE owner_id IN (${NS_USERS})`),
    bookings: await n(`SELECT count(*)::int AS n FROM dispatch.bookings WHERE owner_id IN (${NS_USERS})`),
    booking_events: await n(
      `SELECT count(*)::int AS n FROM dispatch.booking_events e JOIN dispatch.bookings b ON b.id = e.booking_id
       WHERE b.owner_id IN (${NS_USERS})`,
    ),
    jobs: await n(`SELECT count(*)::int AS n FROM dispatch.jobs WHERE provider_id IN (${NS_USERS})`),
    applications: await n(
      `SELECT count(*)::int AS n FROM dispatch.applications a JOIN dispatch.jobs j ON j.id = a.job_id
       WHERE j.provider_id IN (${NS_USERS})`,
    ),
    offers: await n(
      `SELECT count(*)::int AS n FROM dispatch.offers o JOIN dispatch.jobs j ON j.id = o.job_id
       WHERE j.provider_id IN (${NS_USERS})`,
    ),
    recruitment_events: await n(
      `SELECT count(*)::int AS n FROM dispatch.recruitment_events e WHERE e.entity_id IN (
         SELECT j.id FROM dispatch.jobs j WHERE j.provider_id IN (${NS_USERS})
         UNION ALL SELECT a.id FROM dispatch.applications a JOIN dispatch.jobs j ON j.id = a.job_id WHERE j.provider_id IN (${NS_USERS})
         UNION ALL SELECT o.id FROM dispatch.offers o JOIN dispatch.jobs j ON j.id = o.job_id WHERE j.provider_id IN (${NS_USERS}))`,
    ),
  };

  const violations = [];
  for (const [key, want] of Object.entries(expectedCounts(count))) {
    if (counts[key] !== want) violations.push(`${key} count ${counts[key]} != expected ${want}`);
  }
  const rules = [
    [
      'booking snapshot differs from field or service rows',
      `SELECT count(*)::int AS n FROM dispatch.bookings b
       JOIN dispatch.fields f ON f.id = b.field_id AND f.owner_id = b.owner_id
       JOIN dispatch.services s ON s.id = b.service_id
       WHERE b.owner_id IN (${NS_USERS}) AND (b.field_name <> f.name OR b.field_area_m2 <> f.area_m2
         OR b.service_code <> s.code OR b.service_name <> s.name OR b.service_data_label <> s.data_label
         OR b.price_per_ha_vnd <> s.price_per_ha_vnd)`,
    ],
    [
      'booking total differs from quote rule',
      `SELECT count(*)::int AS n FROM dispatch.bookings b
       WHERE b.owner_id IN (${NS_USERS})
         AND b.total_vnd <> floor((b.price_per_ha_vnd::numeric * b.field_area_m2 + 5000) / 10000)::bigint`,
    ],
    ['booking state not REQUESTED', `SELECT count(*)::int AS n FROM dispatch.bookings WHERE owner_id IN (${NS_USERS}) AND state <> 'REQUESTED'`],
    [
      'booking without exactly one BOOKING_REQUESTED event and nothing else',
      `SELECT count(*)::int AS n FROM dispatch.bookings b WHERE b.owner_id IN (${NS_USERS}) AND (
         (SELECT count(*) FROM dispatch.booking_events e WHERE e.booking_id = b.id AND e.event_type = 'BOOKING_REQUESTED') <> 1
         OR EXISTS (SELECT 1 FROM dispatch.booking_events e WHERE e.booking_id = b.id AND e.event_type <> 'BOOKING_REQUESTED'))`,
    ],
    [
      'service without synthetic label',
      `SELECT count(*)::int AS n FROM dispatch.services WHERE code LIKE $1 AND data_label <> 'synthetic'`,
      [codeLike],
    ],
    [
      'booking snapshot without synthetic label',
      `SELECT count(*)::int AS n FROM dispatch.bookings WHERE owner_id IN (${NS_USERS}) AND service_data_label <> 'synthetic'`,
    ],
    [
      'offer status not OFFERED (accept or decline outside the generator)',
      `SELECT count(*)::int AS n FROM dispatch.offers o JOIN dispatch.jobs j ON j.id = o.job_id
       WHERE j.provider_id IN (${NS_USERS}) AND o.status <> 'OFFERED'`,
    ],
    [
      'job applications not above capacity',
      `SELECT count(*)::int AS n FROM dispatch.jobs j WHERE j.provider_id IN (${NS_USERS})
         AND (SELECT count(*) FROM dispatch.applications a WHERE a.job_id = j.id) <= j.capacity`,
    ],
    [
      'job without exactly one job.created event',
      `SELECT count(*)::int AS n FROM dispatch.jobs j WHERE j.provider_id IN (${NS_USERS})
         AND (SELECT count(*) FROM dispatch.recruitment_events e WHERE e.entity_type = 'job' AND e.entity_id = j.id AND e.action = 'job.created') <> 1`,
    ],
  ];
  for (const [label, sql, params] of rules) {
    const found = await n(sql, params);
    if (found > 0) violations.push(`${label}: ${found}`);
  }
  return { ok: violations.length === 0, violations, counts };
}

function parseArgs(argv) {
  const out = { confirm: false };
  const flags = { '--seed': 'seed', '--count': 'count', '--batch-size': 'batchSize' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--confirm-synthetic') {
      out.confirm = true;
    } else if (Object.hasOwn(flags, flag)) {
      const value = argv[i + 1];
      if (value === undefined || !/^\d{1,10}$/.test(value)) throw fail('ARGS_INVALID', `${flag} needs an integer value`);
      out[flags[flag]] = Number(value);
      i += 1;
    } else {
      throw fail('ARGS_INVALID', 'unknown argument');
    }
  }
  return out;
}

async function main() {
  let pool;
  try {
    const args = parseArgs(process.argv.slice(2));
    const seed = assertSeed(args.seed ?? Number.NaN);
    const count = assertCount(args.count ?? Number.NaN);
    const batchSize = assertBatchSize(args.batchSize);
    if (!args.confirm) {
      console.log(JSON.stringify(buildPlan({ seed, count, batchSize })));
      return;
    }
    assertGenerateAllowed({ databaseUrl: process.env.DATABASE_URL, confirmed: true, nodeEnv: process.env.NODE_ENV });
    const password = assertSyntheticPassword(process.env.SYNTHETIC_PASSWORD);
    pool = createPool(process.env.DATABASE_URL, { statementTimeout: 60000 });
    const result = await generateData(pool, { seed, count, batchSize, password });
    const check = await checkGeneratedData(pool, { seed, count });
    const size = await pool.query('SELECT pg_database_size(current_database())::bigint AS bytes');
    console.log(JSON.stringify({
      mode: 'write',
      seed,
      count,
      batchSize,
      batches: result.batches,
      inserted: result.inserted,
      existing: result.existing,
      check,
      dbBytes: Number(size.rows[0].bytes),
    }));
    if (!check.ok) process.exitCode = 1;
  } catch (error) {
    const ours = typeof error.code === 'string' && /^(SEED|COUNT|BATCH|GENERATE|SYNTHETIC|ARGS|ROLE)/.test(error.code);
    console.error('Synthetic generation failed', { name: error.name, code: error.code, message: ours ? error.message : undefined });
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
