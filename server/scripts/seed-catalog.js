import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db.js';

// Synthetic demo catalog. Prices are invented placeholder values labelled "synthetic"; they are not market rates
// and not agreed business constants (see docs/cloud-stages.md).
const SERVICES = [
  { id: '00000000-0000-4000-8000-000000000101', code: 'tillage-tractor', name: 'Cày, xới đất bằng máy kéo (giả lập)', pricePerHaVnd: '900000', active: true },
  { id: '00000000-0000-4000-8000-000000000102', code: 'harvest-combine', name: 'Gặt lúa bằng máy gặt đập liên hợp (giả lập)', pricePerHaVnd: '1200000', active: true },
  { id: '00000000-0000-4000-8000-000000000103', code: 'drone-spray', name: 'Phun thuốc bằng drone (giả lập)', pricePerHaVnd: '350000', active: true },
  { id: '00000000-0000-4000-8000-000000000104', code: 'legacy-paused', name: 'Dịch vụ tạm ngưng (giả lập)', pricePerHaVnd: '500000', active: false },
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CONFIRM_VALUE = 'local-synthetic';

// Refuses to seed anything but a local, non-production database that the operator explicitly confirmed.
export function assertSeedAllowed(env = process.env) {
  if (env.NODE_ENV === 'production') throw Object.assign(new Error('Seed refused in production'), { code: 'SEED_REFUSED' });
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw Object.assign(new Error('DATABASE_URL is not a valid URL'), { code: 'SEED_REFUSED' });
  }
  if (!LOCAL_HOSTS.has(url.hostname)) throw Object.assign(new Error('Seed allowed only for loopback hosts'), { code: 'SEED_REFUSED' });
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) {
    throw Object.assign(new Error('Seed requires a PostgreSQL URL without query parameters or fragments'), { code: 'SEED_REFUSED' });
  }
  if (env.SEED_CATALOG_CONFIRM !== CONFIRM_VALUE) {
    throw Object.assign(new Error(`Set SEED_CATALOG_CONFIRM=${CONFIRM_VALUE} to confirm a local synthetic seed`), { code: 'SEED_NOT_CONFIRMED' });
  }
  return url.hostname;
}

// Idempotent UPSERT by fixed id. Never truncates; operational rows (fields, machines) are untouched.
export async function seedCatalog(pool) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    for (const service of SERVICES) {
      await client.query(
        `INSERT INTO dispatch.services (id, code, name, price_per_ha_vnd, data_label, active)
         VALUES ($1, $2, $3, $4, 'synthetic', $5)
         ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name,
           price_per_ha_vnd = EXCLUDED.price_per_ha_vnd, data_label = EXCLUDED.data_label,
           active = EXCLUDED.active, updated_at = now()`,
        [service.id, service.code, service.name, service.pricePerHaVnd, service.active],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
  return { services: SERVICES.length, activeServices: SERVICES.filter((service) => service.active).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    assertSeedAllowed(process.env);
    pool = createPool(process.env.DATABASE_URL, { statementTimeout: 60000 });
    console.log(JSON.stringify(await seedCatalog(pool)));
  } catch (error) {
    const safe = error.code?.startsWith('SEED_') ? error.message : undefined;
    console.error('Catalog seed failed', { name: error.name, code: error.code, message: safe });
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}
