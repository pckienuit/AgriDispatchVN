import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePolygonAreaM2, validateFieldDetailsInput, validateLocationConsentInput } from '../src/field-details.js';
import { validateBookingInput } from '../src/booking.js';

const rectangle = [[105.8, 10.0], [105.81, 10.0], [105.81, 10.01], [105.8, 10.01], [105.8, 10.0]];

test('polygon area derives from closed lon/lat ring and rejects malformed or unsafe boundaries', () => {
  const area = calculatePolygonAreaM2(rectangle);
  assert.ok(area > 1100000 && area < 1300000, `unexpected area ${area}`);
  for (const ring of [
    [[105.8, 10], [105.81, 10], [105.8, 10.01]],
    [[105.8, 10], [105.81, 10], [105.8, 10.01], [105.81, 10.01], [105.8, 10]],
    [[105.8, 10], [181, 10], [105.81, 10.01], [105.8, 10]],
    Array.from({ length: 103 }, (_, i) => [105.8 + i / 10000, 10 + (i % 2) / 10000]),
  ]) assert.throws(() => calculatePolygonAreaM2(ring), { status: 400, code: 'VALIDATION_FAILED' });
});

test('field detail updates accept bounded access values and derive polygon area', () => {
  const parsed = validateFieldDetailsInput({
    coordinates: rectangle,
    access: { roadWidthM: 2.5, bridgeLoadT: 4, soil: 'soft', hasBoatDock: false },
  });
  assert.equal(parsed.areaM2, calculatePolygonAreaM2(rectangle));
  assert.equal(parsed.access.roadWidthM, 2.5);
  for (const input of [
    { coordinates: rectangle, areaM2: 999 },
    { coordinates: rectangle, access: { bridgeLoadT: -1 } },
    { coordinates: rectangle, access: { hasBoatDock: 'yes' } },
    { coordinates: rectangle, access: { soil: 'unknown-value' } },
    { coordinates: rectangle, privateNote: 'extra' },
  ]) assert.throws(() => validateFieldDetailsInput(input), { status: 400 });
});

test('location consent requires explicit affirmative action and a known version', () => {
  assert.deepEqual(validateLocationConsentInput({ consent: true, version: 'field-boundary-v1' }), { version: 'field-boundary-v1' });
  for (const input of [{}, { consent: false, version: 'field-boundary-v1' }, { consent: true, version: 'other' }, { consent: true, version: 'field-boundary-v1', coordinates: rectangle }]) {
    assert.throws(() => validateLocationConsentInput(input), { status: 400 });
  }
});

test('harvest metadata stays optional and rejects invalid dates or unexpected keys', () => {
  const base = { fieldId: '44444444-4444-4444-8444-444444444444', serviceId: '55555555-5555-4555-8555-555555555555', startAt: '2026-11-25T08:00:00Z', endAt: '2026-11-25T12:00:00Z' };
  assert.deepEqual(validateBookingInput(base), { fieldId: base.fieldId, serviceId: base.serviceId, startAt: '2026-11-25T08:00:00.000Z', endAt: '2026-11-25T12:00:00.000Z' });
  assert.deepEqual(validateBookingInput({ ...base, cropVariety: 'OM5451', sowDate: '2026-08-01', harvestDate: '2026-11-30' }).cropVariety, 'OM5451');
  for (const input of [
    { ...base, sowDate: '2026-02-30' },
    { ...base, sowDate: '2026-12-01', harvestDate: '2026-11-01' },
    { ...base, cropVariety: 'x'.repeat(81) },
    { ...base, surprise: true },
  ]) assert.throws(() => validateBookingInput(input), { status: 400 });
});
