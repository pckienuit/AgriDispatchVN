import express from 'express';
import { hasOpenDispute } from './disputes.js';

// G7b: versioned booking acceptance and payer-reported external payment acknowledgments.
// No funds move. A payment row is a payer claim (REPORTED) until the assigned provider confirms it.
// Amounts are integer VND as decimal strings. Surcharges, fees and VAT are not modelled.
// ponytail: agreed total is the proposal total, no surcharge rule. Upgrade: versioned pricing rule once agreed.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VND_NONNEGATIVE = /^(0|[1-9][0-9]{0,14})$/;
const VND_POSITIVE = /^[1-9][0-9]{0,14}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9._-]{4,64}$/;
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;
const READ_ROLES = ['farmer', 'coop', 'provider'];
const MAX_AREA_M2 = 2147483647;
const MAX_TEXT = 500;
// ponytail: payment list capped at 200 rows per booking. Summary sums in SQL over all rows. Upgrade: cursor paging.
const PAYMENT_LIST_LIMIT = 200;
const DB_UNAVAILABLE_CODE = /^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/;
const RESTRICT_VIOLATION = '23001';

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code) => new ApiError(status, code);

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function identifier(value) {
  if (!isUuid(value)) throw fail(400, 'INVALID_ID');
  return value.toLowerCase();
}

function versionOf(value) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) throw fail(400, 'INVALID_VERSION');
  return Number(value);
}

function plainBody(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_BODY');
  if (Object.keys(input).some((key) => !keys.includes(key))) throw fail(400, 'UNKNOWN_FIELD');
  return input;
}

function text(value) {
  if (typeof value !== 'string') throw fail(400, 'VALIDATION_FAILED');
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > MAX_TEXT || trimmed.includes('\0')) throw fail(400, 'VALIDATION_FAILED');
  return trimmed;
}

export function validateProposalInput(body) {
  const input = plainBody(body, ['areaM2', 'totalVnd', 'note']);
  if (!Number.isSafeInteger(input.areaM2) || input.areaM2 <= 0 || input.areaM2 > MAX_AREA_M2) throw fail(400, 'VALIDATION_FAILED');
  if (typeof input.totalVnd !== 'string' || !VND_NONNEGATIVE.test(input.totalVnd)) throw fail(400, 'VALIDATION_FAILED');
  return { areaM2: input.areaM2, totalVnd: input.totalVnd, note: input.note === undefined ? null : text(input.note) };
}

export function validatePaymentInput(body) {
  const input = plainBody(body, ['amountVnd', 'reference']);
  if (typeof input.amountVnd !== 'string' || !VND_POSITIVE.test(input.amountVnd)) throw fail(400, 'VALIDATION_FAILED');
  if (typeof input.reference !== 'string' || !REFERENCE_PATTERN.test(input.reference)) throw fail(400, 'VALIDATION_FAILED');
  return { amountVnd: input.amountVnd, reference: input.reference };
}

// Consent and confirm take no fields. An absent body counts as empty.
function emptyBody(body) {
  plainBody(body ?? {}, []);
}

function isDbUnavailable(error) {
  return DB_UNAVAILABLE_CODE.test(typeof error.code === 'string' ? error.code : '');
}

