import { createApp } from './app.js';
import { readBookingConfig } from './config.js';
import { createPool } from './db.js';
import { configuredEvidenceStore } from './local-evidence-store.js';

try {
  const config = readBookingConfig();
  const pool = createPool(config.databaseUrl);
  const server = createApp({ pool, accountServiceUrl: config.accountServiceUrl, internalServiceToken: config.internalServiceToken, trustedProxyHops: config.trustedProxyHops, trustedProxyCidrs: config.trustedProxyCidrs, servicesCacheMs: config.servicesCacheMs, depositExpiryHours: config.depositExpiryHours, buildSha:process.env.BUILD_SHA ?? 'development', evidenceStore:configuredEvidenceStore(process.env) }).listen(config.port, '0.0.0.0');
  server.once('listening', () => {
    console.log(`Listening on port ${config.port}`);
  });
  let stopping = false;
  function shutdown(code = 0) {
    if (code) process.exitCode = code;
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(async (error) => {
      try {
        await pool.end();
        if (error) process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }
    });
  }
  server.on('error', (error) => {
    console.error('HTTP server failed', { name: error.name, code: error.code });
    shutdown(1);
  });
  process.once('SIGTERM', () => shutdown());
  process.once('SIGINT', () => shutdown());
} catch (error) {
  console.error('Startup failed', { name: error.name });
  process.exitCode = 1;
}
