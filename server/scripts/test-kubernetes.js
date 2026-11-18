// Dedicated local Kind runtime test. Never targets AKS or claims cloud identity verification.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs } from 'node:util';

const exec = promisify(execFile);
const { AbortSignal } = globalThis;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stage = 'target validation';
export function validateLocalTarget({ context, server, image, buildSha }) {
  let url;
  try { url = new URL(server); } catch { throw new Error('Invalid local Kubernetes test target'); }
  if (context !== 'kind-agridispatch-ready' || url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      typeof image !== 'string' || !/^agridispatch-vn:kind-[a-z0-9-]{7,48}$/.test(image) || typeof buildSha !== 'string' || !/^[a-f0-9]{40}$/.test(buildSha)) throw new Error('Invalid local Kubernetes test target');
}

async function main() {
  const { values } = parseArgs({ options: { kubeconfig: { type: 'string' }, kubectl: { type: 'string', default: 'kubectl' }, image: { type: 'string' }, sha: { type: 'string' }, output: { type: 'string' } } });
  assert.ok(values.kubeconfig && values.image && values.sha && values.output, '--kubeconfig --image --sha --output required');
  const output = resolve(values.output);
  const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  assert.ok(!output.startsWith(repo + '/') && output !== repo, 'output must be outside repository');
  const base = ['--kubeconfig', resolve(values.kubeconfig)];
  async function kubectl(args) {
    try { return (await exec(values.kubectl, [...base, ...args], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
    catch { throw new Error(`Local kubectl operation failed: ${args[0]}`); }
  }
  const config = JSON.parse(await kubectl(['config', 'view', '--minify', '-o', 'json']));
  validateLocalTarget({ context: config['current-context'], server: config.clusters[0].cluster.server, image: values.image, buildSha: values.sha });
  const ns = 'agridispatch-probe-' + randomBytes(5).toString('hex');
  const resource = (kind, name, spec, extra = {}) => ({ apiVersion: kind === 'Deployment' ? 'apps/v1' : kind === 'Job' ? 'batch/v1' : 'v1', kind, metadata: { name, namespace: ns }, ...(spec ? { spec } : {}), ...extra });
  async function apply(items) {
    const child = spawn(values.kubectl, [...base, 'apply', '-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const result = new Promise((r, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? r() : reject(new Error('Local kubectl apply failed'))); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try { await result; } finally { clearTimeout(timer); }
  }
  const dbPassword = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  const env = ['DATABASE_URL', 'INTERNAL_SERVICE_TOKEN'].map(name => ({ name, valueFrom: { secretKeyRef: { name: 'runtime', key: name } } }));
  const service = (name, port) => resource('Service', name, { selector: { app: name }, ports: [{ port, targetPort: port }] });
  const deploy = (name, container) => resource('Deployment', name, { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [container] } } });
  const app = (name, port, entry) => deploy(name, { name, image: values.image, imagePullPolicy: 'Never', command: ['node', entry], env: [...env, { name: 'PORT', value: String(port) }, { name: 'BUILD_SHA', value: values.sha }, ...(name === 'booking' ? [{ name: 'ACCOUNT_SERVICE_URL', value: 'http://account:3001' }] : [{ name: 'REQUIRE_SIGNED_CLIENT_IDENTITY', value: 'true' }])],
    securityContext: { runAsNonRoot: true, runAsUser: 1000, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
    readinessProbe: { httpGet: { path: '/ready', port }, periodSeconds: 2 }, livenessProbe: { httpGet: { path: '/health', port }, initialDelaySeconds: 5, periodSeconds: 5 } });
  let created = false, forward, restartReadRetries = 0;
  try {
    stage = 'namespace creation';
    await apply([{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } }]); created = true;
    stage = 'database readiness';
    await apply([resource('Secret', 'runtime', null, { stringData: { DATABASE_URL: `postgresql://fixture:${dbPassword}@db/runtime_test`, INTERNAL_SERVICE_TOKEN: token, POSTGRES_PASSWORD: dbPassword } }),
      deploy('db', { name: 'db', image: 'postgres:17-alpine', imagePullPolicy: 'Never', env: [{ name: 'POSTGRES_USER', value: 'fixture' }, { name: 'POSTGRES_DB', value: 'runtime_test' }, { name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: 'runtime', key: 'POSTGRES_PASSWORD' } } }], readinessProbe: { exec: { command: ['pg_isready', '-U', 'fixture', '-d', 'runtime_test', '-h', '127.0.0.1'] }, periodSeconds: 2 } }), service('db', 5432)]);
    await kubectl(['-n', ns, 'rollout', 'status', 'deployment/db', '--timeout=90s']);
    stage = 'migration job';
    await apply([resource('Job', 'migrate', { backoffLimit: 0, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'migrate', image: values.image, imagePullPolicy: 'Never', command: ['node', 'server/scripts/migrate.js'], env }] } } })]);
    const deadline = Date.now() + 90000;
    for (;;) {
      const job = JSON.parse(await kubectl(['-n', ns, 'get', 'job/migrate', '-o', 'json']));
      if (job.status?.failed) throw new Error('Local migration Job failed');
      if (job.status?.succeeded === 1) break;
      if (Date.now() > deadline) throw new Error('Local migration Job timed out');
      await sleep(500);
    }
    stage = 'service readiness';
    await apply([app('account', 3001, 'server/src/account-server.js'), service('account', 3001), app('booking', 3000, 'server/src/server.js'), service('booking', 3000)]);
    for (const name of ['account', 'booking']) await kubectl(['-n', ns, 'rollout', 'status', 'deployment/' + name, '--timeout=90s']);
    stage = 'cross-service network readiness';
    await kubectl(['-n', ns, 'exec', 'deployment/booking', '--', 'node', '-e', "(async()=>{for(let i=0;i<40;i++){try{const r=await fetch('http://account:3001/ready',{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}process.exitCode=1;})()"]);
    stage = 'unsigned account request rejected';
    await kubectl(['-n', ns, 'exec', 'deployment/booking', '--', 'node', '-e', "(async()=>{const r=await fetch('http://account:3001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'synthetic-kind@example.com',password:'unsigned-test-only'}),signal:AbortSignal.timeout(3000)});const b=await r.json();if(r.status!==400||b.error?.code!=='INVALID_CLIENT_IDENTITY')process.exitCode=1;})().catch(()=>{process.exitCode=1;})"]);
    stage = 'port forward';
    const listener = createServer();
    await new Promise(r => listener.listen(0, '127.0.0.1', r));
    const port = listener.address().port;
    await new Promise(r => listener.close(r));
    forward = spawn(values.kubectl, [...base, '-n', ns, 'port-forward', '--address=127.0.0.1', 'service/booking', `${port}:3000`], { stdio: 'ignore' });
    forward.on('error', () => {});
    async function request(path, body, auth) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) console.error(`Local HTTP check failed: ${path} status ${response.status}`);
      assert.ok(response.ok, `Local HTTP status ${response.status}`);
      return { data: await response.json(), revision: response.headers.get('X-Build-SHA') };
    }
    for (let attempt = 0; ; attempt++) {
      try { assert.equal((await request('/ready')).revision, values.sha); break; }
      catch (error) { if (attempt >= 30) throw error; await sleep(250); }
    }
    stage = 'authenticated HTTP workflow';
    const password = randomBytes(24).toString('base64url');
    await request('/api/auth/register', { email: 'synthetic-kind@example.com', name: 'Synthetic Kubernetes', password });
    stage = 'login HTTP workflow';
    const auth = (await request('/api/auth/login', { email: 'synthetic-kind@example.com', password })).data.token;
    stage = 'field HTTP workflow';
    const field = (await request('/api/fields', { name: 'Synthetic Kubernetes field', locality: 'Synthetic', areaM2: 10000 }, auth)).data.field;
    stage = 'account rolling restart';
    await kubectl(['-n', ns, 'rollout', 'restart', 'deployment/account']);
    await kubectl(['-n', ns, 'rollout', 'status', 'deployment/account', '--timeout=90s']);
    // Readiness is pod-local; endpoint propagation and pooled HTTP sockets can lag a rollout.
    // Retry this read only. Never retry a state-changing request as a readiness check.
    for (let attempt = 0; ; attempt++) {
      try {
        assert.ok((await request('/api/fields', undefined, auth)).data.items.some(row => row.id === field.id));
        break;
      } catch (error) {
        if (attempt >= 10) throw error;
        restartReadRetries++;
        await sleep(500);
      }
    }
    await writeFile(output, JSON.stringify({ localOnly: true, declaredBuildSha: values.sha, image: values.image, migrationJob: true, nonRootReadOnly: true, unsignedAccountRequestRejected: true, signedGatewayRegisterLogin: true, crossServiceRegisterLogin: true, fieldAndSessionPersistAfterAccountRollingRestart: true, restartReadRetries, uninterruptedAvailabilityVerified: false, cloudIdentityRbacVnetVerified: false }) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('KUBERNETES_SYSTEM_PASS: local runtime only; cloud identity, RBAC and VNet unverified');
  } catch (error) {
    const network = await kubectl(['-n', ns, 'exec', 'deployment/booking', '--', 'node', '-e', "fetch('http://account:3001/health').then(r=>console.log('ACCOUNT_HEALTH',r.status)).catch(e=>console.log('ACCOUNT_NETWORK',e.cause?.code??e.name))"]).catch(() => 'network diagnostic unavailable');
    console.error(network.trim());
    console.error(await kubectl(['-n', ns, 'get', 'endpointslices', '-o', 'wide']).catch(() => 'endpoint diagnostic unavailable'));
    console.error(await kubectl(['-n', ns, 'exec', 'deployment/account', '--', 'node', '-e', "console.log('PORT',process.env.PORT);fetch('http://127.0.0.1:3001/health').then(r=>console.log('SELF',r.status)).catch(e=>console.log('SELF',e.cause?.code))"]).catch(() => 'account self check unavailable'));
    for (const name of ['account', 'booking']) {
      const logs = await kubectl(['-n', ns, 'logs', 'deployment/' + name, '--tail=20']).catch(() => '');
      for (const line of logs.split('\n')) {
        const match = /(?:name: '([A-Za-z]+)', code: '([A-Z0-9_]+)')/.exec(line);
        if (match) console.error(`Local ${name} dependency error ${match[1]} ${match[2]}`);
      }
    }
    throw error;
  } finally {
    if (forward) { forward.kill('SIGTERM'); await sleep(250); if (forward.exitCode === null) forward.kill('SIGKILL'); }
    if (created) await kubectl(['delete', 'namespace', ns, '--wait=true', '--timeout=90s']);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error(`Local Kubernetes system test failed at ${stage}; no secret values logged`); process.exitCode = 1; });