// A failed COMMIT or ROLLBACK destroys the connection so no partial write survives.
async function transaction(pool, work) {
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

// Provider scope: the booking must sit in a package whose claimed provider is the actor. Missing and foreign both 404.
async function lockProviderBooking(client, bookingId, actorId) {
  const { rows } = await client.query(
    `SELECT b.state, b.owner_id, b.field_area_m2, b.total_vnd, p.id AS package_id
       FROM dispatch.bookings b
       JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       JOIN dispatch.packages p ON p.id = pb.package_id
      WHERE b.id = $1 AND p.provider_id = $2 FOR UPDATE OF b`,
    [bookingId, actorId],
  );
  if (!rows[0]) throw fail(404, 'NOT_FOUND');
  return rows[0];
}

// Party scope for consent: booking owner or assigned provider. The coordinating coop and others get 404.
async function lockPartyBooking(client, bookingId, actorId) {
  const { rows } = await client.query(
    `SELECT b.owner_id, p.provider_id
       FROM dispatch.bookings b
       JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       JOIN dispatch.packages p ON p.id = pb.package_id
      WHERE b.id = $1 AND (b.owner_id = $2 OR p.provider_id = $2) FOR UPDATE OF b`,
    [bookingId, actorId],
  );
  if (!rows[0]) throw fail(404, 'NOT_FOUND');
  return rows[0];
}

async function currentAcceptance(client, bookingId) {
  const { rows } = await client.query(
    'SELECT * FROM dispatch.acceptances WHERE booking_id = $1 ORDER BY version DESC LIMIT 1',
    [bookingId],
  );
  return rows[0] ?? null;
}

async function consentsFor(client, bookingId, version) {
  const { rows } = await client.query(
    'SELECT party FROM dispatch.acceptance_consents WHERE booking_id = $1 AND version = $2',
    [bookingId, version],
  );
  const parties = rows.map((row) => row.party);
  return { owner: parties.includes('owner'), provider: parties.includes('provider') };
}

async function acceptanceDto(client, row) {
  const consents = await consentsFor(client, row.booking_id, row.version);
  return {
    bookingId: row.booking_id,
    version: row.version,
    areaM2: row.area_m2,
    totalVnd: row.total_vnd,
    note: row.note,
    proposedAt: row.created_at.toISOString(),
    consents,
    agreed: consents.owner && consents.provider,
  };
}

// Pending payer reports reserve reporting capacity, but do not reduce the unconfirmed balance.
async function financialSummary(client, bookingId, acceptance) {
  const consents = await consentsFor(client, bookingId, acceptance.version);
  if (!(consents.owner && consents.provider)) return null;
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_vnd) FILTER (WHERE confirmed AND NOT deposit), 0)::text AS confirmed,
            COALESCE(SUM(amount_vnd) FILTER (WHERE NOT confirmed AND NOT deposit), 0)::text AS reported,
            COALESCE(SUM(amount_vnd) FILTER (WHERE confirmed AND deposit), 0)::text AS confirmed_deposit,
            COALESCE(SUM(amount_vnd) FILTER (WHERE NOT confirmed AND deposit), 0)::text AS reported_deposit
       FROM (
         SELECT p.amount_vnd, c.id IS NOT NULL AS confirmed, false AS deposit
           FROM dispatch.payments p
           LEFT JOIN dispatch.payment_events c ON c.payment_id = p.id AND c.event_type = 'PAYMENT_CONFIRMED'
          WHERE p.booking_id = $1
         UNION ALL
         SELECT d.amount_vnd, c.id IS NOT NULL, true
           FROM dispatch.deposits d
           LEFT JOIN dispatch.deposit_events c ON c.deposit_id = d.id AND c.event_type = 'DEPOSIT_CONFIRMED'
           LEFT JOIN dispatch.deposit_holds h ON h.booking_id = d.booking_id
          WHERE d.booking_id = $1 AND h.deposit_expired_at IS NULL
       ) amounts`,
    [bookingId],
  );
  const agreed = BigInt(acceptance.total_vnd);
  const confirmed = BigInt(rows[0].confirmed);
  const reported = BigInt(rows[0].reported);
  const confirmedDeposit = BigInt(rows[0].confirmed_deposit);
  const reportedDeposit = BigInt(rows[0].reported_deposit);
  const balance = agreed - confirmed - confirmedDeposit;
  const available = balance - reported - reportedDeposit;
  return {
    agreedVnd: agreed.toString(),
    confirmedVnd: confirmed.toString(),
    reportedVnd: reported.toString(),
    confirmedDepositVnd: confirmedDeposit.toString(),
    reportedDepositVnd: reportedDeposit.toString(),
    outstandingVnd: (balance > 0n ? balance : 0n).toString(),
    availableToReportVnd: (available > 0n ? available : 0n).toString(),
    excessConfirmedVnd: (balance < 0n ? -balance : 0n).toString(),
  };
}

const PAYMENT_SELECT = `SELECT p.id, p.amount_vnd, p.created_at, c.created_at AS confirmed_at
  FROM dispatch.payments p
  LEFT JOIN dispatch.payment_events c ON c.payment_id = p.id AND c.event_type = 'PAYMENT_CONFIRMED'`;

function paymentDto(row) {
  return {
    id: row.id,
    amountVnd: row.amount_vnd,
    status: row.confirmed_at ? 'CONFIRMED' : 'REPORTED',
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
  };
}

async function paymentById(client, paymentId) {
  const { rows } = await client.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [paymentId]);
  return paymentDto(rows[0]);
}

async function proposeAcceptance(pool, actor, bookingId, input) {
  return transaction(pool, async (client) => {
    const booking = await lockProviderBooking(client, bookingId, actor.id);
    if (await hasOpenDispute(client, bookingId)) throw fail(409, 'DISPUTE_OPEN');
    if (booking.owner_id === actor.id) throw fail(409, 'PARTY_CONFLICT');
    if (booking.state !== 'ASSIGNED') throw fail(409, 'BOOKING_UNAVAILABLE');
    const completed = await client.query(
      "SELECT 1 FROM dispatch.shifts WHERE package_id = $1 AND status = 'COMPLETED'",
      [booking.package_id],
    );
    if (!completed.rowCount) throw fail(409, 'SHIFT_NOT_COMPLETED');
    if (input.areaM2 > booking.field_area_m2 || BigInt(input.totalVnd) > BigInt(booking.total_vnd)) {
      throw fail(400, 'VALIDATION_FAILED');
    }
    const latest = await currentAcceptance(client, bookingId);
    if (latest) {
      const consents = await consentsFor(client, bookingId, latest.version);
      if (consents.owner && consents.provider) throw fail(409, 'ACCEPTANCE_AGREED');
    }
    const { rows } = await client.query(
      `INSERT INTO dispatch.acceptances (booking_id, version, proposer_id, area_m2, total_vnd, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [bookingId, (latest?.version ?? 0) + 1, actor.id, input.areaM2, input.totalVnd, input.note],
    );
    return { status: 201, body: { acceptance: await acceptanceDto(client, rows[0]) } };
  });
}

