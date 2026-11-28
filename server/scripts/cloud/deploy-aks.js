// AKS deploy helper. Default: dry-run prints the planned argv steps as JSON lines (no secret values, no cloud calls).
// --execute requires an explicit subscription UUID, the bt05 resource group, a cluster resource ID, an expected kube context,
// a kubeconfig path outside the default kubeconfig, a budget gate ID and a bounded ready timeout.
// ponytail: readiness is polled from kubectl JSON with one deadline; no retry on transient API errors. Ceiling: flaky API servers. Upgrade: backoff per call.
import { fileURLToPath } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { renderAccount, renderMigrationJob } from './render-k8s.js';
import {
  BUDGET_GATE_PATTERN, RESOURCE_GROUP, UUID_PATTERN, assertTargetAccount, coded, delay, parseFlags, parseJsonOutput, requireOk, runCommand,
} from './lib.js';

const CLUSTER_ID = /^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([A-Za-z0-9._()-]{1,90})\/providers\/Microsoft\.ContainerService\/managedClusters\/([A-Za-z0-9_-]{1,63})$/i;
const CONTEXT = /^[A-Za-z0-9_.@:/-]{1,128}$/;
const NAMESPACE = 'agridispatch';
const DEMO_RESOURCE_GROUP = 'rg-is402-agri';
const DEMO_CLUSTER = 'aks-agri-bt05a1';
const DEMO_ACCOUNT_IP = '10.42.2.240';

const FLAGS = {
  '--subscription': { key: 'subscription' },
  '--resource-group': { key: 'resourceGroup' },
  '--cluster-resource-id': { key: 'clusterResourceId' },
  '--context': { key: 'context' },
  '--kubeconfig': { key: 'kubeconfig' },
  '--image': { key: 'image' },
  '--sha': { key: 'buildSha' },
  '--client-id': { key: 'clientId' },
  '--migration-client-id': { key: 'migrationClientId' },
  '--tenant-id': { key: 'tenantId' },
  '--keyvault': { key: 'keyVaultName' },
  '--subnet': { key: 'subnetName' },
  '--ready-timeout': { key: 'readyTimeout' },
  '--budget-gate': { key: 'budgetGate' },
  '--execute': { key: 'execute', flag: true },
};

