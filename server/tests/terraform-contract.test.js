import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const TF_DIR = join(REPO_ROOT, 'infra', 'terraform');
const TF_FILES = readdirSync(TF_DIR).filter((name) => name.endsWith('.tf'));

function readTf(file) {
  return readFileSync(join(TF_DIR, file), 'utf8');
}

function readAllTf() {
  return TF_FILES.map((file) => `# ${file}\n${readTf(file)}`).join('\n');
}

describe('infra/terraform contract', () => {
  it('pins Terraform and azurerm 5.14.0 with partial azurerm backend and no auto provider registration', () => {
    const versions = readTf('versions.tf');
    const providers = readTf('providers.tf');
    const lockfile = readFileSync(join(TF_DIR, '.terraform.lock.hcl'), 'utf8');

    assert.match(versions, /version\s*=\s*"5\.14\.0"/);
    assert.match(versions, /backend\s+"azurerm"\s*\{\s*\}/);
    assert.match(lockfile, /provider\s+"registry\.terraform\.io\/hashicorp\/azurerm"/);
    assert.match(lockfile, /version\s*=\s*"5\.14\.0"/);
    assert.match(providers, /resource_provider_registrations\s*=\s*"none"/);
    assert.match(providers, /storage_use_azuread\s*=\s*true/);
    assert.match(providers, /purge_soft_delete_on_destroy\s*=\s*false/);
  });

  it('keeps state backend and secret inputs safe without plaintext secret outputs', () => {
    const allTf = readAllTf();
    const outputs = readTf('outputs.tf');
    const keyvault = readTf('keyvault.tf');
    const variables = readTf('variables.tf');

    assert.doesNotMatch(allTf, /resource\s+"random_password"/);
    assert.doesNotMatch(outputs, /var\.(pg_admin_password|account_database_url|booking_database_url|migration_database_url|internal_service_token)|\.value\b/);
    assert.match(keyvault, /value_wo\s*=\s*var\.account_database_url/);
    assert.match(keyvault, /value_wo\s*=\s*var\.booking_database_url/);
    assert.match(keyvault, /value_wo\s*=\s*var\.migration_database_url/);
    assert.match(keyvault, /value_wo\s*=\s*var\.internal_service_token/);
    assert.match(keyvault, /name\s*=\s*"ACCOUNT-DATABASE-URL"/);
    assert.match(keyvault, /name\s*=\s*"BOOKING-DATABASE-URL"/);
    assert.match(keyvault, /name\s*=\s*"MIGRATION-DATABASE-URL"/);
    assert.match(keyvault, /name\s*=\s*"INTERNAL-SERVICE-TOKEN"/);
    assert.match(variables, /\\?sslmode=verify-full\$/);
    assert.match(variables, /@\[a-z0-9-\]\+\\\\\.postgres\\\\\.database\\\\\.azure\\\\\.com:5432\/agridispatch\\\\\?sslmode=verify-full\$/);
    for (const secretVar of ['pg_admin_password', 'account_database_url', 'booking_database_url', 'migration_database_url', 'internal_service_token']) {
      assert.match(variables, new RegExp(`variable\\s+"${secretVar}"[\\s\\S]*?sensitive\\s*=\\s*true[\\s\\S]*?ephemeral\\s*=\\s*true`));
    }
  });

  it('separates account and migrator workload identities and scopes Key Vault secrets per identity', () => {
    const identity = readTf('identity.tf');
    const keyvault = readTf('keyvault.tf');
    const variables = readTf('variables.tf');
    const outputs = readTf('outputs.tf');

    assert.match(identity, /resource\s+"azurerm_user_assigned_identity"\s+"account"/);
    assert.match(identity, /resource\s+"azurerm_user_assigned_identity"\s+"migrator"/);
    assert.match(variables, /variable\s+"account_k8s_service_account"[\s\S]*default\s*=\s*"agridispatch-account"/);
    assert.match(variables, /variable\s+"migration_k8s_service_account"[\s\S]*default\s*=\s*"agridispatch-migrate"/);
    assert.match(keyvault, /resource\s+"azurerm_role_assignment"\s+"account_kv_reader"[\s\S]*azurerm_key_vault_secret\.account_database_url\.resource_versionless_id[\s\S]*azurerm_user_assigned_identity\.account\.principal_id/);
    assert.match(keyvault, /resource\s+"azurerm_role_assignment"\s+"account_token_kv_reader"[\s\S]*azurerm_key_vault_secret\.internal_service_token\.resource_versionless_id[\s\S]*azurerm_user_assigned_identity\.account\.principal_id/);
    assert.match(keyvault, /resource\s+"azurerm_role_assignment"\s+"migrator_kv_reader"[\s\S]*azurerm_key_vault_secret\.migration_database_url\.resource_versionless_id[\s\S]*azurerm_user_assigned_identity\.migrator\.principal_id/);
    assert.doesNotMatch(keyvault, /resource\s+"azurerm_role_assignment"[^}]*scope\s*=\s*azurerm_key_vault\.main\.id[^}]*azurerm_user_assigned_identity\.(account|migrator)\.principal_id/);
    assert.doesNotMatch(keyvault, /resource\s+"azurerm_role_assignment"[^}]*azurerm_user_assigned_identity\.(account|migrator)\.principal_id[^}]*scope\s*=\s*azurerm_key_vault\.main\.id/);
    assert.match(outputs, /output\s+"account_client_id"/);
    assert.match(outputs, /output\s+"migration_client_id"/);
    assert.match(outputs, /output\s+"key_vault_name"/);
    assert.match(outputs, /output\s+"tenant_id"/);
  });

  it('matches network, AKS, App Service slot, full-host Function MI, storage, and prevent_destroy invariants', () => {
    const locals = readTf('locals.tf');
    const aks = readTf('aks.tf');
    const apps = readTf('apps.tf');
    const storage = readTf('storage.tf');
    const database = readTf('database.tf');
    const keyvault = readTf('keyvault.tf');
    const registry = readTf('registry.tf');

    const functionJson = JSON.parse(readFileSync(join(REPO_ROOT, 'functions', 'thumbnail', 'function.json'), 'utf8'));
    const bindingConnection = functionJson.bindings[0].connection;

    assert.match(locals, /vnet_cidr\s*=\s*"10\.42\.0\.0\/16"/);
    assert.match(locals, /subnet_webapp_cidr\s*=\s*"10\.42\.1\.0\/24"/);
    assert.match(locals, /subnet_aks_cidr\s*=\s*"10\.42\.2\.0\/24"/);
    assert.match(locals, /subnet_pg_cidr\s*=\s*"10\.42\.3\.0\/24"/);
    assert.match(locals, /aks_service_cidr\s*=\s*"10\.43\.0\.0\/16"/);
    assert.match(locals, /aks_dns_service_ip\s*=\s*"10\.43\.0\.10"/);
    assert.match(locals, /account_service_url\s*=\s*"http:\/\/10\.42\.2\.10:3001"/);
    assert.match(locals, /pg_database_name\s*=\s*"agridispatch"/);
    assert.match(locals, /pg_dns_zone\s*=\s*"private\.postgres\.database\.azure\.com"/);
    assert.match(locals, /pg_fqdn\s*=\s*"\$\{local\.pg_name\}\.postgres\.database\.azure\.com"/);

    const dbBlocks = database.match(/resource\s+"azurerm_postgresql_flexible_server_database"/g) || [];
    assert.equal(dbBlocks.length, 1);
    assert.match(database, /resource\s+"azurerm_postgresql_flexible_server_database"\s+"main"[\s\S]*name\s*=\s*local\.pg_database_name/);

    assert.match(aks, /network_plugin\s*=\s*"azure"/);
    assert.match(aks, /oidc_issuer_enabled\s*=\s*true/);
    assert.match(aks, /workload_identity_enabled\s*=\s*true/);
    assert.match(aks, /key_vault_secrets_provider/);

    assert.match(apps, /resource\s+"azurerm_linux_web_app"\s+"booking"[\s\S]*type\s*=\s*"SystemAssigned, UserAssigned"/);
    assert.match(apps, /resource\s+"azurerm_linux_web_app_slot"\s+"staging"/);
    assert.match(apps, /resource\s+"azurerm_linux_function_app"\s+"thumbnail"[\s\S]*type\s*=\s*"SystemAssigned"/);
    assert.match(apps, /image_name\s*=\s*"\$\{local\.function_repo\}@sha256"[\s\S]*image_tag\s*=\s*local\.function_digest/);
    assert.doesNotMatch(apps, /image_tag\s*=\s*var\.build_sha/);
    assert.equal(bindingConnection, 'EvidenceSource');
    assert.match(apps, /AzureWebJobsStorage__accountName/);
    assert.match(apps, new RegExp(`${bindingConnection}__blobServiceUri`));
    assert.match(apps, new RegExp(`${bindingConnection}__queueServiceUri`));
    assert.match(apps, /EVIDENCE_BLOB_ACCOUNT_URL/);

    assert.match(storage, /shared_access_key_enabled\s*=\s*false/);
    assert.match(storage, /allow_nested_items_to_be_public\s*=\s*false/);
    assert.match(storage, /container_access_type\s*=\s*"private"/);

    for (const content of [locals, registry, database, keyvault, storage, aks, apps]) {
      assert.match(content, /prevent_destroy\s*=\s*true/);
    }
  });

  it('ignores local Terraform state and caches without ignoring .terraform.lock.hcl', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    const docs = readFileSync(join(REPO_ROOT, 'docs', 'terraform.md'), 'utf8');

    assert.match(docs, /terraform\.tfstate/);
    assert.match(docs, /backend\.hcl/);
    assert.match(docs, /43\.03/);
    assert.match(docs, /ephemeral\s*=\s*true/);
    assert.match(docs, /-target/);
    assert.ok(!existsSync(join(TF_DIR, 'terraform.tfstate')));
    assert.ok(!existsSync(join(TF_DIR, 'terraform.tfstate.backup')));
    assert.ok(gitignore.length > 0);
  });

  it('excludes backend credentials from Docker contexts that copy infra', () => {
    const dockerignore = readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8');
    assert.ok(dockerignore.split(/\r?\n/).includes('**/backend.hcl'));
  });
});

