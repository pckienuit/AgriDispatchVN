mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "11111111-1111-1111-1111-111111111111"
      object_id = "22222222-2222-2222-2222-222222222222"
    }
  }

  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05"
    }
  }

  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Network/virtualNetworks/vnet-agri-bt05"
    }
  }

  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Network/virtualNetworks/vnet-agri-bt05/subnets/snet-mock"
    }
  }

  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Network/privateDnsZones/private.postgres.database.azure.com"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-mock"
      client_id    = "44444444-4444-4444-4444-444444444444"
      principal_id = "55555555-5555-5555-5555-555555555555"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.ContainerRegistry/registries/acragribt05a1"
      login_server = "acragribt05a1.azurecr.io"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.KeyVault/vaults/kv-agri-bt05a1"
      vault_uri = "https://kv-agri-bt05a1.vault.azure.net/"
    }
  }

  mock_resource "azurerm_key_vault_secret" {
    defaults = {
      id                      = "https://kv-agri-bt05a1.vault.azure.net/secrets/MOCK/00000000000000000000000000000000"
      resource_versionless_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.KeyVault/vaults/kv-agri-bt05a1/secrets/MOCK"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-agri-bt05a1"
      fqdn = "psql-agri-bt05a1.postgres.database.azure.com"
    }
  }

  mock_resource "azurerm_service_plan" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Web/serverFarms/asp-agri-bt05"
    }
  }

  mock_resource "azurerm_linux_web_app" {
    defaults = {
      id               = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Web/sites/app-booking-bt05a1"
      default_hostname = "app-booking-bt05a1.azurewebsites.net"
      identity = {
        principal_id = "66666666-6666-6666-6666-666666666666"
        tenant_id    = "11111111-1111-1111-1111-111111111111"
      }
    }
  }

  mock_resource "azurerm_linux_web_app_slot" {
    defaults = {
      id               = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Web/sites/app-booking-bt05a1/slots/staging"
      default_hostname = "app-booking-bt05a1-staging.azurewebsites.net"
      identity = {
        principal_id = "77777777-7777-7777-7777-777777777777"
        tenant_id    = "11111111-1111-1111-1111-111111111111"
      }
    }
  }

  mock_resource "azurerm_linux_function_app" {
    defaults = {
      id               = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Web/sites/func-thumb-bt05a1"
      default_hostname = "func-thumb-bt05a1.azurewebsites.net"
      identity = {
        principal_id = "88888888-8888-8888-8888-888888888888"
        tenant_id    = "11111111-1111-1111-1111-111111111111"
      }
    }
  }

  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      id              = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.ContainerService/managedClusters/aks-agri-bt05a1"
      oidc_issuer_url = "https://japaneast.oic.prod-aks.azure.com/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id                     = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Storage/storageAccounts/stevdbt05a1"
      primary_blob_endpoint  = "https://stevdbt05a1.blob.core.windows.net/"
      primary_queue_endpoint = "https://stevdbt05a1.queue.core.windows.net/"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.OperationalInsights/workspaces/log-agri-bt05"
    }
  }

  mock_resource "azurerm_application_insights" {
    defaults = {
      id                = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.Insights/components/appi-agri-bt05"
      connection_string = "InstrumentationKey=00000000-0000-0000-0000-000000000000"
    }
  }
}

variables {
  subscription_id        = "00000000-0000-0000-0000-000000000001"
  location               = "japaneast"
  resource_group_name    = "rg-agridispatch-bt05"
  name_suffix            = "bt05a1"
  operator_ip_ranges     = ["198.51.100.10/32"]
  kubernetes_version     = "1.31"
  aks_system_vm_size     = "Standard_D4s_v3"
  aks_system_node_count  = 2
  app_service_sku_name   = "S1"
  build_sha              = "14a0e9a71427e1664d24003338578083c47c4322"
  app_image              = "acragribt05a1.azurecr.io/agridispatch-app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  function_image         = "acragribt05a1.azurecr.io/agridispatch-thumbnail@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  pg_admin_password      = "test-only-bootstrap-password-24chars"
  account_database_url   = "postgresql://account_runtime:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full"
  booking_database_url   = "postgresql://booking_runtime:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full"
  migration_database_url = "postgresql://migrator_role:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full"
  internal_service_token = "test-only-internal-service-token-32chars"
  budget_amount_usd      = 43.03
  budget_contact_emails  = ["ops@example.invalid"]
}