export function validateDeployArgs(args) {
  const need = ['subscription', 'clusterResourceId', 'context', 'image', 'buildSha', 'clientId', 'tenantId', 'keyVaultName'];
  for (const key of need) if (!args[key]) throw coded('MISSING_ARG', `Missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  if (!UUID_PATTERN.test(args.subscription)) throw coded('INVALID_SUBSCRIPTION', '--subscription must be a UUID');
  const cluster = CLUSTER_ID.exec(args.clusterResourceId);
  if (!cluster) throw coded('INVALID_CLUSTER_ID', '--cluster-resource-id must be an AKS managedClusters resource ID');
  if (cluster[1].toLowerCase() !== args.subscription.toLowerCase()) throw coded('SUBSCRIPTION_MISMATCH', 'cluster subscription differs from --subscription');
  const resourceGroup = args.resourceGroup ?? RESOURCE_GROUP;
  const approvedGroup = resourceGroup === RESOURCE_GROUP || (resourceGroup === DEMO_RESOURCE_GROUP && cluster[3] === DEMO_CLUSTER);
  if (!approvedGroup || cluster[2] !== resourceGroup) throw coded('RESOURCE_GROUP_MISMATCH', 'cluster must match an approved AKS resource group');
  if (!CONTEXT.test(args.context)) throw coded('INVALID_CONTEXT', '--context has invalid characters');
  const timeout = Number(args.readyTimeout ?? 300);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 900) throw coded('INVALID_TIMEOUT', '--ready-timeout must be 30 to 900 seconds');
  return { subscription: args.subscription, resourceGroup: cluster[2], clusterName: cluster[3], context: args.context, timeout };
}

// Pure: derive the ordered plan. Namespace first, then migration Job to completion, then the account Deployment.
export function buildPlan(args, { kubeconfig = '<kubeconfig>' } = {}) {
  const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  if (kubeconfig !== '<kubeconfig>' && (!isAbsolute(kubeconfig) || kubeconfig.endsWith('/.kube/config') || resolve(kubeconfig).startsWith(repo + '/'))) throw coded('INVALID_KUBECONFIG', 'kubeconfig must be a dedicated absolute path outside the repository');
  const target = validateDeployArgs(args);
  const common = { image: args.image, buildSha: args.buildSha, clientId: args.clientId, migrationClientId: args.migrationClientId, tenantId: args.tenantId, keyVaultName: args.keyVaultName, subnetName: args.subnetName ?? 'snet-aks' };
  const account = renderAccount({ ...common, accountIp: target.resourceGroup === DEMO_RESOURCE_GROUP ? DEMO_ACCOUNT_IP : undefined });
  const migration = renderMigrationJob(common);
  const namespace = account.filter((item) => item.kind === 'Namespace');
  const accountRest = account.filter((item) => item.kind !== 'Namespace');
  const jobName = migration.find((item) => item.kind === 'Job').metadata.name;
  const kubectl = (...rest) => ['kubectl', '--kubeconfig', kubeconfig, '--context', target.context, ...rest];
  return {
    target,
    steps: [
      { label: 'account-context', argv: ['az', 'account', 'show', '--subscription', target.subscription, '-o', 'json'] },
      { label: 'aks-credentials', argv: ['az', 'aks', 'get-credentials', '--subscription', target.subscription, '--resource-group', target.resourceGroup, '--name', target.clusterName, '--context', target.context, '--file', kubeconfig, '--overwrite-existing'] },
      { label: 'apply-namespace', argv: kubectl('apply', '-f', '<namespace.json>'), manifest: { apiVersion: 'v1', kind: 'List', items: namespace } },
      { label: 'apply-migration-identity-and-provider', argv: kubectl('apply', '-f', '<migration.json>'), manifest: { apiVersion: 'v1', kind: 'List', items: migration.filter((item) => item.kind !== 'Job') } },
      { label: 'apply-migration-job', argv: kubectl('apply', '-f', '<migration-job.json>'), manifest: { apiVersion: 'v1', kind: 'List', items: migration.filter((item) => item.kind === 'Job') } },
      { label: 'wait-migration-job', argv: kubectl('-n', NAMESPACE, 'get', 'job', jobName, '-o', 'json'), poll: { kind: 'job', name: jobName, timeout: target.timeout } },
      { label: 'apply-account', argv: kubectl('apply', '-f', '<account.json>'), manifest: { apiVersion: 'v1', kind: 'List', items: accountRest } },
      { label: 'rollout-account', argv: kubectl('-n', NAMESPACE, 'rollout', 'status', 'deployment/account', `--timeout=${target.timeout}s`) },
    ],
  };
}

// Pure: classify a Job object from kubectl JSON. Failed jobs stop the run; no logs or secrets are read.
export function jobOutcome(job) {
  const conditions = job?.status?.conditions ?? [];
  if (conditions.some((c) => c.type === 'Failed' && c.status === 'True')) return 'failed';
  if (conditions.some((c) => c.type === 'Complete' && c.status === 'True')) return 'complete';
  return 'running';
}

export async function waitForJob(run, { kubectlArgv, timeout, now = Date.now, sleep = delay, intervalMs = 5000 }) {
  const deadline = now() + timeout * 1000;
  for (;;) {
    const result = await run(kubectlArgv);
    const outcome = jobOutcome(parseJsonOutput(requireOk(result, 'kubectl get job'), 'kubectl get job'));
    if (outcome !== 'running') return outcome;
    if (now() >= deadline) return 'timeout';
    await sleep(intervalMs);
  }
}

// Execute path: side effects only through injected run(argv). Stops at the first failing step.
export async function execute(plan, { run = runCommand, writeManifest = writeJson, sleep = delay, now = Date.now, intervalMs } = {}) {
  const accountCheck = parseJsonOutput(requireOk(await run(plan.steps[0].argv), 'az account show'), 'az account show');
  assertTargetAccount(accountCheck, plan.target.subscription);
  const done = [];
  for (const step of plan.steps) {
    if (step.label === 'account-context') { done.push(step.label); continue; }
    if (step.poll) {
      const outcome = await waitForJob(run, { kubectlArgv: step.argv, timeout: step.poll.timeout, now, sleep, intervalMs });
      if (outcome !== 'complete') throw coded('MIGRATION_JOB_NOT_COMPLETE', `migration job ${outcome}`);
      done.push(step.label);
      continue;
    }
    if (step.manifest) {
      const file = await writeManifest(step.label, step.manifest);
      const argv = step.argv.map((part) => (part.startsWith('<') ? file : part));
      requireOk(await run(argv), step.label);
    } else {
      requireOk(await run(step.argv), step.label);
    }
    done.push(step.label);
  }
  return done;
}

async function writeJson(label, value) {
  const dir = resolve(process.env.TMPDIR ?? '.', 'k8s-render');
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, `${label}.json`);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function main(argv) {
  const args = parseFlags(argv, FLAGS);
  const kubeconfig = args.kubeconfig;
  if (args.execute) {
    if (!kubeconfig) throw coded('MISSING_ARG', '--kubeconfig required with --execute (scratch path, not default kubeconfig)');
    if (!args.budgetGate || !BUDGET_GATE_PATTERN.test(args.budgetGate)) throw coded('BUDGET_GATE_REQUIRED', '--budget-gate artifact ID required with --execute');
  }
  const plan = buildPlan(args, { kubeconfig: kubeconfig ?? '<kubeconfig>' });
  if (!args.execute) {
    const lines = plan.steps.map((step) => JSON.stringify({ step: step.label, argv: step.argv }));
    return { mode: 'dry-run', lines: lines.join('\n') };
  }
  const done = await execute(plan);
  return { mode: 'executed', done };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((out) => {
    process.stdout.write(`${out.lines ?? JSON.stringify(out)}\n`);
  }).catch((error) => {
    console.error(`deploy failed: ${error.code ?? 'ERROR'}`);
    process.exitCode = 1;
  });
}
