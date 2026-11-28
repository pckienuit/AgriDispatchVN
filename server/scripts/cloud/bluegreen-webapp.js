// Web Apps blue-green helper (booking service). Dry-run by default; --execute needs explicit gates.
// Flow: snapshot production image digest + BUILD_SHA -> set staging image + BUILD_SHA -> probe staging /ready with exact SHA
//       -> swap staging->production -> probe production -> on any failure restore the snapshot digest and SHA on production.
// Never runs migrations and never touches the database. Rollback never assumes a tag: it reuses the recorded digest.
// ponytail: swap-back is not used; rollback reapplies the snapshot to production (restarts the app). Ceiling: one restart of production on rollback. Upgrade: swap-back when staging still holds the snapshot.
// ponytail: az accepts `--container-image-name` with a digest reference is UNVERIFIED in this sandbox (no Azure calls). Confirm with a read-back before first --execute.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { IMAGE_PATTERN, SHA_PATTERN, BUDGET_GATE_PATTERN, RESOURCE_GROUP, UUID_PATTERN, assertTargetAccount, coded, parseFlags, parseJsonOutput, requireOk, runCommand } from './lib.js';
import { waitReady, validateProbeUrl } from './health.js';

const APP_NAME = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const FLAGS = {
  '--subscription': { key: 'subscription' },
  '--resource-group': { key: 'resourceGroup' },
  '--app': { key: 'app' },
  '--staging-slot': { key: 'stagingSlot' },
  '--image': { key: 'image' },
  '--sha': { key: 'buildSha' },
  '--staging-probe-url': { key: 'stagingProbeUrl' },
  '--production-probe-url': { key: 'productionProbeUrl' },
  '--ready-timeout': { key: 'readyTimeout' },
  '--budget-gate': { key: 'budgetGate' },
  '--execute': { key: 'execute', flag: true },
};

export function validateArgs(args) {
  if (!UUID_PATTERN.test(args.subscription ?? '')) throw coded('INVALID_SUBSCRIPTION', '--subscription must be a UUID');
  if ((args.resourceGroup ?? RESOURCE_GROUP) !== RESOURCE_GROUP) throw coded('RESOURCE_GROUP_MISMATCH', `resource group must be ${RESOURCE_GROUP}`);
  if (!APP_NAME.test(args.app ?? '')) throw coded('INVALID_APP', '--app must be a valid Web App name');
  const staging = args.stagingSlot ?? 'staging';
  if (!SLOT_NAME.test(staging) || staging === 'production') throw coded('INVALID_SLOT', 'staging slot must be a non-production slot name');
  if (!IMAGE_PATTERN.test(args.image ?? '')) throw coded('INVALID_IMAGE', '--image must be an ACR reference with @sha256 digest');
  if (!SHA_PATTERN.test(args.buildSha ?? '')) throw coded('INVALID_SHA', '--sha must be the full 40-char commit SHA');
  validateProbeUrl(args.stagingProbeUrl ?? '');
  validateProbeUrl(args.productionProbeUrl ?? '');
  const timeout = Number(args.readyTimeout ?? 120);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 900) throw coded('INVALID_TIMEOUT', '--ready-timeout must be 30 to 900 seconds');
  return { ...args, stagingSlot: staging, resourceGroup: RESOURCE_GROUP, timeout, registryUrl: `https://${args.image.split('/')[0]}` };
}

// Parse `az webapp config container show` output (JSON array of name/value). Value form: "DOCKER|<registry>/<repo>@sha256:<hex>".
// Returns { image } only when a digest reference is present; a tag-only value yields null so rollback refuses to guess.
export function parseContainerSnapshot(json) {
  const entry = (Array.isArray(json) ? json : []).find((item) => item?.name === 'DOCKER_CUSTOM_IMAGE_NAME');
  const raw = String(entry?.value ?? '').replace(/^DOCKER\|/, '');
  return { image: IMAGE_PATTERN.test(raw) ? raw : null };
}

// Parse app setting list (JSON array) for BUILD_SHA. Snapshot without a full SHA cannot drive rollback.
export function parseBuildSha(json) {
  const entry = (Array.isArray(json) ? json : []).find((item) => item?.name === 'BUILD_SHA');
  const value = entry?.value ?? null;
  return SHA_PATTERN.test(value ?? '') ? value : null;
}

const az = (...rest) => ['az', ...rest];

export function buildPlan(args) {
  const v = validateArgs(args);
  const common = ['--subscription', v.subscription, '-g', v.resourceGroup, '-n', v.app];
  return {
    target: v,
    steps: [
      { label: 'account-context', argv: az('account', 'show', '--subscription', v.subscription, '-o', 'json') },
      { label: 'snapshot-container', argv: az('webapp', 'config', 'container', 'show', ...common, '--slot', 'production', '-o', 'json') },
      { label: 'snapshot-app-settings', argv: az('webapp', 'config', 'appsettings', 'list', ...common, '--slot', 'production', '-o', 'json') },
      { label: 'stage-container', argv: az('webapp', 'config', 'container', 'set', ...common, '--slot', v.stagingSlot, '--container-image-name', v.image, '--container-registry-url', v.registryUrl) },
      { label: 'stage-build-sha', argv: az('webapp', 'config', 'appsettings', 'set', ...common, '--slot', v.stagingSlot, '--settings', `BUILD_SHA=${v.buildSha}`) },
      { label: 'probe-staging', probe: { url: v.stagingProbeUrl, sha: v.buildSha } },
      { label: 'swap', argv: az('webapp', 'deployment', 'slot', 'swap', ...common, '--slot', v.stagingSlot, '--target-slot', 'production', '--action', 'swap') },
      { label: 'probe-production', probe: { url: v.productionProbeUrl, sha: v.buildSha } },
    ],
  };
}

