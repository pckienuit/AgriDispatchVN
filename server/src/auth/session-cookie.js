export const SESSION_COOKIE = 'agri_session';
export const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionCookie(header = '') {
  let token = null;
  for (const part of header.split(';')) {
    const pair = part.trim();
    if (!pair.startsWith(`${SESSION_COOKIE}=`)) continue;
    const value = pair.slice(SESSION_COOKIE.length + 1);
    if (token || !SESSION_TOKEN.test(value)) return null;
    token = value;
  }
  return token;
}

export function requestToken(req, bearerPattern) {
  const authorization = req.get('Authorization');
  return authorization === undefined ? sessionCookie(req.get('Cookie')) : bearerPattern.exec(authorization)?.[1];
}

export function isSecure(req) {
  return req.secure || req.get('X-Forwarded-Proto')?.split(',')[0].trim().toLowerCase() === 'https';
}

export function cookieOptions(req) {
  return { httpOnly: true, path: '/', sameSite: 'lax', secure: process.env.NODE_ENV === 'production' || isSecure(req) };
}

export function crossOriginWrite(req, { unsafeRead = false } = {}) {
  if (!unsafeRead && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  if (['cross-site', 'same-site'].includes(req.get('Sec-Fetch-Site'))) return true;
  const origin = req.get('Origin');
  if (origin === undefined) return false;
  const host = req.get('Host');
  if (!host) return true;
  try { return origin !== new URL(`${isSecure(req) ? 'https' : 'http'}://${host}`).origin; } catch { return true; }
}
