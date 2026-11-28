# Notification-only budget at the BT05 resource group scope.
# Azure budgets send alerts; they do NOT stop spending or pause resources.
resource "azurerm_consumption_budget_resource_group" "bt05" {
  name              = "budget-agri-bt05"
  resource_group_id = azurerm_resource_group.bt05.id
  amount            = var.budget_amount_usd
  time_grain        = "Monthly"

  time_period {
    start_date = var.budget_start_date
    end_date   = var.budget_end_date
  }

  notification {
    enabled        = true
    threshold      = 50
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"
    contact_emails = var.budget_contact_emails
  }
}
