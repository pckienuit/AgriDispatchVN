import pg from 'pg';

export function createPool(databaseUrl, { statementTimeout = 5000 } = {}) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 1000,
  });
  pool.on('error', (error) => console.error('Idle database connection failed', { name: error.name, code: error.code }));
  return pool;
}