async function consentAcceptance(pool, actor, bookingId, version) {
  return transaction(pool, async (client) => {
    const parties = await lockPartyBooking(client, bookingId, actor.id);
    if (await hasOpenDispute(client, bookingId)) throw fail(409, 'DISPUTE_OPEN');
    if (parties.provider_id === parties.owner_id) throw fail(409, 'PARTY_CONFLICT');
    const latest = await currentAcceptance(client, bookingId);
    if (!latest || version > latest.version) throw fail(404, 'NOT_FOUND');
    if (version < latest.version) throw fail(409, 'STALE_VERSION');
    const party = parties.owner_id === actor.id ? 'owner' : 'provider';
    await client.query(
      'INSERT INTO dispatch.acceptance_consents (booking_id, version, party, actor_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [bookingId, version, party, actor.id],
    );
    return { status: 200, body: { acceptance: await acceptanceDto(client, latest) } };
  });
}

async function readAcceptance(pool, actor, bookingId) {
  const { rows } = await pool.query(
    `SELECT b.id,b.state,b.owner_id,p.provider_id,
      EXISTS (SELECT 1 FROM dispatch.shifts s WHERE s.package_id=p.id AND s.status='COMPLETED') AS completed
      FROM dispatch.bookings b
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       LEFT JOIN dispatch.packages p ON p.id = pb.package_id
      WHERE b.id = $1 AND (b.owner_id = $2 OR p.provider_id = $2 OR p.coop_id = $2)`,
    [bookingId, actor.id],
  );
  if (!rows[0]) throw fail(404, 'NOT_FOUND');
  const latest = await currentAcceptance(pool, bookingId);
  const acceptance = latest ? await acceptanceDto(pool, latest) : null;
  const booking = rows[0];
  const blockedByDispute = await hasOpenDispute(pool, bookingId);
  const party = booking.owner_id === actor.id ? 'owner' : booking.provider_id === actor.id ? 'provider' : null;
  const canPropose = party === 'provider' && actor.roles.includes('provider')
    && booking.provider_id !== booking.owner_id && booking.state === 'ASSIGNED' && booking.completed
    && !blockedByDispute && !acceptance?.agreed;
  return { status: 200, body: { acceptance, permissions: { party, canPropose, blockedByDispute } } };
}

