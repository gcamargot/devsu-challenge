resource "random_password" "pg" {
  length           = 24
  special          = true
  override_special = "_-"
}

resource "azurerm_postgresql_flexible_server" "pg" {
  count               = var.enable_managed_pg ? 1 : 0
  name                = "${var.prefix}-pg-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  version             = "16"

  administrator_login    = var.pg_admin_user
  administrator_password = random_password.pg.result

  sku_name   = "B_Standard_B1ms"
  storage_mb = 32768

  # With enable_vnet the server is VNet-integrated (private, no public endpoint).
  # Without it (trial path) it falls back to public access + a firewall rule.
  public_network_access_enabled = !local.enable_vnet
  delegated_subnet_id           = local.enable_vnet ? azurerm_subnet.data[0].id : null
  private_dns_zone_id           = local.enable_vnet ? azurerm_private_dns_zone.pg[0].id : null

  tags = var.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.pg]
}

resource "azurerm_postgresql_flexible_server_database" "db" {
  count     = var.enable_managed_pg ? 1 : 0
  name      = "devsu"
  server_id = azurerm_postgresql_flexible_server.pg[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# public-access path only: allow other Azure services (incl. AKS egress) to reach the server.
# With enable_vnet the server is private and this rule is not created.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure" {
  count            = var.enable_managed_pg && !local.enable_vnet ? 1 : 0
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.pg[0].id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}
