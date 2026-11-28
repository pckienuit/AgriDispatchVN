# One Linux Dedicated plan shared by the booking web app, its staging slot and the thumbnail
# Function. Slots need Standard or higher. Shared plan means shared CPU/RAM under load.
resource "azurerm_service_plan" "bt05" {
  name                = local.plan_name
  resource_group_name = azurerm_resource_group.bt05.name
  location            = azurerm_resource_group.bt05.location
  os_type             = "Linux"
  sku_name            = var.app_service_sku_name
  tags                = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# Booking web app: VNet-integrated, reads account-service over the internal static IP.
# Secrets come from Key Vault through the web UAMI; no secret values in app settings.
resource "azurerm_linux_web_app" "booking" {
  name                            = local.web_app_name
  resource_group_name             = azurerm_resource_group.bt05.name
  location                        = azurerm_resource_group.bt05.location
  service_plan_id                 = azurerm_service_plan.bt05.id
  https_only                      = true
  public_network_access_enabled   = true
  virtual_network_subnet_id       = azurerm_subnet.webapp.id
  key_vault_reference_identity_id = azurerm_user_assigned_identity.web.id
  tags                            = local.tags

  identity {
    type         = "SystemAssigned, UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.web.id]
  }

  site_config {
    always_on                         = true
    ftps_state                        = "Disabled"
    minimum_tls_version               = "1.2"
    health_check_path                 = var.health_check_path
    health_check_eviction_time_in_min = 5
    vnet_route_all_enabled            = true

    container_registry_use_managed_identity       = true
    container_registry_managed_identity_client_id = azurerm_user_assigned_identity.web.client_id

    application_stack {
      docker_image_name   = local.app_image_ref
      docker_registry_url = "https://${local.acr_login_server}"
    }
  }

  app_settings = {
    WEBSITES_PORT                         = "3000"
    PORT                                  = "3000"
    NODE_ENV                              = "production"
    BUILD_SHA                             = var.build_sha
    ACCOUNT_SERVICE_URL                   = local.account_service_url
    DATABASE_URL                          = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.main.name};SecretName=BOOKING-DATABASE-URL)"
    INTERNAL_SERVICE_TOKEN                = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.main.name};SecretName=INTERNAL-SERVICE-TOKEN)"
    EVIDENCE_BLOB_ACCOUNT_URL             = azurerm_storage_account.evidence.primary_blob_endpoint
    EVIDENCE_CONTAINER                    = local.evidence_container
    THUMBNAIL_CONTAINER                   = local.thumbnail_container
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
    TRUST_PROXY_HOPS                      = "1"
  }

  logs {
    application_logs {
      file_system_level = "Warning"
    }
    http_logs {
      file_system {
        retention_in_days = 3
        retention_in_mb   = 35
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Staging slot for blue/green. Same VNet integration and Key Vault identity; swap is manual.
resource "azurerm_linux_web_app_slot" "staging" {
  name                            = "staging"
  app_service_id                  = azurerm_linux_web_app.booking.id
  https_only                      = true
  public_network_access_enabled   = true
  virtual_network_subnet_id       = azurerm_subnet.webapp.id
  key_vault_reference_identity_id = azurerm_user_assigned_identity.web.id
  tags                            = local.tags

  identity {
    type         = "SystemAssigned, UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.web.id]
  }

  site_config {
    always_on                         = true
    ftps_state                        = "Disabled"
    minimum_tls_version               = "1.2"
    health_check_path                 = var.health_check_path
    health_check_eviction_time_in_min = 5
    vnet_route_all_enabled            = true

    container_registry_use_managed_identity       = true
    container_registry_managed_identity_client_id = azurerm_user_assigned_identity.web.client_id

    application_stack {
      docker_image_name   = local.staging_image_ref
      docker_registry_url = "https://${local.acr_login_server}"
    }
  }

  app_settings = {
    WEBSITES_PORT                         = "3000"
    PORT                                  = "3000"
    NODE_ENV                              = "production"
    BUILD_SHA                             = var.build_sha
    ACCOUNT_SERVICE_URL                   = local.account_service_url
    DATABASE_URL                          = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.main.name};SecretName=BOOKING-DATABASE-URL)"
    INTERNAL_SERVICE_TOKEN                = "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.main.name};SecretName=INTERNAL-SERVICE-TOKEN)"
    EVIDENCE_BLOB_ACCOUNT_URL             = azurerm_storage_account.evidence.primary_blob_endpoint
    EVIDENCE_CONTAINER                    = local.evidence_container
    THUMBNAIL_CONTAINER                   = local.thumbnail_container
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
    TRUST_PROXY_HOPS                      = "1"
  }
}

# Thumbnail Function: full Functions host image on the same Dedicated plan, Always On.
# System-assigned identity only: configuredBlobStore has no client-ID selector.
resource "azurerm_linux_function_app" "thumbnail" {
  name                          = local.function_name
  resource_group_name           = azurerm_resource_group.bt05.name
  location                      = azurerm_resource_group.bt05.location
  service_plan_id               = azurerm_service_plan.bt05.id
  storage_account_name          = azurerm_storage_account.host.name
  storage_uses_managed_identity = true
  functions_extension_version   = "~4"
  https_only                    = true
  public_network_access_enabled = true
  virtual_network_subnet_id     = azurerm_subnet.webapp.id
  tags                          = local.tags

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on              = true
    ftps_state             = "Disabled"
    minimum_tls_version    = "1.2"
    vnet_route_all_enabled = true

    container_registry_use_managed_identity = true

    application_stack {
      docker {
        registry_url = "https://${local.acr_login_server}"
        image_name   = "${local.function_repo}@sha256"
        image_tag    = local.function_digest
      }
    }
  }

  app_settings = {
    BUILD_SHA                             = var.build_sha
    AzureWebJobsStorage__accountName      = azurerm_storage_account.host.name
    EvidenceSource__blobServiceUri        = azurerm_storage_account.evidence.primary_blob_endpoint
    EvidenceSource__queueServiceUri       = azurerm_storage_account.evidence.primary_queue_endpoint
    EVIDENCE_BLOB_ACCOUNT_URL             = azurerm_storage_account.evidence.primary_blob_endpoint
    EVIDENCE_CONTAINER                    = local.evidence_container
    THUMBNAIL_CONTAINER                   = local.thumbnail_container
    WEBSITES_ENABLE_APP_SERVICE_STORAGE   = "false"
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
  }

  lifecycle {
    prevent_destroy = true
  }
}
