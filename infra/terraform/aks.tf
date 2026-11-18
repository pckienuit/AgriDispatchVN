# AKS: system pool only (apps and account-service pods share it).
# Constraints from Microsoft system-pool docs: >= 2 nodes, >= 4 vCPU and 4 GiB per node, no B-series.
# Authorized IP ranges restrict the API server; empty list is rejected by the precondition.
resource "azurerm_kubernetes_cluster" "main" {
  name                = local.aks_name
  location            = azurerm_resource_group.bt05.location
  resource_group_name = azurerm_resource_group.bt05.name
  dns_prefix          = "agri-${var.name_suffix}"
  kubernetes_version  = var.kubernetes_version
  sku_tier            = "Free"
  tags                = local.tags

  private_cluster_enabled           = false
  role_based_access_control_enabled = true
  oidc_issuer_enabled               = true
  workload_identity_enabled         = true
  local_account_disabled            = false

  api_server_access_profile {
    authorized_ip_ranges = var.operator_ip_ranges
  }

  node_provisioning_profile {
    mode = "Manual"
  }

  default_node_pool {
    name                         = "system"
    vm_size                      = var.aks_system_vm_size
    node_count                   = var.aks_system_node_count
    vnet_subnet_id               = azurerm_subnet.aks.id
    os_disk_size_gb              = 64
    os_disk_type                 = "Managed"
    type                         = "VirtualMachineScaleSets"
    auto_scaling_enabled         = false
    only_critical_addons_enabled = false
    zones                        = []
    tags                         = local.tags
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aks_cluster.id]
  }

  kubelet_identity {
    client_id                 = azurerm_user_assigned_identity.aks_kubelet.client_id
    object_id                 = azurerm_user_assigned_identity.aks_kubelet.principal_id
    user_assigned_identity_id = azurerm_user_assigned_identity.aks_kubelet.id
  }

  network_profile {
    network_plugin    = "azure"
    network_policy    = "azure"
    load_balancer_sku = "standard"
    outbound_type     = "loadBalancer"
    service_cidr      = local.aks_service_cidr
    dns_service_ip    = local.aks_dns_service_ip
  }

  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = length(var.operator_ip_ranges) > 0
      error_message = "operator_ip_ranges must list at least one CIDR; an empty list leaves the AKS API server open to the internet."
    }

    precondition {
      condition     = var.aks_system_node_count >= 2
      error_message = "AKS system pool requires at least 2 nodes."
    }
  }

  depends_on = [
    azurerm_role_assignment.aks_subnet_network,
    azurerm_role_assignment.aks_kubelet_operator,
  ]
}
