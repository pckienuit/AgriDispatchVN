import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPoint, fit, formatPoint, nudgePoint, parseVertices, toGeo, toSvg } from '../../web/v2/screens/field-boundary.js';

test('parseVertices accepts decimal lon/lat lines and rejects malformed or out-of-range input', () => {
  assert.deepEqual(parseVertices('105.8, 10\n105.801,10.001\n .5 , -3.25'), [[105.8, 10], [105.801, 10.001], [0.5, -3.25]]);
  assert.throws(() => parseVertices('105.8, 10\n105.801, 10'), /Nhập từ 3 đến 100 đỉnh/);
  assert.throws(() => parseVertices('1e3, 10\n2, 10\n3, 10'), /dấu chấm/);
  assert.throws(() => parseVertices('181, 10\n2, 10\n3, 11'), /vượt phạm vi/);
});

test('formatPoint writes fixed decimals that parseVertices reads back exactly', () => {
  const point = [105.8000001, 9.99999999];
  const text = formatPoint(point);
  assert.equal(text, '105.8000001, 10.0000000');
  assert.deepEqual(parseVertices(`${text}\n1, 1\n2, 2`)[0], [105.8000001, 10]);
});

test('keyboard nudge moves about 1 m per press, 10x with Shift, and clamps to valid range', () => {
  assert.deepEqual(nudgePoint([105.8, 10], 'ArrowRight'), [105.80001, 10]);
  assert.deepEqual(nudgePoint([105.8, 10], 'ArrowDown', { shift: true }), [105.8, 9.9999]);
  assert.deepEqual(nudgePoint([180, 90], 'ArrowUp'), [180, 90]);
  assert.equal(nudgePoint([105.8, 10], 'Enter'), null);
  assert.deepEqual(clampPoint([200, -100]), [180, -90]);
});

test('schematic transform keeps shape and inverts exactly for drag', () => {
  const ring = [[105.8, 10], [105.801, 10], [105.801, 10.001], [105.8, 10.001]];
  const t = fit(ring);
  for (const p of ring) {
    const [x, y] = toSvg(t, p);
    assert.ok(x >= 0 && x <= 220 && y >= 0 && y <= 168, `inside frame ${x},${y}`);
    const [lon, lat] = toGeo(t, [x, y]);
    assert.ok(Math.abs(lon - p[0]) < 1e-9 && Math.abs(lat - p[1]) < 1e-9);
  }
  const [x0, y0] = toSvg(t, ring[0]);
  const [x2, y2] = toSvg(t, ring[2]);
  assert.ok(x2 > x0, 'east is right');
  assert.ok(y2 < y0, 'north is up');
});
