import express from 'express';
import { parsePagination } from './catalog.js';
import { hasOpenDispute } from './disputes.js';
import { readDepositExpiryHours } from './config.js';
import { assertFieldInspectionPassedForBooking, FieldInspectionError } from './field-inspection-gate.js';
import { ACCOUNT_NUMBER, BANK_BIN, buildVietqrPayload, renderQrSvg, vietqrDescription } from './vietqr-emvco.js';

// Local service extensions:
// 1. D5 (F-09): HTX call confirmation on claimed packages + external deposit records (10% hypothetical snapshot).
//    Direct P2P transfers, no escrow, bank validation or automatic receipt confirmation.
// 2. D6 (F-10, O-02, H-06): Read-only server-simulated telemetry derived from DB phase/events and server clock.
//    Visibly synthetic; never mutates operational state or implies real measured GPS coordinates.
// 3. D8 (H-09): Read-only hypothetical HTX commission estimates from actual scoped records, distinct from owed/paid.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VND_POSITIVE = /^[1-9][0-9]{0,17}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9._-]{4,64}$/;
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const MAX_TEXT = 500;
const DEPOSIT_RATE_BPS = 1000;
const HYPOTHETICAL_HTX_COMMISSION_BPS = 300;
const DB_UNAVAILABLE_CODE = /^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/;
const RESTRICT_VIOLATION = '23001';

const VIETQR_NOTICE = 'Chuyển khoản trực tiếp cho chủ máy. Nền tảng không giữ tiền và không tự xác nhận giao dịch.';
const DEPOSIT_NOTICE = `Mức đặt cọc 10% là mức áp dụng thử. ${VIETQR_NOTICE}`;
const TELEMETRY_NOTICE = 'Dữ liệu telemetry mô phỏng theo pha ca máy và đồng hồ máy chủ, không phải tín hiệu GPS hay cảm biến thực tế.';
const COMMISSION_NOTICE = 'Hoa hồng HTX chỉ là ước tính giả định từ đơn thuộc phạm vi HTX, chưa được duyệt chính thức và không phải khoản phải thu hay đã chi trả.';

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

function plainBody(input, keys, { allowAbsent = false } = {}) {
  if (input === undefined && allowAbsent) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_BODY');
  if (Object.keys(input).some((key) => !keys.includes(key))) throw fail(400, 'UNKNOWN_FIELD');
  return input;
}

function boundedText(value) {
  if (typeof value !== 'string') throw fail(400, 'VALIDATION_FAILED');
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > MAX_TEXT) throw fail(400, 'VALIDATION_FAILED');
  return trimmed;
}

function parseInstant(value) {
  const match = typeof value === 'string' ? INSTANT_PATTERN.exec(value) : null;
  if (!match) throw fail(400, 'VALIDATION_FAILED');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  const roundTrip = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  if (!roundTrip) throw fail(400, 'VALIDATION_FAILED');
  return date;
}

export function deriveTenPercentDepositVnd(totalVnd) {
  const value = BigInt(totalVnd);
  if (value <= 0n) return 0n;
  return (value + 5n) / 10n;
}

export function deriveHypotheticalCommissionVnd(baseVnd, rateBps = HYPOTHETICAL_HTX_COMMISSION_BPS) {
  const value = BigInt(baseVnd);
  if (value <= 0n) return 0n;
  return (value * BigInt(rateBps) + 5000n) / 10000n;
}

export function validateCallConfirmationInput(body) {
  const input = plainBody(body, ['note'], { allowAbsent: true });
  return { note: input.note === undefined ? null : boundedText(input.note) };
}

export function validateDepositReportInput(body) {
  const input = plainBody(body, ['reference', 'amountVnd']);
  if (typeof input.reference !== 'string' || !REFERENCE_PATTERN.test(input.reference)) {
    throw fail(400, 'VALIDATION_FAILED');
  }
  let amountVnd = null;
  if (input.amountVnd !== undefined) {
    if (typeof input.amountVnd !== 'string' || !VND_POSITIVE.test(input.amountVnd)) {
      throw fail(400, 'VALIDATION_FAILED');
    }
    amountVnd = input.amountVnd;
  }
  return { reference: input.reference, amountVnd };
}

export function validateCommissionQuery(query) {
  let window;
  try {
    window = parsePagination(query);
  } catch (error) {
    throw fail(error.status, error.code);
  }
  const from = query?.from !== undefined ? parseInstant(query.from) : null;
  const to = query?.to !== undefined ? parseInstant(query.to) : null;
  if (from && to && to <= from) throw fail(400, 'VALIDATION_FAILED');
  return { ...window, from, to };
}

function isDbUnavailable(error) {
  return DB_UNAVAILABLE_CODE.test(typeof error.code === 'string' ? error.code : '');
}

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

function callConfirmationDto(row) {
  if (!row) return null;
  return {
    packageId: row.package_id,
    confirmedAt: row.confirmed_at.toISOString(),
    note: row.note ?? null,
  };
}

function bankAccountDto(row) {
  if (!row) return null;
  return { bankBin: row.bank_bin, bankName: row.bank_name, accountNumber: row.account_number,
    accountHolder: row.account_holder, updatedAt: row.updated_at.toISOString() };
}

async function loadBankAccount(db, providerId) {
  const result = await db.query('SELECT * FROM dispatch.provider_bank_accounts WHERE provider_user_id = $1', [providerId]);
  return bankAccountDto(result.rows[0]);
}

function validateBankAccount(body) {
  const input = plainBody(body, ['bankBin', 'bankName', 'accountNumber', 'accountHolder']);
  if (typeof input.bankBin !== 'string' || !BANK_BIN.test(input.bankBin) ||
      typeof input.accountNumber !== 'string' || !ACCOUNT_NUMBER.test(input.accountNumber)) throw fail(400, 'VALIDATION_FAILED');
  const bankName = boundedText(input.bankName), accountHolder = boundedText(input.accountHolder);
  if ([bankName, accountHolder].some((text) => [...text].length > 120 || /\p{Cc}/u.test(text))) throw fail(400, 'VALIDATION_FAILED');
  return [input.bankBin, bankName, input.accountNumber, accountHolder];
}

async function loadHold(db, bookingId) {
  const { rows } = await db.query(`SELECT *, deposit_expires_at <= clock_timestamp() AS overdue
    FROM dispatch.deposit_holds WHERE booking_id = $1`, [bookingId]);
  return rows[0];
}

async function openDepositHold(db, bookingId, hours, existing) {
  if (existing) return existing;
  // Caller holds the booking lock. Start at the server clock after acquiring locks, never reset on refresh.
  const { rows } = await db.query(`INSERT INTO dispatch.deposit_holds (booking_id, deposit_expires_at)
    VALUES ($1, date_trunc('milliseconds', clock_timestamp()) + make_interval(hours => $2)) RETURNING *`, [bookingId, hours]);
  return rows[0];
}

