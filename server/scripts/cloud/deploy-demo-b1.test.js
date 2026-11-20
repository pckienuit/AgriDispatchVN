import assert from 'node:assert/strict';
import test from 'node:test';
import { deployDemo } from './deploy-demo-b1.js';
import { probeOnce } from './health.js';

const { Response } = globalThis;
const oldSha = '1'.repeat(40);
const sha = '2'.repeat(40);
const repo = 'acris402agri.azurecr.io/agridispatch-vn';
const oldImage = `${repo}@sha256:${'a'.repeat(64)}`;
const digest = `sha256:${'b'.repeat(64)}`;
const image = `${repo}@${digest}`;
const account = 'app-account-bt05a1';
const booking = 'app-booking-bt05a1';
const env = {
  BUILD_SHA: sha,
  BUDGET_APPROVAL_ID: 'approved-demo',
  QUOTA_CHECKED_AT: '2026-11-21T01:00:00Z',
  DEMO_AZURE_SUBSCRIPTION_ID: '11111111-1111-4111-8111-111111111111',
};
const result = {
  status: 'SUCCESS', sha, publish: true,
  images: [{ name: 'app', tag: sha, repository: 'agridispatch-vn', digest, ref: image }],
};

function fixture({ failBooking = false } = {}) {
  const apps = { [account]: { sha: oldSha, image: oldImage }, [booking]: { sha: oldSha, image: oldImage } };
  const updates = [];
  async function run(args) {
    const app = args[args.indexOf('-n') + 1];
    const state = apps[app];
    let stdout = '';
    assert.equal(args[0], 'az');
    if (args[1] === 'account') stdout = args[2] === 'show' ? env.DEMO_AZURE_SUBSCRIPTION_ID : 'test-token';
    else if (args[2] === 'sitecontainers' && args[3] === 'show') stdout = state.image;
    else if (args[2] === 'sitecontainers' && args[3] === 'update') {
      state.image = args[args.indexOf('--image') + 1];
      updates.push([app, state.image]);
    } else if (args[4] === 'list') stdout = state.sha;
    else if (args[4] === 'set') state.sha = args[args.indexOf('--settings') + 1].slice('BUILD_SHA='.length);
    else assert.fail('Unexpected Azure command');
    return { code: 0, stdout };
  }
  async function fetchImpl(url, options) {
    if (options.method === 'POST') {
      assert.match(String(url), /\.scm\.japaneast-01\.azurewebsites\.net\/api\/command$/);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      const { command, dir } = JSON.parse(options.body);
      assert.equal(dir, '/home');
      assert.match(command, /^curl -fsSi --max-time 5 https:\/\/app-account-bt05a1\.azurewebsites\.net\/(health|ready)$/);
      const body = JSON.stringify({ status: command.endsWith('/ready') ? 'ready' : 'ok' });
      return new Response(JSON.stringify({ ExitCode: 0, Output: `HTTP/2 200\r\nx-build-sha: ${apps[account].sha}\r\n\r\n${body}` }));
    }
    assert.match(url.hostname, /^app-booking-bt05a1-/);
    const bookingSha = apps[booking].sha;
    if (failBooking && bookingSha === sha) return new Response(null, { status: 503 });
    return new Response(JSON.stringify({ status: url.pathname === '/ready' ? 'ready' : 'ok' }), {
      headers: { 'X-Build-SHA': bookingSha },
    });
  }
  return { updates, apps, options: { run, fetchImpl, wait: probeOnce, now: Date.parse(env.QUOTA_CHECKED_AT) } };
}

test('deploys account before booking by digest and is idempotent on retry', async () => {
  const { updates, options } = fixture();
  assert.deepEqual(await deployDemo(result, env, options), { sha, image, services: [account, booking] });
  await deployDemo(result, env, options);
  assert.deepEqual(updates, [[account, image], [booking, image]]);
});

test('restores both previous releases when booking readiness fails', async () => {
  const { updates, apps, options } = fixture({ failBooking: true });
  await assert.rejects(deployDemo(result, env, options), { code: 'DEMO_NOT_READY' });
  assert.deepEqual(updates, [[account, image], [booking, image], [booking, oldImage], [account, oldImage]]);
  assert.equal(apps[account].sha, oldSha);
  assert.equal(apps[booking].sha, oldSha);
});

test('rejects a mismatched artifact or expired quota record before calling Azure', async () => {
  const { options } = fixture();
  options.run = () => assert.fail('Azure must not be called');
  await assert.rejects(deployDemo({ ...result, sha: oldSha }, env, options), { code: 'DEMO_RELEASE_REFUSED' });
  await assert.rejects(deployDemo(result, { ...env, QUOTA_CHECKED_AT: '2026-11-19T01:00:00Z' }, options), { code: 'DEMO_APPROVAL_REQUIRED' });
});