async function reportPayment(pool, actor, bookingId, input) {
  return transaction(pool, async (client) => {
    // Payer scope and the booking row lock serialize every claim on this booking.
    const owned = await client.query('SELECT id FROM dispatch.bookings WHERE id = $1 AND owner_id = $2 FOR UPDATE', [bookingId, actor.id]);
    if (!owned.rows[0]) throw fail(404, 'NOT_FOUND');
    if (await hasOpenDispute(client, bookingId)) throw fail(409, 'DISPUTE_OPEN');
    const latest = await currentAcceptance(client, bookingId);
    const summary = latest ? await financialSummary(client, bookingId, latest) : null;
    if (!summary) throw fail(409, 'ACCEPTANCE_NOT_AGREED');
    // Same reference and same amount is a retry of the stored claim. Any other payload is a conflict.
    const same = await client.query('SELECT id, amount_vnd FROM dispatch.payments WHERE booking_id = $1 AND reference = $2', [bookingId, input.reference]);
    if (same.rows[0]) {
      if (same.rows[0].amount_vnd !== input.amountVnd) throw fail(409, 'REFERENCE_CONFLICT');
      return { status: 200, body: { payment: await paymentById(client, same.rows[0].id), summary } };
    }
    const deposit = await client.query('SELECT 1 FROM dispatch.deposits WHERE booking_id = $1 AND reference = $2', [bookingId, input.reference]);
    if (deposit.rowCount) throw fail(409, 'REFERENCE_CONFLICT');
    if (BigInt(input.amountVnd) > BigInt(summary.availableToReportVnd)) throw fail(409, 'AMOUNT_EXCEEDS_OUTSTANDING');
    const inserted = await client.query(
      'INSERT INTO dispatch.payments (booking_id, acceptance_version, payer_id, amount_vnd, reference) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [bookingId, latest.version, actor.id, input.amountVnd, input.reference],
    );
    await client.query("INSERT INTO dispatch.payment_events (payment_id, event_type, actor_id) VALUES ($1, 'PAYMENT_REPORTED', $2)", [inserted.rows[0].id, actor.id]);
    return {
      status: 201,
      body: { payment: await paymentById(client, inserted.rows[0].id), summary: await financialSummary(client, bookingId, latest) },
    };
  });
}

