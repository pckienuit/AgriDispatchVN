resource "azurerm_key_vault" "main" {
  name                          = local.kv_name
  resource_group_name           = azurerm_resource_group.bt05.name
  location                      = azurerm_resource_group.bt05.location
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 7
  public_network_access_enabled = true
  tags                          = local.tags

  network_acls {
    bypass                     = "AzureServices"
    default_action             = "Deny"
    ip_rules                   = var.operator_ip_ranges
    virtual_network_subnet_ids = [azurerm_subnet.aks.id, azurerm_subnet.webapp.id]
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Secret writers (human or pipeline runner) need Secrets Officer on the vault.
resource "azurerm_role_assignment" "kv_operator_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Each workload reads only its own secret names. Scope is per-secret, not per-vault.
resource "azurerm_role_assignment" "account_kv_reader" {
  scope                = azurerm_key_vault_secret.account_database_url.resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.account.principal_id
}

resource "azurerm_role_assignment" "account_token_kv_reader" {
  scope                = azurerm_key_vault_secret.internal_service_token.resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.account.principal_id
}

resource "azurerm_role_assignment" "migrator_kv_reader" {
  scope                = azurerm_key_vault_secret.migration_database_url.resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.migrator.principal_id
}

resource "azurerm_role_assignment" "web_booking_kv_reader" {
  scope                = azurerm_key_vault_secret.booking_database_url.resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.web.principal_id
}

resource "azurerm_role_assignment" "web_token_kv_reader" {
  scope                = azurerm_key_vault_secret.internal_service_token.resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.web.principal_id
}

# Write-only values never enter state. Bump the *_version variable to rotate.
resource "azurerm_key_vault_secret" "account_database_url" {
  name             = "ACCOUNT-DATABASE-URL"
  key_vault_id     = azurerm_key_vault.main.id
  value_wo         = var.account_database_url
  value_wo_version = var.secret_version
  content_type     = "text/plain"
  tags             = local.tags
  depends_on       = [azurerm_role_assignment.kv_operator_secrets]
}

resource "azurerm_key_vault_secret" "internal_service_token" {
  name             = "INTERNAL-SERVICE-TOKEN"
  key_vault_id     = azurerm_key_vault.main.id
  value_wo         = var.internal_service_token
  value_wo_version = var.secret_version
  content_type     = "text/plain"
  tags             = local.tags
  depends_on       = [azurerm_role_assignment.kv_operator_secrets]
}

resource "azurerm_key_vault_secret" "migration_database_url" {
  name             = "MIGRATION-DATABASE-URL"
  key_vault_id     = azurerm_key_vault.main.id
  value_wo         = var.migration_database_url
  value_wo_version = var.secret_version
  content_type     = "text/plain"
  tags             = local.tags
  depends_on       = [azurerm_role_assignment.kv_operator_secrets]
}

resource "azurerm_key_vault_secret" "booking_database_url" {
  name             = "BOOKING-DATABASE-URL"
  key_vault_id     = azurerm_key_vault.main.id
  value_wo         = var.booking_database_url
  value_wo_version = var.secret_version
  content_type     = "text/plain"
  tags             = local.tags
  depends_on       = [azurerm_role_assignment.kv_operator_secrets]
}

resource "azurerm_key_vault_secret" "pg_admin_password" {
  name             = "PG-ADMIN-PASSWORD"
  key_vault_id     = azurerm_key_vault.main.id
  value_wo         = var.pg_admin_password
  value_wo_version = var.pg_admin_password_version
  content_type     = "text/plain"
  tags             = local.tags
  depends_on       = [azurerm_role_assignment.kv_operator_secrets]
}
