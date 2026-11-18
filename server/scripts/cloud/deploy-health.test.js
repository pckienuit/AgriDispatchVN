// Helper contract tests with injected fakes only. No az/kubectl/network calls.
// Run: node --test server/scripts/cloud/*.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan as buildAksPlan, execute as executeAks, jobOutcome, validateDeployArgs } from './deploy-aks.js';
import { buildPlan as buildWebPlan, execute as executeWeb, parseContainerSnapshot, parseBuildSha, rollbackPlan } from './bluegreen-webapp.js';
import { probeOnce, waitReady } from './health.js';
const { Response } = globalThis;

const SHA = '14a0e9a71427e1664d24003338578083c47c4322';
const DIGEST = 'a'.repeat(64);
const SUB = '11111111-2222-3333-4444-555555555555';
const CLUSTER = `/subscriptions/${SUB}/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.ContainerService/managedClusters/agri-aks`;
const IMAGE = `agridispatchacr.azurecr.io/account@sha256:${DIGEST}`;
const WEB_IMAGE = `agridispatchacr.azurecr.io/booking@sha256:${'b'.repeat(64)}`;
const aksArgs = {
  subscription: SUB, clusterResourceId: CLUSTER, context: 'agri-aks', kubeconfig: '/tmp/x.kubeconfig', image: IMAGE, buildSha: SHA,
  clientId: '11111111-2222-3333-4444-555555555555', migrationClientId: '22222222-2222-3333-4444-555555555555', tenantId: '66666666-7777-8888-9999-aaaaaaaaaaaa', keyVaultName: 'agridispatch-kv', budgetGate: 'gate-1', readyTimeout: '60',
};

test('AKS dry-run plan orders namespace, migration before account rollout and never mutates', () => {
  const steps = buildAksPlan(aksArgs).steps.map((s) => s.label);
  assert.deepEqual(steps, ['account-context', 'aks-credentials', 'apply-namespace', 'apply-migration-identity-and-provider', 'apply-migration-job', 'wait-migration-job', 'apply-account', 'rollout-account']);
  const argvs = buildAksPlan(aksArgs).steps.map((s) => s.argv).flat();
  assert.ok(argvs.includes('--context') && argvs.includes('agri-aks'));
});

test('AKS rejects wrong resource group, wrong subscription and bad cluster ID', () => {
  assert.throws(() => validateDeployArgs({ ...aksArgs, clusterResourceId: CLUSTER.replace('rg-agridispatch-bt05', 'rg-is402') }), (e) => e.code === 'RESOURCE_GROUP_MISMATCH');
  assert.throws(() => validateDeployArgs({ ...aksArgs, subscription: '99999999-2222-3333-4444-555555555555' }), (e) => e.code === 'SUBSCRIPTION_MISMATCH');
  assert.throws(() => validateDeployArgs({ ...aksArgs, clusterResourceId: 'my-cluster' }), (e) => e.code === 'INVALID_CLUSTER_ID');
  assert.throws(() => validateDeployArgs({ ...aksArgs, readyTimeout: '5' }), (e) => e.code === 'INVALID_TIMEOUT');
  assert.throws(() => validateDeployArgs({ ...aksArgs, context: 'ctx; rm -rf /' }), (e) => e.code === 'INVALID_CONTEXT');
});

test('AKS rejects non-digest image and tag-looking sha before any command', () => {
  assert.throws(() => buildAksPlan({ ...aksArgs, image: IMAGE.replace(/@sha256:.*/, ':main') }), (e) => e.code === 'INVALID_IMAGE');
  assert.throws(() => buildAksPlan({ ...aksArgs, buildSha: 'main' }), (e) => e.code === 'INVALID_SHA');
});

test('jobOutcome classifies failed, complete and running', () => {
  assert.equal(jobOutcome({ status: { conditions: [{ type: 'Failed', status: 'True' }] } }), 'failed');
  assert.equal(jobOutcome({ status: { conditions: [{ type: 'Complete', status: 'True' }] } }), 'complete');
  assert.equal(jobOutcome({ status: {} }), 'running');
});

test('AKS execute stops before account apply when migration job fails', async () => {
  const plan = buildAksPlan(aksArgs);
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.join(' '));
    if (argv[0] === 'az' && argv[1] === 'account') return { code: 0, stdout: JSON.stringify({ id: SUB }) };
    if (argv.includes('get') && argv.includes('job')) return { code: 0, stdout: JSON.stringify({ status: { conditions: [{ type: 'Failed', status: 'True' }] } }) };
    return { code: 0, stdout: '' };
  };
  await assert.rejects(executeAks(plan, { run, writeManifest: async (l) => `/tmp/${l}.json`, sleep: async () => {}, intervalMs: 1 }), (e) => e.code === 'MIGRATION_JOB_NOT_COMPLETE');
  assert.equal(calls.some((c) => c.includes('apply -f /tmp/apply-account.json')), false);
});

