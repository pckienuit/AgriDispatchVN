# Two storage accounts, separated by purpose:
#   evidence  - private case evidence (input) and derived thumbnails (output containers)
#   host      - Functions host state (AzureWebJobsStorage) only
# Shared keys are disabled; every data-plane call is Entra ID / managed identity.
resource "azurerm_storage_account" "evidence" {
  name                            = local.evidence_account
  resource_group_name             = azurerm_resource_group.bt05.name
  location                        = azurerm_resource_group.bt05.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  public_network_access           = "Enabled"
  tags                            = local.tags

  blob_properties {
    delete_retention_policy {
      days = 7
    }
    container_delete_retention_policy {
      days = 7
    }
  }

  network_rules {
    default_action             = "Deny"
    bypass                     = ["AzureServices"]
    ip_rules                   = local.storage_ip_rules
    virtual_network_subnet_ids = [azurerm_subnet.webapp.id]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_account" "host" {
  name                            = local.host_account
  resource_group_name             = azurerm_resource_group.bt05.name
  location                        = azurerm_resource_group.bt05.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  public_network_access           = "Enabled"
  tags                            = local.tags

  network_rules {
    default_action             = "Deny"
    bypass                     = ["AzureServices"]
    ip_rules                   = local.storage_ip_rules
    virtual_network_subnet_ids = [azurerm_subnet.webapp.id]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "evidence" {
  name                  = local.evidence_container
  storage_account_id    = azurerm_storage_account.evidence.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "thumbnails" {
  name                  = local.thumbnail_container
  storage_account_id    = azurerm_storage_account.evidence.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

# Container-scoped grants. The thumbnail Function reads evidence and writes thumbnails;
# the booking web app uploads evidence and reads thumbnails. Nothing is granted at account scope.
locals {
  evidence_container_scope  = "${azurerm_storage_account.evidence.id}/blobServices/default/containers/${local.evidence_container}"
  thumbnail_container_scope = "${azurerm_storage_account.evidence.id}/blobServices/default/containers/${local.thumbnail_container}"
}

resource "azurerm_role_assignment" "function_evidence_read" {
  scope                = local.evidence_container_scope
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_function_app.thumbnail.identity[0].principal_id
}

resource "azurerm_role_assignment" "function_thumbnail_write" {
  scope                = local.thumbnail_container_scope
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_function_app.thumbnail.identity[0].principal_id
}

# Blob trigger uses the evidence queue endpoint (EvidenceSource__queueServiceUri).
resource "azurerm_role_assignment" "function_evidence_queue" {
  scope                = azurerm_storage_account.evidence.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_linux_function_app.thumbnail.identity[0].principal_id
}

resource "azurerm_role_assignment" "function_host_owner" {
  scope                = azurerm_storage_account.host.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azurerm_linux_function_app.thumbnail.identity[0].principal_id
}

resource "azurerm_role_assignment" "function_host_queue" {
  scope                = azurerm_storage_account.host.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_linux_function_app.thumbnail.identity[0].principal_id
}

resource "azurerm_role_assignment" "function_host_table" {
  scope                = azurerm_storage_account.host.id
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = azurerm_linux_function_app.thumbnail.identity[0].principal_id
}

# Booking web app and staging slot use SystemAssigned MI at runtime because
# configuredBlobStore calls IDENTITY_ENDPOINT without a client_id selector.
resource "azurerm_role_assignment" "web_evidence_upload" {
  scope                = local.evidence_container_scope
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_web_app.booking.identity[0].principal_id
}

resource "azurerm_role_assignment" "web_thumbnail_read" {
  scope                = local.thumbnail_container_scope
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_web_app.booking.identity[0].principal_id
}

resource "azurerm_role_assignment" "staging_evidence_upload" {
  scope                = local.evidence_container_scope
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_web_app_slot.staging.identity[0].principal_id
}

resource "azurerm_role_assignment" "staging_thumbnail_read" {
  scope                = local.thumbnail_container_scope
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_web_app_slot.staging.identity[0].principal_id
}
