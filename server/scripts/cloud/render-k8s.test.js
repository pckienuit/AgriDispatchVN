// Renderer contract tests. Run: node --test server/scripts/cloud/*.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAccount, renderMigrationJob, main, ACCOUNT_IP, NAMESPACE } from './render-k8s.js';

const good = Object.freeze({
  image: 'agridispatchacr.azurecr.io/account@sha256:' + 'a'.repeat(64),
  buildSha: '14a0e9a71427e1664d24003338578083c47c4322',
  clientId: '11111111-2222-3333-4444-555555555555',
  migrationClientId: '22222222-2222-3333-4444-555555555555',
  tenantId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
  keyVaultName: 'agridispatch-kv',
  subnetName: 'aks',
});
const byKind = (items, kind) => items.find((item) => item.kind === kind);

test('account render emits required kinds with the contract values', () => {
  const items = renderAccount(good);
  const deploy = byKind(items, 'Deployment');
  const svc = byKind(items, 'Service');
  assert.equal(deploy.metadata.namespace, NAMESPACE);
  assert.equal(deploy.spec.replicas, 2);
  assert.deepEqual(deploy.spec.strategy.rollingUpdate, { maxUnavailable: 0, maxSurge: 1 });
  const c = deploy.spec.template.spec.containers[0];
  assert.equal(c.image, good.image);
  assert.deepEqual(c.resources, { requests: { cpu: '256m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } });
  assert.equal(c.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(c.securityContext.capabilities, { drop: ['ALL'] });
  assert.equal(c.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(c.livenessProbe.httpGet.path, '/health');
  assert.equal(c.readinessProbe.httpGet.path, '/ready');
  assert.equal(deploy.spec.template.spec.securityContext.runAsUser, 1000);
  assert.equal(svc.metadata.annotations['service.beta.kubernetes.io/azure-load-balancer-ipv4'], ACCOUNT_IP);
  assert.equal(svc.spec.ports[0].port, 3001);
  assert.equal(byKind(items, 'ServiceAccount').metadata.annotations['azure.workload.identity/client-id'], good.clientId);
  assert.equal(deploy.spec.template.metadata.labels['azure.workload.identity/use'], 'true');
});

test('secret provider syncs both account secrets and sources them from key vault objects', () => {
  const sp = byKind(renderAccount(good), 'SecretProviderClass');
  assert.equal(sp.spec.provider, 'azure');
  assert.equal(sp.spec.parameters.keyvaultName, good.keyVaultName);
  assert.equal(sp.spec.parameters.useWorkloadIdentity, 'true');
  assert.match(sp.spec.parameters.objects, /objectName: ACCOUNT-DATABASE-URL/);
  assert.match(sp.spec.parameters.objects, /objectName: INTERNAL-SERVICE-TOKEN/);
  assert.doesNotMatch(sp.spec.parameters.objects, /MIGRATION/);
  assert.deepEqual(sp.spec.secretObjects[0].data.map((d) => d.key), ['DATABASE_URL', 'INTERNAL_SERVICE_TOKEN']);
});

test('account pod never receives the privileged migration secret', () => {
  const text = JSON.stringify(renderAccount(good));
  assert.doesNotMatch(text, /MIGRATION-DATABASE-URL/);
});

test('network policy allows only web app subnet on 3001 and pins PostgreSQL and DNS egress', () => {
  const np = byKind(renderAccount(good), 'NetworkPolicy');
  assert.deepEqual(np.spec.ingress, [{ from: [{ ipBlock: { cidr: '10.42.1.0/24' } }], ports: [{ protocol: 'TCP', port: 3001 }] }]);
  const cidrs = np.spec.egress.flatMap((r) => (r.to ?? []).map((t) => t.ipBlock?.cidr));
  assert.ok(cidrs.includes('10.42.3.0/24'));
});

test('migration job is separate, backoff 0, uses migration secret only', () => {
  const items = renderMigrationJob(good);
  assert.equal(byKind(items, 'ServiceAccount').metadata.annotations['azure.workload.identity/client-id'], good.migrationClientId);
  assert.notEqual(byKind(items, 'ServiceAccount').metadata.annotations['azure.workload.identity/client-id'], good.clientId);
  const job = byKind(items, 'Job');
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 600);
  const c = job.spec.template.spec.containers[0];
  assert.deepEqual(c.command, ['node', 'server/scripts/migrate.js']);
  assert.equal(c.image, good.image);
  const sp = byKind(items, 'SecretProviderClass');
  assert.match(sp.spec.parameters.objects, /MIGRATION-DATABASE-URL/);
  assert.doesNotMatch(sp.spec.parameters.objects, /INTERNAL-SERVICE-TOKEN/);
  assert.equal(job.spec.template.spec.restartPolicy, 'Never');
});

test('migration refuses the runtime identity or missing migration identity', () => {
  for (const migrationClientId of [undefined, good.clientId]) assert.throws(() => renderMigrationJob({ ...good, migrationClientId }), /migration identity/);
});

test('rejects non-digest image, short or non-hex sha, and injected strings', () => {
  const bad = [
    { image: good.image.replace(/@sha256:.*/, ':latest') },
    { image: good.image.replace('a'.repeat(64), 'G'.repeat(64)) },
    { buildSha: 'main' },
    { buildSha: '14a0e9a' },
    { buildSha: good.buildSha + '\n' },
    { clientId: 'not-a-uuid' },
    { keyVaultName: 'x"; rm -rf /' },
    { keyVaultName: 'kv' },
    { subnetName: 'aks, evil' },
  ];
  for (const patch of bad) {
    assert.throws(() => renderAccount({ ...good, ...patch }), (e) => ['INVALID_IMAGE', 'INVALID_SHA', 'INVALID_UUID', 'INVALID_KEYVAULT', 'INVALID_SUBNET'].includes(e.code), JSON.stringify(patch));
  }
});

test('CLI rejects unknown flag and invalid mode; emits valid JSON List', () => {
  assert.throws(() => main(['--bogus', 'x']), (e) => e.code === 'UNKNOWN_FLAG');
  assert.throws(() => main(['--mode', 'yaml']), (e) => e.code === 'INVALID_MODE');
  const args = ['--image', good.image, '--sha', good.buildSha, '--client-id', good.clientId, '--tenant-id', good.tenantId, '--keyvault', good.keyVaultName];
  const parsed = JSON.parse(main(args));
  assert.equal(parsed.kind, 'List');
  assert.ok(parsed.items.length >= 6);
});
