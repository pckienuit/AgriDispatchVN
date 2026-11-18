provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  # Never auto-register resource providers. Registration is a manual, reviewed step.
  resource_provider_registrations = "none"

  features {
    resource_group {
      # Refuse to delete a resource group that still holds resources.
      prevent_deletion_if_contains_resources = true
    }

    key_vault {
      # Soft-deleted vaults are recovered, never purged, by this stack.
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
  }
}
