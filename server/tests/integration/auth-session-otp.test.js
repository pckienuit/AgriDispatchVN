import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { test } from 'node:test';
import { bootstrapDatabase } from '../../scripts/bootstrap-db.js';
import { migrate } from '../../scripts/migrate.js';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const PASSWORD = 'synthetic original password';
const NEW_PASSWORD = 'synthetic replacement password';

async function fixture(t, accountOptions = {}) {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const admin = createPool(db.url, { statementTimeout: 60000 });
  const suffix = randomBytes(8).toString('hex');
  const roles = { account: `acct_${suffix}`, booking: `book_${suffix}` };
  const passwords = { account: randomBytes(24).toString('hex'), booking: randomBytes(24).toString('hex') };
  const pools = [];
  const servers = [];
  const logs = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.end();
    await db.drop();
    const cluster = createPool(process.env.TEST_DATABASE_URL);
    try { await cluster.query(`DROP ROLE IF EXISTS ${roles.account}, ${roles.booking}`); } finally { await cluster.end(); }
  });
  await migrate(admin);
  await bootstrapDatabase(admin, { roles, passwords });
  function runtime(key) {
    const url = new URL(db.url);
    url.username = roles[key];
    url.password = passwords[key];
    const pool = createPool(url.href);
    pools.push(pool);
    return pool;
  }
  const listen = async (app) => {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  const internalServiceToken = randomBytes(32).toString('hex');
  const log = (entry) => logs.push(entry);
  const accountServiceUrl = await listen(createAccountApp({ pool: runtime('account'), internalServiceToken, log, ...accountOptions }));
  const bookingPool = runtime('booking');
  const origin = await listen(createApp({ pool: bookingPool, accountServiceUrl, internalServiceToken, log }));
  function request(path, { method = 'GET', body, cookie, token, headers = {}, direct = false } = {}) {
    return fetch(`${direct ? accountServiceUrl : origin}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const post = (path, body, opts) => request(`/api/auth/${path}`, { ...opts, method: 'POST', body });
  return { admin, bookingPool, logs, post, request, listen };
}

function cookieOf(response) {
  const header = response.headers.get('set-cookie');
  assert.match(header ?? '', /^agri_session=[\w-]{43}; .*Max-Age=28800/i);
  assert.match(header, /; Path=\//i);
  assert.match(header, /; HttpOnly/i);
  assert.match(header, /; SameSite=Lax/i);
  return header.split(';')[0];
}

async function deliveriesReach(items, count) {
  for (let tries = 0; tries < 100 && items.length < count; tries += 1) await delay(20);
  assert.equal(items.length, count, 'delivery count');
  return items.at(-1);
}

function loopback(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); for (const socket of sockets) socket.destroy(); }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const email = 'session@example.test';
const register = (post, identifier = { email }) => post('register', { ...identifier, name: 'Synthetic', password: PASSWORD });
const login = (post, password = PASSWORD) => post('login', { email, password });

async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: { code } });
}

test('cookie survives F5 across account and booking APIs, isolates sessions, and clears on logout', async (t) => {
  const { admin, post, request } = await fixture(t);
  const registered = await register(post);
  assert.equal(registered.status, 201);
  const registrationCookie = cookieOf(registered);
  assert.deepEqual(Object.keys(await registered.json()), ['user']);
  const loggedIn = await post('login', { email, password: PASSWORD }, { headers: { 'User-Agent': 'Synthetic browser', 'X-Forwarded-Proto': 'https' } });
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.headers.get('set-cookie') ?? '', /; Secure/i);
  const cookie = cookieOf(loggedIn);
  const { token, user } = await loggedIn.json();
  assert.equal((await request('/v2/', { cookie })).status, 200);
  assert.deepEqual(await (await request('/api/me', { cookie })).json(), { user });
  assert.deepEqual(await (await request('/api/me', { cookie, direct: true })).json(), { user });
  assert.equal((await request('/api/fields', { cookie })).status, 200);
  assert.equal((await request('/api/role-requests', { cookie })).status, 200);
  await error(await request('/api/me', { cookie, token: 'A'.repeat(43) }), 401, 'UNAUTHORIZED');
  assert.equal((await request('/api/me', { token })).status, 200);
  assert.equal((await request('/api/me', { headers: { Prefer: 'anonymous' } })).status, 204);
  await error(await request('/api/me'), 401, 'UNAUTHORIZED');
  await error(await request('/api/auth/sessions/%2e%2e', { method: 'DELETE', cookie }), 404, 'NOT_FOUND');
  await error(await request('/api/auth/sessions/%2f', { method: 'DELETE', cookie }), 400, 'INVALID_REQUEST');

  const other = cookieOf(await register(post, { email: 'other@example.test' }));
  const { sessions: [foreign] } = await (await request('/api/auth/sessions', { cookie: other })).json();
  const { sessions } = await (await request('/api/auth/sessions', { cookie })).json();
  assert.equal(sessions.length, 2);
  const current = sessions.find((session) => session.isCurrent);
  assert.deepEqual(Object.keys(current).sort(), ['createdAt', 'expiresAt', 'id', 'ip', 'isCurrent', 'revokedAt', 'userAgent']);
  assert.equal(current.userAgent, 'Synthetic browser');
  assert.equal(current.ip, '127.0.0.0/24');
  assert.ok(sessions.every(({ id }) => id !== foreign.id));
  const revoke = (id, opts = {}) => request(`/api/auth/sessions/${id}`, { method: 'DELETE', cookie, ...opts });
  await error(await revoke(foreign.id), 404, 'NOT_FOUND');
  assert.equal((await request('/api/me', { cookie: other })).status, 200);
  await error(await revoke(current.id, { headers: { 'Sec-Fetch-Site': 'same-site' } }), 403, 'CROSS_ORIGIN_REQUEST');
  const old = sessions.find((session) => !session.isCurrent);
  assert.equal((await revoke(old.id)).status, 204);
  assert.equal((await request('/api/me', { cookie: registrationCookie })).status, 401);
  const after = (await (await request('/api/auth/sessions', { cookie })).json()).sessions;
  assert.ok(after.find(({ id }) => id === old.id).revokedAt);
  await admin.query("UPDATE account.sessions SET created_at = now() - interval '1 day', expires_at = now() - interval '1 second' WHERE id = $1", [foreign.id]);
  assert.equal((await request('/api/fields', { cookie: other })).status, 401);

  const logout = await post('logout', undefined, { cookie });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie') ?? '', /^agri_session=; .*Expires=Thu, 01 Jan 1970/i);
  assert.equal((await request('/api/fields', { cookie })).status, 401);
  assert.equal((await request('/api/me', { token })).status, 401);
});

test('change password keeps current session and revokes others by default', async (t) => {
  const { post, request } = await fixture(t);
  const first = cookieOf(await register(post));
  const browserLogin = await post('login', { email, password: PASSWORD }, { headers: { Prefer: 'session-cookie' } });
  const current = cookieOf(browserLogin);
  assert.deepEqual(Object.keys(await browserLogin.json()), ['expiresAt', 'user']);
  const change = (currentPassword, newPassword, options = {}) => post('change-password', { currentPassword, newPassword, ...options }, { cookie: current });
  await error(await change('wrong password', NEW_PASSWORD), 401, 'INVALID_CREDENTIALS');
  assert.equal((await change(PASSWORD, NEW_PASSWORD, { revokeOtherSessions: false })).status, 204);
  assert.equal((await request('/api/me', { cookie: first })).status, 200);
  assert.equal((await change(NEW_PASSWORD, `${NEW_PASSWORD} again`)).status, 204);
  assert.equal((await request('/api/me', { cookie: first })).status, 401);
  assert.equal((await request('/api/me', { cookie: current })).status, 200);
  await error(await login(post), 401, 'INVALID_CREDENTIALS');
  assert.equal((await login(post, `${NEW_PASSWORD} again`)).status, 200);
});

test('webhook delivers a hashed, expiring OTP to a phone account; max attempts and concurrent replay cannot reset twice', async (t) => {
  const delivered = [];
  const secret = randomBytes(32).toString('hex');
  const port = await loopback(t, createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    delivered.push({ payload: JSON.parse(raw), signature: req.headers['x-otp-signature'], raw });
    res.writeHead(204).end();
  }));
  const { admin, bookingPool, logs, post, request } = await fixture(t, { otpEnv: {
    OTP_DELIVERY_MODE: 'webhook', OTP_WEBHOOK_URL: `http://127.0.0.1:${port}`, OTP_WEBHOOK_SECRET: secret,
  } });
  const phone = '0901234567';
  const registration = await register(post, { phone });
  const cookie = cookieOf(registration);
  const { user } = await registration.json();
  const second = await post('login', { phone, password: PASSWORD });
  const { token } = await second.json();
  const forgot = (identifier) => post('forgot-password', { identifier });
  const reset = (otp) => post('reset-password', { identifier: phone, otp, newPassword: NEW_PASSWORD });
  const unrecognized = await forgot('missing@example.test');
  const recognized = await forgot('+84 901 234 567');
  assert.equal(recognized.status, 200);
  assert.equal(unrecognized.status, 200);
  assert.deepEqual(await recognized.json(), await unrecognized.json());
  const first = await deliveriesReach(delivered, 1);
  assert.equal(first.signature, `sha256=${createHmac('sha256', secret).update(first.raw).digest('hex')}`);
  const { otp, identifier, channel, expiresInSeconds } = first.payload;
  assert.equal(identifier, phone);
  assert.equal(channel, 'phone');
  assert.equal(expiresInSeconds, 900);
  assert.match(otp, /^[A-Za-z0-9_-]{22}$/);
  const { rows: [row] } = await admin.query(`SELECT token_hash, attempts, used_at,
    extract(epoch FROM expires_at - now())::float8 AS seconds FROM account.password_reset_tokens WHERE user_id = $1`, [user.id]);
  assert.equal(row.token_hash, createHash('sha256').update(otp).digest('hex'));
  assert.ok(row.seconds > 890 && row.seconds <= 900);
  assert.equal(row.attempts, 0);
  assert.equal(row.used_at, null);
  await assert.rejects(bookingPool.query('SELECT token_hash FROM account.password_reset_tokens'), { code: '42501' });

  for (let i = 0; i < 5; i += 1) await error(await reset('A'.repeat(22)), 400, 'INVALID_OTP');
  await error(await reset(otp), 400, 'INVALID_OTP');
  assert.equal((await admin.query('SELECT attempts FROM account.password_reset_tokens WHERE user_id = $1', [user.id])).rows[0].attempts, 5);
  assert.equal((await forgot(phone)).status, 200);
  const fresh = (await deliveriesReach(delivered, 2)).payload.otp;
  const outcomes = await Promise.all([reset(fresh), reset(fresh)]);
  assert.deepEqual(outcomes.map((response) => response.status).sort(), [204, 400]);
  await error(outcomes.find((response) => response.status === 400), 400, 'INVALID_OTP');
  await error(await reset(fresh), 400, 'INVALID_OTP');
  assert.equal((await request('/api/me', { cookie })).status, 401);
  assert.equal((await request('/api/fields', { token })).status, 401);
  await error(await post('login', { phone, password: PASSWORD }), 401, 'INVALID_CREDENTIALS');
  assert.equal((await post('login', { phone, password: NEW_PASSWORD })).status, 200);
  assert.ok((await admin.query('SELECT used_at FROM account.password_reset_tokens WHERE user_id = $1', [user.id])).rows[0].used_at);
  for (const value of [phone, otp, fresh, token, cookie, secret, PASSWORD, NEW_PASSWORD]) {
    assert.equal(JSON.stringify(logs).includes(value), false, 'request log must not contain sensitive data');
  }
});