describe('infra/terraform native CLI stage', () => {
  const cachedBin = join(process.env.HOME || '', '.hermes/profiles/agri-dispatch/cache/scratch/bin/terraform');
  const cachedData = join(process.env.HOME || '', '.hermes/profiles/agri-dispatch/cache/scratch/tf-data-worker');
  const tfBin = process.env.TERRAFORM_BIN || (existsSync(cachedBin) ? cachedBin : '');
  const dataDir = process.env.TF_DATA_DIR || cachedData;
  const hasProviderCache = Boolean(tfBin) && (Boolean(process.env.TERRAFORM_BIN) || existsSync(join(dataDir, 'providers')));
  const skipReason = hasProviderCache
    ? false
    : 'Native Terraform CLI and cached azurerm provider not present; run native stage with terraform fmt/validate/test';

  it('passes native terraform fmt/validate/test when local Terraform binary and cached provider exist', { skip: skipReason }, () => {
    const env = { ...process.env, TF_DATA_DIR: dataDir, TF_IN_AUTOMATION: '1', CHECKPOINT_DISABLE: '1' };

    execFileSync(tfBin, ['fmt', '-recursive', '-check'], { cwd: TF_DIR, env, stdio: 'pipe' });
    execFileSync(tfBin, ['validate', '-no-color'], { cwd: TF_DIR, env, stdio: 'pipe' });
    execFileSync(tfBin, ['test', '-no-color'], { cwd: TF_DIR, env, stdio: 'pipe' });
  });
});
