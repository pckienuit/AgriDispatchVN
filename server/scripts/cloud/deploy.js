import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelease } from './preflight.js';
import { buildPlan as aksPlan, execute as aksExecute } from './deploy-aks.js';
import { buildPlan as webPlan, execute as webExecute } from './bluegreen-webapp.js';
import { runCommand, requireOk } from './lib.js';

export async function deployRelease(release, { run = runCommand, deployAccount = aksExecute, deployWeb = webExecute } = {}) {
  const args = { ...release.target, image: release.images.app, buildSha: release.sha, budgetGate: release.budgetGate };
  const account = aksPlan(args, { kubeconfig: release.target.kubeconfig });
  const web = webPlan(args);
  const functionArgs = ['--subscription', args.subscription, '--resource-group', args.resourceGroup, '--name', args.functionApp];
  const functionCommands = [
    ['az', 'functionapp', 'config', 'container', 'set', ...functionArgs, '--image', release.images.function, '--registry-server', `https://${release.images.function.split('/')[0]}`, '--output', 'none'],
    ['az', 'functionapp', 'config', 'appsettings', 'set', ...functionArgs, '--settings', `BUILD_SHA=${release.sha}`, '--output', 'none'],
  ];
  if (!release.execute) return { mode: 'dry-run', steps: [...account.steps.map(s => s.label), 'function-image', 'function-build-sha', ...web.steps.map(s => s.label)] };
  await deployAccount(account, { run });
  for (const command of functionCommands) requireOk(await run(command), 'Function release');
  await deployWeb(web, { run });
  return { mode: 'executed', sha: release.sha, cloudAcceptanceVerified: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) loadRelease(process.argv.slice(2)).then(r => deployRelease(r)).then(r => console.log(JSON.stringify(r))).catch(() => { console.error('Cloud release failed; do not infer rollback of every service'); process.exitCode = 1; });
