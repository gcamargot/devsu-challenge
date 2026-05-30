# DNS zone for the domain (registered via Azure App Service Domains, which can
# create this zone automatically; here we manage it as code).
resource "azurerm_dns_zone" "zone" {
  name                = var.domain_name
  resource_group_name = azurerm_resource_group.rg.name
  tags                = var.tags
}
