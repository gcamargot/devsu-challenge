# Off-cluster monitoring for AKS: Azure Monitor managed Prometheus + Azure Managed Grafana.
#
# WHY OFF-CLUSTER: the node pool is at its trial quota (2x Standard_D2s_v3 = 4 vCPU). A
# Grafana OSS pod + Prometheus server would not fit. Azure Monitor managed Prometheus stores
# metrics in a managed Azure Monitor workspace; only a lightweight scrape agent (ama-metrics
# DaemonSet + kube-state-metrics) runs on the cluster. Grafana is fully managed (no pods).
#
# STATUS: authored as IaC documentation. In the trial these were provisioned live via az CLI
# (see observability/README.md) so a `terraform apply` is NOT required and was NOT run. If you
# adopt this file, set enable_monitoring=true and import the live resources first, or let TF
# create them in a fresh environment.
#
# Toggle in locals.tf:  enable_monitoring = var.enable_monitoring
# Default OFF to match the "author but do not apply" constraint.

# ---- Azure Monitor workspace (managed Prometheus backend) ----
resource "azurerm_monitor_workspace" "amw" {
  count               = local.enable_monitoring ? 1 : 0
  name                = "${var.prefix}-amw"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  tags                = var.tags
}

# ---- Enable the managed Prometheus metrics add-on on AKS ----
# Adds the ama-metrics agent (DaemonSet + ksm) to the cluster and ships metrics to the workspace.
# Equivalent to: az aks update --enable-azure-monitor-metrics --azure-monitor-workspace-resource-id ...
resource "azurerm_monitor_data_collection_endpoint" "dce" {
  count               = local.enable_monitoring ? 1 : 0
  name                = "${var.prefix}-dce"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  kind                = "Linux"
  tags                = var.tags
}

resource "azurerm_monitor_data_collection_rule" "dcr" {
  count                       = local.enable_monitoring ? 1 : 0
  name                        = "${var.prefix}-dcr"
  resource_group_name         = azurerm_resource_group.rg.name
  location                    = azurerm_resource_group.rg.location
  data_collection_endpoint_id = azurerm_monitor_data_collection_endpoint.dce[0].id
  kind                        = "Linux"

  destinations {
    monitor_account {
      monitor_account_id = azurerm_monitor_workspace.amw[0].id
      name               = "MonitoringAccount1"
    }
  }

  data_flow {
    streams      = ["Microsoft-PrometheusMetrics"]
    destinations = ["MonitoringAccount1"]
  }

  data_sources {
    prometheus_forwarder {
      streams = ["Microsoft-PrometheusMetrics"]
      name    = "PrometheusDataSource"
    }
  }
  tags = var.tags
}

resource "azurerm_monitor_data_collection_rule_association" "dcra" {
  count                   = local.enable_monitoring ? 1 : 0
  name                    = "${var.prefix}-dcra"
  target_resource_id      = azurerm_kubernetes_cluster.aks.id
  data_collection_rule_id = azurerm_monitor_data_collection_rule.dcr[0].id
}

# ---- Azure Managed Grafana ----
resource "azurerm_dashboard_grafana" "grafana" {
  count                             = local.enable_monitoring ? 1 : 0
  name                              = "${var.prefix}-grafana"
  resource_group_name               = azurerm_resource_group.rg.name
  location                          = azurerm_resource_group.rg.location
  sku                               = "Standard"
  grafana_major_version             = "12"
  api_key_enabled                   = false
  deterministic_outbound_ip_enabled = false
  public_network_access_enabled     = true

  identity {
    type = "SystemAssigned"
  }

  azure_monitor_workspace_integrations {
    resource_id = azurerm_monitor_workspace.amw[0].id
  }

  tags = var.tags
}

# Grafana's managed identity needs to read metrics from the workspace (auto-wired by the
# az --grafana-resource-id flag; explicit here for IaC parity).
resource "azurerm_role_assignment" "grafana_monitoring_reader" {
  count                = local.enable_monitoring ? 1 : 0
  scope                = azurerm_monitor_workspace.amw[0].id
  role_definition_name = "Monitoring Data Reader"
  principal_id         = azurerm_dashboard_grafana.grafana[0].identity[0].principal_id
}

# Grant the operator (current signed-in user) Grafana Admin so they can view/edit dashboards.
resource "azurerm_role_assignment" "grafana_admin" {
  count                = local.enable_monitoring ? 1 : 0
  scope                = azurerm_dashboard_grafana.grafana[0].id
  role_definition_name = "Grafana Admin"
  principal_id         = data.azurerm_client_config.current.object_id
}

output "grafana_endpoint" {
  value = local.enable_monitoring ? azurerm_dashboard_grafana.grafana[0].endpoint : ""
}

output "prometheus_query_endpoint" {
  value = local.enable_monitoring ? azurerm_monitor_workspace.amw[0].query_endpoint : ""
}
