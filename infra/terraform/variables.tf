# Non-secret inputs. Secret inputs (database URLs, internal token, admin password)
# are sensitive and ephemeral, reaching Key Vault/PostgreSQL only as write-only values
# so they are kept out of both state and saved plan files.

variable "subscription_id" {
  description = "Target Azure subscription GUID. Must be the student subscription that holds the approved credit."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a GUID."
  }
}

variable "location" {
  description = "Azure region. Limited to the last-read allowed-location snapshot. Re-read the policy before apply; this list is not a quota or SKU proof."
  type        = string

  validation {
    condition     = contains(["koreacentral", "uaenorth", "japaneast", "indonesiacentral", "centralindia"], var.location)
    error_message = "location must be one of the last-read allowed regions: koreacentral, uaenorth, japaneast, indonesiacentral, centralindia."
  }
}

variable "resource_group_name" {
  description = "Dedicated BT05 resource group. Kept separate from the Azure Bot assignment group rg-is402."
  type        = string
  default     = "rg-agridispatch-bt05"

  validation {
    condition     = var.resource_group_name == "rg-agridispatch-bt05"
    error_message = "resource_group_name must be rg-agridispatch-bt05, separate from all other coursework."
  }
}

variable "name_suffix" {
  description = "Short lowercase suffix for globally unique names (ACR, Key Vault, storage, web app, PostgreSQL)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{4,7}$", var.name_suffix))
    error_message = "name_suffix must be 5 to 8 lowercase letters or digits, starting with a letter."
  }
}

variable "tags" {
  description = "Extra tags merged with the fixed BT05 tags. Do not add auto-delete tags."
  type        = map(string)
  default     = {}
}

variable "operator_ip_ranges" {
  description = "Public IPv4 CIDRs of the human or pipeline runner that writes Key Vault secrets and reads the AKS API. Never 0.0.0.0/0."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.operator_ip_ranges : c != "0.0.0.0/0" && !endswith(c, "/31") && can(cidrnetmask(c))])
    error_message = "operator_ip_ranges entries must be valid IPv4 CIDRs, must not include 0.0.0.0/0, and must not use /31 (rejected by Azure Storage firewall)."
  }
}

variable "kubernetes_version" {
  description = "AKS Kubernetes version (minor or patch). Choose a version currently supported by AKS in the target region; no default is assumed."
  type        = string

  validation {
    condition     = can(regex("^1\\.[0-9]{2}(\\.[0-9]+)?$", var.kubernetes_version))
    error_message = "kubernetes_version must look like 1.NN or 1.NN.P."
  }
}

variable "aks_system_vm_size" {
  description = "System node pool VM size. Must be a non-B-series, non-Spot size with at least 4 vCPU and 4 GiB RAM (Microsoft system-pool requirement)."
  type        = string
  default     = "Standard_D4s_v3"

  validation {
    condition     = contains(["Standard_D4s_v3", "Standard_D4s_v4", "Standard_D4s_v5", "Standard_D4as_v5"], var.aks_system_vm_size)
    error_message = "aks_system_vm_size must be one of the allow-listed 4-vCPU general-purpose sizes (not B-series, not Spot)."
  }
}

variable "aks_system_node_count" {
  description = "System node count. Set 1 explicitly for a Free-tier demo with no node redundancy. Default: 2."
  type        = number
  default     = 2
  nullable    = false

  validation {
    condition     = contains([1, 2, 3], var.aks_system_node_count)
    error_message = "aks_system_node_count must be 1, 2 or 3."
  }
}

variable "app_service_sku_name" {
  description = "Shared Linux Dedicated plan SKU for the booking web app, its staging slot and the thumbnail Function. Slots need Standard or higher."
  type        = string
  default     = "S1"

  validation {
    condition     = contains(["S1", "S2", "S3", "P0v3", "P1v3", "P2v3"], var.app_service_sku_name)
    error_message = "app_service_sku_name must be S1, S2, S3, P0v3, P1v3 or P2v3. Free, Basic and Consumption tiers cannot host the required slot and host model."
  }
}

variable "app_image" {
  description = "Booking app image as an immutable digest reference <acr>.azurecr.io/<repo>@sha256:<64 hex>. Produced by the CI build; no default."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+\\.azurecr\\.io/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$", var.app_image))
    error_message = "app_image must be an azurecr.io repository reference pinned by @sha256 digest (64 lowercase hex characters)."
  }
}

variable "staging_app_image" {
  description = "Optional immutable digest reference for the staging slot (blue/green candidate). Null uses app_image."
  type        = string
  default     = null

  validation {
    condition     = var.staging_app_image == null || can(regex("^[a-z0-9-]+\\.azurecr\\.io/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$", var.staging_app_image))
    error_message = "staging_app_image must be null or an azurecr.io reference pinned by @sha256 digest."
  }
}

variable "function_image" {
  description = "Thumbnail Function host image as an immutable digest reference, built from infra/Function.Dockerfile. No default."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+\\.azurecr\\.io/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$", var.function_image))
    error_message = "function_image must be an azurecr.io repository reference pinned by @sha256 digest (64 lowercase hex characters)."
  }
}

variable "build_sha" {
  description = "Full 40-character Git commit SHA of the deployed source. Exposed to app and Function as BUILD_SHA."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.build_sha))
    error_message = "build_sha must be the full 40-character lowercase Git SHA."
  }
}

