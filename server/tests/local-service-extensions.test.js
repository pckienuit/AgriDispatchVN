import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSimulatedTelemetry,
  computeActiveElapsedSeconds,
  createLocalServiceExtensionsRouter,
  deriveHypotheticalCommissionVnd,
  deriveTenPercentDepositVnd,
  validateCallConfirmationInput,
  validateCommissionQuery,
  validateDepositReportInput,
} from '../src/local-service-extensions.js';

test('createLocalServiceExtensionsRouter validates dependencies', () => {
  assert.throws(() => createLocalServiceExtensionsRouter({}), TypeError);
  assert.throws(() => createLocalServiceExtensionsRouter({ pool: { query() {}, connect() {} } }), TypeError);
  const router = createLocalServiceExtensionsRouter({
    pool: { query() {}, connect() {} },
    authenticate: (_req, _res, next) => next(),
  });
  assert.equal(typeof router, 'function');
});

test('deriveTenPercentDepositVnd uses round-half-up BigInt arithmetic', () => {
  assert.equal(deriveTenPercentDepositVnd('0'), 0n);
  assert.equal(deriveTenPercentDepositVnd('4'), 0n);
  assert.equal(deriveTenPercentDepositVnd('5'), 1n);
  assert.equal(deriveTenPercentDepositVnd('14'), 1n);
  assert.equal(deriveTenPercentDepositVnd('15'), 2n);
  assert.equal(deriveTenPercentDepositVnd('900000'), 90000n);
  assert.equal(deriveTenPercentDepositVnd('123456789012345'), 12345678901235n);
});

test('deriveHypotheticalCommissionVnd uses 300 bps round-half-up', () => {
  assert.equal(deriveHypotheticalCommissionVnd('0'), 0n);
  assert.equal(deriveHypotheticalCommissionVnd('1000000'), 30000n);
  assert.equal(deriveHypotheticalCommissionVnd('16'), 0n);
  assert.equal(deriveHypotheticalCommissionVnd('17'), 1n);
  assert.equal(deriveHypotheticalCommissionVnd('166'), 5n);
  assert.equal(deriveHypotheticalCommissionVnd('167'), 5n);
});

test('validators reject invalid bodies, unknown fields, and malformed instants', () => {
  assert.deepEqual(validateCallConfirmationInput(undefined), { note: null });
  assert.deepEqual(validateCallConfirmationInput({ note: '  Đã gọi 2 bên  ' }), { note: 'Đã gọi 2 bên' });
  assert.throws(() => validateCallConfirmationInput({ note: '   ' }), { status: 400, code: 'VALIDATION_FAILED' });
  assert.throws(() => validateCallConfirmationInput({ note: 'x'.repeat(501) }), { status: 400, code: 'VALIDATION_FAILED' });
  assert.throws(() => validateCallConfirmationInput({ extra: true }), { status: 400, code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateCallConfirmationInput([]), { status: 400, code: 'INVALID_BODY' });

  assert.deepEqual(validateDepositReportInput({ reference: 'DEP-0001' }), { reference: 'DEP-0001', amountVnd: null });
  assert.deepEqual(validateDepositReportInput({ reference: 'DEP-0001', amountVnd: '90000' }), { reference: 'DEP-0001', amountVnd: '90000' });
  assert.throws(() => validateDepositReportInput({ reference: 'ab' }), { status: 400, code: 'VALIDATION_FAILED' });
  assert.throws(() => validateDepositReportInput({ reference: 'DEP-0001', amountVnd: 90000 }), { status: 400, code: 'VALIDATION_FAILED' });
  assert.throws(() => validateDepositReportInput({ reference: 'DEP-0001', amountVnd: '0' }), { status: 400, code: 'VALIDATION_FAILED' });
  assert.throws(() => validateDepositReportInput({ reference: 'DEP-0001', rate: 0.1 }), { status: 400, code: 'UNKNOWN_FIELD' });

  assert.throws(() => validateCommissionQuery({ from: '2026-02-30T00:00:00Z' }), { status: 400, code: 'VALIDATION_FAILED' });
  assert.throws(() => validateCommissionQuery({ from: '2026-12-02T00:00:00Z', to: '2026-12-01T00:00:00Z' }), { status: 400, code: 'VALIDATION_FAILED' });
  const q = validateCommissionQuery({ from: '2026-12-01T00:00:00Z', to: '2026-12-02T00:00:00Z', limit: '10', offset: '0' });
  assert.equal(q.limit, 10);
  assert.equal(q.offset, 0);
});

test('computeActiveElapsedSeconds and buildSimulatedTelemetry derive from phase and server clock', () => {
  const t0 = Date.parse('2026-12-01T08:00:00Z');
  const events = [
    { event_type: 'SHIFT_STARTED', created_at: new Date(t0) },
    { event_type: 'SHIFT_PAUSED', created_at: new Date(t0 + 600_000) },
    { event_type: 'SHIFT_RESUMED', created_at: new Date(t0 + 900_000) },
  ];
  assert.equal(computeActiveElapsedSeconds(events, t0 + 1_200_000), 900);

  const running = buildSimulatedTelemetry({
    scope: 'shift',
    packageId: '10000000-0000-4000-8000-000000000001',
    shiftId: '20000000-0000-4000-8000-000000000001',
    packageStatus: 'CLAIMED',
    shiftStatus: 'RUNNING',
    machineType: 'harvester',
    serviceCode: 'harvest-combine',
    windowStartAt: '2026-12-01T08:00:00Z',
    windowEndAt: '2026-12-01T12:00:00Z',
    scopeAreaM2: 10000,
    events,
    serverNow: new Date(t0 + 1_200_000),
  });
  assert.equal(running.simulation.simulated, true);
  assert.equal(running.simulation.realDeviceTelemetry, false);
  assert.equal(running.simulation.measuredCoordinatesAvailable, false);
  assert.equal(running.syntheticTrack.realGpsCoordinates, false);
  assert.equal(running.syntheticTrack.coordSpace, 'SYNTHETIC_LOCAL_GRID_0_100');
  assert.equal(running.metrics.activeElapsedSeconds, 900);
  assert.equal(running.metrics.implementActive, true);
  assert.ok(running.metrics.speedKmh > 0);
  assert.ok(running.metrics.cutterBarRpm > 0);
  assert.equal('lat' in running.syntheticTrack, false);
  assert.equal('lng' in running.syntheticTrack, false);

  const paused = buildSimulatedTelemetry({
    scope: 'shift',
    packageId: '10000000-0000-4000-8000-000000000001',
    shiftId: '20000000-0000-4000-8000-000000000001',
    packageStatus: 'CLAIMED',
    shiftStatus: 'PAUSED',
    machineType: 'harvester',
    serviceCode: 'harvest-combine',
    windowStartAt: '2026-12-01T08:00:00Z',
    windowEndAt: '2026-12-01T12:00:00Z',
    scopeAreaM2: 10000,
    events: events.slice(0, 2),
    serverNow: new Date(t0 + 1_200_000),
  });
  assert.equal(paused.metrics.speedKmh, 0);
  assert.equal(paused.metrics.cutterBarRpm, 0);
  assert.equal(paused.metrics.implementActive, false);
});
