# ---- cert-manager workload identity (DNS-01 solver against Azure DNS) ----
resource "azurerm_user_assigned_identity" "certmanager" {
  count               = local.enable_azure_dns ? 1 : 0
  name                = "${var.prefix}-certmanager"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  tags                = var.tags
}

resource "azurerm_role_assignment" "certmanager_dns" {
  count                = local.enable_azure_dns ? 1 : 0
  scope                = azurerm_dns_zone.zone[0].id
  role_definition_name = "DNS Zone Contributor"
  principal_id         = azurerm_user_assigned_identity.certmanager[0].principal_id
}

# bind the identity to the cert-manager service account via OIDC
resource "azurerm_federated_identity_credential" "certmanager" {
  count               = local.enable_azure_dns ? 1 : 0
  name                = "cert-manager"
  resource_group_name = azurerm_resource_group.rg.name
  parent_id           = azurerm_user_assigned_identity.certmanager[0].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.aks.oidc_issuer_url
  subject             = "system:serviceaccount:cert-manager:cert-manager"
}

# ---- GitHub Actions OIDC (no long-lived secret) ----
resource "azuread_application" "gha" {
  display_name = "${var.prefix}-github-actions"
}

resource "azuread_service_principal" "gha" {
  client_id = azuread_application.gha.client_id
}

resource "azuread_application_federated_identity_credential" "gha_master" {
  application_id = azuread_application.gha.id
  display_name   = "github-master"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:${var.github_repo}:ref:refs/heads/master"
}

# deploy permissions: push to ACR, pull kubeconfig and apply to AKS
resource "azurerm_role_assignment" "gha_acr_push" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPush"
  principal_id         = azuread_service_principal.gha.object_id
}

resource "azurerm_role_assignment" "gha_aks_admin" {
  scope                = azurerm_kubernetes_cluster.aks.id
  role_definition_name = "Azure Kubernetes Service Cluster Admin Role"
  principal_id         = azuread_service_principal.gha.object_id
}
