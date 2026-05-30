resource "random_password" "pg" {
  length           = 24
  special          = true
  override_special = "_-"
}

resource "azurerm_postgresql_flexible_server" "pg" {
  name                = "${var.prefix}-pg-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  version             = "16"

  administrator_login    = var.pg_admin_user
  administrator_password = random_password.pg.result

  sku_name   = "B_Standard_B1ms"
  storage_mb = 32768

  # Public access + firewall for the trial. Production would use a private
  # endpoint / VNet integration instead (documented in the README).
  public_network_access_enabled = true

  tags = var.tags
}

resource "azurerm_postgresql_flexible_server_database" "db" {
  name      = "devsu"
  server_id = azurerm_postgresql_flexible_server.pg.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# allow other Azure services (incl. AKS egress) to reach the server
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure" {
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.pg.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}