test('AKS execute refuses when active subscription differs', async () => {
  const plan = buildAksPlan(aksArgs);
  const run = async () => ({ code: 0, stdout: JSON.stringify({ id: '99999999-2222-3333-4444-555555555555' }) });
  await assert.rejects(executeAks(plan, { run, writeManifest: async (l) => `/tmp/${l}.json` }), (e) => e.code === 'SUBSCRIPTION_MISMATCH');
});

test('web plan stages container and SHA on staging before swap and probes both sides', () => {
  const args = { subscription: SUB, app: 'agri-booking-web', image: WEB_IMAGE, buildSha: SHA, stagingProbeUrl: 'https://agri-booking-web-staging.azurewebsites.net', productionProbeUrl: 'https://agri-booking-web.azurewebsites.net', budgetGate: 'g' };
  const labels = buildWebPlan(args).steps.map((s) => s.label);
  assert.deepEqual(labels, ['account-context', 'snapshot-container', 'snapshot-app-settings', 'stage-container', 'stage-build-sha', 'probe-staging', 'swap', 'probe-production']);
  const swap = buildWebPlan(args).steps.find((s) => s.label === 'swap').argv;
  assert.deepEqual(swap.slice(swap.indexOf('--action'), swap.indexOf('--action') + 2), ['--action', 'swap']);
});

test('web plan rejects production as staging slot and bad probe URLs with credentials', () => {
  const base = { subscription: SUB, app: 'agri-booking-web', image: WEB_IMAGE, buildSha: SHA, stagingProbeUrl: 'https://s.example', productionProbeUrl: 'https://p.example' };
  assert.throws(() => buildWebPlan({ ...base, stagingSlot: 'production' }), (e) => e.code === 'INVALID_SLOT');
  assert.throws(() => buildWebPlan({ ...base, stagingProbeUrl: 'https://u:p@s.example' }), (e) => e.code === 'INVALID_PROBE_URL');
  assert.throws(() => buildWebPlan({ ...base, productionProbeUrl: 'https://p.example/?x=1' }), (e) => e.code === 'INVALID_PROBE_URL');
});

test('parsers read digest from DOCKER|value and refuse tag-only values', () => {
  assert.deepEqual(parseContainerSnapshot([{ name: 'DOCKER_CUSTOM_IMAGE_NAME', value: `DOCKER|${WEB_IMAGE}` }]), { image: WEB_IMAGE });
  assert.deepEqual(parseContainerSnapshot([{ name: 'DOCKER_CUSTOM_IMAGE_NAME', value: 'DOCKER|agridispatchacr.azurecr.io/booking:latest' }]), { image: null });
  assert.equal(parseBuildSha([{ name: 'BUILD_SHA', value: SHA }]), SHA);
  assert.equal(parseBuildSha([{ name: 'BUILD_SHA', value: 'latest' }]), null);
});

function webEnv(overrides = {}) {
  const base = { subscription: SUB, app: 'agri-booking-web', image: WEB_IMAGE, buildSha: SHA, stagingProbeUrl: 'https://s.example', productionProbeUrl: 'https://p.example', readyTimeout: '60' };
  return { ...base, ...overrides };
}

function fakeRun({ failOn = null, snapshotImage = `DOCKER|agridispatchacr.azurecr.io/booking@sha256:${'c'.repeat(64)}`, snapshotSha = '0123456789abcdef0123456789abcdef01234567' } = {}) {
  const calls = [];
  const run = async (argv) => {
    const line = argv.join(' ');
    calls.push(line);
    if (argv[1] === 'account') return { code: 0, stdout: JSON.stringify({ id: SUB }) };
    if (argv.includes('container') && argv.includes('show')) return { code: 0, stdout: JSON.stringify([{ name: 'DOCKER_CUSTOM_IMAGE_NAME', value: snapshotImage }]) };
    if (argv.includes('appsettings') && argv.includes('list')) return { code: 0, stdout: JSON.stringify([{ name: 'BUILD_SHA', value: snapshotSha }]) };
    if (failOn && line.includes(failOn)) return { code: 1, stdout: '' };
    return { code: 0, stdout: '' };
  };
  return { run, calls };
}

