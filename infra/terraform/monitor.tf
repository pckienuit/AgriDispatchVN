# Bounded Azure Monitor workspace + Application Insights + diagnostic settings.
# No fabricated alert thresholds or fake SLA alarms here.
resource "azurerm_log_analytics_workspace" "main" {
  name                = local.log_name
  location            = azurerm_resource_group.bt05.location
  resource_group_name = azurerm_resource_group.bt05.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.5
  tags                = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_application_insights" "main" {
  name                 = local.appi_name
  location             = azurerm_resource_group.bt05.location
  resource_group_name  = azurerm_resource_group.bt05.name
  workspace_id         = azurerm_log_analytics_workspace.main.id
  application_type     = "Node.JS"
  retention_in_days    = 30
  daily_data_cap_in_gb = 0.5
  tags                 = local.tags
}

resource "azurerm_monitor_diagnostic_setting" "webapp" {
  name                       = "diag-webapp-bt05"
  target_resource_id         = azurerm_linux_web_app.booking.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "AppServiceHTTPLogs"
  }

  enabled_log {
    category = "AppServiceConsoleLogs"
  }

  enabled_log {
    category = "AppServiceAppLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "function" {
  name                       = "diag-function-bt05"
  target_resource_id         = azurerm_linux_function_app.thumbnail.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "FunctionAppLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "aks" {
  name                       = "diag-aks-bt05"
  target_resource_id         = azurerm_kubernetes_cluster.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "kube-apiserver"
  }

  enabled_log {
    category = "kube-controller-manager"
  }

  enabled_log {
    category = "cluster-autoscaler"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "pg" {
  name                       = "diag-pg-bt05"
  target_resource_id         = azurerm_postgresql_flexible_server.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "PostgreSQLLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "evidence_blob" {
  name                       = "diag-evidence-blob-bt05"
  target_resource_id         = "${azurerm_storage_account.evidence.id}/blobServices/default"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "StorageRead"
  }

  enabled_log {
    category = "StorageWrite"
  }

  enabled_metric {
    category = "Transaction"
  }
}

resource "azurerm_monitor_diagnostic_setting" "key_vault" {
  name                       = "diag-kv-bt05"
  target_resource_id         = azurerm_key_vault.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "AuditEvent"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}
