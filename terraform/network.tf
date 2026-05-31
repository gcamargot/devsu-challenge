# Network segmentation (the Azure equivalent of an AWS VPC: VNet + subnets + NSGs +
# private endpoints). Gated by enable_vnet, off by default: moving AKS into a custom VNet
# forces a cluster recreation, and the managed PostgreSQL that benefits most from it is
# itself gated off on this trial subscription. Kept as the production network design.

resource "azurerm_virtual_network" "vnet" {
  count               = local.enable_vnet ? 1 : 0
  name                = "${var.prefix}-vnet"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  address_space       = ["10.20.0.0/16"]
  tags                = var.tags
}

# nodes + pods (Azure CNI)
resource "azurerm_subnet" "aks" {
  count                = local.enable_vnet ? 1 : 0
  name                 = "snet-aks"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet[0].name
  address_prefixes     = ["10.20.0.0/22"]
}

# data plane: delegated to PostgreSQL Flexible for VNet integration (no public endpoint)
resource "azurerm_subnet" "data" {
  count                = local.enable_vnet ? 1 : 0
  name                 = "snet-data"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet[0].name
  address_prefixes     = ["10.20.8.0/24"]

  delegation {
    name = "pgflex"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_network_security_group" "aks" {
  count               = local.enable_vnet ? 1 : 0
  name                = "${var.prefix}-nsg-aks"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  tags                = var.tags
}

resource "azurerm_subnet_network_security_group_association" "aks" {
  count                     = local.enable_vnet ? 1 : 0
  subnet_id                 = azurerm_subnet.aks[0].id
  network_security_group_id = azurerm_network_security_group.aks[0].id
}

# data subnet only accepts postgres traffic coming from the AKS subnet
resource "azurerm_network_security_group" "data" {
  count               = local.enable_vnet ? 1 : 0
  name                = "${var.prefix}-nsg-data"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location

  security_rule {
    name                       = "allow-pg-from-aks"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "5432"
    source_address_prefix      = "10.20.0.0/22"
    destination_address_prefix = "*"
  }

  tags = var.tags
}

resource "azurerm_subnet_network_security_group_association" "data" {
  count                     = local.enable_vnet ? 1 : 0
  subnet_id                 = azurerm_subnet.data[0].id
  network_security_group_id = azurerm_network_security_group.data[0].id
}

# private DNS so the app resolves the managed PostgreSQL to its private address
resource "azurerm_private_dns_zone" "pg" {
  count               = local.enable_vnet && var.enable_managed_pg ? 1 : 0
  name                = "${var.prefix}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "pg" {
  count                 = local.enable_vnet && var.enable_managed_pg ? 1 : 0
  name                  = "pg-link"
  resource_group_name   = azurerm_resource_group.rg.name
  private_dns_zone_name = azurerm_private_dns_zone.pg[0].name
  virtual_network_id    = azurerm_virtual_network.vnet[0].id
}
