export function readBookingConfig(env = process.env) {
  const base = readConfig(env);
  let origin;
  try { origin = new URL(env.ACCOUNT_SERVICE_URL); } catch { throw new Error('Invalid booking identity configuration'); }
  const token = env.INTERNAL_SERVICE_TOKEN;
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || typeof token !== 'string' || token.length < 32 || token.length > 256 || /[\r\n]/.test(token)) throw new Error('Invalid booking identity configuration');
  return { ...base, accountServiceUrl: env.ACCOUNT_SERVICE_URL, internalServiceToken: token };
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
