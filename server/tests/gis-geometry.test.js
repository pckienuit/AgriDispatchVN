import assert from 'node:assert/strict';
import test from 'node:test';
import * as geometry from '../src/gis-geometry.js';

const ring = [[105.8, 10], [105.801, 10], [105.801, 10.001], [105.8, 10.001], [105.8, 10]];
const polygon = (coordinates) => ({ type: 'Polygon', coordinates: [coordinates] });

test('Mekong Delta field matches independent PROJ geodesic area on a 6378137 m sphere', () => {
  // PROJ geod_polygonarea with flattening=0: 12203.747486054897 m² (synthetic Cần Thơ outline).
  assert.equal(typeof geometry.measurePolygon, 'function');
  for (const positions of [ring, [...ring].reverse()]) {
    const { calculatedAreaM2, centroid } = geometry.measurePolygon(polygon(positions));
    assert.equal(calculatedAreaM2, 12204);
    assert.ok(Math.abs(centroid.lat - 10.0005) < 1e-9);
    assert.ok(Math.abs(centroid.lng - 105.8005) < 1e-9);
  }
  assert.deepEqual(geometry.AREA_UNITS, { haConversionM2: 10000, congUnit: 'cong_tam_cat_1296m2', congConversionM2: 1296 });
});

test('centroid is area-weighted, not a vertex average', () => {
  const triangle = [[105, 10], [105.003, 10], [105.001, 10.003], [105, 10]];
  const { centroid } = geometry.measurePolygon(polygon(triangle));
  assert.ok(Math.abs(centroid.lat - 10.001) < 1e-9);
  assert.ok(Math.abs(centroid.lng - (105 + 0.004 / 3)) < 1e-9);
});

test('rejects malformed, unclosed, crossing, backtracking and zero-area outlines', () => {
  const bad = [
    null, { type: 'MultiPolygon', coordinates: [ring] }, { type: 'Polygon', coordinates: [ring, ring] },
    polygon(ring.slice(0, 4)), polygon(ring.slice(0, 3)),
    polygon([ring[0], ring[2], ring[1], ring[3], ring[0]]),
    polygon([[105, 10], [105.001, 10], [105.0005, 10], [105.001, 10.001], [105, 10.001], [105, 10]]),
    polygon([[105, 10], [106, 10], [107, 10], [105, 10]]),
    polygon([[105, 10], [105 + 1e-8, 10], [105, 10 + 1e-8], [105, 10]]),
    ...[[Infinity, 10], [105, NaN], ['105', 10], [181, 10], [105, -91], [105, 10, 0], Array(2), ring[0]]
      .map((badPoint) => polygon([ring[0], badPoint, ...ring.slice(2)])),
  ];
  for (const input of bad) assert.throws(() => geometry.measurePolygon(input), { status: 400, code: 'VALIDATION_FAILED', field: 'boundaryGeojson' });
});

test('Haversine matches PROJ geod_inverse between Cần Thơ and Long Xuyên on the same sphere', () => {
  const distance = geometry.haversineKm(10.0452, 105.7469, 10.3765, 105.4352);
  assert.ok(Math.abs(distance - 50.26209073234598) < 1e-9);
  assert.equal(geometry.haversineKm(10, 105, 10, 105), 0);
  assert.ok(Math.abs(geometry.haversineKm(0, 0, 0, 180) - Math.PI * 6378.137) < 1e-8);
});
