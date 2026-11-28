import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { createLocalEvidenceStore } from '../../src/local-evidence-store.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseDisposableRoot } from '../helpers/test-db.js';

parseDisposableRoot(process.env.TEST_DATABASE_URL);

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const INTERNAL_SECRET = 'integration-local-evidence-secret-0123456789';
const PASSWORD = 'local-evidence-integration-passphrase';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function registerAndLogin(accountUrl, pool, email, name, roles = []) {
  const reg = await fetch(`${accountUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, password: PASSWORD }),
  });
  assert.equal(reg.status, 201);
  const { user } = await reg.json();
  for (const role of roles) {
    await pool.query('INSERT INTO account.user_roles(user_id, role) VALUES($1, $2) ON CONFLICT DO NOTHING', [user.id, role]);
  }
  const login = await fetch(`${accountUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  return { id: user.id, token: (await login.json()).token };
}

async function openAssignedDispute(pool, { farmerId, coopId, providerId, operatorId }) {
  const fieldId = (await pool.query(
    "INSERT INTO dispatch.fields(owner_id, name, locality, area_m2) VALUES($1, 'Synthetic Field', 'An Giang', 10000) RETURNING id",
    [farmerId],
  )).rows[0].id;
  const bookingId = (await pool.query(
    `INSERT INTO dispatch.bookings(
       owner_id, field_id, service_id, start_at, end_at, field_name, field_area_m2,
       service_code, service_name, service_data_label, price_per_ha_vnd, total_vnd, coordinator_id
     )
     SELECT $1, $2, id, '2026-11-26T08:00:00Z'::timestamptz, '2026-11-26T12:00:00Z'::timestamptz,
            'Synthetic Field', 10000, code, name, data_label, price_per_ha_vnd, price_per_ha_vnd, $3
       FROM dispatch.services WHERE code = 'tillage-tractor'
     RETURNING id`,
    [farmerId, fieldId, coopId],
  )).rows[0].id;
  const machineId = (await pool.query(
    "INSERT INTO dispatch.machines(owner_id, name, machine_type) VALUES($1, 'Synthetic Tractor', 'tractor') RETURNING id",
    [providerId],
  )).rows[0].id;
  const pkgId = (await pool.query(
    `INSERT INTO dispatch.packages(
       coop_id, service_id, locality, window_start_at, window_end_at, provider_id, machine_id, operator_id, status
     )
     SELECT $1, service_id, 'An Giang', start_at, end_at, $2, $4, $5, 'CLAIMED'
       FROM dispatch.bookings WHERE id = $3
     RETURNING id`,
    [coopId, providerId, bookingId, machineId, operatorId],
  )).rows[0].id;
  await pool.query('INSERT INTO dispatch.package_bookings(package_id, booking_id) VALUES($1, $2)', [pkgId, bookingId]);
  await pool.query("UPDATE dispatch.bookings SET state = 'GROUPED' WHERE id = $1", [bookingId]);
  await pool.query("UPDATE dispatch.bookings SET state = 'ASSIGNED' WHERE id = $1", [bookingId]);
  const disputeId = (await pool.query(
    "INSERT INTO dispatch.disputes(booking_id, claimant_id, respondent_id, reason, status) VALUES($1, $2, $3, 'QUALITY', 'OPEN') RETURNING id",
    [bookingId, farmerId, providerId],
  )).rows[0].id;
  return disputeId;
}

test('local evidence store persists exact originals and stripped thumbnails across restart and enforces access boundaries', async (t) => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'local-evidence-int-'));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));

  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool1 = createPool(db.url);
  let pool1Ended = false;
  t.after(async () => {
    if (!pool1Ended) await pool1.end();
    await db.drop();
  });
  await migrate(pool1);
  await seedCatalog(pool1);

  const accountUrl = await listen(t, createAccountApp({ pool: pool1, internalServiceToken: INTERNAL_SECRET }));
  const farmer = await registerAndLogin(accountUrl, pool1, 'farmer-ev@example.com', 'Farmer', ['farmer']);
  const provider = await registerAndLogin(accountUrl, pool1, 'provider-ev@example.com', 'Provider', ['provider']);
  const coop = await registerAndLogin(accountUrl, pool1, 'coop-ev@example.com', 'Coop', ['coop']);
  const operator = await registerAndLogin(accountUrl, pool1, 'operator-ev@example.com', 'Operator', ['operator']);
  const outsider = await registerAndLogin(accountUrl, pool1, 'outsider-ev@example.com', 'Outsider', ['farmer']);
  const admin = await registerAndLogin(accountUrl, pool1, 'admin-ev@example.com', 'Admin', ['admin']);

  const disputeId = await openAssignedDispute(pool1, {
    farmerId: farmer.id,
    coopId: coop.id,
    providerId: provider.id,
    operatorId: operator.id,
  });

  const store1 = createLocalEvidenceStore({ rootDir: evidenceDir });
  const bookingServer1 = createApp({
    pool: pool1,
    accountServiceUrl: accountUrl,
    internalServiceToken: INTERNAL_SECRET,
    evidenceStore: store1,
  }).listen(0, '127.0.0.1');
  await once(bookingServer1, 'listening');
  const bookingUrl1 = `http://127.0.0.1:${bookingServer1.address().port}`;
  let server1Closed = false;
  t.after(async () => {
    if (!server1Closed && bookingServer1.listening) {
      await new Promise((resolve) => { bookingServer1.close(resolve); bookingServer1.closeAllConnections(); });
    }
  });

  const jpegWithExif = await sharp({ create: { width: 640, height: 320, channels: 3, background: { r: 25, g: 130, b: 55 } } })
    .withExif({ IFD0: { Make: 'PrivateFieldPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '10/1 0/1 0/1' } })
    .jpeg()
    .toBuffer();

  // Access boundaries before/during upload
  assert.equal((await fetch(`${bookingUrl1}/api/disputes/${disputeId}/evidence`)).status, 401);
  assert.equal((await fetch(`${bookingUrl1}/api/disputes/${disputeId}/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${outsider.token}`, 'Content-Type': 'image/jpeg' },
    body: jpegWithExif,
  })).status, 404);
  assert.equal((await fetch(`${bookingUrl1}/api/disputes/${disputeId}/evidence`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  })).status, 404);

  // Party upload succeeds
  const uploadRes = await fetch(`${bookingUrl1}/api/disputes/${disputeId}/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${farmer.token}`, 'Content-Type': 'image/jpeg' },
    body: jpegWithExif,
  });
  assert.equal(uploadRes.status, 201);
  const { evidence } = await uploadRes.json();
  assert.equal(evidence.status, 'UPLOADED');
  assert.equal(evidence.byteSize, jpegWithExif.length);
  assert.equal(evidence.width, 640);
  assert.equal(evidence.height, 320);

  // Dedupe replay returns 200 and same id
  const replayRes = await fetch(`${bookingUrl1}/api/disputes/${disputeId}/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${farmer.token}`, 'Content-Type': 'image/jpeg' },
    body: jpegWithExif,
  });
  assert.equal(replayRes.status, 200);
  assert.equal((await replayRes.json()).evidence.id, evidence.id);

  // Close first booking server + pool to simulate full app restart while keeping DB and local volume
  await new Promise((resolve) => { bookingServer1.close(resolve); bookingServer1.closeAllConnections(); });
  server1Closed = true;
  await pool1.end();
  pool1Ended = true;

  const pool2 = createPool(db.url);
  t.after(() => pool2.end());
  const accountUrl2 = await listen(t, createAccountApp({ pool: pool2, internalServiceToken: INTERNAL_SECRET }));
  const store2 = createLocalEvidenceStore({ rootDir: evidenceDir });
  const bookingUrl2 = await listen(t, createApp({
    pool: pool2,
    accountServiceUrl: accountUrl2,
    internalServiceToken: INTERNAL_SECRET,
    evidenceStore: store2,
  }));

  // Durable reads after restart by authorized respondent
  const listRes = await fetch(`${bookingUrl2}/api/disputes/${disputeId}/evidence`, {
    headers: { Authorization: `Bearer ${provider.token}` },
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.storageAvailable, true);
  assert.deepEqual(listBody.items.map((x) => x.id), [evidence.id]);

  const contentRes = await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/content`, {
    headers: { Authorization: `Bearer ${provider.token}` },
  });
  assert.equal(contentRes.status, 200);
  assert.equal(contentRes.headers.get('content-disposition'), 'attachment');
  assert.equal(contentRes.headers.get('cache-control'), 'private, no-store');
  const downloaded = Buffer.from(await contentRes.arrayBuffer());
  assert.ok(downloaded.equals(jpegWithExif), 'original bytes must be exact after restart');

  const thumbRes = await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/thumbnail`, {
    headers: { Authorization: `Bearer ${provider.token}` },
  });
  assert.equal(thumbRes.status, 200);
  assert.equal(thumbRes.headers.get('content-type'), 'image/jpeg');
  assert.equal(thumbRes.headers.get('content-disposition'), 'inline');
  const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
  const thumbMeta = await sharp(thumbBytes).metadata();
  assert.equal(thumbMeta.format, 'jpeg');
  assert.equal(thumbMeta.width, 320);
  assert.equal(thumbMeta.height, 160);
  assert.equal(thumbMeta.exif, undefined);
  assert.equal(thumbBytes.includes(Buffer.from('PrivateFieldPhone', 'latin1')), false);

  // Access boundary checks on content and thumbnail
  assert.equal((await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/content`)).status, 401);
  assert.equal((await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/thumbnail`)).status, 401);
  assert.equal((await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/content`, {
    headers: { Authorization: `Bearer ${outsider.token}` },
  })).status, 404);
  assert.equal((await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/thumbnail`, {
    headers: { Authorization: `Bearer ${outsider.token}` },
  })).status, 404);
  assert.equal((await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/content`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  })).status, 404);

  // Escalate to ADMIN and assign independent mediator: mediator gains read, still cannot upload (403)
  await fetch(`${bookingUrl2}/api/disputes/${disputeId}/escalate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${farmer.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Synthetic escalation' }),
  });
  const assignRes = await fetch(`${bookingUrl2}/api/disputes/${disputeId}/mediator`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediatorId: admin.id }),
  });
  assert.equal(assignRes.status, 200);
  assert.equal((await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/content`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  })).status, 200);
  assert.equal((await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/thumbnail`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  })).status, 200);
  assert.equal((await fetch(`${bookingUrl2}/api/disputes/${disputeId}/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'image/jpeg' },
    body: jpegWithExif,
  })).status, 403);

  // Private permissions and corruption detection on disk
  const key = `${disputeId}/${evidence.id}/${sha256(jpegWithExif)}`;
  const diskOriginal = path.join(evidenceDir, 'original', key);
  assert.equal((await stat(diskOriginal)).mode & 0o777, 0o600);
  await writeFile(diskOriginal, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
  assert.equal((await fetch(`${bookingUrl2}/api/evidence/${evidence.id}/content`, {
    headers: { Authorization: `Bearer ${provider.token}` },
  })).status, 503);
});
