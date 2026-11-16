import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createPool } from './db.js';

try {
  const config = readConfig();
  const pool = createPool(config.databaseUrl);
  const server = createApp({ pool }).listen(config.port, '0.0.0.0', () => {
    console.log(`Listening on port ${config.port}`);
  });
  let stopping = false;
  function shutdown(code = 0) {
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
