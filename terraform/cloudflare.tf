provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# DNS records proxied through Cloudflare (the edge: CDN / WAF / DDoS / Universal SSL,
# replacing Azure Front Door which is forbidden on trial accounts). The wildcard covers
# devsu-prod and the self-service provisioner's ephemeral subdomains. ttl=1 => automatic
# (required while proxied).
resource "cloudflare_dns_record" "wildcard" {
  count   = local.enable_cloudflare ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "*"
  type    = "A"
  content = azurerm_public_ip.ingress.ip_address
  ttl     = 1
  proxied = true
}

resource "cloudflare_dns_record" "app" {
  count   = local.enable_cloudflare ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.app_subdomain
  type    = "A"
  content = azurerm_public_ip.ingress.ip_address
  ttl     = 1
  proxied = true
}
