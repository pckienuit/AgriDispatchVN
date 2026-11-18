# Shared naming and contract values. Names are derived from name_suffix so they are
# globally unique without random resources, which keeps plans reproducible.
locals {
  tags = merge({
    project   = "agridispatch-vn"
    course    = "IS402-BT05"
    managed   = "terraform"
    retention = "keep-until-approved-no-auto-delete"
  }, var.tags)

  acr_name         = "acragri${var.name_suffix}"
  acr_login_server = "${local.acr_name}.azurecr.io"
  kv_name          = "kv-agri-${var.name_suffix}"
  pg_name          = "psql-agri-${var.name_suffix}"
  pg_database_name = "agridispatch"
  pg_dns_zone      = "private.postgres.database.azure.com"
  pg_fqdn          = "${local.pg_name}.postgres.database.azure.com"
  evidence_account = "stevd${var.name_suffix}"
  host_account     = "sthost${var.name_suffix}"
  web_app_name     = "app-booking-${var.name_suffix}"
  function_name    = "func-thumb-${var.name_suffix}"
  plan_name        = "asp-agri-bt05"
  aks_name         = "aks-agri-${var.name_suffix}"
  log_name         = "log-agri-bt05"
  appi_name        = "appi-agri-bt05"

  # Contract values from the BT05 architecture. Changing them changes the parent contract.
  vnet_cidr             = "10.42.0.0/16"
  subnet_webapp_cidr    = "10.42.1.0/24"
  subnet_aks_cidr       = "10.42.2.0/24"
  subnet_pg_cidr        = "10.42.3.0/24"
  aks_service_cidr      = "10.43.0.0/16"
  aks_dns_service_ip    = "10.43.0.10"
  account_service_ip    = "10.42.2.10"
  account_service_port  = 3001
  account_service_url   = "http://10.42.2.10:3001"
  account_k8s_subject   = "system:serviceaccount:${var.account_k8s_namespace}:${var.account_k8s_service_account}"
  migration_k8s_subject = "system:serviceaccount:${var.account_k8s_namespace}:${var.migration_k8s_service_account}"
  oidc_audience         = "api://AzureADTokenExchange"
  evidence_container    = "evidence"
  thumbnail_container   = "thumbnails"
  staging_image         = var.staging_app_image != null ? var.staging_app_image : var.app_image
  app_image_ref         = trimprefix(var.app_image, "${local.acr_login_server}/")
  app_repo              = split("@sha256:", local.app_image_ref)[0]
  staging_image_ref     = trimprefix(local.staging_image, "${local.acr_login_server}/")
  function_image_ref    = trimprefix(var.function_image, "${local.acr_login_server}/")
  function_repo         = split("@sha256:", local.function_image_ref)[0]
  function_digest       = split("@sha256:", local.function_image_ref)[1]
  # Azure Storage network_rules rejects /32 CIDRs; strip /32 to bare IPv4 for Storage only.
  storage_ip_rules = [for c in var.operator_ip_ranges : endswith(c, "/32") ? trimsuffix(c, "/32") : c]
}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "bt05" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags

  lifecycle {
    prevent_destroy = true
  }
}