function depositDto(row, events, hold) {
  if (!row) return null;
  const confirmed = events.find((e) => e.event_type === 'DEPOSIT_CONFIRMED');
  return {
    id: row.id,
    bookingId: row.booking_id,
    packageId: row.package_id,
    status: confirmed ? 'CONFIRMED' : hold?.overdue || hold?.deposit_expired_at ? 'EXPIRED' : 'REPORTED',
    expiresAt: hold?.deposit_expires_at.toISOString() ?? null,
    expiredAt: hold?.deposit_expired_at?.toISOString() ?? null,
    bookingTotalVnd: String(row.booking_total_vnd),
    depositRateBps: Number(row.deposit_rate_bps),
    depositRatePercent: 10,
    expectedDepositVnd: String(row.expected_deposit_vnd),
    amountVnd: String(row.amount_vnd),
    hypothetical: true,
    createdAt: row.created_at.toISOString(),
    confirmedAt: confirmed ? confirmed.created_at.toISOString() : null,
    events: events.map((e) => ({
      eventType: e.event_type,
      createdAt: e.created_at.toISOString(),
    })),
  };
}

async function loadDepositAndEvents(db, bookingId) {
  const { rows } = await db.query('SELECT * FROM dispatch.deposits WHERE booking_id = $1', [bookingId]);
  if (!rows[0]) return { row: null, events: [] };
  const ev = await db.query(
    'SELECT event_type, created_at FROM dispatch.deposit_events WHERE deposit_id = $1 ORDER BY id',
    [rows[0].id],
  );
  return { row: rows[0], events: ev.rows };
}

async function loadAccountingBreakdown(db, booking, depositRow, depositEvents, hold) {
  const acceptanceRes = await db.query(
    `SELECT a.version, a.total_vnd::text AS total_vnd
       FROM dispatch.acceptances a
      WHERE a.booking_id = $1
        AND (SELECT count(*) FROM dispatch.acceptance_consents c
              WHERE c.booking_id = a.booking_id AND c.version = a.version) = 2
      ORDER BY a.version DESC LIMIT 1`,
    [booking.id],
  );
  const agreed = acceptanceRes.rows[0] ?? null;

  const payRes = await db.query(
    `SELECT COALESCE(SUM(p.amount_vnd) FILTER (WHERE c.id IS NOT NULL), 0)::text AS confirmed,
            COALESCE(SUM(p.amount_vnd) FILTER (WHERE c.id IS NULL), 0)::text AS reported
       FROM dispatch.payments p
       LEFT JOIN dispatch.payment_events c ON c.payment_id = p.id AND c.event_type = 'PAYMENT_CONFIRMED'
      WHERE p.booking_id = $1`,
    [booking.id],
  );
  const confirmedFinal = BigInt(payRes.rows[0].confirmed);
  const reportedFinal = BigInt(payRes.rows[0].reported);

  const isDepositConfirmed = depositEvents.some((e) => e.event_type === 'DEPOSIT_CONFIRMED');
  const depositAmount = depositRow ? BigInt(depositRow.amount_vnd) : 0n;
  const confirmedDeposit = isDepositConfirmed ? depositAmount : 0n;
  const reportedDeposit = depositRow && !isDepositConfirmed && !hold?.deposit_expired_at ? depositAmount : 0n;

  const referenceTotal = BigInt(agreed ? agreed.total_vnd : booking.total_vnd);
  const totalConfirmed = confirmedDeposit + confirmedFinal;
  const totalReportedPending = reportedDeposit + reportedFinal;
  const remainingAfterConfirmed = referenceTotal > totalConfirmed ? referenceTotal - totalConfirmed : 0n;
  const remainingAvailableToReport = referenceTotal > (totalConfirmed + totalReportedPending)
    ? referenceTotal - totalConfirmed - totalReportedPending
    : 0n;
  const excessConfirmed = totalConfirmed > referenceTotal ? totalConfirmed - referenceTotal : 0n;

  return {
    referenceTotalVnd: referenceTotal.toString(),
    referenceTotalSource: agreed ? 'AGREED_ACCEPTANCE' : 'BOOKING_ESTIMATE_SNAPSHOT',
    confirmedDepositVnd: confirmedDeposit.toString(),
    reportedDepositVnd: reportedDeposit.toString(),
    confirmedFinalPaymentVnd: confirmedFinal.toString(),
    reportedFinalPaymentVnd: reportedFinal.toString(),
    totalConfirmedVnd: totalConfirmed.toString(),
    totalReportedPendingVnd: totalReportedPending.toString(),
    remainingAfterConfirmedVnd: remainingAfterConfirmed.toString(),
    remainingAvailableToReportVnd: remainingAvailableToReport.toString(),
    excessConfirmedVnd: excessConfirmed.toString(),
    settlementIntegrated: true,
    integrationNote: 'Cọc đã xác nhận được trừ khi quyết toán. Cọc chờ xác nhận chỉ giữ chỗ trong hạn mức ghi báo.',
  };
}

async function buildBookingDepositView(db, actor, bookingId) {
  const isFarmer = actor.roles.includes('farmer');
  const isCoop = actor.roles.includes('coop');
  const isProvider = actor.roles.includes('provider');

  const { rows } = await db.query(
    `SELECT b.id, b.owner_id, b.coordinator_id, b.state AS booking_state, b.total_vnd::text AS total_vnd,
            pb.package_id, p.status AS package_status, p.coop_id, p.provider_id,
            cc.confirmed_at AS call_confirmed_at, cc.note AS call_note
       FROM dispatch.bookings b
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       LEFT JOIN dispatch.packages p ON p.id = pb.package_id
       LEFT JOIN dispatch.package_call_confirmations cc ON cc.package_id = p.id
      WHERE b.id = $1
        AND (($3::boolean AND b.owner_id = $2)
          OR ($4::boolean AND (b.owner_id = $2 OR b.coordinator_id = $2 OR p.coop_id = $2))
          OR ($5::boolean AND p.provider_id = $2))`,
    [bookingId, actor.id, isFarmer, isCoop, isProvider],
  );
  const row = rows[0];
  if (!row) throw fail(404, 'NOT_FOUND');

  const expectedDepositVnd = deriveTenPercentDepositVnd(row.total_vnd);
  const { row: depositRow, events } = await loadDepositAndEvents(db, bookingId);
  const hold = await loadHold(db, bookingId);
  const accounting = await loadAccountingBreakdown(db, row, depositRow, events, hold);
  const blockedByDispute = await hasOpenDispute(db, bookingId);
  const htxConfirmed = Boolean(row.call_confirmed_at);

  const party = row.owner_id === actor.id
    ? 'owner'
    : row.provider_id === actor.id
      ? 'provider'
      : row.coop_id === actor.id || row.coordinator_id === actor.id
        ? 'coop'
        : null;

  let blockReason = null;
  if (hold?.deposit_expired_at || (hold?.overdue && !events.some((e) => e.event_type === 'DEPOSIT_CONFIRMED'))) blockReason = 'DEPOSIT_EXPIRED';
  else if (blockedByDispute) blockReason = 'DISPUTE_OPEN';
  else if (!row.package_id || row.booking_state !== 'ASSIGNED') blockReason = 'BOOKING_UNAVAILABLE';
  else if (row.package_status !== 'CLAIMED') blockReason = 'PACKAGE_NOT_CLAIMED';
  else if (row.owner_id === row.provider_id) blockReason = 'PARTY_CONFLICT';
  else if (expectedDepositVnd <= 0n) blockReason = 'DEPOSIT_NOT_APPLICABLE';
  else if (!htxConfirmed) blockReason = 'HTX_CALL_NOT_CONFIRMED';

  const depositView = depositDto(depositRow, events, hold);
  let reportBlock = blockReason;
  if (!reportBlock && !depositView) {
    try { await assertFieldInspectionPassedForBooking(db, bookingId); } catch (error) {
      if (!(error instanceof FieldInspectionError)) throw error;
      reportBlock = error.code;
    }
    if (!reportBlock && !(await loadBankAccount(db, row.provider_id))) reportBlock = 'PROVIDER_BANK_ACCOUNT_REQUIRED';
  }
  const canReport = party === 'owner'
    && (isFarmer || isCoop)
    && !reportBlock
    && !depositView
    && BigInt(accounting.remainingAvailableToReportVnd) >= expectedDepositVnd;
  const canConfirm = party === 'provider'
    && isProvider
    && !blockReason
    && depositView?.status === 'REPORTED';

  return {
    bookingId: row.id,
    packageId: row.package_id ?? null,
    packageStatus: row.package_status ?? null,
    bookingState: row.booking_state,
    snapshot: {
      bookingTotalVnd: row.total_vnd,
      depositRateBps: DEPOSIT_RATE_BPS,
      depositRatePercent: 10,
      expectedDepositVnd: expectedDepositVnd.toString(),
      hypothetical: true,
      simulated: false,
      notice: DEPOSIT_NOTICE,
    },
    htxCallConfirmation: row.package_id
      ? {
        confirmed: htxConfirmed,
        packageId: row.package_id,
        confirmedAt: row.call_confirmed_at ? row.call_confirmed_at.toISOString() : null,
        note: row.call_note ?? null,
      }
      : null,
    deposit: depositView,
    expiresAt: hold?.deposit_expires_at.toISOString() ?? null,
    expiredAt: hold?.deposit_expired_at?.toISOString() ?? null,
    releaseReason: hold?.release_reason ?? null,
    permissions: {
      party,
      canReport,
      canConfirm,
      blockedByDispute,
      blockReason: reportBlock,
    },
    accounting,
  };
}

