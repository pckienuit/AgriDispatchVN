export function readBookingConfig(env = process.env) {
  const base = readConfig(env);
  let origin;
  try { origin = new URL(env.ACCOUNT_SERVICE_URL); } catch { throw new Error('Invalid booking identity configuration'); }
  const token = env.INTERNAL_SERVICE_TOKEN;
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || typeof token !== 'string' || token.length < 32 || token.length > 256 || /[\r\n]/.test(token)) throw new Error('Invalid booking identity configuration');
  const hops = env.TRUST_PROXY_HOPS ?? '0';
  if (!/^(?:[0-9]|10)$/.test(hops)) throw new Error('Invalid trusted proxy configuration');
  const cidrs = env.TRUSTED_PROXY_CIDRS === undefined ? null : env.TRUSTED_PROXY_CIDRS.split(',').map(s => s.trim());
  const sweepMs = env.DEPOSIT_EXPIRY_SWEEP_INTERVAL_MS ?? '300000';
  if (!/^\d{1,10}$/.test(sweepMs) || Number(sweepMs) > 2147483647) throw new Error('DEPOSIT_EXPIRY_SWEEP_INTERVAL_MS must be an integer between 0 and 2147483647');
  return { ...base, accountServiceUrl: env.ACCOUNT_SERVICE_URL, internalServiceToken: token, trustedProxyHops: Number(hops), trustedProxyCidrs: cidrs, servicesCacheMs: readServicesCacheMs(env), depositExpiryHours: readDepositExpiryHours(env), depositExpirySweepIntervalMs: Number(sweepMs) };
}

export function readDepositExpiryHours(env = process.env) {
  const text = env.DEPOSIT_EXPIRY_HOURS ?? '24';
  if (!/^[1-9][0-9]{0,2}$/.test(text) || Number(text) > 720) throw new Error('DEPOSIT_EXPIRY_HOURS must be an integer between 1 and 720');
  return Number(text);
}

// Optional public service list cache in ms (CL-12). Unset or 0 keeps the cache off.
export function readServicesCacheMs(env = process.env) {
  const text = env.SERVICES_CACHE_MS ?? '0';
  if (!/^\d{1,6}$/.test(text) || Number(text) > 300000) throw new Error('SERVICES_CACHE_MS must be an integer between 0 and 300000');
  return Number(text);
}

export function readConfig(env = process.env) {
  const portText = env.PORT ?? '3000';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL with a host and database');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL with a host and database');
  }
  return { port: Number(portText), databaseUrl: env.DATABASE_URL };
}
