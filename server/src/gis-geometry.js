export const AREA_UNITS = Object.freeze({ haConversionM2: 10000, congUnit: 'cong_tam_cat_1296m2', congConversionM2: 1296 });
export const MAX_FIELD_AREA_M2 = 10000000;
const EARTH_RADIUS_M = 6378137;
const rad = Math.PI / 180;
const cross = ([ax, ay], [bx, by]) => ax * by - ay * bx;
const delta = (a, b) => a.map((value, i) => value - b[i]);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const turn = (a, b, c) => cross(delta(b, a), delta(c, a));
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

function intersects(a, b, c, d) {
  const p = turn(a, b, c), q = turn(a, b, d), r = turn(c, d, a), s = turn(c, d, b);
  const within = (u, v, w) => w.every((n, i) => n >= Math.min(u[i], v[i]) && n <= Math.max(u[i], v[i]));
  return (p * q < 0 && r * s < 0) || (p === 0 && within(a, b, c)) || (q === 0 && within(a, b, d))
    || (r === 0 && within(c, d, a)) || (s === 0 && within(c, d, b));
}

function vector([lng, lat]) {
  const cosLat = Math.cos(lat * rad);
  return [cosLat * Math.cos(lng * rad), cosLat * Math.sin(lng * rad), Math.sin(lat * rad)];
}

export function measurePolygon(value) {
  const invalid = () => Object.assign(new Error('Invalid field polygon'), { status: 400, code: 'VALIDATION_FAILED', field: 'boundaryGeojson' });
  if (value?.type !== 'Polygon' || !Array.isArray(value.coordinates) || value.coordinates.length !== 1) throw invalid();
  const [ring] = value.coordinates;
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 101) throw invalid();
  for (const point of ring) {
    if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
      || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw invalid();
  }
  if (!same(ring[0], ring.at(-1))) throw invalid();
  const points = ring.slice(0, -1);
  const longitudes = points.map(([lng]) => lng);
  // ponytail: local single-ring fields. Reject antimeridian-spanning outlines; use split geometries if global coverage is needed.
  if (Math.max(...longitudes) - Math.min(...longitudes) >= 180 || new Set(points.map((p) => p.join(','))).size !== points.length
    || points.filter(([, lat]) => lat === 90).length > 1 || points.filter(([, lat]) => lat === -90).length > 1) throw invalid();

  for (let i = 0; i < points.length; i += 1) {
    const a = ring[i], b = ring[i + 1], c = ring[(i + 2) % points.length];
    if (turn(a, b, c) === 0 && dot(delta(a, b), delta(c, b)) > 0) throw invalid();
    for (let j = i + 2; j < points.length; j += 1) {
      if (i === 0 && j === points.length - 1) continue;
      if (intersects(a, b, ring[j], ring[j + 1])) throw invalid();
    }
  }

  const [origin] = points;
  const [anchor, ...vectors] = points.map(vector);
  let excess = 0, twiceArea = 0, lngMoment = 0, latMoment = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = vectors[i - 1], b = vectors[i];
    const [ax, ay, az] = delta(a, anchor), [bx, by, bz] = delta(b, anchor);
    const determinant = dot(anchor, [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]);
    // Signed spherical excess of each triangle, with a translated determinant to keep precision for small fields.
    excess += 2 * Math.atan2(determinant, 1 + dot(anchor, a) + dot(a, b) + dot(b, anchor));
    // Area-weighted centroid in local longitude/latitude coordinates (not a survey-grade geodesic center).
    const p = delta(points[i], origin), q = delta(points[i + 1], origin);
    const area = cross(p, q);
    twiceArea += area;
    lngMoment += (p[0] + q[0]) * area;
    latMoment += (p[1] + q[1]) * area;
  }
  const calculatedAreaM2 = Math.round(Math.abs(excess) * EARTH_RADIUS_M ** 2);
  if (!twiceArea || calculatedAreaM2 < 1 || calculatedAreaM2 > MAX_FIELD_AREA_M2) throw invalid();
  return {
    calculatedAreaM2,
    centroid: { lat: origin[1] + latMoment / (3 * twiceArea), lng: origin[0] + lngMoment / (3 * twiceArea) },
  };
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 2 * (EARTH_RADIUS_M / 1000) * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function areaInLocalUnits(areaM2) {
  const { haConversionM2, congConversionM2, congUnit } = AREA_UNITS;
  return { areaHa: areaM2 / haConversionM2, areaCong: areaM2 / congConversionM2, congUnit, congConversionM2 };
}
