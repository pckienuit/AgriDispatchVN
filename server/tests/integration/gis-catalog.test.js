import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { bootstrapDatabase } from '../../scripts/bootstrap-db.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

const root = process.env.TEST_DATABASE_URL;
parseDisposableRoot(root);
const people = Object.fromEntries(Object.entries({ farmer: 'farmer', other: 'farmer', coop: 'coop', otherCoop: 'coop', provider: 'provider', rival: 'provider', admin: 'admin' })
  .map(([key, role]) => [key, { id: randomUUID(), name: key, roles: [role] }]));
const servers = [];
let disposable, pool, runtime, url;
const suffix = randomBytes(6).toString('hex');
const roles = { account: `gis_acc_${suffix}`, booking: `gis_book_${suffix}` };
const internal = randomUUID();
const tokens = Object.fromEntries(Object.keys(people).map((key) => [key, randomUUID()]));
const polygon = (lng = 105.8, lat = 10) => ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]] });
const fieldInput = { name: 'Ruộng thử', locality: 'Xã kiểm thử', provinceCode: 'CT', communeCode: 'TEST-XA' };

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  disposable = await createDisposableDatabase(root);
  pool = createPool(disposable.url);
  assert.ok((await migrate(pool)).includes('028_gis_polygons_real_catalog.sql'));
  await seedCatalog(pool);
  const passwords = { account: randomBytes(24).toString('hex'), booking: randomBytes(24).toString('hex') };
  await bootstrapDatabase(pool, { roles, passwords });
  const runtimeUrl = new URL(disposable.url);
  runtimeUrl.username = roles.booking;
  runtimeUrl.password = passwords.booking;
  runtime = createPool(runtimeUrl.href);
  // Identity test seam only. Requests still pass through createApp and real bearer-token introspection middleware.
  const identity = express().use(express.json());
  identity.post('/internal/introspect', (req, res) => {
    const actor = Object.keys(tokens).find((key) => tokens[key] === req.body.token);
    if (req.get('X-Service-Token') !== internal || !actor) return res.sendStatus(401);
    return res.json({ user: people[actor] });
  });
  url = await listen(createApp({ pool: runtime, accountServiceUrl: await listen(identity), internalServiceToken: internal, servicesCacheMs: 60000, log: () => {} }));
});

after(async () => {
  for (const server of servers) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await runtime?.end();
  await pool?.end();
  await disposable?.drop();
  const admin = createPool(root);
  try { await admin.query(`DROP ROLE IF EXISTS ${roles.account}, ${roles.booking}`); }
  finally { await admin.end(); }
});

test('booking runtime cannot hard-delete services or alter their immutable identity and provenance', async () => {
  await assert.rejects(runtime.query('DELETE FROM dispatch.services WHERE false'), { code: '42501' });
  await assert.rejects(runtime.query("UPDATE dispatch.services SET data_label='synthetic' WHERE false"), { code: '42501' });
  await assert.rejects(runtime.query('UPDATE dispatch.services SET created_by_user_id=NULL WHERE false'), { code: '42501' });
});

async function call(method, path, actor, payload, extra = {}) {
  const headers = { ...extra };
  if (actor) headers.authorization = `Bearer ${tokens[actor]}`;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url + path, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const data = await response.json();
  return { status: response.status, data, cache: response.headers.get('cache-control') };
}

const consent = (actor) => call('POST', '/api/location-consent', actor, { consent: true, version: 'field-boundary-v1' });

