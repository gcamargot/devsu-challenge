# Static public IP for the ingress-nginx LB (core: always created).
resource "azurerm_public_ip" "ingress" {
  name                = "${var.prefix}-ingress-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

# AKS control-plane identity manages the LB, so let it use this IP
resource "azurerm_role_assignment" "aks_ingress_ip" {
  scope                = azurerm_public_ip.ingress.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_kubernetes_cluster.aks.identity[0].principal_id
}

# ---- everything below is gated on a domain being configured ----

# origin.<domain> -> ingress public IP (cert-manager issues a LE cert for it)
resource "azurerm_dns_a_record" "origin" {
  count               = local.enable_dns ? 1 : 0
  name                = var.origin_subdomain
  zone_name           = azurerm_dns_zone.zone[0].name
  resource_group_name = azurerm_resource_group.rg.name
  ttl                 = 300
  records             = [azurerm_public_ip.ingress.ip_address]
}

resource "azurerm_cdn_frontdoor_profile" "fd" {
  count               = local.enable_dns ? 1 : 0
  name                = "${var.prefix}-fd"
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = "Standard_AzureFrontDoor"
  tags                = var.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "fd" {
  count                    = local.enable_dns ? 1 : 0
  name                     = "${var.prefix}-ep"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.fd[0].id
}

resource "azurerm_cdn_frontdoor_origin_group" "fd" {
  count                    = local.enable_dns ? 1 : 0
  name                     = "aks-origin-group"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.fd[0].id

  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }

  health_probe {
    path                = "/health"
    protocol            = "Https"
    request_type        = "GET"
    interval_in_seconds = 30
  }
}

resource "azurerm_cdn_frontdoor_origin" "fd" {
  count                         = local.enable_dns ? 1 : 0
  name                          = "aks-ingress"
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.fd[0].id
  enabled                       = true

  host_name          = "${var.origin_subdomain}.${var.domain_name}"
  origin_host_header = "${var.origin_subdomain}.${var.domain_name}"
  https_port         = 443
  http_port          = 80
  priority           = 1
  weight             = 1000

  certificate_name_check_enabled = true
}

resource "azurerm_cdn_frontdoor_custom_domain" "app" {
  count                    = local.enable_dns ? 1 : 0
  name                     = "app-domain"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.fd[0].id
  dns_zone_id              = azurerm_dns_zone.zone[0].id
  host_name                = "${var.app_subdomain}.${var.domain_name}"

  tls {
    certificate_type = "ManagedCertificate"
    minimum_version  = "TLS12"
  }
}

resource "azurerm_cdn_frontdoor_route" "app" {
  count                         = local.enable_dns ? 1 : 0
  name                          = "app-route"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.fd[0].id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.fd[0].id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.fd[0].id]

  cdn_frontdoor_custom_domain_ids = [azurerm_cdn_frontdoor_custom_domain.app[0].id]
  supported_protocols             = ["Http", "Https"]
  patterns_to_match               = ["/*"]
  forwarding_protocol             = "HttpsOnly"
  https_redirect_enabled          = true
  link_to_default_domain          = false
}

resource "azurerm_dns_txt_record" "app_validation" {
  count               = local.enable_dns ? 1 : 0
  name                = "_dnsauth.${var.app_subdomain}"
  zone_name           = azurerm_dns_zone.zone[0].name
  resource_group_name = azurerm_resource_group.rg.name
  ttl                 = 3600

  record {
    value = azurerm_cdn_frontdoor_custom_domain.app[0].validation_token
  }
}

resource "azurerm_dns_cname_record" "app" {
  count               = local.enable_dns ? 1 : 0
  name                = var.app_subdomain
  zone_name           = azurerm_dns_zone.zone[0].name
  resource_group_name = azurerm_resource_group.rg.name
  ttl                 = 300
  record              = azurerm_cdn_frontdoor_endpoint.fd[0].host_name
}

# ---- WAF (Standard: custom rules; managed rule sets require Premium) ----
resource "azurerm_cdn_frontdoor_firewall_policy" "waf" {
  count               = local.enable_dns ? 1 : 0
  name                = "${var.prefix}waf"
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = azurerm_cdn_frontdoor_profile.fd[0].sku_name
  enabled             = true
  mode                = "Prevention"

  custom_rule {
    name     = "ratelimit"
    enabled  = true
    priority = 1
    type     = "RateLimitRule"
    action   = "Block"

    rate_limit_duration_in_minutes = 1
    rate_limit_threshold           = 300

    match_condition {
      match_variable     = "RequestUri"
      operator           = "Any"
      negation_condition = false
      match_values       = []
    }
  }
}

resource "azurerm_cdn_frontdoor_security_policy" "waf" {
  count                    = local.enable_dns ? 1 : 0
  name                     = "${var.prefix}-waf-assoc"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.fd[0].id

  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.waf[0].id

      association {
        domain {
          cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_custom_domain.app[0].id
        }
        patterns_to_match = ["/*"]
      }
    }
  }
}
