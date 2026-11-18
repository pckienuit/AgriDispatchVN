// Renders the AKS account-service manifests as JSON (kubectl apply -f accepts JSON).
// Inputs are validated against strict patterns before they reach the output; no YAML is parsed or emitted.
// Stdlib only. Output is printed to stdout; nothing is applied from here.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { IMAGE_PATTERN, SHA_PATTERN, UUID_PATTERN, coded, parseFlags } from './lib.js';

export const NAMESPACE = 'agridispatch';
export const ACCOUNT_IP = '10.42.2.10';
export const ACCOUNT_PORT = 3001;
export const WEBAPP_CIDR = '10.42.1.0/24';
export const POSTGRES_CIDR = '10.42.3.0/24';
export const KEY_VAULT_OBJECTS = Object.freeze({
  account: 'ACCOUNT-DATABASE-URL',
  token: 'INTERNAL-SERVICE-TOKEN',
  migration: 'MIGRATION-DATABASE-URL',
  booking: 'BOOKING-DATABASE-URL',
});
const KEY_VAULT_NAME = /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/;
const SUBNET_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const APP_LABEL = { app: 'account' };
const MIGRATE_LABEL = { app: 'account-migrate' };
const WORKLOAD_LABEL = { 'azure.workload.identity/use': 'true' };
const SECURITY = Object.freeze({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } });

function requireMatch(value, pattern, code, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw coded(code, `${label} is missing or malformed`);
  return value;
}

export function validateInputs(input) {
  const image = requireMatch(input.image, IMAGE_PATTERN, 'INVALID_IMAGE', 'image (must be ACR name with @sha256 digest)');
  const sha = requireMatch(input.buildSha, SHA_PATTERN, 'INVALID_SHA', 'buildSha (full 40-char commit SHA)');
  const clientId = requireMatch(input.clientId, UUID_PATTERN, 'INVALID_UUID', 'clientId');
  const tenantId = requireMatch(input.tenantId, UUID_PATTERN, 'INVALID_UUID', 'tenantId');
  const keyVault = requireMatch(input.keyVaultName, KEY_VAULT_NAME, 'INVALID_KEYVAULT', 'keyVaultName');
  const subnet = requireMatch(input.subnetName ?? 'snet-aks', SUBNET_NAME, 'INVALID_SUBNET', 'subnetName');
  const digest = image.split('@sha256:')[1];
  if (!DIGEST_HEX.test(digest)) throw coded('INVALID_IMAGE', 'image digest malformed');
  return { image, sha, clientId, tenantId, keyVault, subnet };
}

// Keys become Kubernetes object names: keep them lowercase DNS labels so no template value escapes its field.
const shortSha = (sha) => sha.slice(0, 12);

function secretProviderClass(name, v, objects) {
  // The azure provider reads this YAML string; every value is validated above, so nothing here is attacker-controlled.
  const objectsYaml = `array:\n${objects.map((o) => `  - |\n    objectName: ${o}\n    objectType: secret`).join('\n')}\n`;
  return {
    apiVersion: 'secrets-store.csi.x-k8s.io/v1',
    kind: 'SecretProviderClass',
    metadata: { name, namespace: NAMESPACE },
    spec: {
      provider: 'azure',
      parameters: {
        useWorkloadIdentity: 'true',
        clientID: v.clientId,
        keyvaultName: v.keyVault,
        tenantId: v.tenantId,
        objects: objectsYaml,
      },
    },
  };
}

function csiVolume(spClassName) {
  return {
    name: 'kv-secrets',
    csi: { driver: 'secrets-store.csi.k8s.io', readOnly: true, volumeAttributes: { secretProviderClass: spClassName } },
  };
}

const secretEnv = (name, secret, key) => ({ name, valueFrom: { secretKeyRef: { name: secret, key } } });

function podSecurity() {
  return { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } };
}

function egressRules() {
  return [
    { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
    { to: [{ ipBlock: { cidr: POSTGRES_CIDR } }], ports: [{ protocol: 'TCP', port: 5432 }] },
    // Broad 443 for Key Vault and Entra token exchange. Narrow it when service tags or NSG rules allow.
    { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 443 }] },
  ];
}

function networkPolicy(name, selector, ingress) {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace: NAMESPACE },
    spec: { podSelector: { matchLabels: selector }, policyTypes: ingress ? ['Ingress', 'Egress'] : ['Egress'], ...(ingress ? { ingress } : {}), egress: egressRules() },
  };
}

