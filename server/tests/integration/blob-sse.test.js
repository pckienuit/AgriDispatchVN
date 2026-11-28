import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import sharp from 'sharp';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createBlobStore } from '../../src/blob-store.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const secret = 'synthetic-dev55-integration-service-secret';
const password = 'synthetic-dev55-test-password';

async function listen(app, cleanup) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('private Blob evidence and durable SSE enforce participant scope through HTTP and PG17', { timeout: 30000 }, async t => {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url);
  const cleanup = [db.drop, () => pool.end()];
  t.after(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
  });
  await migrate(pool);
  await seedCatalog(pool);
  const account = await listen(createAccountApp({ pool, internalServiceToken: secret, log() {} }), cleanup);
  const auth = token => ({ Authorization: `Bearer ${token}` });
  const request = (base, path, token, body, headers) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token && auth(token)), ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const json = async (pending, expected) => {
    const res = await pending;
    const text = await res.text();
    assert.equal(res.status, expected, text);
    return JSON.parse(text);
  };
  async function actor(name, role) {
    const email = `dev55-${name}@example.test`;
    const { user } = await json(request(account, '/api/auth/register', null, { email, name, password }), 201);
    if (role !== 'farmer') await pool.query('INSERT INTO account.user_roles (user_id, role) VALUES ($1,$2)', [user.id, role]);
    const { token } = await json(request(account, '/api/auth/login', null, { email, password }), 200);
    return { id: user.id, token };
  }
  const [farmer, coop, provider, operator, admin, outsider] = await Promise.all([
    actor('owner', 'farmer'), actor('coop', 'coop'), actor('provider', 'provider'), actor('operator', 'operator'),
    actor('admin', 'admin'), actor('outsider', 'farmer'),
  ]);

  // Azure REST protocol stub; no Azure resources or credentials.
  const objects = new Map();
  let blobCalls = 0;
  let failThumbnail = false;
  const storage = await listen(createServer(async (req, res) => {
    blobCalls++;
    const key = req.url;
    if (req.headers.authorization !== 'Bearer synthetic-blob-identity') return res.writeHead(403).end();
    if (req.method === 'PUT' && failThumbnail && key.startsWith('/thumbnails/')) return res.writeHead(503).end();
    if (req.method === 'PUT' && req.headers['if-none-match'] === '*') {
      if (objects.has(key)) return res.writeHead(409, { 'x-ms-error-code': 'BlobAlreadyExists' }).end();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(key, { bytes: Buffer.concat(chunks), type: req.headers['content-type'] });
      return res.writeHead(201, { ETag: '"fixture"' }).end();
    }
    if (req.method === 'DELETE') return res.writeHead(objects.delete(key) ? 202 : 404).end();
    const item = objects.get(key);
    if (req.method === 'GET' && item) return res.writeHead(200, { 'Content-Type': item.type, ETag: '"fixture"' }).end(item.bytes);
    return res.writeHead(404).end();
  }), cleanup);
  const app = () => createApp({ pool, accountServiceUrl: account, internalServiceToken: secret,
    evidenceStore: createBlobStore({ accountUrl: storage, allowLoopback: true, getToken: async () => 'synthetic-blob-identity' }), log() {} });
  let base = await listen(app(), cleanup);
  const call = (path, who, body, headers) => request(base, path, who?.token, body, headers);
  const feed = who => json(call('/api/notifications', who), 200);

  async function stream(who, last, cookie = false, fallback = '0') {
    const controller = new globalThis.AbortController();
    cleanup.push(() => controller.abort());
    const res = await fetch(`${base}/api/events/stream?lastEventId=${fallback}`, {
      signal: controller.signal,
      headers: { ...(cookie ? { Cookie: `agri_session=${who.token}` } : auth(who.token)), ...(last && { 'Last-Event-ID': last }) },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new globalThis.TextDecoder();
    const frames = [];
    let pending = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const lines = pending.slice(0, end).split('\n');
          pending = pending.slice(end + 2);
          const field = name => lines.find(line => line.startsWith(name + ': '))?.slice(name.length + 2);
          if (field('event')) frames.push({ event: field('event'), id: field('id'), data: JSON.parse(field('data')) });
        }
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    return { frames, stop: async () => { controller.abort(); await pump; } };
  }
  async function waitFor(check) {
    const end = Date.now() + 4500;
    while (Date.now() < end) {
      const result = check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Expected SSE event did not arrive');
  }

  const farmerStream = await stream(farmer, null, true);
  const strangerStream = await stream(outsider);
  const fieldId = (await pool.query("INSERT INTO dispatch.fields(owner_id,name,locality,area_m2) VALUES($1,'Test','An Giang',10000) RETURNING id", [farmer.id])).rows[0].id;
  const serviceId = (await pool.query("SELECT id FROM dispatch.services WHERE code='tillage-tractor'")).rows[0].id;
  const booking = (await json(call('/api/bookings', farmer, {
    fieldId, serviceId, startAt: '2099-01-01T08:00:00Z', endAt: '2099-01-01T12:00:00Z',
  }, { 'Idempotency-Key': 'synthetic-dev55-booking' }), 201)).booking;
  const created = await waitFor(() => farmerStream.frames.find(frame => frame.event === 'BOOKING_REQUESTED'));
  assert.equal(created.data.entityId, booking.id);
  const aborted = await pool.connect();
  try {
    await aborted.query('BEGIN');
    await aborted.query("INSERT INTO dispatch.booking_events(booking_id,event_type,to_state,actor_id) VALUES($1,'BOOKING_REQUESTED','REQUESTED',$2)", [booking.id, farmer.id]);
    await aborted.query('SET CONSTRAINTS dispatch.booking_event_notification IMMEDIATE');
    assert.equal((await feed(farmer)).items.length, 1, 'uncommitted outbox row is invisible');
  } finally {
    await aborted.query('ROLLBACK');
    aborted.release();
  }
  assert.equal((await feed(farmer)).items.length, 1, 'rolled-back domain event leaves no notification');
  await farmerStream.stop();
  await json(call(`/api/bookings/${booking.id}/coordinator`, farmer, { coordinatorId: coop.id }), 200);
  const pkg = (await json(call('/api/packages', coop, { bookingIds: [booking.id] }), 201)).package;
  const machineId = (await pool.query("INSERT INTO dispatch.machines(owner_id,name,machine_type) VALUES($1,'Test','tractor') RETURNING id", [provider.id])).rows[0].id;
  await pool.query("UPDATE dispatch.packages SET status='CLAIMED',provider_id=$2,machine_id=$3,operator_id=$4 WHERE id=$1", [pkg.id, provider.id, machineId, operator.id]);
  await pool.query("UPDATE dispatch.bookings SET state='ASSIGNED' WHERE id=$1", [booking.id]);
  await json(call(`/api/bookings/${booking.id}/readiness`, farmer, { drained: true, mature: true, intakeReady: true }), 200);
  await json(call(`/api/bookings/${booking.id}/inspections`, coop, { result: 'PASSED' }), 201);
  const { shift } = await json(call(`/api/packages/${pkg.id}/shifts/start`, operator, {}), 201);
  assert.equal((await json(call(`/api/shifts/${shift.id}/complete`, outsider, { areaM2: 8000 }), 403)).error.code, 'FORBIDDEN');
  await json(call(`/api/shifts/${shift.id}/complete`, operator, { areaM2: 8000 }), 200);
  await json(call(`/api/bookings/${booking.id}/acceptance`, provider, { areaM2: 8000, totalVnd: '1000' }), 201);
  assert.deepEqual((await feed(operator)).items.map(item => item.eventType), ['SHIFT_COMPLETED', 'SHIFT_STARTED', 'PACKAGE_CLAIMED']);
  assert.ok((await feed(coop)).items.some(item => item.eventType === 'ACCEPTANCE_PROPOSED'));
  const dispute = (await json(call(`/api/bookings/${booking.id}/disputes`, farmer, { reason: 'QUALITY', details: 'Private case text' }), 201)).dispute;
  assert.ok((await feed(provider)).items.some(item => item.eventType === 'DISPUTE_OPENED' && item.entityId === dispute.id));
  for (const who of [admin, outsider, coop, operator]) assert.ok(!(await feed(who)).items.some(item => item.entityId === dispute.id));

  // New router instance sees durable rows and header wins over the query fallback.
  base = await listen(app(), cleanup);
  const reconnect = await stream(farmer, created.id);
  await waitFor(() => reconnect.frames.some(frame => frame.event === 'DISPUTE_OPENED'));
  const before = await feed(farmer);
  const catchupIds = reconnect.frames.filter(frame => frame.id).map(frame => frame.id);
  assert.deepEqual(catchupIds, before.items.map(item => item.id).filter(id => BigInt(id) > BigInt(created.id)).reverse());
  assert.equal(new Set(catchupIds).size, catchupIds.length);
  assert.ok(!JSON.stringify(reconnect.frames).includes('Private case text'));
  const providerFeed = await feed(provider);
  const roleRequest = (await json(call('/api/role-requests', outsider, { role: 'operator' }), 201)).request;
  assert.equal((await feed(outsider)).items[0].eventType, 'ROLE_REQUEST_PENDING');
  await json(call(`/api/admin/role-requests/${roleRequest.id}/approve`, admin, {}), 200);
  assert.equal((await feed(admin)).items[0].eventType, 'ROLE_REQUEST_APPROVED');
  await waitFor(() => strangerStream.frames.some(frame => frame.event === 'ROLE_REQUEST_APPROVED'));
  assert.deepEqual(strangerStream.frames.filter(frame => frame.id).map(frame => frame.data.entityId), [roleRequest.id, roleRequest.id]);
  assert.ok(!reconnect.frames.some(frame => frame.data.entityId === roleRequest.id));
  assert.equal((await json(call('/api/notifications/read', farmer, { id: providerFeed.items[0].id }), 200)).unreadCount, before.unreadCount);
  assert.equal((await json(call('/api/notifications/read', farmer, { all: true }), 200)).unreadCount, 0);
  await waitFor(() => reconnect.frames.some(frame => frame.event === 'unread_sync' && frame.data.unreadCount === 0));
  const queryReconnect = await stream(farmer, null, false, catchupIds.at(-1));
  await waitFor(() => queryReconnect.frames.some(frame => frame.event === 'unread_sync'));
  assert.deepEqual(queryReconnect.frames.map(frame => frame.event), ['unread_sync']);
  await queryReconnect.stop();
  assert.equal((await feed(provider)).unreadCount, providerFeed.unreadCount);
  assert.deepEqual((await feed(outsider)).items.map(item => item.entityId), [roleRequest.id, roleRequest.id]);
  assert.equal(strangerStream.frames.filter(frame => frame.id).length, 2);
  await reconnect.stop();
  await strangerStream.stop();

  const casePath = `/api/disputes/${dispute.id}/evidence`;
  const image = await sharp({ create: { width: 640, height: 320, channels: 3, background: '#228b22' } }).withExif({ IFD0: { Make: 'Test' } }).jpeg().toBuffer();
  const upload = (who, bytes = image) => fetch(base + casePath, { method: 'POST', headers: { ...auth(who.token), 'Content-Type': 'image/jpeg' }, body: bytes });
  assert.equal((await upload(outsider)).status, 404);
  assert.equal(blobCalls, 0);
  failThumbnail = true;
  assert.equal((await upload(farmer)).status, 503);
  assert.equal(objects.size, 0, 'failed thumbnail write cleans up original');
  failThumbnail = false;
  const { evidence } = await json(upload(farmer), 201);
  assert.equal((await json(upload(farmer), 200)).evidence.id, evidence.id);
  assert.equal(objects.size, 2, 'upload persists original and thumbnail');
  assert.equal((await json(call(casePath, provider), 200)).items[0].id, evidence.id);
  const evidencePath = `/api/evidence/${evidence.id}`;
  const readBefore = blobCalls;
  for (const who of [outsider, admin, coop, operator]) {
    for (const path of [casePath, `${evidencePath}/content`, `${evidencePath}/thumbnail`]) assert.equal((await call(path, who)).status, 404);
  }
  assert.equal(blobCalls, readBefore);
  const original = await call(`${evidencePath}/content`, provider);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('content-disposition'), 'attachment');
  assert.equal(original.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), image);
  const thumb = [...objects.keys()].find(key => key.startsWith('/thumbnails/'));
  const saved = objects.get(thumb);
  objects.set(thumb, { ...saved, bytes: Buffer.from('not a JPEG') });
  assert.equal((await call(`${evidencePath}/thumbnail`, provider)).status, 503);
  objects.delete(thumb);
  const regenerated = await call(`${evidencePath}/thumbnail`, provider);
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.headers.get('content-type'), 'image/jpeg');
  const thumbnail = sharp(Buffer.from(await regenerated.arrayBuffer()));
  const meta = await thumbnail.metadata();
  assert.deepEqual([meta.width, meta.height, meta.exif], [320, 160, undefined]);
  assert.equal((await thumbnail.raw().toBuffer()).length, 320 * 160 * 3);
  assert.ok(objects.has(thumb));
});

