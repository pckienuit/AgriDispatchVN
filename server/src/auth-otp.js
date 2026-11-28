import { Buffer } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect as tcpConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export const OTP_TTL_SECONDS = 900;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_FORMAT = /^[A-Za-z0-9_-]{22}$/;
export function generateOtp() { return randomBytes(16).toString('base64url'); }

const { AbortSignal } = globalThis;
const DELIVERY_TIMEOUT_MS = 5000;
const MAILBOX = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const deliveryFailed = () => new Error('OTP delivery failed');

// Missing or unsafe config disables issuing codes; never fall back to stdout or cleartext in production.
export function createOtpDelivery(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (env.OTP_DELIVERY_MODE === 'webhook') {
    let url;
    try { url = new URL(env.OTP_WEBHOOK_URL); } catch { return null; }
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' &&
      (production || url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)))) return null;
    const secret = env.OTP_WEBHOOK_SECRET;
    return async (identifier, _email, otp) => {
      const body = JSON.stringify({ identifier, channel: identifier.includes('@') ? 'email' : 'phone', otp, expiresInSeconds: OTP_TTL_SECONDS });
      const headers = { 'Content-Type': 'application/json' };
      if (secret) headers['X-OTP-Signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
      await response.body?.cancel();
      if (!response.ok) throw deliveryFailed();
    };
  }
  if (env.OTP_DELIVERY_MODE === 'smtp') {
    const { SMTP_HOST: host, SMTP_PORT: portText = '587', SMTP_FROM: from, SMTP_USER: user, SMTP_PASS: pass } = env;
    const port = Number(portText);
    const mode = env.SMTP_TLS_MODE ?? (port === 465 ? 'implicit' : 'starttls');
    if (!host || !(isIP(host) || /^[a-z0-9.-]{1,253}$/i.test(host)) || !/^\d{1,5}$/.test(portText) || port < 1 || port > 65535 ||
      !from || from.length > 254 || !MAILBOX.test(from) || Boolean(user) !== Boolean(pass) ||
      [user, pass].some((part) => part && (part.length > 512 || /\p{Cc}/u.test(part))) ||
      !['implicit', 'starttls', 'plain'].includes(mode) || (mode === 'plain' && (production || !LOOPBACK.has(host)))) return null;
    return async (_identifier, email, otp) => {
      if (!email || !MAILBOX.test(email)) throw deliveryFailed();
      await sendSmtp({ host, port, from, user, pass, mode }, email, otp);
    };
  }
  return null;
}

function readReply(socket, expected, message) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let code;
    const lines = [];
    const cleanup = () => {
      socket.off('data', read);
      socket.off('close', fail);
      socket.off('error', fail);
    };
    function fail() { cleanup(); reject(deliveryFailed()); }
    function read(chunk) {
      buffer += chunk.toString('ascii');
      if (buffer.length > 8192) return fail();
      for (let index; (index = buffer.indexOf('\r\n')) !== -1;) {
        const line = /^([2-5]\d\d)([ -])(.*)$/.exec(buffer.slice(0, index));
        if (!line || (code && code !== Number(line[1])) || lines.length >= 32) return fail();
        code = Number(line[1]);
        lines.push(line[3]);
        buffer = buffer.slice(index + 2);
        if (line[2] === ' ') {
          if (!expected.includes(code) || buffer) return fail();
          cleanup();
          return resolve({ code, lines });
        }
      }
    }
    if (socket.destroyed) return fail();
    socket.on('data', read);
    socket.once('close', fail);
    socket.once('error', fail);
    if (message !== undefined) socket.write(`${message}\r\n`);
  });
}

async function sendSmtp({ host, port, from, user, pass, mode }, to, otp) {
  const tlsOptions = { servername: isIP(host) ? undefined : host, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  // Keep late errors (including after QUIT) from escaping when no reply is pending.
  const own = (socket) => socket.on('error', () => {});
  let socket = own(mode === 'implicit' ? tlsConnect({ host, port, ...tlsOptions }) : tcpConnect({ host, port }));
  const timer = setTimeout(() => socket.destroy(), DELIVERY_TIMEOUT_MS);
  const base64 = (text) => Buffer.from(text).toString('base64');
  const reply = (expected, message) => readReply(socket, expected, message);
  try {
    await reply([220]);
    let { lines } = await reply([250], 'EHLO agridispatch');
    if (mode === 'starttls') {
      if (!lines.some((line) => /^STARTTLS\b/i.test(line))) throw deliveryFailed();
      await reply([220], 'STARTTLS');
      socket = own(tlsConnect({ socket, host, ...tlsOptions }));
      await once(socket, 'secureConnect', { signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
      ({ lines } = await reply([250], 'EHLO agridispatch'));
    }
    if (user) {
      const auth = lines.flatMap((line) => /^AUTH[ =](.+)$/i.exec(line)?.[1].toUpperCase().split(/\s+/) ?? []);
      if (auth.includes('PLAIN')) {
        const credentials = base64(`\0${user}\0${pass}`);
        if ((await reply([235, 334], `AUTH PLAIN ${credentials}`)).code === 334) await reply([235], credentials);
      } else if (auth.includes('LOGIN')) {
        await reply([334], 'AUTH LOGIN');
        await reply([334], base64(user));
        await reply([235], base64(pass));
      } else throw deliveryFailed();
    }
    await reply([250], `MAIL FROM:<${from}>`);
    await reply([250, 251], `RCPT TO:<${to}>`);
    await reply([354], 'DATA');
    await reply([250], [ `From: <${from}>`, `To: <${to}>`, 'Subject: AgriDispatch password reset',
      'Content-Type: text/plain; charset=utf-8', '', `OTP: ${otp}`, 'This code expires in 15 minutes.', '.' ].join('\r\n'));
    socket.end('QUIT\r\n');
  } finally {
    clearTimeout(timer);
    if (!socket.writableEnded) socket.destroy();
    else socket.setTimeout(1000, () => socket.destroy());
  }
}