async function confirmPayment(pool, actor, paymentId) {
  return transaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT p.booking_id, p.amount_vnd, b.owner_id, pk.provider_id
         FROM dispatch.payments p
         JOIN dispatch.bookings b ON b.id = p.booking_id
         JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
         JOIN dispatch.packages pk ON pk.id = pb.package_id
        WHERE p.id = $1 AND pk.provider_id = $2 FOR UPDATE OF b`,
      [paymentId, actor.id],
    );
    const target = rows[0];
    if (!target) throw fail(404, 'NOT_FOUND');
    if (await hasOpenDispute(client, target.booking_id)) throw fail(409, 'DISPUTE_OPEN');
    if (target.owner_id === actor.id) throw fail(409, 'PARTY_CONFLICT');
    const latest = await currentAcceptance(client, target.booking_id);
    const summary = latest ? await financialSummary(client, target.booking_id, latest) : null;
    if (!summary) throw fail(409, 'ACCEPTANCE_NOT_AGREED');
    const done = await client.query(
      "SELECT 1 FROM dispatch.payment_events WHERE payment_id = $1 AND event_type = 'PAYMENT_CONFIRMED'",
      [paymentId],
    );
    if (!done.rowCount) {
      if (BigInt(target.amount_vnd) > BigInt(summary.outstandingVnd)) throw fail(409, 'OVER_CONFIRMED');
      await client.query("INSERT INTO dispatch.payment_events (payment_id, event_type, actor_id) VALUES ($1, 'PAYMENT_CONFIRMED', $2)", [paymentId, actor.id]);
    }
    return {
      status: 200,
      body: { payment: await paymentById(client, paymentId), summary: await financialSummary(client, target.booking_id, latest) },
    };
  });
}

async function listPayments(pool, actor, bookingId) {
  const { rows } = await pool.query(
    `SELECT b.id FROM dispatch.bookings b
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       LEFT JOIN dispatch.packages p ON p.id = pb.package_id
      WHERE b.id = $1 AND (b.owner_id = $2 OR p.provider_id = $2)`,
    [bookingId, actor.id],
  );
  if (!rows[0]) throw fail(404, 'NOT_FOUND');
  const latest = await currentAcceptance(pool, bookingId);
  const summary = latest ? await financialSummary(pool, bookingId, latest) : null;
  const list = await pool.query(`${PAYMENT_SELECT} WHERE p.booking_id = $1 ORDER BY p.created_at, p.id LIMIT $2`, [bookingId, PAYMENT_LIST_LIMIT]);
  return { status: 200, body: { payments: list.rows.map(paymentDto), summary } };
}

export function createAcceptanceRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') {
    throw new TypeError('createAcceptanceRouter requires a pool with query() and connect()');
  }
  if (typeof authenticate !== 'function') throw new TypeError('createAcceptanceRouter requires an authenticate middleware');

  const router = express.Router();

  // Runs after the injected authenticate middleware. Fails closed when no verified actor is attached.
  function handle(roles, work) {
    return async (req, res, next) => {
      try {
        const actor = req.actor;
        if (!actor || !isUuid(actor.id) || !Array.isArray(actor.roles)) throw fail(401, 'UNAUTHENTICATED');
        if (!actor.roles.some((role) => roles.includes(role))) throw fail(403, 'FORBIDDEN');
        const { status = 200, body } = await work(req);
        return res.status(status).json(body);
      } catch (error) {
        if (error instanceof ApiError) return res.status(error.status).json({ error: { code: error.code } });
        // Trigger-level refusal means a concurrent change beat this request.
        if (error.code === RESTRICT_VIOLATION) return res.status(409).json({ error: { code: 'STATE_CHANGED' } });
        if (isDbUnavailable(error)) return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
        return next(error);
      }
    };
  }

  router.post('/api/bookings/:id/acceptance', authenticate, handle(['provider'], async (req) => {
    const bookingId = identifier(req.params.id);
    const input = validateProposalInput(req.body);
    return proposeAcceptance(pool, req.actor, bookingId, input);
  }));

  router.post('/api/bookings/:id/acceptance/:version/consent', authenticate, handle(['farmer', 'coop', 'provider'], async (req) => {
    const bookingId = identifier(req.params.id);
    const version = versionOf(req.params.version);
    emptyBody(req.body);
    return consentAcceptance(pool, req.actor, bookingId, version);
  }));

  router.get('/api/bookings/:id/acceptance', authenticate, handle(READ_ROLES, async (req) => {
    return readAcceptance(pool, req.actor, identifier(req.params.id));
  }));

  router.post('/api/bookings/:id/payments', authenticate, handle(['farmer', 'coop'], async (req) => {
    const bookingId = identifier(req.params.id);
    return reportPayment(pool, req.actor, bookingId, validatePaymentInput(req.body));
  }));

  router.post('/api/payments/:id/confirm', authenticate, handle(['provider'], async (req) => {
    const paymentId = identifier(req.params.id);
    emptyBody(req.body);
    return confirmPayment(pool, req.actor, paymentId);
  }));

  router.get('/api/bookings/:id/payments', authenticate, handle(READ_ROLES, async (req) => {
    return listPayments(pool, req.actor, identifier(req.params.id));
  }));

  return router;
}
