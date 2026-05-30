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
  value = azurerm_postgresql_flexible_server.pg.fqdn
}

output "key_vault_name" {
  value = azurerm_key_vault.kv.name
}

output "ingress_public_ip" {
  value = azurerm_public_ip.ingress.ip_address
}

output "dns_zone_name_servers" {
  description = "Set these as the NS records at the registrar"
  value       = azurerm_dns_zone.zone.name_servers
}

output "frontdoor_endpoint" {
  value = azurerm_cdn_frontdoor_endpoint.fd.host_name
}

output "app_url" {
  value = "https://${var.app_subdomain}.${var.domain_name}"
}

output "origin_host" {
  value = "${var.origin_subdomain}.${var.domain_name}"
}

output "certmanager_identity_client_id" {
  value = azurerm_user_assigned_identity.certmanager.client_id
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
