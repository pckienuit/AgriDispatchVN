import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './health.js';
import { BUDGET_GATE_PATTERN, SHA_PATTERN, UUID_PATTERN, coded, parseJsonOutput, requireOk, runCommand } from './lib.js';

const { AbortSignal, Response } = globalThis;
const registryRepo = 'acris402agri.azurecr.io/agridispatch-vn';
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const account = { name: 'app-account-bt05a1', origin: 'https://app-account-bt05a1.azurewebsites.net' };
const booking = { name: 'app-booking-bt05a1', origin: 'https://app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net' };
const bookingKudu = 'https://app-booking-bt05a1-dhedg0a2c0aecnfh.scm.japaneast-01.azurewebsites.net/api/command';
const services = [account, booking];

function validate(result, env, now) {
  const sha = env.BUILD_SHA;
  const subscription = env.DEMO_AZURE_SUBSCRIPTION_ID;
  const checkedAt = Date.parse(env.QUOTA_CHECKED_AT);
  if (!UUID_PATTERN.test(subscription ?? '') || !BUDGET_GATE_PATTERN.test(env.BUDGET_APPROVAL_ID ?? '') ||
      !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 86_400_000) {
    throw coded('DEMO_APPROVAL_REQUIRED', 'Demo requires the approved Azure subscription and a current quota check');
  }
  const app = Array.isArray(result?.images) ? result.images.filter((image) => image?.name === 'app') : [];
  if (!SHA_PATTERN.test(sha ?? '') || result?.sha !== sha || result.status !== 'SUCCESS' || result.publish !== true ||
      app.length !== 1 || app[0].tag !== sha || app[0].repository !== 'agridispatch-vn' ||
      !digestPattern.test(app[0].digest ?? '') || app[0].ref !== `${registryRepo}@${app[0].digest}`) {
    throw coded('DEMO_RELEASE_REFUSED', 'Jenkins artifact must identify the published demo image for this commit');
  }
  return { sha, subscription, image: app[0].ref };
}

function accountFetch(token, fetchImpl) {
  return async (url, { signal }) => {
    if (url.origin !== account.origin || !['/health', '/ready'].includes(url.pathname)) {
      throw coded('DEMO_PROBE_REFUSED', 'Account probe requested an unexpected URL');
    }
    // Account denies public ingress. Run only these two HTTP probes from booking's staging subnet.
    const response = await fetchImpl(bookingKudu, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `curl -fsSi --max-time 5 ${account.origin}${url.pathname}`, dir: '/home' }),
    });
    if (!response.ok) throw coded('DEMO_KUDU_PROBE_FAILED', 'Booking Kudu could not probe account');
    const { Output, ExitCode } = await response.json();
    if (ExitCode !== 0 || typeof Output !== 'string' || Output.length > 8192) {
      throw coded('DEMO_KUDU_PROBE_FAILED', 'Account probe returned an invalid result');
    }
    const clean = Output.replaceAll('\r\n', '\n');
    const end = clean.indexOf('\n\n');
    const headers = clean.slice(0, end);
    if (end < 0 || !/^HTTP\/\S+ 200(?: |\n)/.test(headers)) {
      throw coded('DEMO_KUDU_PROBE_FAILED', 'Account did not return HTTP 200');
    }
    const sha = /^x-build-sha:\s*([0-9a-f]{40})[ \t]*$/im.exec(headers)?.[1] ?? '';
    return new Response(clean.slice(end + 2), { headers: { 'X-Build-SHA': sha } });
  };
}

