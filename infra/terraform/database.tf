# Azure Database for PostgreSQL Flexible Server 17, Burstable B1ms, 32 GiB, private VNet access.
# TLS is enforced server-side; clients must use sslmode=verify-full (see the secret URL contract).
resource "azurerm_postgresql_flexible_server" "main" {
  name                          = local.pg_name
  resource_group_name           = azurerm_resource_group.bt05.name
  location                      = azurerm_resource_group.bt05.location
  version                       = "17"
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  auto_grow_enabled             = false
  delegated_subnet_id           = azurerm_subnet.pg.id
  private_dns_zone_id           = azurerm_private_dns_zone.pg.id
  public_network_access_enabled = false

  administrator_login               = var.pg_admin_login
  administrator_password_wo         = var.pg_admin_password
  administrator_password_wo_version = var.pg_admin_password_version

  authentication {
    active_directory_auth_enabled = false
    password_auth_enabled         = true
  }

  tags = local.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.pg]

  lifecycle {
    prevent_destroy = true
  }
}

# Require TLS in transit on the server side. Clients still verify the server certificate.
resource "azurerm_postgresql_flexible_server_configuration" "require_secure_transport" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "on"
}

# Single shared PostgreSQL database (schemas `account` and `dispatch`) matching app migrations.
# Out-of-band DB bootstrap creates distinct least-privilege roles (account_runtime, booking_runtime, migrator).
resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = local.pg_database_name
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"

  lifecycle {
    prevent_destroy = true
  }
}
