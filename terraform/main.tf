data "azurerm_client_config" "current" {}

# random suffix for globally-unique names (ACR, Key Vault)
resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_resource_group" "rg" {
  name     = "${var.prefix}-rg"
  location = var.location
  tags     = var.tags
}

resource "azurerm_container_registry" "acr" {
  name                = "${var.prefix}acr${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = var.tags
}

resource "azurerm_kubernetes_cluster" "aks" {
  name                = "${var.prefix}-aks"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  dns_prefix          = "${var.prefix}-aks"
  sku_tier            = "Free"

  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  default_node_pool {
    name       = "system"
    node_count = var.node_count
    vm_size    = var.node_vm_size
    # when a custom VNet is enabled, run the nodes in its dedicated subnet
    vnet_subnet_id = local.enable_vnet ? azurerm_subnet.aks[0].id : null
  }

  identity {
    type = "SystemAssigned"
  }

  # Azure CNI so NetworkPolicy is actually enforced (unlike kind's kindnet)
  network_profile {
    network_plugin = "azure"
    network_policy = "azure"
  }

  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }

  tags = var.tags
}

# let AKS pull images from our ACR without imagePullSecrets
resource "azurerm_role_assignment" "aks_acr_pull" {
  scope                            = azurerm_container_registry.acr.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.aks.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}
