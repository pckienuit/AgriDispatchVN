import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAccountApp } from '../../src/account-app.js';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

test('real account roles protect recruitment and concurrent HTTP accepts consume one slot', async (t) => {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url);
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await pool.end(); await db.drop();
  });
  await migrate(pool);
  const secret = 'synthetic-service-credential-0123456789abcdef';
  const listen = async (app) => {
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  const accountUrl = await listen(createAccountApp({ pool, internalServiceToken: secret }));
  const url = await listen(createApp({ pool, accountServiceUrl: accountUrl, internalServiceToken: secret }));
  const post = async (path, body, token) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const session = async (name, role) => {
    const email = name + '@example.com'; const password = 'synthetic-test-passphrase';
    const registered = await post('/api/auth/register', { email, name, password });
    assert.equal(registered.status, 201);
    // Test fixture only: a trusted admin grant, never a client-provided role.
    if (role !== 'farmer') await pool.query('INSERT INTO account.user_roles(user_id,role) VALUES($1,$2)', [registered.body.user.id, role]);
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.status, 200); return login.body.token;
  };
  const provider = await session('synthetic-provider', 'provider');
  const operators = await Promise.all([session('synthetic-operator-a', 'operator'), session('synthetic-operator-b', 'operator')]);
  const jobInput = { title: 'Tuyển thợ mô phỏng', locality: 'Địa bàn mô phỏng', capacity: 1, startAt: '2026-12-01T01:00:00Z', endAt: '2026-12-01T05:00:00Z' };
  assert.equal((await post('/api/jobs', jobInput, operators[0])).status, 403);
  const created = await post('/api/jobs', jobInput, provider);
  assert.equal(created.status, 201); const jobId = created.body.job.id;
  const offers = [];
  for (const operator of operators) {
    const application = await post(`/api/jobs/${jobId}/applications`, {}, operator);
    assert.equal(application.status, 201);
    const offer = await post(`/api/applications/${application.body.application.id}/offers`, {}, provider);
    assert.equal(offer.status, 201); offers.push(offer.body.offer.id);
  }
  const accepted = await Promise.all(operators.map((token, i) => post(`/api/offers/${offers[i]}/accept`, {}, token)));
  assert.deepEqual(accepted.map((r) => r.status).sort(), [200, 409]);
  const winner = accepted.findIndex((r) => r.status === 200);
  assert.equal((await post(`/api/offers/${offers[winner]}/accept`, {}, operators[winner])).status, 200);
  assert.equal((await pool.query("SELECT count(*)::integer n FROM dispatch.offers WHERE status='ACCEPTED' AND job_id=$1", [jobId])).rows[0].n, 1);
  assert.equal((await post(`/api/offers/${offers[winner]}/decline`, {}, provider)).status, 403);
});