// Restore production to the recorded digest and SHA. Throws when the snapshot is incomplete: no guessed tag.
export function rollbackPlan(v, snapshot) {
  if (!snapshot.image || !IMAGE_PATTERN.test(snapshot.image)) throw coded('ROLLBACK_SNAPSHOT_INCOMPLETE', 'previous production digest not recorded');
  if (!snapshot.buildSha) throw coded('ROLLBACK_SNAPSHOT_INCOMPLETE', 'previous production BUILD_SHA not recorded');
  const common = ['--subscription', v.subscription, '-g', v.resourceGroup, '-n', v.app];
  const registryUrl = `https://${snapshot.image.split('/')[0]}`;
  return [
    az('webapp', 'config', 'container', 'set', ...common, '--slot', 'production', '--container-image-name', snapshot.image, '--container-registry-url', registryUrl),
    az('webapp', 'config', 'appsettings', 'set', ...common, '--slot', 'production', '--settings', `BUILD_SHA=${snapshot.buildSha}`),
  ];
}

export async function execute(plan, { run = runCommand, probe = waitReady } = {}) {
  const v = plan.target;
  assertTargetAccount(parseJsonOutput(requireOk(await run(plan.steps[0].argv), 'az account show'), 'az account show'), v.subscription);
  const snapshot = {};
  const container = parseContainerSnapshot(parseJsonOutput(requireOk(await run(plan.steps[1].argv), 'container snapshot'), 'container snapshot'));
  snapshot.image = container.image;
  snapshot.buildSha = parseBuildSha(parseJsonOutput(requireOk(await run(plan.steps[2].argv), 'settings snapshot'), 'settings snapshot'));
  rollbackPlan(v, snapshot); // Refuse a release without a usable rollback before changing anything.
  let swapAttempted = false;
  const done = ['account-context', 'snapshot-container', 'snapshot-app-settings'];

  const rollback = async (reason) => {
    const commands = rollbackPlan(v, snapshot);
    for (const argv of commands) requireOk(await run(argv), 'rollback');
    const check = await probe(v.productionProbeUrl, snapshot.buildSha, { timeoutSeconds: v.timeout });
    if (!check.ok) throw coded('ROLLBACK_NOT_READY', `rollback production not ready (${check.reason})`);
    return { rolledBack: true, reason };
  };

  try {
    for (const step of plan.steps.slice(3, 5)) {
      requireOk(await run(step.argv), step.label);
      done.push(step.label);
    }
    const staged = await probe(v.stagingProbeUrl, v.buildSha, { timeoutSeconds: v.timeout });
    if (!staged.ok) throw coded('STAGING_NOT_READY', `staging not ready (${staged.reason})`);
    done.push('probe-staging');
    swapAttempted = true;
    requireOk(await run(plan.steps[6].argv), 'swap');
    done.push('swap');
    const live = await probe(v.productionProbeUrl, v.buildSha, { timeoutSeconds: v.timeout });
    if (!live.ok) throw coded('PRODUCTION_NOT_READY', `production not ready after swap (${live.reason})`);
    done.push('probe-production');
    return { mode: 'executed', done };
  } catch (error) {
    let rolled;
    try {
      rolled = swapAttempted ? await rollback(error.code ?? 'ERROR') : { rolledBack: false, reason: 'production not changed' };
    } catch (rollbackError) {
      rolled = { rolledBack: false, reason: rollbackError.code ?? 'ROLLBACK_ERROR' };
    }
    throw Object.assign(error, { done, rollback: rolled });
  }
}

export async function main(argv) {
  const args = parseFlags(argv, FLAGS);
  if (args.execute && (!args.budgetGate || !BUDGET_GATE_PATTERN.test(args.budgetGate))) throw coded('BUDGET_GATE_REQUIRED', '--budget-gate artifact ID required with --execute');
  const plan = buildPlan(args);
  if (!args.execute) return { mode: 'dry-run', lines: plan.steps.map((s) => JSON.stringify({ step: s.label, argv: s.argv ?? null, probe: s.probe ? { url: s.probe.url, sha: s.probe.sha } : null })).join('\n') };
  return execute(plan);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((out) => {
    process.stdout.write(`${out.lines ?? JSON.stringify(out)}\n`);
  }).catch((error) => {
    console.error(`bluegreen failed: ${error.code ?? 'ERROR'}`);
    process.exitCode = 1;
  });
}