test('SMTP sends only to the account email; expired codes cannot reset even if unused', async (t) => {
  const delivered = [];
  const commands = [];
  const smtpUser = 'fixture-user';
  const smtpPass = randomBytes(16).toString('hex');
  const server = createTcpServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let data = null;
    socket.write('220 fixture ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\r\n')) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data && line !== '.') { data.push(line); continue; }
        if (data) { delivered.push(data.join('\n')); data = null; socket.write('250 queued\r\n'); continue; }
        commands.push(line);
        if (line.startsWith('EHLO ')) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN ')) socket.write('235 authenticated\r\n');
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 accepted\r\n');
        else if (line === 'DATA') { data = []; socket.write('354 continue\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 unexpected command\r\n');
      }
    });
  });
  const port = await loopback(t, server);
  const { admin, logs, post, request } = await fixture(t, { otpEnv: {
    OTP_DELIVERY_MODE: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_TLS_MODE: 'plain',
    SMTP_FROM: 'reset@example.test', SMTP_USER: smtpUser, SMTP_PASS: smtpPass,
  } });
  const cookie = cookieOf(await register(post));
  const reset = (otp) => post('reset-password', { identifier: email, otp, newPassword: NEW_PASSWORD });
  assert.equal((await post('forgot-password', { identifier: email })).status, 200);
  const first = (await deliveriesReach(delivered, 1)).match(/OTP: ([A-Za-z0-9_-]{22})/)?.[1];
  assert.ok(first);
  await admin.query("UPDATE account.password_reset_tokens SET expires_at = now() - interval '1 second'");
  await error(await reset(first), 400, 'INVALID_OTP');
  assert.equal((await request('/api/me', { cookie })).status, 200);
  assert.equal((await post('forgot-password', { identifier: email })).status, 200);
  const fresh = (await deliveriesReach(delivered, 2)).match(/OTP: ([A-Za-z0-9_-]{22})/)?.[1];
  assert.ok(fresh);
  assert.equal((await reset(fresh)).status, 204);
  assert.equal((await request('/api/me', { cookie })).status, 401);
  await error(await reset(fresh), 400, 'INVALID_OTP');
  assert.ok(commands.includes(`AUTH PLAIN ${Buffer.from(`\0${smtpUser}\0${smtpPass}`).toString('base64')}`));
  assert.ok(commands.includes('MAIL FROM:<reset@example.test>'));
  assert.ok(commands.includes(`RCPT TO:<${email}>`));
  for (const value of [email, first, fresh, smtpPass]) assert.equal(JSON.stringify(logs).includes(value), false);
});