test('field polygon round-trips only for its owner and consent withdrawal erases geometry, not area', async () => {
  const path = '/api/fields';
  const rejected = await call('POST', path, 'farmer', { ...fieldInput, boundaryGeojson: { type: 'Polygon', coordinates: [] } });
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.data.error, { code: 'VALIDATION_FAILED', field: 'boundaryGeojson' });
  assert.equal((await call('POST', path, 'farmer', { ...fieldInput, boundaryGeojson: polygon() })).data.error.code, 'LOCATION_CONSENT_REQUIRED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch.fields')).rows[0].n, 0);
  assert.equal((await consent('farmer')).status, 201);
  const shape = polygon();
  const created = await call('POST', path, 'farmer', { ...fieldInput, boundaryGeojson: { ...shape, bbox: [0, 0, 1, 1], junk: 'discard' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { field } = created.data;
  assert.deepEqual(field.boundaryGeojson, shape);
  assert.deepEqual((await pool.query('SELECT boundary_geojson FROM dispatch.fields WHERE id = $1', [field.id])).rows[0].boundary_geojson, shape);
  assert.equal(field.calculatedAreaM2, 12204);
  assert.equal(field.areaM2, 12204);
  assert.equal(field.areaHa, 1.2204);
  assert.equal(field.areaCong, 12204 / 1296);
  assert.equal(field.congConversionM2, 1296);
  assert.equal(field.congUnit, 'cong_tam_cat_1296m2');
  assert.ok(Math.abs(field.centroid.lng - 105.8005) < 1e-9);
  assert.ok(Math.abs(field.centroid.lat - 10.0005) < 1e-9);
  const detail = `${path}/${field.id}`;
  assert.deepEqual((await call('GET', detail, 'farmer')).data.field, field);
  assert.deepEqual((await call('GET', path, 'farmer')).data.items, [field]);
  assert.equal((await call('GET', detail, 'other')).status, 404);
  assert.equal((await call('PATCH', detail, 'other', { name: 'Không được sửa' })).status, 404);
  assert.equal((await call('PATCH', detail, 'farmer', { boundaryGeojson: { type: 'LineString', coordinates: [] } })).status, 400);
  assert.deepEqual((await call('GET', detail, 'farmer')).data.field, field);
  const updated = await call('PATCH', detail, 'farmer', { boundaryGeojson: { ...polygon(105.8, 10.01), crs: 'ignored' }, areaM2: 1234 });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.field.boundaryGeojson, polygon(105.8, 10.01));
  assert.equal(updated.data.field.areaM2, updated.data.field.calculatedAreaM2);
  assert.equal((await call('PATCH', detail, 'farmer', { name: 'Đổi tên' })).data.field.centroid.lat, updated.data.field.centroid.lat);
  assert.deepEqual((await call('GET', `${detail}/details`, 'farmer')).data.details.coordinates, polygon(105.8, 10.01).coordinates[0]);
  assert.equal((await call('DELETE', '/api/location-consent', 'farmer')).status, 200);
  const cleared = (await call('GET', detail, 'farmer')).data.field;
  assert.equal(cleared.boundaryGeojson, null);
  assert.equal(cleared.centroid, null);
  assert.equal(cleared.calculatedAreaM2, null);
  assert.equal(cleared.areaM2, updated.data.field.areaM2);
  assert.deepEqual((await pool.query('SELECT boundary, boundary_geojson, centroid_lat, centroid_lng, calculated_area_m2 FROM dispatch.fields WHERE id=$1', [field.id])).rows[0],
    { boundary: null, boundary_geojson: null, centroid_lat: null, centroid_lng: null, calculated_area_m2: null });
  const legacy = (await call('POST', path, 'other', { name: 'Ruộng cũ', locality: 'Cần Thơ', areaM2: 1296 })).data.field;
  assert.equal(legacy.areaM2, 1296);
  assert.equal(legacy.areaCong, 1);
  assert.equal(legacy.boundaryGeojson, null);
});

let bookingCount = 0;
const window = { startAt: '2099-01-15T08:00:00Z', endAt: '2099-01-15T12:00:00Z' };
async function book(fieldId, serviceId, time = window) {
  return call('POST', '/api/bookings', 'farmer', { fieldId, serviceId, ...time }, { 'Idempotency-Key': `dev54-test-booking-${++bookingCount}` });
}

