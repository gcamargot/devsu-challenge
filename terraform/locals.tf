locals {
  # A domain is configured (drives the app host name / outputs).
  enable_dns = var.domain_name != ""

  # Azure DNS zone + cert-manager DNS-01 identity. Off when DNS lives in Cloudflare.
  enable_azure_dns = local.enable_dns && var.enable_azure_dns

  # Front Door is forbidden on trial accounts; off by default. Needs the Azure DNS zone.
  enable_frontdoor = local.enable_azure_dns && var.enable_frontdoor

  # Cloudflare manages DNS + edge (proxy/WAF/SSL) when a token + zone id are provided.
  enable_cloudflare = var.cloudflare_api_token != "" && var.cloudflare_zone_id != ""
}
