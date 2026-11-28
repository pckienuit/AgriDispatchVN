resource "azurerm_container_registry" "main" {
  name                          = local.acr_name
  resource_group_name           = azurerm_resource_group.bt05.name
  location                      = azurerm_resource_group.bt05.location
  sku                           = "Basic"
  admin_enabled                 = false
  anonymous_pull_enabled        = false
  public_network_access_enabled = true
  tags                          = local.tags

  lifecycle {
    prevent_destroy = true
  }
}