async function confirmHtxPackageCall(pool, actor, packageId, input) {
  return transaction(pool, async (client) => {
    const pkgRes = await client.query('SELECT id, coop_id, status FROM dispatch.packages WHERE id = $1 FOR UPDATE', [packageId]);
    const pkg = pkgRes.rows[0];
    if (!pkg || pkg.coop_id !== actor.id) throw fail(404, 'NOT_FOUND');
    if (pkg.status !== 'CLAIMED') throw fail(409, 'PACKAGE_NOT_CLAIMED');

    const disputeRes = await client.query(
      `SELECT 1 FROM dispatch.package_bookings pb
         JOIN dispatch.disputes d ON d.booking_id = pb.booking_id
        WHERE pb.package_id = $1 AND d.status IN ('OPEN', 'CLOSED_UNRESOLVED') LIMIT 1`,
      [packageId],
    );
    if (disputeRes.rowCount > 0) throw fail(409, 'DISPUTE_OPEN');

    const existing = await client.query(
      'SELECT package_id, coop_id, note, confirmed_at FROM dispatch.package_call_confirmations WHERE package_id = $1',
      [packageId],
    );
    if (existing.rows[0]) {
      if ((existing.rows[0].note ?? null) !== input.note) throw fail(409, 'CALL_CONFIRMATION_CONFLICT');
      return { status: 200, body: { callConfirmation: callConfirmationDto(existing.rows[0]) } };
    }

    const inserted = await client.query(
      `INSERT INTO dispatch.package_call_confirmations (package_id, coop_id, note)
       VALUES ($1, $2, $3) RETURNING package_id, coop_id, note, confirmed_at`,
      [packageId, actor.id, input.note],
    );
    return { status: 201, body: { callConfirmation: callConfirmationDto(inserted.rows[0]) } };
  });
}

async function lockDepositPayer(client, actor, bookingId) {
  // Lock package first, then booking, as in shift and scheduling writers.
  const meta = await client.query(
    `SELECT b.id, b.owner_id, pb.package_id
       FROM dispatch.bookings b
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
      WHERE b.id = $1 AND b.owner_id = $2`,
    [bookingId, actor.id],
  );
  if (!meta.rows[0]) throw fail(404, 'NOT_FOUND');

  const packageId = meta.rows[0].package_id;
  let pkg = null;
  if (packageId) {
    pkg = (await client.query('SELECT id, status, provider_id FROM dispatch.packages WHERE id = $1 FOR UPDATE', [packageId])).rows[0];
  }
  const booking = (await client.query(
    'SELECT id, owner_id, state, total_vnd::text AS total_vnd FROM dispatch.bookings WHERE id = $1 AND owner_id = $2 FOR UPDATE',
    [bookingId, actor.id],
  )).rows[0];
  if (!booking) throw fail(404, 'NOT_FOUND');

  const hold = await loadHold(client, bookingId);
  if (hold?.overdue || hold?.deposit_expired_at) throw fail(409, 'DEPOSIT_EXPIRED');
  if (await hasOpenDispute(client, bookingId)) throw fail(409, 'DISPUTE_OPEN');
  if (!pkg || booking.state !== 'ASSIGNED') throw fail(409, 'BOOKING_UNAVAILABLE');
  if (pkg.status !== 'CLAIMED' || !pkg.provider_id) throw fail(409, 'PACKAGE_NOT_CLAIMED');
  if (pkg.provider_id === booking.owner_id) throw fail(409, 'PARTY_CONFLICT');

  const expectedDepositVnd = deriveTenPercentDepositVnd(booking.total_vnd);
  if (expectedDepositVnd <= 0n) throw fail(409, 'DEPOSIT_NOT_APPLICABLE');

  const callConf = await client.query(
    'SELECT package_id FROM dispatch.package_call_confirmations WHERE package_id = $1',
    [packageId],
  );
  if (!callConf.rows[0]) throw fail(409, 'HTX_CALL_NOT_CONFIRMED');
  await assertFieldInspectionPassedForBooking(client, bookingId);
  return { booking, pkg, packageId, hold, expectedDepositVnd };
}

