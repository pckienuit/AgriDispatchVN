import pg from 'pg';

export function createPool(databaseUrl) {
  // ponytail: queries capped at 5s; give reviewed long-running migrations a separate pool when needed.
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  pool.on('error', (error) => console.error('Idle database connection failed', { name: error.name, code: error.code }));
  return pool;
}
