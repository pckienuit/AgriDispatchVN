// Release-input gate only. Operator attestations are not independent Azure credit/quota evidence.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, IMAGE_PATTERN, SHA_PATTERN, RESOURCE_GROUP, coded } from './lib.js';
import { buildPlan as aksPlan } from './deploy-aks.js';
import { buildPlan as webPlan } from './bluegreen-webapp.js';
const fail = () => coded('RELEASE_GATE_REFUSED', 'Release input or approval failed validation');
const keys = new Set(['subscription','resourceGroup','app','stagingProbeUrl','productionProbeUrl','clusterResourceId','context','kubeconfig','clientId','migrationClientId','tenantId','keyVaultName','subnetName','readyTimeout','functionApp','functionProbeUrl','approval']);
export function validateRelease(result, target, { sha = result?.sha, budgetApproval, quotaCheckedAt, now = Date.now() } = {}) {
  if (!result || !target || Object.keys(target).some(k => !keys.has(k)) || typeof sha !== 'string' || !SHA_PATTERN.test(sha) || result.sha !== sha || result.status !== 'SUCCESS' || result.publish !== true || result.images?.length !== 2 || target.resourceGroup !== RESOURCE_GROUP) throw fail();
  const images = {};
  let registry;
  for (const image of result.images) {
    if (!['app','function'].includes(image.name) || images[image.name] || image.tag !== sha || !IMAGE_PATTERN.test(image.ref)) throw fail();
    const repo = image.name === 'app' ? 'agridispatch-vn' : 'agridispatch-thumbnail';
    if (image.repository !== repo || image.ref !== `${image.ref.split('/')[0]}/${repo}@${image.digest}`) throw fail();
    const host = image.ref.split('/')[0];
    if (registry && registry !== host) throw fail();
    registry = host; images[image.name] = image.ref;
  }
  const a = target.approval;
  const checked = Date.parse(a?.checkedAt);
  if (!a || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(a.id) || budgetApproval !== a.id || quotaCheckedAt !== a.checkedAt || !Number.isFinite(checked) || checked > now || now - checked > 86400000 || a.quotaVerified !== true || a.costComplete !== true || a.spendingLimitOn !== true || !Number.isFinite(a.capUsd) || a.capUsd <= 0 || a.capUsd > 43.03 || !Number.isFinite(a.remainingCreditUsd) || a.capUsd > a.remainingCreditUsd / 2 || !Number.isFinite(a.estimatedTotalUsd) || a.estimatedTotalUsd <= 0 || a.estimatedTotalUsd > a.capUsd) throw fail();
  const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  if (!isAbsolute(target.kubeconfig ?? '') || target.kubeconfig.endsWith('/.kube/config') || resolve(target.kubeconfig).startsWith(repoRoot + '/')) throw fail();
  const expected = { productionProbeUrl: `https://${target.app}.azurewebsites.net`, stagingProbeUrl: `https://${target.app}-staging.azurewebsites.net`, functionProbeUrl: `https://${target.functionApp}.azurewebsites.net` };
  if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(target.functionApp ?? '')) throw fail();
  for (const [key, value] of Object.entries(expected)) if (target[key] !== value) throw fail();
  const args = { ...target, image: images.app, buildSha: sha, budgetGate: a.id };
  aksPlan(args, { kubeconfig: target.kubeconfig }); webPlan(args);
  return { images, sha, target, budgetGate: a.id };
}
export const FLAGS = {
  '--result': { key: 'result' }, '--target': { key: 'target' }, '--sha': { key: 'sha' },
  '--budget-approval': { key: 'budgetApproval' }, '--quota-checked-at': { key: 'quotaCheckedAt' }, '--execute': { key: 'execute', flag: true },
};
export async function loadRelease(argv, env = process.env) {
  const options = parseFlags(argv, FLAGS);
  const targetPath = options.target ?? env.TARGET_CONFIG_FILE;
  if (!options.result || !targetPath) throw fail();
  async function json(path) {
    const body = await readFile(path);
    if (body.length > 65536) throw fail();
    return JSON.parse(body.toString('utf8'));
  }
  const target = await json(targetPath);
  return { ...validateRelease(await json(options.result), target, { sha: options.sha, budgetApproval: options.budgetApproval ?? env.BUDGET_APPROVAL_ID, quotaCheckedAt: options.quotaCheckedAt ?? env.QUOTA_CHECKED_AT }), execute: options.execute === true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) loadRelease(process.argv.slice(2)).then(r => console.log(JSON.stringify({ status: 'INPUT_GATE_PASSED', sha: r.sha, azureCapacityVerifiedByThisScript: false }))).catch(() => { console.error('Release input gate refused'); process.exitCode = 1; });
