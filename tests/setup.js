import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../server/src/db.js';
import { testRoot } from './fixture.js';

const docker = (args, env = process.env) => execFileSync('docker', args, {
  env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 45_000,
}).trim();
let container;
let containerName;

export async function globalSetup() {
  const chromium = process.env.CHROMIUM_BIN || 'chromium';
  try {
    const version = execFileSync(chromium, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    console.log(`BTTH5 browser: ${version}`);
  } catch {
    throw new Error('Install Chromium or set CHROMIUM_BIN to its executable');
  }
  if (process.env.TEST_DATABASE_URL !== undefined) {
    testRoot(process.env.TEST_DATABASE_URL);
    return;
  }

  // ponytail: one local Docker container per run; use TEST_DATABASE_URL for a pre-existing test cluster.
  const name = `agridispatch-btth5-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const user = 'btth5';
  const db = 'agridispatch_btth5_test';
  try {
    const endpoint = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    const localSocket = /^(unix|npipe):\/\//;
    if (!localSocket.test(endpoint) || (process.env.DOCKER_HOST && !localSocket.test(process.env.DOCKER_HOST))) {
      throw new Error('Not a local Docker socket');
    }
    container = docker(['create', '--rm', '--name', name, '--tmpfs', '/var/lib/postgresql/data',
      '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_USER=${user}`,
      '-e', `POSTGRES_DB=${db}`, 'postgres:17-alpine'], { ...process.env, POSTGRES_PASSWORD: password });
    containerName = name;
    docker(['start', container]);
    const [, port] = /^127\.0\.0\.1:(\d+)$/.exec(docker(['port', name, '5432/tcp'])) ?? [];
    if (!port) throw new Error('Docker did not expose PostgreSQL on loopback');
    process.env.TEST_DATABASE_URL = `postgresql://${user}:${password}@127.0.0.1:${port}/${db}`;
  } catch {
    await globalTeardown();
    throw new Error('Cannot start local postgres:17-alpine; check Docker or set TEST_DATABASE_URL to a dedicated local *_test database');
  }

  try {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    try {
      for (let attempt = 1; ; attempt++) {
        try { await pool.query('SELECT 1'); break; } catch {
          if (attempt === 30) throw new Error('Temporary PostgreSQL did not become ready');
          await delay(200);
        }
      }
    } finally {
      await pool.end();
    }
    console.log(`BTTH5 PostgreSQL: ${name} (PostgreSQL 17, ephemeral container)`);
  } catch (error) {
    await globalTeardown();
    throw error;
  }
}

export async function globalTeardown() {
  if (!container) return;
  docker(['rm', '-f', container]);
  console.log(`BTTH5 cleanup: removed ${containerName}`);
  container = undefined;
}
