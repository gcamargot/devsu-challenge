locals {
  # DNS + Front Door + cert-manager DNS-01 only make sense once a domain is set.
  # Empty domain_name => deploy core infra only (RG, ACR, AKS, PG, Key Vault, ingress IP).
  enable_dns = var.domain_name != ""
}
