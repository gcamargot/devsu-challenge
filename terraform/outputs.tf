output "resource_group" {
  value = azurerm_resource_group.rg.name
}

output "acr_login_server" {
  value = azurerm_container_registry.acr.login_server
}

output "aks_name" {
  value = azurerm_kubernetes_cluster.aks.name
}

output "aks_oidc_issuer_url" {
  value = azurerm_kubernetes_cluster.aks.oidc_issuer_url
}

output "postgres_fqdn" {
  value = var.enable_managed_pg ? azurerm_postgresql_flexible_server.pg[0].fqdn : ""
}

output "key_vault_name" {
  value = azurerm_key_vault.kv.name
}

output "ingress_public_ip" {
  value = azurerm_public_ip.ingress.ip_address
}

output "dns_zone_name_servers" {
  description = "Azure DNS name servers (only when DNS is managed in Azure; DNS now lives in Cloudflare)"
  value       = local.enable_azure_dns ? azurerm_dns_zone.zone[0].name_servers : []
}

output "frontdoor_endpoint" {
  value = local.enable_frontdoor ? azurerm_cdn_frontdoor_endpoint.fd[0].host_name : ""
}

output "app_url" {
  value = local.enable_dns ? "https://${var.app_subdomain}.${var.domain_name}" : ""
}

output "origin_host" {
  value = local.enable_frontdoor ? "${var.origin_subdomain}.${var.domain_name}" : ""
}

output "certmanager_identity_client_id" {
  value = local.enable_azure_dns ? azurerm_user_assigned_identity.certmanager[0].client_id : ""
}

output "github_actions_client_id" {
  value = azuread_application.gha.client_id
}

output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "subscription_id" {
  value = data.azurerm_client_config.current.subscription_id
}
