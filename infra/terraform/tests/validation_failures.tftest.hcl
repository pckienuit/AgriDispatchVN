mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "11111111-1111-1111-1111-111111111111"
      object_id = "22222222-2222-2222-2222-222222222222"
    }
  }

  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      oidc_issuer_url = "https://japaneast.oic.prod-aks.azure.com/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      primary_blob_endpoint  = "https://stevdbt05a1.blob.core.windows.net/"
      primary_queue_endpoint = "https://stevdbt05a1.queue.core.windows.net/"
    }
  }

  mock_resource "azurerm_application_insights" {
    defaults = {
      connection_string = "InstrumentationKey=00000000-0000-0000-0000-000000000000"
    }
  }
}

variables {
  subscription_id        = "00000000-0000-0000-0000-000000000001"
  location               = "japaneast"
  resource_group_name    = "rg-agridispatch-bt05"
  name_suffix            = "bt05a1"
  operator_ip_ranges     = ["198.51.100.10/32"]
  kubernetes_version     = "1.31"
  aks_system_vm_size     = "Standard_D4s_v3"
  aks_system_node_count  = 2
  app_service_sku_name   = "S1"
  build_sha              = "14a0e9a71427e1664d24003338578083c47c4322"
  app_image              = "acragribt05a1.azurecr.io/agridispatch-app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  function_image         = "acragribt05a1.azurecr.io/agridispatch-thumbnail@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  pg_admin_password      = "test-only-bootstrap-password-24chars"
  account_database_url   = "postgresql://account_runtime:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full"
  booking_database_url   = "postgresql://booking_runtime:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full"
  migration_database_url = "postgresql://migrator_role:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full"
  internal_service_token = "test-only-internal-service-token-32chars"
  budget_amount_usd      = 43.03
  budget_contact_emails  = ["ops@example.invalid"]
}

run "reject_disallowed_region" {
  command = plan

  variables {
    location = "eastus"
  }

  expect_failures = [var.location]
}

run "reject_fractional_system_nodes" {
  command = plan
  variables { aks_system_node_count = 2.5 }
  expect_failures = [var.aks_system_node_count]
}

run "reject_budget_above_authorized_cap" {
  command = plan
  variables { budget_amount_usd = 44 }
  expect_failures = [var.budget_amount_usd]
}

run "reject_alternate_resource_group" {
  command = plan
  variables { resource_group_name = "unrelated-course" }
  expect_failures = [var.resource_group_name]
}

run "reject_disallowed_region_again" {
  command = plan

  variables {
    location = "eastus"
  }

  expect_failures = [
    var.location,
  ]
}

run "reject_bot_resource_group_reuse" {
  command = plan

  variables {
    resource_group_name = "rg-is402"
  }

  expect_failures = [
    var.resource_group_name,
  ]
}

run "reject_b_series_aks_system_pool" {
  command = plan

  variables {
    aks_system_vm_size = "Standard_B2as_v2"
  }

  expect_failures = [
    var.aks_system_vm_size,
  ]
}

run "reject_single_node_aks_system_pool" {
  command = plan

  variables {
    aks_system_node_count = 1
  }

  expect_failures = [
    var.aks_system_node_count,
  ]
}

run "reject_excess_aks_node_count" {
  command = plan

  variables {
    aks_system_node_count = 4
  }

  expect_failures = [
    var.aks_system_node_count,
  ]
}

run "reject_basic_app_service_sku_without_slots" {
  command = plan

  variables {
    app_service_sku_name = "B1"
  }

  expect_failures = [
    var.app_service_sku_name,
  ]
}

run "reject_unpinned_latest_app_image" {
  command = plan

  variables {
    app_image = "acragribt05a1.azurecr.io/agridispatch-app:latest"
  }

  expect_failures = [
    var.app_image,
  ]
}

run "reject_unpinned_function_image" {
  command = plan

  variables {
    function_image = "acragribt05a1.azurecr.io/agridispatch-thumbnail:14a0e9a"
  }

  expect_failures = [
    var.function_image,
  ]
}

run "reject_short_build_sha" {
  command = plan

  variables {
    build_sha = "14a0e9a"
  }

  expect_failures = [
    var.build_sha,
  ]
}

run "reject_world_open_firewall_cidr" {
  command = plan

  variables {
    operator_ip_ranges = ["0.0.0.0/0"]
  }

  expect_failures = [
    var.operator_ip_ranges,
  ]
}

run "reject_slash31_storage_firewall_cidr" {
  command = plan

  variables {
    operator_ip_ranges = ["198.51.100.10/31"]
  }

  expect_failures = [
    var.operator_ip_ranges,
  ]
}

run "reject_empty_aks_authorized_ip_ranges" {
  command = plan

  variables {
    operator_ip_ranges = []
  }

  expect_failures = [
    azurerm_kubernetes_cluster.main,
  ]
}

run "reject_database_url_without_verify_full" {
  command = plan

  variables {
    booking_database_url = "postgresql://booking_runtime:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=require"
  }

  expect_failures = [
    var.booking_database_url,
  ]
}

run "reject_database_url_with_extra_query_param" {
  command = plan

  variables {
    account_database_url = "postgresql://account_runtime:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full&host=evil.invalid"
  }

  expect_failures = [
    var.account_database_url,
  ]
}

run "reject_short_internal_service_token" {
  command = plan

  variables {
    internal_service_token = "too-short-token"
  }

  expect_failures = [
    var.internal_service_token,
  ]
}

run "reject_noncanonical_postgres_fqdn" {
  command = plan

  variables {
    account_database_url = "postgresql://account_runtime:test-only-pass-value@psql-agri-bt05a1.bt05a1.postgres.database.azure.com:5432/agridispatch?sslmode=verify-full"
  }

  expect_failures = [
    var.account_database_url,
  ]
}

run "reject_split_database_name" {
  command = plan

  variables {
    booking_database_url = "postgresql://booking_runtime:test-only-pass-value@psql-agri-bt05a1.postgres.database.azure.com:5432/agridispatch_booking?sslmode=verify-full"
  }

  expect_failures = [
    var.booking_database_url,
  ]
}