run "valid_plan_enforces_architecture_and_security_contract" {
  command = plan

  assert {
    condition     = contains(azurerm_virtual_network.bt05.address_space, "10.42.0.0/16")
    error_message = "VNet CIDR must match parent contract 10.42.0.0/16."
  }

  assert {
    condition     = azurerm_subnet.webapp.address_prefixes[0] == "10.42.1.0/24"
    error_message = "Web app subnet must be 10.42.1.0/24."
  }

  assert {
    condition     = azurerm_subnet.aks.address_prefixes[0] == "10.42.2.0/24"
    error_message = "AKS subnet must be 10.42.2.0/24."
  }

  assert {
    condition     = azurerm_subnet.pg.address_prefixes[0] == "10.42.3.0/24"
    error_message = "PostgreSQL subnet must be 10.42.3.0/24."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.main.network_profile[0].network_plugin == "azure" && azurerm_kubernetes_cluster.main.network_profile[0].network_policy == "azure"
    error_message = "AKS must use Azure CNI."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.main.network_profile[0].service_cidr == "10.43.0.0/16" && azurerm_kubernetes_cluster.main.network_profile[0].dns_service_ip == "10.43.0.10"
    error_message = "AKS service CIDR and DNS IP must match contract."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.main.oidc_issuer_enabled && azurerm_kubernetes_cluster.main.workload_identity_enabled && azurerm_kubernetes_cluster.main.key_vault_secrets_provider[0].secret_rotation_enabled
    error_message = "AKS must enable OIDC, workload identity, and KV CSI secrets provider."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.main.default_node_pool[0].vm_size == "Standard_D4s_v3" && azurerm_kubernetes_cluster.main.default_node_pool[0].node_count >= 2
    error_message = "AKS system pool must have at least 2 Standard_D4s_v3 nodes."
  }

  assert {
    condition     = azurerm_container_registry.main.sku == "Basic" && !azurerm_container_registry.main.admin_enabled && !azurerm_container_registry.main.anonymous_pull_enabled
    error_message = "ACR must be Basic with admin and anonymous pull disabled."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.main.version == "17" && azurerm_postgresql_flexible_server.main.sku_name == "B_Standard_B1ms" && azurerm_postgresql_flexible_server.main.storage_mb == 32768 && !azurerm_postgresql_flexible_server.main.public_network_access_enabled
    error_message = "PostgreSQL must be private v17 B_Standard_B1ms 32 GiB."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server_configuration.require_secure_transport.value == "on"
    error_message = "PostgreSQL must enforce require_secure_transport=on."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server_database.main.name == "agridispatch" && azurerm_private_dns_zone.pg.name == "private.postgres.database.azure.com"
    error_message = "PostgreSQL must define one shared agridispatch database and canonical private.postgres.database.azure.com zone."
  }

  assert {
    condition     = azurerm_key_vault.main.rbac_authorization_enabled && azurerm_key_vault.main.purge_protection_enabled && azurerm_key_vault.main.network_acls[0].default_action == "Deny"
    error_message = "Key Vault must enforce RBAC, purge protection, and default Deny network ACL."
  }

  assert {
    condition     = !azurerm_storage_account.evidence.shared_access_key_enabled && !azurerm_storage_account.evidence.allow_nested_items_to_be_public && azurerm_storage_account.evidence.https_traffic_only_enabled && azurerm_storage_account.evidence.min_tls_version == "TLS1_2"
    error_message = "Evidence storage must disable shared keys and public blobs and enforce HTTPS TLS 1.2."
  }

  assert {
    condition     = !azurerm_storage_account.host.shared_access_key_enabled && !azurerm_storage_account.host.allow_nested_items_to_be_public && azurerm_storage_account.host.https_traffic_only_enabled && azurerm_storage_account.host.min_tls_version == "TLS1_2"
    error_message = "Host storage must disable shared keys and public blobs and enforce HTTPS TLS 1.2."
  }

  assert {
    condition     = azurerm_storage_container.evidence.container_access_type == "private" && azurerm_storage_container.thumbnails.container_access_type == "private"
    error_message = "Both storage containers must be private."
  }

  assert {
    condition     = azurerm_linux_web_app.booking.identity[0].type == "SystemAssigned, UserAssigned" && azurerm_linux_web_app.booking.https_only && azurerm_linux_web_app.booking.app_settings["ACCOUNT_SERVICE_URL"] == "http://10.42.2.10:3001"
    error_message = "Booking web app must have SystemAssigned + UserAssigned MI, HTTPS only, and internal account service URL."
  }

  assert {
    condition     = startswith(azurerm_linux_web_app.booking.app_settings["DATABASE_URL"], "@Microsoft.KeyVault(") && startswith(azurerm_linux_web_app.booking.app_settings["INTERNAL_SERVICE_TOKEN"], "@Microsoft.KeyVault(")
    error_message = "Web app secrets must be Key Vault references, not plain text."
  }

  assert {
    condition     = azurerm_linux_web_app_slot.staging.name == "staging" && azurerm_linux_web_app_slot.staging.identity[0].type == "SystemAssigned, UserAssigned"
    error_message = "Staging slot must exist with SystemAssigned + UserAssigned MI."
  }

  assert {
    condition     = azurerm_linux_function_app.thumbnail.identity[0].type == "SystemAssigned" && azurerm_linux_function_app.thumbnail.site_config[0].always_on && azurerm_linux_function_app.thumbnail.storage_uses_managed_identity
    error_message = "Thumbnail Function must use SystemAssigned MI, AlwaysOn, and managed identity host storage."
  }

  assert {
    condition     = azurerm_linux_function_app.thumbnail.site_config[0].application_stack[0].docker[0].image_name == "agridispatch-thumbnail@sha256" && azurerm_linux_function_app.thumbnail.site_config[0].application_stack[0].docker[0].image_tag == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    error_message = "Thumbnail Function docker block must encode the @sha256 digest via image_name=<repo>@sha256 and image_tag=<hex>."
  }

  assert {
    condition     = azurerm_linux_function_app.thumbnail.app_settings["AzureWebJobsStorage__accountName"] == azurerm_storage_account.host.name && azurerm_linux_function_app.thumbnail.app_settings["EVIDENCE_CONTAINER"] == "evidence" && azurerm_linux_function_app.thumbnail.app_settings["THUMBNAIL_CONTAINER"] == "thumbnails"
    error_message = "Function settings must wire AzureWebJobsStorage__accountName and evidence/thumbnails containers."
  }

  assert {
    condition     = contains(azurerm_storage_account.evidence.network_rules[0].ip_rules, "198.51.100.10")
    error_message = "Storage network_rules must strip /32 suffix to bare IPv4."
  }

  assert {
    condition     = azurerm_federated_identity_credential.account.subject == "system:serviceaccount:agridispatch:agridispatch-account" && azurerm_federated_identity_credential.migrator.subject == "system:serviceaccount:agridispatch:agridispatch-migrate"
    error_message = "Account and migrator federated subjects must be distinct and match K8s service accounts."
  }

  assert {
    condition     = azurerm_user_assigned_identity.account.name != azurerm_user_assigned_identity.migrator.name
    error_message = "Account and migrator must use separate UAMIs."
  }

  assert {
    condition     = azurerm_consumption_budget_resource_group.bt05.amount == 43.03
    error_message = "Budget threshold must match approved 43.03 USD cap."
  }
}

