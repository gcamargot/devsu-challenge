resource "azurerm_key_vault" "kv" {
  name                       = "${var.prefix}kv${random_string.suffix.result}"
  location                   = azurerm_resource_group.rg.location
  resource_group_name        = azurerm_resource_group.rg.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = false
  tags                       = var.tags
}

# whoever runs terraform needs to be able to write the secret
resource "azurerm_role_assignment" "kv_deployer" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_key_vault_secret" "db_password" {
  name         = "db-password"
  value        = random_password.pg.result
  key_vault_id = azurerm_key_vault.kv.id

  depends_on = [azurerm_role_assignment.kv_deployer]
}

# the AKS Secrets Store CSI driver identity reads the secret at runtime
resource "azurerm_role_assignment" "kv_csi_reader" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_kubernetes_cluster.aks.key_vault_secrets_provider[0].secret_identity[0].object_id
}
