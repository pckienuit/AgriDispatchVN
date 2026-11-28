import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { test } from 'node:test';
import { createOtpDelivery, generateOtp, OTP_FORMAT, OTP_TTL_SECONDS } from '../src/auth-otp.js';
import { cookieOptions, crossOriginWrite, requestToken, sessionCookie } from '../src/auth/session-cookie.js';

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); for (const socket of sockets) socket.destroy(); }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('OTP decodes to 16 random bytes without padding', () => {
  const tokens = Array.from({ length: 64 }, generateOtp);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, OTP_FORMAT);
    assert.equal(Buffer.from(token, 'base64url').length, 16);
  }
  assert.equal(OTP_TTL_SECONDS, 900);
});

test('production refuses missing configuration, plaintext or partial SMTP auth, and unsafe webhook targets', () => {
  const smtp = { OTP_DELIVERY_MODE: 'smtp', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_FROM: 'reset@example.test' };
  const webhook = { OTP_DELIVERY_MODE: 'webhook' };
  for (const config of [ {}, { ...smtp, SMTP_PORT: '1e3' }, { ...smtp, SMTP_USER: 'incomplete' },
    { ...smtp, SMTP_TLS_MODE: 'plain', SMTP_HOST: '127.0.0.1' }, { ...smtp, SMTP_FROM: 'sender@example.test\r\n' },
    { ...webhook, OTP_WEBHOOK_URL: 'http://127.0.0.1' }, { ...webhook, OTP_WEBHOOK_URL: 'https://user@example.test' }, webhook ]) {
    assert.equal(createOtpDelivery({ ...config, NODE_ENV: 'production' }), null);
  }
  assert.equal(typeof createOtpDelivery({ ...smtp, NODE_ENV: 'production' }), 'function');
});

test('webhook signs exact JSON and refuses redirects and non-2xx acknowledgments', async (t) => {
  const seen = [];
  const secret = randomBytes(32).toString('hex');
  const port = await listen(t, createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === '/redirect') return res.writeHead(307, { Location: '/ack' }).end();
    return res.writeHead(req.url === '/ack' ? 204 : 500).end();
  }));
  const make = (path) => createOtpDelivery({ OTP_DELIVERY_MODE: 'webhook', OTP_WEBHOOK_URL: `http://127.0.0.1:${port}${path}`, OTP_WEBHOOK_SECRET: secret });
  const otp = generateOtp();
  await make('/ack')('example@example.test', null, otp);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].headers['x-otp-signature'], `sha256=${createHmac('sha256', secret).update(seen[0].body).digest('hex')}`);
  assert.deepEqual(JSON.parse(seen[0].body), { identifier: 'example@example.test', channel: 'email', otp, expiresInSeconds: 900 });
  await assert.rejects(make('/reject')('example@example.test', null, otp), /OTP delivery failed/);
  await assert.rejects(make('/redirect')('example@example.test', null, otp));
  assert.deepEqual(seen.map(({ path }) => path), ['/ack', '/reject', '/redirect']);
});

test('SMTP fails before sending credentials when server does not offer STARTTLS', async (t) => {
  const received = [];
  const port = await listen(t, createTcpServer((socket) => {
    socket.write('220 synthetic SMTP\r\n');
    socket.on('data', (chunk) => {
      received.push(chunk.toString());
      socket.write('250-synthetic SMTP\r\n');
      socket.write('250 AUTH PLAIN\r\n');
    });
  }));
  const deliver = createOtpDelivery({ OTP_DELIVERY_MODE: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port),
    SMTP_FROM: 'reset@example.test', SMTP_USER: 'fixture', SMTP_PASS: randomBytes(16).toString('hex'), NODE_ENV: 'production' });
  await assert.rejects(deliver('0901234567', 'owner@example.test', generateOtp()), /OTP delivery failed/);
  assert.deepEqual(received, ['EHLO agridispatch\r\n']);
  await assert.rejects(deliver('0901234567', null, generateOtp()), /OTP delivery failed/);
  assert.equal(received.length, 1);
});

const request = (headers, method = 'GET') => ({ method, get: (name) => headers[name.toLowerCase()] });
test('session cookie is strict, Bearer header wins, and insecure proxy requests cannot make cross-site writes', (t) => {
  const token = randomBytes(32).toString('base64url');
  const cookie = `agri_session=${token}`;
  const bearer = /^Bearer ([\w-]{43})$/;
  assert.equal(sessionCookie(`other=1; ${cookie}; another=2`), token);
  assert.equal(sessionCookie(`${cookie}; ${cookie}`), null);
  assert.equal(sessionCookie('agri_session=%20'), null);
  assert.equal(requestToken(request({ cookie }), bearer), token);
  assert.equal(requestToken(request({ authorization: '', cookie }), bearer), undefined);
  const req = request({ host: 'app.example.test', origin: 'https://app.example.test', 'x-forwarded-proto': 'https' }, 'POST');
  assert.equal(cookieOptions(req).secure, true);
  assert.equal(crossOriginWrite(req), false);
  assert.equal(crossOriginWrite(request({ host: 'app.example.test', origin: 'https://other.example.test' }, 'POST')), true);
  assert.equal(crossOriginWrite(request({ 'sec-fetch-site': 'cross-site' })), false);
  const before = process.env.NODE_ENV;
  t.after(() => { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; });
  process.env.NODE_ENV = 'production';
  assert.deepEqual(cookieOptions(request({})), { httpOnly: true, path: '/', sameSite: 'lax', secure: true });
});
