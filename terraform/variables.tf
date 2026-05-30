variable "prefix" {
  description = "Short prefix for resource names"
  type        = string
  default     = "devsu"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "node_count" {
  description = "AKS node count (1 keeps the trial cheap; HPA still works)"
  type        = number
  default     = 1
}

variable "node_vm_size" {
  description = "AKS node VM size"
  type        = string
  default     = "Standard_D2s_v3"
}

variable "enable_managed_pg" {
  description = "Provision Azure PostgreSQL Flexible. Some trial subscriptions restrict it (LocationIsOfferRestricted); then deploy postgres in-cluster instead."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Domain managed in Azure DNS. Empty = skip DNS/Front Door (deploy core infra only)."
  type        = string
  default     = ""
}

variable "app_subdomain" {
  description = "Public hostname exposed by Front Door (customizable per self-service env)"
  type        = string
  default     = "devsu-prod"
}

variable "origin_subdomain" {
  description = "Hostname of the AKS ingress (the Front Door origin)"
  type        = string
  default     = "origin"
}

variable "pg_admin_user" {
  description = "PostgreSQL admin username"
  type        = string
  default     = "devsu"
}

variable "github_repo" {
  description = "owner/repo used for the GitHub Actions OIDC federation subject"
  type        = string
  default     = "gcamargot/devsu-challenge"
}

variable "tags" {
  type = map(string)
  default = {
    project = "devsu-challenge"
    owner   = "gcamargot"
  }
}
