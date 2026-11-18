resource "azurerm_virtual_network" "bt05" {
  name                = "vnet-agri-bt05"
  location            = azurerm_resource_group.bt05.location
  resource_group_name = azurerm_resource_group.bt05.name
  address_space       = [local.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "snet-aks"
  resource_group_name  = azurerm_resource_group.bt05.name
  virtual_network_name = azurerm_virtual_network.bt05.name
  address_prefixes     = [local.subnet_aks_cidr]

  service_endpoint {
    service = "Microsoft.KeyVault"
  }
}

resource "azurerm_subnet" "webapp" {
  name                 = "snet-webapp-integration"
  resource_group_name  = azurerm_resource_group.bt05.name
  virtual_network_name = azurerm_virtual_network.bt05.name
  address_prefixes     = [local.subnet_webapp_cidr]

  service_endpoint {
    service = "Microsoft.KeyVault"
  }

  service_endpoint {
    service = "Microsoft.Storage"
  }

  delegation {
    name = "webapp-serverfarm"
    service_delegation {
      name    = "Microsoft.Web/serverFarms"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

resource "azurerm_subnet" "pg" {
  name                 = "snet-pg"
  resource_group_name  = azurerm_resource_group.bt05.name
  virtual_network_name = azurerm_virtual_network.bt05.name
  address_prefixes     = [local.subnet_pg_cidr]

  delegation {
    name = "pg-flexible"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Private DNS for PostgreSQL Flexible Server VNet integration. Azure requires the zone name
# to end in .postgres.database.azure.com; private.postgres.database.azure.com is used while
# the server's canonical Azure FQDN and TLS SAN remain <server>.postgres.database.azure.com.
resource "azurerm_private_dns_zone" "pg" {
  name                = local.pg_dns_zone
  resource_group_name = azurerm_resource_group.bt05.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "pg" {
  name                 = "link-pg-bt05"
  private_dns_zone_id  = azurerm_private_dns_zone.pg.id
  virtual_network_id   = azurerm_virtual_network.bt05.id
  registration_enabled = false
  tags                 = local.tags
}
