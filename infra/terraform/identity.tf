# User-assigned identities for workloads. Thumbnail Function uses its system-assigned
# identity (configuredBlobStore has no client-ID selector), so it has no UAMI here.
resource "azurerm_user_assigned_identity" "aks_cluster" {
  name                = "id-aks-cluster-bt05"
  location            = azurerm_resource_group.bt05.location
  resource_group_name = azurerm_resource_group.bt05.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "aks_kubelet" {
  name                = "id-aks-kubelet-bt05"
  location            = azurerm_resource_group.bt05.location
  resource_group_name = azurerm_resource_group.bt05.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "account" {
  name                = "id-account-workload-bt05"
  location            = azurerm_resource_group.bt05.location
  resource_group_name = azurerm_resource_group.bt05.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "migrator" {
  name                = "id-db-migrator-bt05"
  location            = azurerm_resource_group.bt05.location
  resource_group_name = azurerm_resource_group.bt05.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "web" {
  name                = "id-booking-web-bt05"
  location            = azurerm_resource_group.bt05.location
  resource_group_name = azurerm_resource_group.bt05.name
  tags                = local.tags
}

# Workload identity federation: the AKS OIDC issuer trusts only the named Kubernetes
# service accounts. Audience and subject are fixed by the contract.
resource "azurerm_federated_identity_credential" "account" {
  name                      = "fic-account-service"
  user_assigned_identity_id = azurerm_user_assigned_identity.account.id
  audience                  = [local.oidc_audience]
  issuer                    = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject                   = local.account_k8s_subject
}

resource "azurerm_federated_identity_credential" "migrator" {
  name                      = "fic-db-migrator"
  user_assigned_identity_id = azurerm_user_assigned_identity.migrator.id
  audience                  = [local.oidc_audience]
  issuer                    = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject                   = local.migration_k8s_subject
}

# AKS cluster identity manages the node subnet and the kubelet identity.
resource "azurerm_role_assignment" "aks_subnet_network" {
  scope                = azurerm_subnet.aks.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_user_assigned_identity.aks_cluster.principal_id
}

resource "azurerm_role_assignment" "aks_kubelet_operator" {
  scope                = azurerm_user_assigned_identity.aks_kubelet.id
  role_definition_name = "Managed Identity Operator"
  principal_id         = azurerm_user_assigned_identity.aks_cluster.principal_id
}

resource "azurerm_role_assignment" "kubelet_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.aks_kubelet.principal_id
}

resource "azurerm_role_assignment" "web_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.web.principal_id
}

resource "azurerm_role_assignment" "function_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_linux_function_app.thumbnail.identity[0].principal_id
}
