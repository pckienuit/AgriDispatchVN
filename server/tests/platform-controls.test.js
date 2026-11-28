import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createPlatformControlsRouter, validatePlatformParameters } from '../src/platform-controls.js';

const ADMIN = '10000000-0000-4000-8000-000000000007';
const OPERATOR = '20000000-0000-4000-8000-000000000001';
const JOB = '30000000-0000-4000-8000-000000000001';
const REPORT = '40000000-0000-4000-8000-000000000001';
const actors = { admin: { id: ADMIN, roles: ['admin'] }, operator: { id: OPERATOR, roles: ['operator'] } };
function makeApp(pool) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = actors[req.get('x-actor')]; next(); });
  app.use(createPlatformControlsRouter({ pool, authenticate: (_req, _res, next) => next() }));
  return app;
}
async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('A-04 validates known assumed parameters and rejects unknown/out-of-range values', () => {
  assert.deepEqual(validatePlatformParameters({ radiusM: 1500 }), { radiusM: 1500 });
  assert.throws(() => validatePlatformParameters({ mystery: 1 }), { code: 'VALIDATION_FAILED' });
  assert.throws(() => validatePlatformParameters({ radiusM: -1 }), { code: 'VALIDATION_FAILED' });
});

test('admin endpoints fail closed for non-admin users', async () => {
  const pool = { query: async () => { throw new Error('must not query'); }, connect: async () => { throw new Error('must not connect'); } };
  await withServer(makeApp(pool), async (base) => {
    const response = await fetch(`${base}/api/admin/platform-parameters`, { headers: { 'x-actor': 'operator' } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'FORBIDDEN');
  });
});

test('O-04 report captures authenticated operator and review never mutates job', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO dispatch.job_reports')) return { rows: [{ id: REPORT, job_id: JOB, reporter_id: OPERATOR, reason: 'Scam', status: 'OPEN' }] };
    return { rows: [], rowCount: 1 };
  }, connect: async () => ({ query: async (sql, params) => { calls.push({ sql, params }); return sql.startsWith('UPDATE dispatch.job_reports') ? { rowCount: 1, rows: [{ id: 'report-id' }] } : { rows: [], rowCount: 1 }; }, release() {} }) };
  await withServer(makeApp(pool), async (base) => {
    const response = await fetch(`${base}/api/jobs/${JOB}/reports`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-actor': 'operator' }, body: JSON.stringify({ reason: 'Scam' }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).report.reporter_id, OPERATOR);
    const review = await fetch(`${base}/api/admin/job-reports/${REPORT}/review`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-actor': 'admin' }, body: JSON.stringify({ status: 'REVIEWED', note: '' }) });
    assert.equal(review.status, 200);
    assert.equal(calls.some((c) => /UPDATE dispatch\.jobs/.test(c.sql)), false);
  });
});