export function renderAccount(input) {
  const v = validateInputs(input);
  const spName = 'agridispatch-account-kv';
  const account = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'account', namespace: NAMESPACE, labels: APP_LABEL },
    spec: {
      replicas: 2,
      revisionHistoryLimit: 5,
      selector: { matchLabels: APP_LABEL },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: {
        metadata: { labels: { ...APP_LABEL, ...WORKLOAD_LABEL } },
        spec: {
          serviceAccountName: 'agridispatch-account',
          automountServiceAccountToken: false,
          securityContext: podSecurity(),
          volumes: [csiVolume(spName), { name: 'tmp', emptyDir: {} }],
          containers: [{
            name: 'account',
            image: v.image,
            command: ['node', 'server/src/account-server.js'],
            ports: [{ name: 'http', containerPort: ACCOUNT_PORT, protocol: 'TCP' }],
            env: [
              { name: 'PORT', value: String(ACCOUNT_PORT) },
              { name: 'NODE_ENV', value: 'production' },
              { name: 'BUILD_SHA', value: v.sha },
              secretEnv('DATABASE_URL', 'account-secrets', 'DATABASE_URL'),
              secretEnv('INTERNAL_SERVICE_TOKEN', 'account-secrets', 'INTERNAL_SERVICE_TOKEN'),
            ],
            resources: { requests: { cpu: '256m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } },
            livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10, timeoutSeconds: 2, failureThreshold: 3 },
            readinessProbe: { httpGet: { path: '/ready', port: 'http' }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 },
            securityContext: SECURITY,
            volumeMounts: [{ name: 'kv-secrets', mountPath: '/mnt/secrets-store', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
          }],
        },
      },
    },
  };
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'account',
      namespace: NAMESPACE,
      labels: APP_LABEL,
      annotations: {
        'service.beta.kubernetes.io/azure-load-balancer-internal': 'true',
        'service.beta.kubernetes.io/azure-load-balancer-internal-subnet': v.subnet,
        'service.beta.kubernetes.io/azure-load-balancer-ipv4': ACCOUNT_IP,
      },
    },
    spec: { type: 'LoadBalancer', selector: APP_LABEL, ports: [{ name: 'http', port: ACCOUNT_PORT, targetPort: 'http', protocol: 'TCP' }] },
  };
  const serviceAccount = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'agridispatch-account', namespace: NAMESPACE, annotations: { 'azure.workload.identity/client-id': v.clientId } },
    automountServiceAccountToken: false,
  };
  const pdb = {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'account', namespace: NAMESPACE },
    spec: { minAvailable: 1, selector: { matchLabels: APP_LABEL } },
  };
  const ingress = [{ from: [{ ipBlock: { cidr: WEBAPP_CIDR } }], ports: [{ protocol: 'TCP', port: ACCOUNT_PORT }] }];
  // secretObjects makes the CSI driver sync Key Vault values into the Kubernetes Secret the env refs point at.
  const accountProvider = secretProviderClass(spName, v, [KEY_VAULT_OBJECTS.account, KEY_VAULT_OBJECTS.token]);
  accountProvider.spec.secretObjects = [{
    secretName: 'account-secrets',
    type: 'Opaque',
    data: [
      { objectName: KEY_VAULT_OBJECTS.account, key: 'DATABASE_URL' },
      { objectName: KEY_VAULT_OBJECTS.token, key: 'INTERNAL_SERVICE_TOKEN' },
    ],
  }];
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NAMESPACE, labels: { 'pod-security.kubernetes.io/enforce': 'restricted' } } },
    serviceAccount,
    accountProvider,
    account,
    service,
    pdb,
    networkPolicy('account-allow-webapp', APP_LABEL, ingress),
  ];
}

// Separate Job: never runs from the Deployment. Uses the privileged migration URL and its own identity subject.
export function renderMigrationJob(input) {
  const v = validateInputs(input);
  const migrationId = requireMatch(input.migrationClientId, UUID_PATTERN, 'INVALID_UUID', 'migration identity');
  if (migrationId.toLowerCase() === v.clientId.toLowerCase()) throw coded('IDENTITY_CONFLICT', 'migration identity must differ from runtime identity');
  v.clientId = migrationId;
  const spName = 'agridispatch-migrate-kv';
  const migrationSa = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'agridispatch-migrate', namespace: NAMESPACE, annotations: { 'azure.workload.identity/client-id': v.clientId } },
    automountServiceAccountToken: false,
  };
  const provider = secretProviderClass(spName, v, [KEY_VAULT_OBJECTS.migration]);
  provider.spec.secretObjects = [{ secretName: 'migration-secrets', type: 'Opaque', data: [{ objectName: KEY_VAULT_OBJECTS.migration, key: 'DATABASE_URL' }] }];
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: `account-migrate-${shortSha(v.sha)}`, namespace: NAMESPACE, labels: MIGRATE_LABEL },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { ...MIGRATE_LABEL, ...WORKLOAD_LABEL } },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: 'agridispatch-migrate',
          automountServiceAccountToken: false,
          securityContext: podSecurity(),
          volumes: [csiVolume(spName), { name: 'tmp', emptyDir: {} }],
          containers: [{
            name: 'migrate',
            image: v.image,
            command: ['node', 'server/scripts/migrate.js'],
            env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'BUILD_SHA', value: v.sha }, secretEnv('DATABASE_URL', 'migration-secrets', 'DATABASE_URL')],
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
            securityContext: SECURITY,
            volumeMounts: [{ name: 'kv-secrets', mountPath: '/mnt/secrets-store', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
          }],
        },
      },
    },
  };
  return [migrationSa, provider, job, networkPolicy('account-migrate-egress', MIGRATE_LABEL, null)];
}

export function renderList(items) {
  return { apiVersion: 'v1', kind: 'List', items };
}

const FLAGS = {
  '--image': { key: 'image' },
  '--sha': { key: 'buildSha' },
  '--client-id': { key: 'clientId' },
  '--migration-client-id': { key: 'migrationClientId' },
  '--tenant-id': { key: 'tenantId' },
  '--keyvault': { key: 'keyVaultName' },
  '--subnet': { key: 'subnetName' },
  '--mode': { key: 'mode' },
};

export function main(argv) {
  const args = parseFlags(argv, FLAGS);
  const mode = args.mode ?? 'account';
  if (!['account', 'migration'].includes(mode)) throw coded('INVALID_MODE', '--mode must be account or migration');
  const items = mode === 'account' ? renderAccount(args) : renderMigrationJob(args);
  return `${JSON.stringify(renderList(items), null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`render failed: ${error.code ?? 'ERROR'}`);
    process.exitCode = 1;
  }
}
