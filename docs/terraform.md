# Terraform BT05 infrastructure (`infra/terraform`)

Dry-run infrastructure definition and offline contract tests for the IS402 BT05 stack. Nothing in this directory has been applied to Azure, and no remote state backend or cloud resource has been created.

## Scope and ownership

- Owned here: Azure resource definitions in `infra/terraform/`, offline provider-schema/mock tests in `infra/terraform/tests/`, and Node contract checks in `server/tests/terraform-contract.test.js`.
- Not managed here: Kubernetes deployment manifests (`account-service` and `db-migrator` pods), PostgreSQL role/schema SQL bootstrap, CI/CD pipelines (Azure DevOps / Jenkins), and manual remote-state storage bootstrap.
- Keep separate from the existing Azure Bot resource group (`rg-is402`); `variables.tf` rejects `rg-is402` and defaults to `rg-agridispatch-bt05`.

## Tooling and provider pins

- Terraform: `>= 1.17.2, < 2.0.0` (verified locally with `1.17.2`).
- Provider: `hashicorp/azurerm` pinned to `5.14.0` in `versions.tf` and locked with hashes in `.terraform.lock.hcl`.
- `resource_provider_registrations = "none"` in `providers.tf`: Terraform never auto-registers Azure resource providers.
- `storage_use_azuread = true` in `providers.tf`: required because shared storage keys are disabled on both storage accounts.

## Architecture and identity wiring

| Component | Target | Identity / Access | Notes |
| --- | --- | --- | --- |
| `account-service` | AKS (`10.42.2.0/24`, static internal LB `10.42.2.10:3001`) | Workload UAMI (`account_client_id`) federated to `system:serviceaccount:agridispatch:agridispatch-account` | Scoped `Key Vault Secrets User` on `ACCOUNT-DATABASE-URL` and `INTERNAL-SERVICE-TOKEN` only |
| `db-migrator` | AKS one-off job | Separate Workload UAMI (`migration_client_id`) federated to `system:serviceaccount:agridispatch:agridispatch-migrate` | Scoped `Key Vault Secrets User` on `MIGRATION-DATABASE-URL` only |
| `booking` web app + `staging` slot | Linux App Service Plan `S1` (`10.42.1.0/24` VNet integration) | `SystemAssigned, UserAssigned` (`web` UAMI pulls ACR + reads Key Vault references; `SystemAssigned` calls `IDENTITY_ENDPOINT` for evidence/thumbnail Blobs) | `ACCOUNT_SERVICE_URL=http://10.42.2.10:3001`; slots require Standard (`S1`) or above |
| `thumbnail` Function | Same Dedicated Linux plan (`AlwaysOn = true`), full host image (`infra/Function.Dockerfile`) | `SystemAssigned` only (`configuredBlobStore` in `server/src/blob-store.js` passes no `client_id` selector) | `AzureWebJobsStorage__accountName` on host storage + `EvidenceSource__blobServiceUri`/`queueServiceUri` (matching `functions/thumbnail/function.json` `connection = "EvidenceSource"`) + `EVIDENCE_BLOB_ACCOUNT_URL` |
| PostgreSQL 17 | Flexible Server `B_Standard_B1ms`, `32768` MB (`10.42.3.0/24` delegated), single shared DB `agridispatch` | Private VNet + `private.postgres.database.azure.com` DNS zone; canonical FQDN `<server>.postgres.database.azure.com`; `require_secure_transport=on` | Distinct out-of-band DB roles (`account_runtime`, `booking_runtime`, `migrator`) on `agridispatch`; clients must supply `?sslmode=verify-full` with no extra query parameters |
| Storage | Two StorageV2 LRS accounts (`evidence` with private `evidence`/`thumbnails` containers; `host` for Functions host) | `shared_access_key_enabled = false`, `allow_nested_items_to_be_public = false`, HTTPS + TLS 1.2, VNet/operator firewall | Container-scoped RBAC only; `/32` operator CIDRs are stripped to bare IPv4 for Azure Storage firewall |
| Key Vault | Standard SKU, RBAC authorization, soft-delete 7 days, purge protection enabled, default `Deny` | Ephemeral inputs (`ephemeral = true`, `sensitive = true`) + write-only secrets (`value_wo`, `administrator_password_wo`) so secret values stay out of both state and saved `.tfplan` files | Secret names: `ACCOUNT-DATABASE-URL`, `BOOKING-DATABASE-URL`, `MIGRATION-DATABASE-URL`, `INTERNAL-SERVICE-TOKEN`, `PG-ADMIN-PASSWORD` |
| Observability + Budget | Log Analytics (`30` days, `0.5` GB/day cap), Application Insights (`Node.JS`), diagnostic settings on app/Function/AKS/PG/evidence Blob/Key Vault | Resource-group budget alert at `43.03` USD (`50%`, `80%` actual; `100%` forecasted) | Cost Management budgets send notifications only; they do not stop spending |

