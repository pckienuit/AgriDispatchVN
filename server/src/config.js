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
