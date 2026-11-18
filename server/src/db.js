import pg from 'pg';

export function databaseOptions(databaseUrl) {
  const invalid = () => new TypeError('Invalid database connection configuration');
  let url;
  try { url = new URL(databaseUrl); } catch { throw invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash) throw invalid();
  const local = ['localhost', '127.0.0.1', '[::1]', 'db', 'test-db'].includes(url.hostname);
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'sslmode') || keys.length > 1) throw invalid();
  const mode = url.searchParams.get('sslmode');
  if ((!local && mode !== 'verify-full') || (local && mode !== null && mode !== 'verify-full')) throw invalid();
  if (mode === null) return { connectionString: databaseUrl };
  // Strip libpq options before pg parses them; TLS policy cannot be replaced by URL settings.
  url.search = '';
  return { connectionString: url.href, ssl: { rejectUnauthorized: true } };
}

export function createPool(databaseUrl, { statementTimeout = 5000 } = {}) {
  const pool = new pg.Pool({
    ...databaseOptions(databaseUrl),
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 1000,
  });
  pool.on('error', (error) => console.error('Idle database connection failed', { name: error.name, code: error.code }));
  return pool;
}
