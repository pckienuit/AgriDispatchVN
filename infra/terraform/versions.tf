terraform {
  required_version = ">= 1.17.2, < 2.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "5.14.0"
    }
  }

  # Partial backend. Supply the state account with `-backend-config=backend.hcl`
  # (template: backend.hcl.example). The state account is bootstrapped manually;
  # this root never creates it. Local state is not used for this stack.
  backend "azurerm" {}
}
