import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelease } from './preflight.js';
import { probeOnce } from './health.js';
import { runCommand, requireOk, parseJsonOutput } from './lib.js';
export async function verifyRelease(release, { run = runCommand, probe = probeOnce } = {}) {
  const t = release.target;
  const common = ['--subscription', t.subscription, '--resource-group', t.resourceGroup];
  const result = await probe(t.productionProbeUrl, release.sha);
  if (!result.ok) throw new Error('Production readiness or SHA mismatch');
  const webFx = requireOk(await run(['az', 'webapp', 'config', 'show', ...common, '--name', t.app, '--query', 'linuxFxVersion', '-o', 'tsv']), 'Web App image').trim();
  if (webFx !== `DOCKER|${release.images.app}`) throw new Error('Web App image revision mismatch');
  const deployment = parseJsonOutput(requireOk(await run(['kubectl', '--kubeconfig', t.kubeconfig, '--context', t.context, '-n', 'agridispatch', 'get', 'deployment/account', '-o', 'json']), 'account revision'), 'account revision');
  const container = deployment.spec?.template?.spec?.containers?.find(c => c.name === 'account');
  if (container?.image !== release.images.app || container.env?.find(e => e.name === 'BUILD_SHA')?.value !== release.sha || deployment.status?.observedGeneration !== deployment.metadata?.generation || deployment.status?.updatedReplicas !== deployment.spec?.replicas || deployment.status?.availableReplicas !== deployment.spec?.replicas) throw new Error('Account deployed revision mismatch');
  const functionFx = requireOk(await run(['az', 'functionapp', 'config', 'show', ...common, '--name', t.functionApp, '--query', 'linuxFxVersion', '-o', 'tsv']), 'Function revision').trim();
  if (functionFx !== `DOCKER|${release.images.function}`) throw new Error('Function image revision mismatch');
  return { status: 'REVISION_CHECKS_PASSED', sha: release.sha, actualBlobInvocationVerified: false, crossServiceCloudWorkflowVerified: false, acceptanceComplete: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) loadRelease(process.argv.slice(2)).then(r => verifyRelease(r)).then(r => console.log(JSON.stringify(r))).catch(() => { console.error('Cloud revision verification failed'); process.exitCode = 1; });
