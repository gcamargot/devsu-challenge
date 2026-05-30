locals {
  # DNS + cert-manager DNS-01 only make sense once a domain is set.
  # Empty domain_name => deploy core infra only (RG, ACR, AKS, PG, Key Vault, ingress IP).
  enable_dns = var.domain_name != ""

  # Front Door is gated separately: it's forbidden on trial accounts. When off (default),
  # the AKS ingress is the public entrypoint and DNS points straight at its IP.
  enable_frontdoor = local.enable_dns && var.enable_frontdoor
}