test('notification IDs cannot commit out of order', { timeout: 10000 }, async t => {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url);
  t.after(async () => { await pool.end(); await db.drop(); });
  await migrate(pool);
  const first = await pool.connect();
  const second = await pool.connect();
  const recipient = '00000000-0000-4000-8000-000000000001';
  const insert = `INSERT INTO dispatch.user_notifications (recipient_user_id,event_type,title)
    VALUES($1,'TEST',$2) RETURNING id`;
  let later;
  try {
    await first.query('BEGIN');
    const earlier = (await first.query(insert, [recipient, 'first'])).rows[0].id;
    const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    later = second.query(insert, [recipient, 'second']);
    const findLock = () => pool.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [pid]);
    for (let i = 0; i < 100 && (await findLock()).rows[0]?.wait_event !== 'advisory'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await findLock()).rows[0]?.wait_event, 'advisory');
    assert.equal((await pool.query('SELECT id FROM dispatch.user_notifications')).rowCount, 0);
    await first.query('COMMIT');
    const { id } = (await later).rows[0];
    assert.ok(BigInt(id) > BigInt(earlier));
    const { rows } = await pool.query('SELECT id FROM dispatch.user_notifications ORDER BY id');
    assert.deepEqual(rows.map(row => row.id), [earlier, id]);
  } finally {
    try { await first.query('ROLLBACK'); } finally { first.release(); }
    try { await later; } finally { second.release(); }
  }
});
