import { createPool } from './db.js';
import { readConfig } from './config.js';
import { createAccountApp, checkAccountOptions, DEFAULT_SESSION_TTL_SECONDS } from './account-app.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function readAccountConfig(env = process.env) {
  const base = readConfig({ ...env, PORT: env.PORT ?? '3001' });
  const ttlText = env.SESSION_TTL_SECONDS ?? String(DEFAULT_SESSION_TTL_SECONDS);
  const signed = env.REQUIRE_SIGNED_CLIENT_IDENTITY ?? 'false';
  if (!['true', 'false'].includes(signed)) throw new Error('REQUIRE_SIGNED_CLIENT_IDENTITY must be true or false');
  if (!/^\d+$/.test(ttlText)) throw new Error('SESSION_TTL_SECONDS must be an integer between 60 and 86400');
  const { internalServiceToken, sessionTtlSeconds } = checkAccountOptions({
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
    sessionTtlSeconds: Number(ttlText),
  });
  return { port: base.port, databaseUrl: base.databaseUrl, internalServiceToken, sessionTtlSeconds, requireSignedClientIdentity: signed === 'true' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = readAccountConfig();
    const pool = createPool(config.databaseUrl);
    const server = createAccountApp({ pool, ...config, buildSha:process.env.BUILD_SHA ?? 'development' }).listen(config.port, '0.0.0.0');
    server.once('listening', () => {
      console.log(`Account service listening on port ${config.port}`);
    });
    let stopping = false;
    function shutdown(code = 0) {
      if (code) process.exitCode = code;
      if (stopping) return;
      stopping = true;
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
    console.error('Account startup failed', { name: error.name });
    process.exitCode = 1;
  }
}