test('forgot is uniform at identifier limits and fails closed without delivery config', async (t) => {
  const { admin, post } = await fixture(t, { otpEnv: { NODE_ENV: 'production' } });
  await register(post);
  const known = await post('forgot-password', { identifier: email });
  const unknown = await post('forgot-password', { identifier: 'missing@example.test' });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  const expected = await known.json();
  assert.deepEqual(await unknown.json(), expected);
  for (let i = 0; i < 3; i += 1) {
    const result = await post('forgot-password', { identifier: ` ${email.toUpperCase()} ` });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), expected);
  }
  const { rows: [tokens] } = await admin.query('SELECT count(*)::int AS count FROM account.password_reset_tokens');
  assert.equal(tokens.count, 0);
  const { rows: [bucket] } = await admin.query('SELECT hits FROM account.rate_limits WHERE bucket = $1', [
    createHash('sha256').update(`forgot-password-id\0${email}`).digest('hex'),
  ]);
  assert.equal(bucket.hits, 4);
  for (let i = 0; i < 11; i += 1) assert.equal((await post('forgot-password', { identifier: `absent-${i}@example.test` })).status, 200);
  const { rows: [ipBucket] } = await admin.query('SELECT hits FROM account.rate_limits WHERE bucket = $1', [
    createHash('sha256').update('forgot-password-ip\0' + '127.0.0.1').digest('hex'),
  ]);
  assert.equal(ipBucket.hits, 16);
  const resetBody = { identifier: email, otp: 'A'.repeat(22), newPassword: NEW_PASSWORD };
  for (let i = 0; i < 15; i += 1) await error(await post('reset-password', resetBody), 400, 'INVALID_OTP');
  const limited = await post('reset-password', resetBody);
  assert.equal(limited.headers.get('retry-after'), '900');
  await error(limited, 429, 'RATE_LIMITED');
});