export async function deployDemo(result, env, { run = runCommand, wait = waitReady, fetchImpl = fetch, now = Date.now() } = {}) {
  const target = validate(result, env, now);
  const az = async (...args) => requireOk(await run(['az', ...args, '--only-show-errors']), args.slice(0, 3).join(' ')).trim();
  const active = await az('account', 'show', '--query', 'id', '-o', 'tsv');
  if (active.toLowerCase() !== target.subscription.toLowerCase()) throw coded('SUBSCRIPTION_MISMATCH', 'Wrong Azure service connection');

  const common = (service) => ['--subscription', target.subscription, '-g', 'rg-is402-agri', '-n', service.name];
  const snapshot = async (service) => {
    const image = await az('webapp', 'sitecontainers', 'show', ...common(service), '--container-name', 'main', '--query', 'image || properties.image', '-o', 'tsv');
    const sha = await az('webapp', 'config', 'appsettings', 'list', ...common(service), '--query', "[?name=='BUILD_SHA'].value | [0]", '-o', 'tsv');
    if (!image.startsWith(`${registryRepo}@`) || !digestPattern.test(image.slice(registryRepo.length + 1)) || !SHA_PATTERN.test(sha)) {
      throw coded('DEMO_SNAPSHOT_REFUSED', 'Current image digest or BUILD_SHA is missing');
    }
    return { image, sha };
  };
  const apply = async (service, release) => {
    await az('webapp', 'sitecontainers', 'update', ...common(service), '--container-name', 'main', '--image', release.image, '-o', 'none');
    await az('webapp', 'config', 'appsettings', 'set', ...common(service), '--settings', `BUILD_SHA=${release.sha}`, '-o', 'none');
  };
  const token = await az('account', 'get-access-token', '--resource', 'https://management.azure.com/', '--query', 'accessToken', '-o', 'tsv');
  if (!token) throw coded('DEMO_TOKEN_MISSING', 'Missing token for the internal health probe');
  const privateFetch = accountFetch(token, fetchImpl);
  const verify = async (service, release) => {
    const current = await snapshot(service);
    if (current.image !== release.image || current.sha !== release.sha) throw coded('DEMO_READBACK_MISMATCH', 'Azure readback differs from the requested release');
    const client = service === account ? privateFetch : fetchImpl;
    const ready = await wait(service.origin, release.sha, { fetchImpl: client, timeoutMs: 9000 });
    if (!ready.ok) throw coded('DEMO_NOT_READY', `${service.name} /ready did not return the requested SHA`);
    const health = await client(new URL('/health', service.origin), { signal: AbortSignal.timeout(9000), redirect: 'error' });
    await health.body?.cancel();
    if (health.status !== 200 || health.headers.get('x-build-sha') !== release.sha) {
      throw coded('DEMO_HEALTH_MISMATCH', `${service.name} /health did not return the requested SHA`);
    }
  };

  // Take both snapshots and verify the old release before changing either service.
  const previous = await Promise.all(services.map(snapshot));
  await Promise.all(services.map((service, index) => verify(service, previous[index])));
  const changed = [];
  try {
    for (const [index, service] of services.entries()) {
      if (previous[index].image !== target.image || previous[index].sha !== target.sha) {
        changed.push({ service, release: previous[index] });
        await apply(service, target);
      }
      await verify(service, target);
    }
  } catch (error) {
    let restored = true;
    for (const { service, release } of changed.reverse()) {
      try { await apply(service, release); } catch { restored = false; }
    }
    for (const [index, service] of services.entries()) {
      try { await verify(service, previous[index]); } catch { restored = false; }
    }
    if (!restored) throw coded('DEMO_ROLLBACK_UNVERIFIED', 'At least one app could not be verified after restore');
    throw coded(error.code ?? 'DEMO_DEPLOY_FAILED', 'Deploy failed and the previous release was verified');
  }
  return { sha: target.sha, image: target.image, services: services.map(({ name }) => name) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const artifact = await readFile(process.argv[2], 'utf8');
    const result = parseJsonOutput(artifact, 'Jenkins artifact');
    console.log(JSON.stringify(await deployDemo(result, process.env)));
  } catch (error) {
    console.error(`Demo deploy failed (${error.code ?? 'ERROR'}): ${error.message}`);
    process.exitCode = 1;
  }
}