async function issueBookingVietqr(pool, actor, bookingId, hours) {
  return transaction(pool, async (client) => {
    const { booking, pkg, packageId, hold, expectedDepositVnd } = await lockDepositPayer(client, actor, bookingId);
    if ((await client.query('SELECT 1 FROM dispatch.deposits WHERE booking_id = $1', [bookingId])).rowCount) {
      throw fail(409, 'DEPOSIT_ALREADY_EXISTS');
    }
    const bank = await loadBankAccount(client, pkg.provider_id);
    if (!bank) throw fail(409, 'PROVIDER_BANK_ACCOUNT_REQUIRED');
    const accounting = await loadAccountingBreakdown(client, booking, null, []);
    if (BigInt(accounting.remainingAvailableToReportVnd) < expectedDepositVnd) throw fail(409, 'AMOUNT_EXCEEDS_OUTSTANDING');
    const description = vietqrDescription(`COC ${bookingId.replaceAll('-', '').slice(0, 20)}`);
    const amountVnd = expectedDepositVnd.toString();
    const payload = buildVietqrPayload({ ...bank, amountVnd, description });
    const svg = renderQrSvg(payload);
    const currentHold = hold && await loadHold(client, bookingId);
    if (currentHold?.overdue) throw fail(409, 'DEPOSIT_EXPIRED');
    const window = await openDepositHold(client, bookingId, hours, currentHold);
    return { noStore: true, body: { bookingId, packageId, expiresAt: window.deposit_expires_at.toISOString(),
      vietqr: { bankBin: bank.bankBin, bankName: bank.bankName, accountNumber: bank.accountNumber,
        accountHolder: bank.accountHolder, amountVnd, description, payload, svg, notice: VIETQR_NOTICE } } };
  });
}

