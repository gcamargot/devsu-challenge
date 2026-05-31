# FinOps: cost allocation + a budget with alerts.
#
# Cost allocation is done with the resource tags defined in variables.tf (project, owner,
# department, cost_center, environment, managed_by). Every resource carries them, so Azure
# Cost Management can break spend down by department/project/environment (Cost analysis ->
# group by tag, or scheduled exports filtered by tag). Enforcing the tags org-wide would be
# an Azure Policy (require-tag / append) at the subscription or management-group scope; left
# as a recommendation since this lives in a single trial subscription.

# Budget on the resource group: alerts at 80% (forecast) and 100% (actual). Created only when
# at least one contact email is provided (a budget needs a notification target).
resource "azurerm_consumption_budget_resource_group" "rg" {
  count             = length(var.budget_contact_emails) > 0 ? 1 : 0
  name              = "${var.prefix}-monthly"
  resource_group_id = azurerm_resource_group.rg.id

  amount     = var.budget_amount
  time_grain = "Monthly"

  time_period {
    start_date = "2026-05-01T00:00:00Z"
    end_date   = "2027-05-01T00:00:00Z"
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = var.budget_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
  }
}