const clustersPath = '/api/coop/cluster-suggestions';
test('HTX suggestions use spherical diameters, enforce scope and never write bookings or packages', async () => {
  assert.equal((await call('GET', clustersPath)).status, 401);
  assert.equal((await call('GET', clustersPath, 'farmer')).status, 403);
  assert.equal((await call('GET', `${clustersPath}?maxDistanceKm=1&maxDistanceKm=2`, 'coop')).data.error.code, 'VALIDATION_FAILED');
  await consent('farmer');
  await pool.query(`INSERT INTO dispatch.commune_territories (coop_id, province_code, province_name, commune_code, commune_name, assigned_by)
    VALUES ($1, 'CT', 'Cần Thơ', 'TEST-XA', 'Xã kiểm thử', $2)`, [people.coop.id, people.admin.id]);
  await pool.query(`INSERT INTO dispatch.platform_parameter_versions (parameters, changed_by, note)
    VALUES ('{"clusterMinHa":2,"radiusM":900}', $1, 'Synthetic test')`, [people.admin.id]);
  const service = (await pool.query("SELECT id FROM dispatch.services WHERE code = 'harvest-combine'")).rows[0].id;
  async function candidate(lat, { coordinator = 'coop', provinceCode = 'CT', time = window, geometry = true, state = 'REQUESTED' } = {}) {
    const created = await call('POST', '/api/fields', 'farmer', { ...fieldInput, provinceCode, ...(geometry ? { boundaryGeojson: polygon(105.8, lat) } : { areaM2: 14000 }) });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const response = await book(created.data.field.id, service, time);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const id = response.data.booking.id;
    await pool.query('UPDATE dispatch.bookings SET coordinator_id=$2 WHERE id=$1', [id, people[coordinator]?.id ?? null]);
    if (state === 'CANCELLED') {
      await pool.query("UPDATE dispatch.bookings SET state='GROUPED' WHERE id=$1", [id]);
      await pool.query("UPDATE dispatch.bookings SET state='CANCELLED' WHERE id=$1", [id]);
    }
    return id;
  }
  const a = await candidate(10), b = await candidate(10.002), c = await candidate(10.005);
  const d = await candidate(10.05), e = await candidate(10.056);
  // Same named commune in another province, delegated elsewhere, undelegated, cancelled, no centroid, expired, incompatible window.
  await candidate(10.0001, { provinceCode: 'AG' });
  await candidate(10.0002, { coordinator: 'otherCoop' });
  await candidate(10.0003, { coordinator: null });
  await candidate(10.0004, { state: 'CANCELLED' });
  await candidate(10.0005, { geometry: false });
  await candidate(10.0006, { time: { startAt: '2020-01-15T08:00:00Z', endAt: '2020-01-15T12:00:00Z' } });
  await candidate(10.0007, { time: { startAt: '2099-01-16T08:00:00Z', endAt: '2099-01-16T12:00:00Z' } });
  const snapshot = async () => (await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM dispatch.bookings b) AS bookings,
    (SELECT count(*) FROM dispatch.booking_events) AS events,
    (SELECT count(*) FROM dispatch.packages) AS packages,
    (SELECT count(*) FROM dispatch.package_bookings) AS members`)).rows[0];
  const before = await snapshot();
  const result = await call('GET', clustersPath, 'coop');
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.cache, 'no-store');
  assert.equal(result.data.minAreaHa, 2);
  assert.equal(result.data.maxDistanceKm, 0.9);
  const [first, second] = result.data.items;
  assert.equal(result.data.items.length, 2);
  assert.deepEqual(new Set(first.members.map((m) => m.bookingId)), new Set([a, b, c]));
  assert.deepEqual(new Set(second.members.map((m) => m.bookingId)), new Set([d, e]));
  assert.equal(first.areaM2, 36612);
  assert.equal(first.areaHa, 3.6612);
  assert.equal(first.areaCong, 36612 / 1296);
  assert.equal(first.pairwiseDistances.length, 3);
  assert.ok(Math.abs(first.maxPairwiseDistanceKm - 0.556597453966) < 1e-9);
  assert.ok(Math.abs(second.maxPairwiseDistanceKm - 0.66791694476) < 1e-9);
  assert.deepEqual(first.pairwiseDistances.map((p) => p.distanceKm), first.pairwiseDistances.map((p) => p.distanceKm).sort((p, q) => p - q));
  assert.ok(first.members.every((m) => Object.keys(m).sort().join(',') === 'bookingId,centroid,fieldId'));
  const short = await call('GET', `${clustersPath}?maxDistanceKm=0.4`, 'coop');
  assert.equal(short.data.items.length, 1, 'A-B and B-C are close, but A-C is outside the threshold');
  assert.deepEqual(new Set(short.data.items[0].members.map((m) => m.bookingId)), new Set([a, b]));
  assert.deepEqual((await call('GET', `${clustersPath}?minAreaHa=4`, 'coop')).data.items, []);
  assert.deepEqual((await call('GET', clustersPath, 'otherCoop')).data.items, []);
  await pool.query('UPDATE dispatch.commune_territories SET removed_at=now(), removed_by=$1 WHERE coop_id=$2', [people.admin.id, people.coop.id]);
  assert.deepEqual((await call('GET', clustersPath, 'coop')).data.items, []);
  assert.deepEqual(await snapshot(), before);
});

const serviceInput = { name: 'Gặt lúa liên hợp', unit: 'ha', pricePerHaVnd: '2345678', machineType: 'harvester', active: true, description: 'Gặt lúa theo diện tích' };
test('only admin and owning provider manage services; all cached pages refresh and booking price stays frozen', async () => {
  const list = (path = '/api/services') => call('GET', path);
  const paths = ['/api/services', '/api/services?limit=10'];
  const baseline = await list();
  assert.ok(baseline.data.items.every((item) => item.dataLabel === 'synthetic'));
  await list(paths[1]);
  assert.equal((await call('POST', '/api/services', undefined, serviceInput)).status, 401);
  for (const actor of ['farmer', 'coop']) assert.equal((await call('POST', '/api/services', actor, serviceInput)).status, 403);
  for (const [key, value] of Object.entries({ name: ' ', unit: 'cong', pricePerHaVnd: '0', machineType: 'boat', active: 'true', description: 'x'.repeat(1001) })) {
    const result = await call('POST', '/api/services', 'provider', { ...serviceInput, [key]: value });
    assert.equal(result.status, 400);
    assert.deepEqual(result.data.error, { code: 'VALIDATION_FAILED', field: key });
  }
  assert.equal((await call('POST', '/api/services', 'provider', { ...serviceInput, dataLabel: 'synthetic' })).data.error.code, 'UNKNOWN_FIELD');
  assert.deepEqual((await list()).data, baseline.data);

  const created = await call('POST', '/api/services', 'provider', serviceInput);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { service } = created.data;
  assert.equal(service.dataLabel, 'real-labelled');
  const path = `/api/services/${service.id}`;
  for (const p of paths) assert.deepEqual((await list(p)).data.items.find((item) => item.id === service.id), service);
  assert.deepEqual((await list(path)).data.service, service);
  assert.equal((await call('PATCH', path, 'rival', { pricePerHaVnd: 42 })).status, 404);
  assert.equal((await call('DELETE', path, 'rival')).status, 404);
  assert.equal((await call('PATCH', path, 'farmer', { pricePerHaVnd: 42 })).status, 403);
  assert.equal((await call('PATCH', path, 'admin', { unit: 'cong' })).status, 400);

  const field = (await call('POST', '/api/fields', 'farmer', { name: 'Ruộng để báo giá', locality: 'Cần Thơ', areaM2: 12500 })).data.field;
  const historical = await book(field.id, service.id);
  assert.equal(historical.status, 201);
  assert.equal(historical.data.booking.service.pricePerHaVnd, '2345678');
  assert.equal(historical.data.booking.totalVnd, '2932098');
  const edited = await call('PATCH', path, 'provider', { name: 'Gặt lúa', pricePerHaVnd: 3000000, description: null });
  assert.equal(edited.status, 200);
  for (const p of paths) assert.equal((await list(p)).data.items.find((item) => item.id === service.id).pricePerHaVnd, '3000000');
  assert.equal((await book(field.id, service.id)).data.booking.totalVnd, '3750000');
  const deleted = await call('DELETE', path, 'admin');
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.service.active, false);
  for (const p of paths) assert.equal((await list(p)).data.items.some((item) => item.id === service.id), false);
  assert.equal((await list(path)).status, 404);
  assert.equal((await book(field.id, service.id)).status, 404);
  const updatedHistorical = await call('GET', `/api/bookings/${historical.data.booking.id}`, 'farmer');
  assert.deepEqual(updatedHistorical.data.booking, historical.data.booking);
  assert.deepEqual((await pool.query(`SELECT active, created_by_user_id, updated_by_user_id, unit, data_label
    FROM dispatch.services WHERE id=$1`, [service.id])).rows[0], {
    active: false, created_by_user_id: people.provider.id, updated_by_user_id: people.admin.id, unit: 'ha', data_label: 'real-labelled',
  });
  await pool.query('UPDATE dispatch.bookings SET coordinator_id=$2 WHERE id=$1', [historical.data.booking.id, people.coop.id]);
  const packaged = await call('POST', '/api/packages', 'coop', { bookingIds: [historical.data.booking.id] });
  assert.equal(packaged.status, 201);
  const claimPath = `/api/packages/${packaged.data.package.id}/claim`;
  const operatorId = randomUUID();
  const hash = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
  for (const [id, role] of [[people.provider.id, 'provider'], [operatorId, 'operator']]) {
    await pool.query('INSERT INTO account.users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [id, `${id}@example.test`, role, hash]);
    await pool.query('INSERT INTO account.user_roles(user_id,role) VALUES($1,$2)', [id, role]);
  }
  const grantJob = (await pool.query(`INSERT INTO dispatch.jobs (provider_id,title,locality,capacity,start_at,end_at)
    VALUES ($1,'Ca thử','Cần Thơ',1,'2099-01-15T00:00:00Z','2099-01-16T00:00:00Z') RETURNING id`, [people.provider.id])).rows[0].id;
  const application = (await pool.query(`INSERT INTO dispatch.applications (job_id,operator_id,status)
    VALUES ($1,$2,'OFFERED') RETURNING id`, [grantJob, operatorId])).rows[0].id;
  await pool.query(`INSERT INTO dispatch.offers (application_id,job_id,operator_id,status,responded_at)
    VALUES ($1,$2,$3,'ACCEPTED',now())`, [application, grantJob, operatorId]);
  const tractor = (await call('POST', '/api/machines', 'provider', { name: 'Máy kéo', type: 'tractor' })).data.machine;
  const harvester = (await call('POST', '/api/machines', 'provider', { name: 'Máy gặt', type: 'harvester' })).data.machine;
  assert.equal((await call('POST', claimPath, 'provider', { machineId: tractor.id, operatorId })).data.error.code, 'MACHINE_UNAVAILABLE');
  assert.equal((await call('POST', claimPath, 'provider', { machineId: harvester.id, operatorId })).status, 200);
  const postponePath = `/api/packages/${packaged.data.package.id}/postponement`;
  const postponed = await call('POST', postponePath, 'coop', {
    reason: 'Lịch thử', startAt: '2099-01-15T13:00:00Z', endAt: '2099-01-15T17:00:00Z',
  });
  assert.equal(postponed.status, 201, JSON.stringify(postponed.data));
  assert.equal((await call('POST', `${postponePath}/1/consent`, 'farmer', {})).status, 200);
  const applied = await call('POST', `${postponePath}/1/consent`, 'provider', {});
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.package.startAt, '2099-01-15T13:00:00.000Z');
  const reactivated = await call('PATCH', path, 'provider', { active: true, unit: 'ha' });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.data.service.active, true);
  assert.equal((await call('POST', '/api/services', 'admin', { ...serviceInput, active: false })).status, 201);
});