async function reportBookingDeposit(pool, actor, bookingId, input, hours) {
  return transaction(pool, async (client) => {
    const { booking, pkg, packageId, hold, expectedDepositVnd } = await lockDepositPayer(client, actor, bookingId);
    if (input.amountVnd !== null && input.amountVnd !== expectedDepositVnd.toString()) {
      throw fail(409, 'DEPOSIT_AMOUNT_MISMATCH');
    }

    const existing = await client.query('SELECT * FROM dispatch.deposits WHERE booking_id = $1', [bookingId]);
    if (existing.rows[0]) {
      if (existing.rows[0].reference !== input.reference) throw fail(409, 'DEPOSIT_ALREADY_EXISTS');
      return { status: 200, noStore: true, body: await buildBookingDepositView(client, actor, bookingId) };
    }
    if (!(await loadBankAccount(client, pkg.provider_id))) throw fail(409, 'PROVIDER_BANK_ACCOUNT_REQUIRED');
    const payment = await client.query('SELECT 1 FROM dispatch.payments WHERE booking_id = $1 AND reference = $2', [bookingId, input.reference]);
    if (payment.rowCount) throw fail(409, 'REFERENCE_CONFLICT');

    const accounting = await loadAccountingBreakdown(client, booking, null, []);
    if (BigInt(accounting.remainingAvailableToReportVnd) < expectedDepositVnd) {
      throw fail(409, 'AMOUNT_EXCEEDS_OUTSTANDING');
    }

    await openDepositHold(client, bookingId, hours, hold);
    const inserted = await client.query(
      `INSERT INTO dispatch.deposits
         (booking_id, package_id, payer_id, payee_id, booking_total_vnd, deposit_rate_bps, expected_deposit_vnd, amount_vnd, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        bookingId,
        packageId,
        actor.id,
        pkg.provider_id,
        booking.total_vnd,
        DEPOSIT_RATE_BPS,
        expectedDepositVnd.toString(),
        expectedDepositVnd.toString(),
        input.reference,
      ],
    );
    await client.query(
      "INSERT INTO dispatch.deposit_events (deposit_id, event_type, actor_id) VALUES ($1, 'DEPOSIT_REPORTED', $2)",
      [inserted.rows[0].id, actor.id],
    );

    return { status: 201, noStore: true, body: await buildBookingDepositView(client, actor, bookingId) };
  });
}

async function confirmBookingDeposit(pool, actor, depositId) {
  return transaction(pool, async (client) => {
    const target = await client.query(
      `SELECT d.booking_id, d.package_id
         FROM dispatch.deposits d
         JOIN dispatch.packages p ON p.id = d.package_id
        WHERE d.id = $1 AND d.payee_id = $2 AND p.provider_id = $2`,
      [depositId, actor.id],
    );
    if (!target.rows[0]) throw fail(404, 'NOT_FOUND');

    const { booking_id: bookingId, package_id: packageId } = target.rows[0];
    const pkg = (await client.query('SELECT status, provider_id FROM dispatch.packages WHERE id = $1 FOR UPDATE', [packageId])).rows[0];
    const booking = (await client.query('SELECT state, owner_id FROM dispatch.bookings WHERE id = $1 FOR UPDATE', [bookingId])).rows[0];
    if (!pkg || pkg.provider_id !== actor.id || !booking) throw fail(404, 'NOT_FOUND');

    if (booking.owner_id === actor.id) throw fail(409, 'PARTY_CONFLICT');
    if (await hasOpenDispute(client, bookingId)) throw fail(409, 'DISPUTE_OPEN');
    const done = await client.query(
      "SELECT 1 FROM dispatch.deposit_events WHERE deposit_id = $1 AND event_type = 'DEPOSIT_CONFIRMED'",
      [depositId],
    );
    if (!done.rowCount) {
      const hold = await loadHold(client, bookingId);
      if (hold?.overdue || hold?.deposit_expired_at) throw fail(409, 'DEPOSIT_EXPIRED');
      if (pkg.status !== 'CLAIMED' || booking.state !== 'ASSIGNED') throw fail(409, 'PACKAGE_NOT_CLAIMED');
      await client.query(
        "INSERT INTO dispatch.deposit_events (deposit_id, event_type, actor_id, created_at) VALUES ($1, 'DEPOSIT_CONFIRMED', $2, clock_timestamp())",
        [depositId, actor.id],
      );
    }
    return { status: 200, noStore: true, body: await buildBookingDepositView(client, actor, bookingId) };
  });
}

// Internal maintenance entrypoint: one transaction, same package-then-booking lock order as writers.
export async function expireOverdueDeposits(pool, now = null) {
  return transaction(pool, async (client) => {
    const { rows: [{ cutoff }] } = await client.query('SELECT COALESCE($1::timestamptz, clock_timestamp())::text AS cutoff', [now]);
    const { rows: packages } = await client.query(`SELECT p.id, p.status FROM dispatch.packages p
      WHERE EXISTS (SELECT 1 FROM dispatch.package_bookings pb JOIN dispatch.deposit_holds h USING (booking_id)
        WHERE pb.package_id = p.id AND h.deposit_expired_at IS NULL AND h.deposit_expires_at <= $1
          AND NOT EXISTS (SELECT 1 FROM dispatch.deposits d JOIN dispatch.deposit_events e ON e.deposit_id = d.id
            WHERE d.booking_id = pb.booking_id AND e.event_type = 'DEPOSIT_CONFIRMED'))
      ORDER BY p.id FOR UPDATE OF p SKIP LOCKED`, [cutoff]);
    const expired = [];
    for (const pkg of packages) {
      const { rows: locked } = await client.query(`SELECT b.id FROM dispatch.package_bookings pb
        JOIN dispatch.bookings b ON b.id = pb.booking_id JOIN dispatch.deposit_holds h ON h.booking_id = b.id
        WHERE pb.package_id = $1 AND h.deposit_expired_at IS NULL AND h.deposit_expires_at <= $2
        ORDER BY b.id FOR UPDATE OF b SKIP LOCKED`, [pkg.id, cutoff]);
      if (!locked.length) continue;
      // Fresh statement after locking: a receipt committed while selecting candidates wins.
      const { rows: released } = await client.query(`UPDATE dispatch.deposit_holds h
        SET deposit_expired_at = $2, release_reason = 'DEPOSIT_EXPIRED'
        WHERE booking_id = ANY($1::uuid[]) AND NOT EXISTS (
          SELECT 1 FROM dispatch.deposits d JOIN dispatch.deposit_events e ON e.deposit_id = d.id
          WHERE d.booking_id = h.booking_id AND e.event_type = 'DEPOSIT_CONFIRMED') RETURNING booking_id`,
      [locked.map(({ id }) => id), cutoff]);
      if (!released.length) continue;
      const ids = released.map(({ booking_id }) => booking_id);
      expired.push(...ids);
      // A running or completed shift already consumed the reservation. Expire only the unpaid hold there.
      if (pkg.status !== 'CLAIMED' || (await client.query('SELECT 1 FROM dispatch.shifts WHERE package_id = $1', [pkg.id])).rowCount) continue;
      await client.query(`WITH cancelled AS (
        UPDATE dispatch.bookings SET state = 'CANCELLED' WHERE id = ANY($1::uuid[]) AND state = 'ASSIGNED' RETURNING id
      ) INSERT INTO dispatch.booking_events (booking_id, event_type, to_state, created_at)
        SELECT id, 'BOOKING_DEPOSIT_EXPIRED', 'CANCELLED', $2 FROM cancelled`, [ids, cutoff]);
      const { rowCount: live } = await client.query(`SELECT 1 FROM dispatch.package_bookings pb
        JOIN dispatch.bookings b ON b.id = pb.booking_id WHERE pb.package_id = $1 AND b.state = 'ASSIGNED' LIMIT 1`, [pkg.id]);
      if (!live) {
        await client.query("UPDATE dispatch.packages SET status = 'CANCELLED', cancellation_reason = 'DEPOSIT_EXPIRED' WHERE id = $1", [pkg.id]);
        await client.query('UPDATE dispatch.allocations SET released_at = $2 WHERE package_id = $1 AND released_at IS NULL', [pkg.id, cutoff]);
      }
    }
    return expired;
  });
}

// Pure server-side phase/clock simulation helpers (no DB writes, no real GPS coordinates).
export function computeActiveElapsedSeconds(events, serverNowMs) {
  let totalMs = 0;
  let runningSinceMs = null;
  for (const event of events) {
    const ts = event.created_at instanceof Date ? event.created_at.getTime() : new Date(event.created_at).getTime();
    if (event.event_type === 'SHIFT_STARTED' || event.event_type === 'SHIFT_RESUMED') {
      if (runningSinceMs === null) runningSinceMs = ts;
    } else if (event.event_type === 'SHIFT_PAUSED' || event.event_type === 'SHIFT_COMPLETED') {
      if (runningSinceMs !== null) {
        totalMs += Math.max(0, ts - runningSinceMs);
        runningSinceMs = null;
      }
    }
  }
  if (runningSinceMs !== null) {
    totalMs += Math.max(0, serverNowMs - runningSinceMs);
  }
  return Math.floor(totalMs / 1000);
}

export function buildSimulatedTelemetry({
  scope,
  packageId,
  bookingId = null,
  shiftId = null,
  packageStatus,
  shiftStatus = null,
  machineType = null,
  serviceCode,
  windowStartAt,
  windowEndAt,
  scopeAreaM2,
  shiftAreaM2 = null,
  events = [],
  serverNow = new Date(),
}) {
  const serverNowMs = serverNow instanceof Date ? serverNow.getTime() : new Date(serverNow).getTime();
  const phase = packageStatus === 'CANCELLED'
    ? 'CANCELLED'
    : packageStatus === 'OPEN'
      ? 'OPEN'
      : shiftStatus ?? 'CLAIMED_PRE_SHIFT';

  const activeElapsedSeconds = shiftId ? computeActiveElapsedSeconds(events, serverNowMs) : 0;
  const windowDurationSec = Math.max(600, Math.floor((new Date(windowEndAt).getTime() - new Date(windowStartAt).getTime()) / 1000));
  const rawProgress = phase === 'COMPLETED'
    ? 1
    : phase === 'RUNNING' || phase === 'PAUSED'
      ? Math.min(0.95, Math.max(0.02, activeElapsedSeconds / windowDurationSec))
      : 0;
  const progressRatioSimulated = Number(rawProgress.toFixed(4));

  const speedProfiles = {
    harvester: { base: 4.8, amp: 0.6, rpmBase: 710, rpmAmp: 25 },
    tractor: { base: 6.6, amp: 0.8, rpmBase: 540, rpmAmp: 15 },
    drone: { base: 20.0, amp: 2.0, rpmBase: 3400, rpmAmp: 150 },
  };
  const profile = speedProfiles[machineType] ?? { base: 5.0, amp: 0.5, rpmBase: 600, rpmAmp: 20 };

  const isRunning = phase === 'RUNNING';
  const wave = Math.sin(activeElapsedSeconds / 17);
  const speedKmh = isRunning ? Number((profile.base + profile.amp * wave).toFixed(2)) : 0;
  const implementRpm = isRunning ? Math.round(profile.rpmBase + profile.rpmAmp * Math.cos(activeElapsedSeconds / 13)) : 0;
  const fuelPercentSimulated = Math.max(15, Math.round(92 - Math.min(70, activeElapsedSeconds / 180)));

  // Schematic back-and-forth boustrophedon pass on normalized [0..100] x [0..100] grid.
  const passCount = 5;
  const scaled = progressRatioSimulated * passCount;
  const passIndex = Math.min(passCount - 1, Math.floor(scaled));
  const passFraction = scaled - passIndex;
  const forward = passIndex % 2 === 0;
  const x = phase === 'OPEN' || phase === 'CANCELLED' || phase === 'CLAIMED_PRE_SHIFT'
    ? 0
    : Number(((forward ? passFraction : 1 - passFraction) * 100).toFixed(2));
  const y = phase === 'OPEN' || phase === 'CANCELLED' || phase === 'CLAIMED_PRE_SHIFT'
    ? 0
    : Number((((passIndex + 0.5) / passCount) * 100).toFixed(2));
  const headingDeg = isRunning ? (forward ? 90 : 270) : 0;

  return {
    simulation: {
      simulated: true,
      source: 'SERVER_CLOCK_PHASE_SIMULATION',
      realDeviceTelemetry: false,
      measuredCoordinatesAvailable: false,
      notice: TELEMETRY_NOTICE,
    },
    scope,
    serverTime: new Date(serverNowMs).toISOString(),
    packageId,
    ...(bookingId ? { bookingId } : {}),
    shiftId,
    phase,
    serviceCode,
    machineType,
    metrics: {
      simulated: true,
      activeElapsedSeconds,
      speedKmh,
      cutterBarRpm: implementRpm,
      implementActive: isRunning,
      fuelPercentSimulated,
      progressRatioSimulated,
      scopeAreaM2,
      simulatedWorkedAreaM2: Math.round(scopeAreaM2 * progressRatioSimulated),
      actualCompletedAreaM2: phase === 'COMPLETED' ? shiftAreaM2 : null,
    },
    syntheticTrack: {
      coordSpace: 'SYNTHETIC_LOCAL_GRID_0_100',
      realGpsCoordinates: false,
      x,
      y,
      headingDeg,
    },
  };
}

async function readTelemetryForPackage(pool, actor, packageId) {
  const isOperator = actor.roles.includes('operator');
  const isCoop = actor.roles.includes('coop');
  const isProvider = actor.roles.includes('provider');
  const pkgRes = await pool.query(
    `SELECT p.id, p.status, p.window_start_at, p.window_end_at,
            sv.code AS service_code, m.machine_type,
            s.id AS shift_id, s.status AS shift_status, s.area_m2 AS shift_area_m2,
            (SELECT COALESCE(SUM(b.field_area_m2), 0)::int
               FROM dispatch.package_bookings pb
               JOIN dispatch.bookings b ON b.id = pb.booking_id
              WHERE pb.package_id = p.id) AS total_area_m2,
            now() AS server_now
       FROM dispatch.packages p
       JOIN dispatch.services sv ON sv.id = p.service_id
       LEFT JOIN dispatch.machines m ON m.id = p.machine_id
       LEFT JOIN dispatch.shifts s ON s.package_id = p.id
      WHERE p.id = $1
        AND (($3::boolean AND p.operator_id = $2)
          OR ($4::boolean AND p.coop_id = $2)
          OR ($5::boolean AND p.provider_id = $2))`,
    [packageId, actor.id, isOperator, isCoop, isProvider],
  );
  const row = pkgRes.rows[0];
  if (!row) throw fail(404, 'NOT_FOUND');

  const events = row.shift_id
    ? (await pool.query(
      'SELECT event_type, created_at FROM dispatch.shift_events WHERE shift_id = $1 ORDER BY sequence',
      [row.shift_id],
    )).rows
    : [];

  return buildSimulatedTelemetry({
    scope: 'package',
    packageId: row.id,
    shiftId: row.shift_id ?? null,
    packageStatus: row.status,
    shiftStatus: row.shift_status ?? null,
    machineType: row.machine_type ?? null,
    serviceCode: row.service_code,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    scopeAreaM2: row.total_area_m2,
    shiftAreaM2: row.shift_area_m2 ?? null,
    events,
    serverNow: row.server_now,
  });
}

async function readTelemetryForShift(pool, actor, shiftId) {
  const isOperator = actor.roles.includes('operator');
  const isCoop = actor.roles.includes('coop');
  const isProvider = actor.roles.includes('provider');
  const shiftRes = await pool.query(
    `SELECT s.id AS shift_id, s.status AS shift_status, s.area_m2 AS shift_area_m2,
            p.id AS package_id, p.status AS package_status, p.window_start_at, p.window_end_at,
            sv.code AS service_code, m.machine_type,
            (SELECT COALESCE(SUM(b.field_area_m2), 0)::int
               FROM dispatch.package_bookings pb
               JOIN dispatch.bookings b ON b.id = pb.booking_id
              WHERE pb.package_id = p.id) AS total_area_m2,
            now() AS server_now
       FROM dispatch.shifts s
       JOIN dispatch.packages p ON p.id = s.package_id
       JOIN dispatch.services sv ON sv.id = p.service_id
       LEFT JOIN dispatch.machines m ON m.id = p.machine_id
      WHERE s.id = $1
        AND (($3::boolean AND p.operator_id = $2)
          OR ($4::boolean AND p.coop_id = $2)
          OR ($5::boolean AND p.provider_id = $2))`,
    [shiftId, actor.id, isOperator, isCoop, isProvider],
  );
  const row = shiftRes.rows[0];
  if (!row) throw fail(404, 'NOT_FOUND');

  const events = (await pool.query(
    'SELECT event_type, created_at FROM dispatch.shift_events WHERE shift_id = $1 ORDER BY sequence',
    [row.shift_id],
  )).rows;

  return buildSimulatedTelemetry({
    scope: 'shift',
    packageId: row.package_id,
    shiftId: row.shift_id,
    packageStatus: row.package_status,
    shiftStatus: row.shift_status,
    machineType: row.machine_type ?? null,
    serviceCode: row.service_code,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    scopeAreaM2: row.total_area_m2,
    shiftAreaM2: row.shift_area_m2 ?? null,
    events,
    serverNow: row.server_now,
  });
}

async function readTelemetryForBooking(pool, actor, bookingId) {
  const isFarmer = actor.roles.includes('farmer');
  const isCoop = actor.roles.includes('coop');
  const isProvider = actor.roles.includes('provider');
  const bkRes = await pool.query(
    `SELECT b.id AS booking_id, b.state AS booking_state, b.field_area_m2, b.service_code,
            b.start_at, b.end_at,
            p.id AS package_id, p.status AS package_status, p.window_start_at, p.window_end_at,
            m.machine_type,
            s.id AS shift_id, s.status AS shift_status, s.area_m2 AS shift_area_m2,
            now() AS server_now
       FROM dispatch.bookings b
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       LEFT JOIN dispatch.packages p ON p.id = pb.package_id
       LEFT JOIN dispatch.machines m ON m.id = p.machine_id
       LEFT JOIN dispatch.shifts s ON s.package_id = p.id
      WHERE b.id = $1
        AND (($3::boolean AND b.owner_id = $2)
          OR ($4::boolean AND (b.owner_id = $2 OR b.coordinator_id = $2 OR p.coop_id = $2))
          OR ($5::boolean AND p.provider_id = $2))`,
    [bookingId, actor.id, isFarmer, isCoop, isProvider],
  );
  const row = bkRes.rows[0];
  if (!row) throw fail(404, 'NOT_FOUND');

  const events = row.shift_id
    ? (await pool.query(
      'SELECT event_type, created_at FROM dispatch.shift_events WHERE shift_id = $1 ORDER BY sequence',
      [row.shift_id],
    )).rows
    : [];

  return buildSimulatedTelemetry({
    scope: 'booking',
    packageId: row.package_id ?? null,
    bookingId: row.booking_id,
    shiftId: row.shift_id ?? null,
    packageStatus: row.package_status ?? (row.booking_state === 'CANCELLED' ? 'CANCELLED' : 'OPEN'),
    shiftStatus: row.shift_status ?? null,
    machineType: row.machine_type ?? null,
    serviceCode: row.service_code,
    windowStartAt: row.window_start_at ?? row.start_at,
    windowEndAt: row.window_end_at ?? row.end_at,
    scopeAreaM2: row.field_area_m2,
    shiftAreaM2: row.shift_area_m2 ?? null,
    events,
    serverNow: row.server_now,
  });
}

async function listHtxCommissionEstimates(pool, actor, query) {
  const { limit, offset, from, to } = validateCommissionQuery(query);
  const fromIso = from ? from.toISOString() : null;
  const toIso = to ? to.toISOString() : null;

  const scopeWhere = `
    (b.coordinator_id = $1 OR p.coop_id = $1)
    AND ($2::timestamptz IS NULL OR b.created_at >= $2::timestamptz)
    AND ($3::timestamptz IS NULL OR b.created_at < $3::timestamptz)
  `;

  const baseSelect = `
    SELECT b.id AS booking_id, b.state AS booking_state, b.field_area_m2, b.service_code,
           b.total_vnd::text AS booking_total_vnd, b.created_at,
           f.locality,
           p.id AS package_id, p.status AS package_status,
           acc.total_vnd::text AS agreed_total_vnd,
           COALESCE((SELECT d.amount_vnd FROM dispatch.deposits d
                       JOIN dispatch.deposit_events de ON de.deposit_id = d.id AND de.event_type = 'DEPOSIT_CONFIRMED'
                      WHERE d.booking_id = b.id), 0)::text AS confirmed_deposit_vnd,
           COALESCE((SELECT SUM(py.amount_vnd) FROM dispatch.payments py
                       JOIN dispatch.payment_events pe ON pe.payment_id = py.id AND pe.event_type = 'PAYMENT_CONFIRMED'
                      WHERE py.booking_id = b.id), 0)::text AS confirmed_final_vnd,
           EXISTS (SELECT 1 FROM dispatch.disputes dp
                    WHERE dp.booking_id = b.id AND dp.status IN ('OPEN', 'CLOSED_UNRESOLVED')) AS has_open_dispute
      FROM dispatch.bookings b
      JOIN dispatch.fields f ON f.id = b.field_id AND f.owner_id = b.owner_id
      LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
      LEFT JOIN dispatch.packages p ON p.id = pb.package_id
      LEFT JOIN LATERAL (
        SELECT a.total_vnd
          FROM dispatch.acceptances a
         WHERE a.booking_id = b.id
           AND (SELECT count(*) FROM dispatch.acceptance_consents c
                 WHERE c.booking_id = a.booking_id AND c.version = a.version) = 2
         ORDER BY a.version DESC LIMIT 1
      ) acc ON true
     WHERE ${scopeWhere}
  `;

  const summaryRes = await pool.query(
    `SELECT count(*)::int AS scoped_count,
            count(*) FILTER (WHERE acc.total_vnd IS NOT NULL)::int AS agreed_count,
            COALESCE(SUM(
              CASE
                WHEN b.state = 'CANCELLED' OR p.status = 'CANCELLED' OR acc.total_vnd IS NULL THEN 0
                ELSE floor((acc.total_vnd::numeric * $4 + 5000) / 10000)
              END
            ), 0)::bigint::text AS total_on_agreed,
            COALESCE(SUM(
              CASE
                WHEN b.state = 'CANCELLED' OR p.status = 'CANCELLED' THEN 0
                ELSE floor((COALESCE(acc.total_vnd, b.total_vnd)::numeric * $4 + 5000) / 10000)
              END
            ), 0)::bigint::text AS total_all_non_cancelled,
            COALESCE(SUM(
              COALESCE((SELECT d.amount_vnd FROM dispatch.deposits d
                          JOIN dispatch.deposit_events de ON de.deposit_id = d.id AND de.event_type = 'DEPOSIT_CONFIRMED'
                         WHERE d.booking_id = b.id), 0)
              + COALESCE((SELECT SUM(py.amount_vnd) FROM dispatch.payments py
                            JOIN dispatch.payment_events pe ON pe.payment_id = py.id AND pe.event_type = 'PAYMENT_CONFIRMED'
                           WHERE py.booking_id = b.id), 0)
            ), 0)::bigint::text AS total_confirmed_customer_payments
       FROM dispatch.bookings b
       LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
       LEFT JOIN dispatch.packages p ON p.id = pb.package_id
       LEFT JOIN LATERAL (
         SELECT a.total_vnd
           FROM dispatch.acceptances a
          WHERE a.booking_id = b.id
            AND (SELECT count(*) FROM dispatch.acceptance_consents c
                  WHERE c.booking_id = a.booking_id AND c.version = a.version) = 2
          ORDER BY a.version DESC LIMIT 1
       ) acc ON true
      WHERE ${scopeWhere}`,
    [actor.id, fromIso, toIso, HYPOTHETICAL_HTX_COMMISSION_BPS],
  );
  const sum = summaryRes.rows[0];

  const pageRes = await pool.query(
    `${baseSelect} ORDER BY b.created_at DESC, b.id DESC LIMIT $4 OFFSET $5`,
    [actor.id, fromIso, toIso, limit, offset],
  );

  const items = pageRes.rows.map((row) => {
    const isCancelled = row.booking_state === 'CANCELLED' || row.package_status === 'CANCELLED';
    const hasAgreed = row.agreed_total_vnd !== null;
    const baseVnd = hasAgreed ? row.agreed_total_vnd : row.booking_total_vnd;
    const estCommission = isCancelled ? 0n : deriveHypotheticalCommissionVnd(baseVnd);
    const confirmedDeposit = BigInt(row.confirmed_deposit_vnd);
    const confirmedFinal = BigInt(row.confirmed_final_vnd);
    const confirmedCustomerTotal = confirmedDeposit + confirmedFinal;

    return {
      bookingId: row.booking_id,
      packageId: row.package_id ?? null,
      packageStatus: row.package_status ?? null,
      bookingState: row.booking_state,
      locality: row.locality,
      serviceCode: row.service_code,
      areaM2: row.field_area_m2,
      createdAt: row.created_at.toISOString(),
      bookingSnapshotTotalVnd: row.booking_total_vnd,
      agreedAcceptanceTotalVnd: row.agreed_total_vnd ?? null,
      confirmedDepositVnd: confirmedDeposit.toString(),
      confirmedFinalPaymentVnd: confirmedFinal.toString(),
      confirmedCustomerTotalVnd: confirmedCustomerTotal.toString(),
      hasOpenDispute: row.has_open_dispute,
      hypothetical: true,
      approvedPolicy: false,
      payable: false,
      hypotheticalRateBps: HYPOTHETICAL_HTX_COMMISSION_BPS,
      hypotheticalRatePercent: 3,
      hypotheticalBaseVnd: isCancelled ? '0' : baseVnd,
      hypotheticalBaseSource: isCancelled
        ? 'CANCELLED_EXCLUDED'
        : hasAgreed
          ? 'AGREED_ACCEPTANCE'
          : 'BOOKING_ESTIMATE_SNAPSHOT',
      hypotheticalCommissionVnd: estCommission.toString(),
      owedVnd: '0',
      paidVnd: '0',
    };
  });

  return {
    summary: {
      hypothetical: true,
      approvedPolicy: false,
      payable: false,
      hypotheticalRateBps: HYPOTHETICAL_HTX_COMMISSION_BPS,
      hypotheticalRatePercent: 3,
      periodFrom: fromIso,
      periodTo: toIso,
      scopedBookingCount: sum.scoped_count,
      agreedAcceptanceCount: sum.agreed_count,
      totalHypotheticalCommissionOnAgreedVnd: sum.total_on_agreed,
      totalHypotheticalCommissionAllNonCancelledVnd: sum.total_all_non_cancelled,
      totalConfirmedCustomerPaymentsVnd: sum.total_confirmed_customer_payments,
      owedToHtxVnd: '0',
      paidToHtxVnd: '0',
      notice: COMMISSION_NOTICE,
    },
    items,
    limit,
    offset,
  };
}

export function createLocalServiceExtensionsRouter({ pool, authenticate, depositExpiryHours = readDepositExpiryHours() }) {
  if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function') {
    throw new TypeError('createLocalServiceExtensionsRouter requires a pool with query() and connect()');
  }
  if (typeof authenticate !== 'function') {
    throw new TypeError('createLocalServiceExtensionsRouter requires an authenticate middleware');
  }

  if (!Number.isInteger(depositExpiryHours) || depositExpiryHours < 1 || depositExpiryHours > 720) throw new RangeError('Invalid depositExpiryHours');
  const router = express.Router();

  function handle(roles, work) {
    return async (req, res, next) => {
      try {
        const actor = req.actor;
        if (!actor || !isUuid(actor.id) || !Array.isArray(actor.roles)) throw fail(401, 'UNAUTHENTICATED');
        if (!actor.roles.some((role) => roles.includes(role))) throw fail(403, 'FORBIDDEN');
        const { status = 200, body, noStore = false } = await work(req);
        if (noStore) res.set('Cache-Control', 'no-store');
        return res.status(status).json(body);
      } catch (error) {
        if (error instanceof FieldInspectionError) return res.status(409).json({ error: { code: error.code, message: error.message } });
        if (error instanceof ApiError) return res.status(error.status).json({ error: { code: error.code } });
        if (error.constraint === 'deposit_deadline') return res.status(409).json({ error: { code: 'DEPOSIT_EXPIRED' } });
        if (error.code === RESTRICT_VIOLATION) return res.status(409).json({ error: { code: 'STATE_CHANGED' } });
        if (isDbUnavailable(error)) return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
        return next(error);
      }
    };
  }

  router.get('/api/provider/bank-account', authenticate, handle(['provider'], async (req) => {
    if (Object.keys(req.query).length) throw fail(403, 'FORBIDDEN');
    return { noStore: true, body: { bankAccount: await loadBankAccount(pool, req.actor.id) } };
  }));

  router.put('/api/provider/bank-account', authenticate, handle(['provider'], async (req) => {
    if (Object.keys(req.query).length || Object.hasOwn(req.body ?? {}, 'providerUserId') ||
        Object.hasOwn(req.body ?? {}, 'provider_user_id')) throw fail(403, 'FORBIDDEN');
    const input = validateBankAccount(req.body);
    const { rows } = await pool.query(`INSERT INTO dispatch.provider_bank_accounts
      (provider_user_id, bank_bin, bank_name, account_number, account_holder) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider_user_id) DO UPDATE SET bank_bin = EXCLUDED.bank_bin, bank_name = EXCLUDED.bank_name,
        account_number = EXCLUDED.account_number, account_holder = EXCLUDED.account_holder, updated_at = clock_timestamp()
      RETURNING *`, [req.actor.id, ...input]);
    return { noStore: true, body: { bankAccount: bankAccountDto(rows[0]) } };
  }));

  // D5 / F-09 Deposit endpoints
  router.post('/api/packages/:id/deposit-call-confirmation', authenticate, handle(['coop'], async (req) => {
    const packageId = identifier(req.params.id);
    const input = validateCallConfirmationInput(req.body);
    return confirmHtxPackageCall(pool, req.actor, packageId, input);
  }));

  router.get('/api/packages/:id/deposit-call-confirmation', authenticate, handle(['coop', 'provider', 'farmer'], async (req) => {
    const packageId = identifier(req.params.id);
    const isCoop = req.actor.roles.includes('coop');
    const isProvider = req.actor.roles.includes('provider');
    const isFarmer = req.actor.roles.includes('farmer');
    const { rows } = await pool.query(
      `SELECT p.id, p.status, p.coop_id,
              cc.package_id, cc.confirmed_at, cc.note
         FROM dispatch.packages p
         LEFT JOIN dispatch.package_call_confirmations cc ON cc.package_id = p.id
        WHERE p.id = $1
          AND (($3::boolean AND p.coop_id = $2)
            OR ($4::boolean AND p.provider_id = $2)
            OR ($5::boolean AND EXISTS (
              SELECT 1 FROM dispatch.package_bookings pb
                JOIN dispatch.bookings b ON b.id = pb.booking_id
               WHERE pb.package_id = p.id AND b.owner_id = $2
            )))`,
      [packageId, req.actor.id, isCoop, isProvider, isFarmer],
    );
    const row = rows[0];
    if (!row) throw fail(404, 'NOT_FOUND');
    const confirmed = Boolean(row.package_id);
    const canConfirm = Boolean(isCoop && row.coop_id === req.actor.id && row.status === 'CLAIMED' && !confirmed);
    return {
      noStore: true,
      body: {
        packageId: row.id,
        packageStatus: row.status,
        confirmed,
        canConfirm,
        callConfirmation: confirmed ? callConfirmationDto(row) : null,
      },
    };
  }));

  router.get('/api/bookings/:id/vietqr', authenticate, handle(['farmer', 'coop'], (req) =>
    issueBookingVietqr(pool, req.actor, identifier(req.params.id), depositExpiryHours)));

  router.get('/api/bookings/:id/deposit', authenticate, handle(['farmer', 'coop', 'provider'], async (req) => {
    const bookingId = identifier(req.params.id);
    return { noStore: true, body: await buildBookingDepositView(pool, req.actor, bookingId) };
  }));

  router.post('/api/bookings/:id/deposit', authenticate, handle(['farmer', 'coop'], async (req) => {
    const bookingId = identifier(req.params.id);
    const input = validateDepositReportInput(req.body);
    return reportBookingDeposit(pool, req.actor, bookingId, input, depositExpiryHours);
  }));

  router.post('/api/deposits/:id/confirm', authenticate, handle(['provider'], async (req) => {
    const depositId = identifier(req.params.id);
    plainBody(req.body, [], { allowAbsent: true });
    return confirmBookingDeposit(pool, req.actor, depositId);
  }));

  // D6 / F-10, O-02, H-06 Server-simulated telemetry endpoints (read-only)
  router.get('/api/packages/:id/telemetry', authenticate, handle(['operator', 'coop', 'provider'], async (req) => {
    const packageId = identifier(req.params.id);
    return { noStore: true, body: { telemetry: await readTelemetryForPackage(pool, req.actor, packageId) } };
  }));

  router.get('/api/shifts/:id/telemetry', authenticate, handle(['operator', 'coop', 'provider'], async (req) => {
    const shiftId = identifier(req.params.id);
    return { noStore: true, body: { telemetry: await readTelemetryForShift(pool, req.actor, shiftId) } };
  }));

  router.get('/api/bookings/:id/telemetry', authenticate, handle(['farmer', 'coop', 'provider'], async (req) => {
    const bookingId = identifier(req.params.id);
    return { noStore: true, body: { telemetry: await readTelemetryForBooking(pool, req.actor, bookingId) } };
  }));

  // D8 / H-09 Read-only hypothetical HTX commission estimates
  router.get('/api/htx/commission-estimates', authenticate, handle(['coop'], async (req) => {
    return { noStore: true, body: await listHtxCommissionEstimates(pool, req.actor, req.query) };
  }));

  return router;
}
