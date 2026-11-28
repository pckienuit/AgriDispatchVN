import { readConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { expireOverdueDeposits } from '../src/local-service-extensions.js';

let pool;
try {
  pool = createPool(readConfig().databaseUrl);
  const expired = await expireOverdueDeposits(pool);
  console.log(JSON.stringify({ expiredCount: expired.length }));
} catch (error) {
  console.error('Deposit expiry failed', { name: error.name, code: error.code });
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