test('web execute happy path swaps only after staging ready and reports done steps', async () => {
  const { run, calls } = fakeRun();
  const probe = async (url) => ({ ok: true, reason: 'READY', url });
  const out = await executeWeb(buildWebPlan(webEnv()), { run, probe });
  assert.deepEqual(out.done.slice(-2), ['swap', 'probe-production']);
  assert.ok(calls.some((c) => c.includes('deployment slot swap')));
});

test('web execute leaves production untouched when staging is not ready', async () => {
  const { run, calls } = fakeRun();
  const probe = async (url) => (url.includes('s.example') ? { ok: false, reason: 'SHA_MISMATCH' } : { ok: true, reason: 'READY' });
  await assert.rejects(executeWeb(buildWebPlan(webEnv()), { run, probe }), (e) => {
    assert.equal(e.code, 'STAGING_NOT_READY');
    assert.equal(e.rollback.rolledBack, false);
    assert.equal(e.rollback.reason, 'production not changed');
    return true;
  });
  assert.equal(calls.some((c) => c.includes('deployment slot swap')), false);
  const rollbackSet = calls.find((c) => c.includes('--slot production') && c.includes('--container-image-name') && c.includes(`@sha256:${'c'.repeat(64)}`));
  assert.equal(rollbackSet, undefined, 'staging failure must not restart healthy production');
});

test('web execute refuses an incomplete rollback snapshot before changing staging or production', async () => {
  const { run, calls } = fakeRun({ snapshotImage: 'DOCKER|agridispatchacr.azurecr.io/booking:latest' });
  const probe = async () => ({ ok: false, reason: 'UNREACHABLE' });
  await assert.rejects(executeWeb(buildWebPlan(webEnv()), { run, probe }), (e) => {
    assert.equal(e.code, 'ROLLBACK_SNAPSHOT_INCOMPLETE');
    return true;
  });
  assert.equal(calls.some(c => c.includes('container set') || c.includes('slot swap')), false);
});

test('rollbackPlan refuses missing SHA and tag-only digest', () => {
  const v = { subscription: SUB, resourceGroup: 'bt05', app: 'x' };
  assert.throws(() => rollbackPlan(v, { image: WEB_IMAGE, buildSha: null }), (e) => e.code === 'ROLLBACK_SNAPSHOT_INCOMPLETE');
  assert.throws(() => rollbackPlan(v, { image: 'agridispatchacr.azurecr.io/booking:v1', buildSha: SHA }), (e) => e.code === 'ROLLBACK_SNAPSHOT_INCOMPLETE');
});

function fakeFetch(map) {
  return async (url) => {
    const entry = map[new URL(url).pathname] ?? { status: 404 };
    return new Response(entry.badJson ? '{' : JSON.stringify(entry.body ?? {}), { status: entry.status, headers: entry.sha ? { 'x-build-sha': entry.sha } : {} });
  };
}

test('probe passes only with 200, matching X-Build-SHA and ready body', async () => {
  const ok = fakeFetch({ '/ready': { status: 200, sha: SHA, body: { status: 'ready' } } });
  assert.deepEqual(await probeOnce('https://s.example', SHA, { fetchImpl: ok }), { ok: true, reason: 'READY' });
  const wrongSha = fakeFetch({ '/ready': { status: 200, sha: 'f'.repeat(40), body: { status: 'ready' } } });
  assert.equal((await probeOnce('https://s.example', SHA, { fetchImpl: wrongSha })).reason, 'SHA_MISMATCH');
  const notReady = fakeFetch({ '/ready': { status: 503, sha: SHA } });
  assert.equal((await probeOnce('https://s.example', SHA, { fetchImpl: notReady })).reason, 'NOT_READY');
  const badBody = fakeFetch({ '/ready': { status: 200, sha: SHA, badJson: true } });
  assert.equal((await probeOnce('https://s.example', SHA, { fetchImpl: badBody })).reason, 'BAD_BODY');
});

test('probe rejects redirect-prone and unreachable without printing bodies', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED internal-host'); };
  assert.deepEqual(await probeOnce('https://s.example', SHA, { fetchImpl: boom }), { ok: false, reason: 'UNREACHABLE' });
  await assert.rejects(probeOnce('https://s.example', 'short', { fetchImpl: boom }), (e) => e.code === 'INVALID_SHA');
});

test('waitReady stops at deadline with timedOut and never loops forever', async () => {
  let t = 0;
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const fetchImpl = fakeFetch({ '/ready': { status: 503 } });
  const result = await waitReady('https://s.example', SHA, { timeoutSeconds: 10, intervalMs: 3000, now, sleep, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});