## Contract notes and bootstrap exception

1. **Private DNS zone and canonical PostgreSQL FQDN**: Azure VNet-integrated Flexible Server requires the private DNS zone name to end with `.postgres.database.azure.com`. `locals.tf` creates `private.postgres.database.azure.com`, while the server's canonical Azure FQDN and TLS SAN remain `<server>.postgres.database.azure.com` so `sslmode=verify-full` validates against Azure's `*.postgres.database.azure.com` certificate.
2. **Function image digest wiring**: `azurerm` `5.14.0` `azurerm_linux_function_app` `site_config.application_stack.docker` requires non-empty `image_name` and `image_tag` and encodes `DOCKER|<registry>/<image_name>:<image_tag>` (`EncodeFunctionAppLinuxFxVersion` / `DecodeFunctionAppDockerFxString`). `apps.tf` splits `var.function_image` into `image_name = "${local.function_repo}@sha256"` and `image_tag = local.function_digest`, which produces `DOCKER|<acr>/<repo>@sha256:<digest>` natively without a second provider or tag fallback.
3. **Two-stage `-target` bootstrap exception (circular ACR and DB URL dependency)**: Full-stack `terraform apply` requires real `@sha256:...` digests for `var.app_image` and `var.function_image` (referencing the ACR created by this root) and real `*_database_url` values pointing at the PostgreSQL server created by this root. When provisioning from an empty subscription (after quota/budget approval):
   - Stage 1 (bootstrap): apply `-target=azurerm_resource_group.bt05 -target=azurerm_container_registry.main` (plus VNet/Private DNS/PostgreSQL if bootstrapping DB roles before final Key Vault secrets), push the built images to ACR to obtain real `@sha256:...` digests, and run out-of-band DB role bootstrap (`account_runtime`, `booking_runtime`, `migrator` on `agridispatch`).
   - Stage 2 (full stack): run full `terraform plan` / `terraform apply` without `-target` using the real ACR image digests and real `*_database_url` secret values.
4. **AKS quota and budget blocker**: Microsoft documents a minimum AKS system pool of 2 nodes with >= 4 vCPU each and no B-series (`Standard_D4s_v3`, 8 vCPUs total). The 18 Nov 2026 read on the student subscription showed a regional total vCPU limit of 6 and `Dsv3`/`Dv4` family quota of 4, plus ambiguous App Service Dedicated quota and a `43.03` USD credit cap (`50%` of `86.06` USD). Do not run `terraform apply` until quota, region policy, full-stack burn including post-demo retention, and manual state backend bootstrap are resolved and approved.

## Safe state and offline verification

- Local state (`terraform.tfstate*`), `.terraform/`, `*.tfvars` (except `.example`), and `backend.hcl` must remain uncommitted and ignored (the parent owns `.gitignore` additions if not yet present).
- Bootstrap the state Storage Account manually in a separate resource group before running `terraform init -backend-config=backend.hcl`.
- Pass sensitive variables via `TF_VAR_*` environment variables (`TF_VAR_pg_admin_password`, `TF_VAR_account_database_url`, `TF_VAR_booking_database_url`, `TF_VAR_migration_database_url`, `TF_VAR_internal_service_token`, `TF_VAR_budget_contact_emails`) rather than plain files.
- Offline verification commands (no cloud credentials or writes):

```sh
cd infra/terraform
terraform init -backend=false
terraform fmt -recursive -check
terraform validate
terraform test
```

- Repository contract check:

```sh
node --test server/tests/terraform-contract.test.js
```

`terraform validate` and `terraform test` (using `mock_provider "azurerm"`) confirm HCL syntax, provider schema compatibility, variable validations, preconditions, and output shape locally; they do not prove Azure quota, SKU availability, runtime RBAC propagation, or live connectivity.

Parent integration adds integer-only node counts, the fixed BT05 resource group, an alert threshold no greater than USD43.03, Azure NetworkPolicy engine and `TRUST_PROXY_HOPS=1` on both Web Apps slots. The proxy setting assumes the direct App Service endpoint adds one trusted hop; verify that topology before adding Front Door or another proxy. Native mock suite has 23 cases. Test-image unit runs explicitly skip the native Terraform CLI stage when its binary/provider cache is absent; native validation must run separately rather than treating that skip as proof.

## Manual provider cache fallback

If `terraform init -backend=false` is blocked by registry access on a CI/dev host, download the `hashicorp/azurerm` `5.14.0` zip and its `SHA256SUMS` from HashiCorp releases, verify the checksum, unpack into a local `filesystem_mirror` directory, and point `TF_CLI_CONFIG_FILE` to a temporary `provider_installation { filesystem_mirror { ... } }` config for that command only (without editing global user config).