variable "health_check_path" {
  description = "App Service Health Check path for the booking app. /health is liveness; /ready also checks the database. Review before cutover."
  type        = string
  default     = "/health"

  validation {
    condition     = startswith(var.health_check_path, "/")
    error_message = "health_check_path must start with /."
  }
}

variable "pg_admin_login" {
  description = "PostgreSQL bootstrap administrator login. Used only by the manual DB bootstrap, not by app roles."
  type        = string
  default     = "agridbadmin"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{2,31}$", var.pg_admin_login))
    error_message = "pg_admin_login must be 3 to 32 lowercase letters, digits or underscores."
  }
}

variable "pg_admin_password" {
  description = "PostgreSQL bootstrap administrator password. Ephemeral and write-only; supplied from a secret store (TF_VAR_pg_admin_password). Never stored in state or saved plans."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = length(var.pg_admin_password) >= 24 && !can(regex("\\s", var.pg_admin_password))
    error_message = "pg_admin_password must be at least 24 characters with no whitespace."
  }
}

variable "pg_admin_password_version" {
  description = "Increment to rotate pg_admin_password (write-only attribute)."
  type        = number
  default     = 1
}

variable "account_database_url" {
  description = "Runtime PostgreSQL URL for account-service (role account_runtime on shared DB agridispatch), generated outside Terraform by DB bootstrap. Must be exactly postgresql://...@<server>.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full with no other query parameters."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = can(regex("^postgresql://[^\\s?#@/:]+:[^\\s?#@/]+@[a-z0-9-]+\\.postgres\\.database\\.azure\\.com:5432/agridispatch\\?sslmode=verify-full$", var.account_database_url))
    error_message = "account_database_url must be a PostgreSQL URL to the Azure PostgreSQL FQDN with exactly ?sslmode=verify-full as the only query parameter."
  }
}

variable "booking_database_url" {
  description = "Runtime PostgreSQL URL for the booking web app (role booking_runtime on shared DB agridispatch). Same format rules as account_database_url, separate least-privilege role."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = can(regex("^postgresql://[^\\s?#@/:]+:[^\\s?#@/]+@[a-z0-9-]+\\.postgres\\.database\\.azure\\.com:5432/agridispatch\\?sslmode=verify-full$", var.booking_database_url))
    error_message = "booking_database_url must be a PostgreSQL URL to the Azure PostgreSQL FQDN with exactly ?sslmode=verify-full as the only query parameter."
  }
}

variable "migration_database_url" {
  description = "Migration PostgreSQL URL with DDL rights on shared DB agridispatch. Stored only in Key Vault, readable only by the migration workload identity. Same format rules as account_database_url."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = can(regex("^postgresql://[^\\s?#@/:]+:[^\\s?#@/]+@[a-z0-9-]+\\.postgres\\.database\\.azure\\.com:5432/agridispatch\\?sslmode=verify-full$", var.migration_database_url))
    error_message = "migration_database_url must be a PostgreSQL URL to the Azure PostgreSQL FQDN with exactly ?sslmode=verify-full as the only query parameter."
  }
}

variable "internal_service_token" {
  description = "Shared secret for internal HTTP calls between booking and account-service. Ephemeral and write-only; 32 to 256 characters, no whitespace. Generate outside Terraform."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = length(var.internal_service_token) >= 32 && length(var.internal_service_token) <= 256 && !can(regex("\\s", var.internal_service_token))
    error_message = "internal_service_token must be 32 to 256 characters with no whitespace."
  }
}

variable "secret_version" {
  description = "Increment to rewrite all write-only Key Vault secrets (value_wo_version)."
  type        = number
  default     = 1
}

variable "account_k8s_namespace" {
  description = "Kubernetes namespace of account-service. Must match the federated identity subject."
  type        = string
  default     = "agridispatch"
}

variable "account_k8s_service_account" {
  description = "Kubernetes service account used by the account-service pod (workload identity)."
  type        = string
  default     = "agridispatch-account"
}

variable "migration_k8s_service_account" {
  description = "Kubernetes service account used only by the database migration job."
  type        = string
  default     = "agridispatch-migrate"
}

variable "budget_amount_usd" {
  description = "Azure Cost Management notification threshold. Notifications are not spending caps. The approved cap is 50% of remaining credit at spending start (43.03 USD on the 18 Nov 2026 read)."
  type        = number
  default     = 43.03

  validation {
    condition     = var.budget_amount_usd > 0 && var.budget_amount_usd <= 43.03
    error_message = "budget_amount_usd must be positive and no greater than the authorized USD43.03 threshold; alerts are not hard caps."
  }
}

variable "budget_contact_emails" {
  description = "Email recipients for budget notifications. Supply in a gitignored tfvars file; never commit."
  type        = list(string)
  sensitive   = true

  validation {
    condition     = length(var.budget_contact_emails) >= 1 && alltrue([for e in var.budget_contact_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "budget_contact_emails needs at least one valid email address."
  }
}

variable "budget_start_date" {
  description = "Budget period start. Must be the first day of a month, in UTC."
  type        = string
  default     = "2026-11-01T00:00:00Z"

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-01T00:00:00Z$", var.budget_start_date))
    error_message = "budget_start_date must be the first day of a month at 00:00:00Z."
  }
}

variable "budget_end_date" {
  description = "Budget period end, UTC. Reviewed at each budget checkpoint."
  type        = string
  default     = "2027-06-30T00:00:00Z"

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00Z$", var.budget_end_date))
    error_message = "budget_end_date must be a date at 00:00:00Z."
  }
}
