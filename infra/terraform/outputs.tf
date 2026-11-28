# Safe non-secret outputs only. No connection strings, keys, tokens, or secret values.

output "resource_group_name" {
  description = "Dedicated BT05 resource group name."
  value       = azurerm_resource_group.bt05.name
}

output "location" {
  description = "Deployed Azure region."
  value       = azurerm_resource_group.bt05.location
}

output "acr_login_server" {
  description = "ACR login server hostname."
  value       = azurerm_container_registry.main.login_server
}

output "key_vault_name" {
  description = "Key Vault name for AKS CSI SecretProviderClass and App Service references."
  value       = azurerm_key_vault.main.name
}

output "key_vault_uri" {
  description = "Key Vault URI."
  value       = azurerm_key_vault.main.vault_uri
}

output "tenant_id" {
  description = "Entra tenant ID required by AKS SecretProviderClass and workload identity."
  value       = data.azurerm_client_config.current.tenant_id
}

output "account_client_id" {
  description = "Client ID of the account-service workload UAMI (distinct from migration_client_id)."
  value       = azurerm_user_assigned_identity.account.client_id
}

output "migration_client_id" {
  description = "Client ID of the db-migrator workload UAMI (federated to system:serviceaccount:agridispatch:agridispatch-migrate)."
  value       = azurerm_user_assigned_identity.migrator.client_id
}

output "account_workload_identity_client_id" {
  description = "Alias of account_client_id for Kubernetes ServiceAccount annotation and SecretProviderClass."
  value       = azurerm_user_assigned_identity.account.client_id
}

output "migrator_workload_identity_client_id" {
  description = "Alias of migration_client_id for the Kubernetes migration job."
  value       = azurerm_user_assigned_identity.migrator.client_id
}

output "web_identity_client_id" {
  description = "Client ID of the booking web app UAMI (ACR pull and Key Vault references)."
  value       = azurerm_user_assigned_identity.web.client_id
}

output "aks_cluster_name" {
  description = "AKS cluster name."
  value       = azurerm_kubernetes_cluster.main.name
}

output "aks_oidc_issuer_url" {
  description = "AKS OIDC issuer URL (non-secret discovery endpoint)."
  value       = azurerm_kubernetes_cluster.main.oidc_issuer_url
}

output "account_service_internal_url" {
  description = "Static internal URL of account-service inside the AKS subnet, consumed by the booking web app."
  value       = local.account_service_url
}

output "account_service_internal_ip" {
  description = "Static internal LoadBalancer IP for account-service inside snet-aks (10.42.2.0/24)."
  value       = local.account_service_ip
}

output "booking_web_app_hostname" {
  description = "Default HTTPS hostname of the booking web app."
  value       = azurerm_linux_web_app.booking.default_hostname
}

output "booking_staging_hostname" {
  description = "Default HTTPS hostname of the booking staging slot."
  value       = azurerm_linux_web_app_slot.staging.default_hostname
}

output "thumbnail_function_hostname" {
  description = "Default HTTPS hostname of the thumbnail Function host."
  value       = azurerm_linux_function_app.thumbnail.default_hostname
}

output "postgres_fqdn" {
  description = "Private FQDN of the PostgreSQL Flexible Server."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "evidence_storage_blob_endpoint" {
  description = "Primary Blob service endpoint for private evidence and thumbnails."
  value       = azurerm_storage_account.evidence.primary_blob_endpoint
}

output "log_analytics_workspace_id" {
  description = "Resource ID of the Log Analytics workspace."
  value       = azurerm_log_analytics_workspace.main.id
}

output "key_vault_secret_names" {
  description = "Contract secret names provisioned in Key Vault (names only, no values)."
  value = [
    azurerm_key_vault_secret.account_database_url.name,
    azurerm_key_vault_secret.booking_database_url.name,
    azurerm_key_vault_secret.migration_database_url.name,
    azurerm_key_vault_secret.internal_service_token.name,
  ]
}

output "deployed_image_references" {
  description = "Non-secret immutable image digest inputs wired to App Service, staging slot, and Function host."
  value = {
    app_image         = var.app_image
    staging_app_image = local.staging_image
    function_image    = var.function_image
    function_digest   = "sha256:${local.function_digest}"
    build_sha         = var.build_sha
  }
}