run "valid_apply_mock_produces_safe_contract_outputs" {
  command = apply

  assert {
    condition     = output.account_service_internal_url == "http://10.42.2.10:3001"
    error_message = "Internal account-service URL output must match contract."
  }

  assert {
    condition     = output.key_vault_name == "kv-agri-bt05a1" && output.tenant_id == "11111111-1111-1111-1111-111111111111"
    error_message = "Key Vault name and tenant ID outputs must be populated."
  }

  assert {
    condition     = toset(output.key_vault_secret_names) == toset(["ACCOUNT-DATABASE-URL", "BOOKING-DATABASE-URL", "MIGRATION-DATABASE-URL", "INTERNAL-SERVICE-TOKEN"])
    error_message = "Key Vault secret names must match the K8s and app contract."
  }

  assert {
    condition     = length(output.account_workload_identity_client_id) > 0 && length(output.migrator_workload_identity_client_id) > 0 && length(output.web_identity_client_id) > 0
    error_message = "Workload and web UAMI client IDs must be exported."
  }

  assert {
    condition     = output.deployed_image_references.app_image == var.app_image && output.deployed_image_references.function_image == var.function_image && output.deployed_image_references.build_sha == var.build_sha
    error_message = "Deployed image references output must match pinned inputs."
  }

  assert {
    condition     = output.postgres_fqdn == "psql-agri-bt05a1.postgres.database.azure.com"
    error_message = "PostgreSQL FQDN output must use canonical <server>.postgres.database.azure.com hostname."
  }

  assert {
    condition     = !can(regex("test-only-pass-value|test-only-internal-service-token|test-only-bootstrap-password", jsonencode([output.key_vault_secret_names, output.postgres_fqdn, output.deployed_image_references, output.account_service_internal_url])))
    error_message = "Secret values must never leak into outputs."
  }
}
