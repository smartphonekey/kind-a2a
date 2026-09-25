# SPDX-License-Identifier: AGPL-3.0-only
terraform {
  required_version = ">= 1.16.0, < 1.17.0"
  required_providers {
    agyn = {
      source  = "agynio/agyn"
      version = "0.12.0"
    }
  }

  # Credentials come from KUBE_CONFIG_PATH or KUBE_IN_CLUSTER_CONFIG, never Git.
  # This is a separate state object; it does not adopt the application's PVC.
  backend "kubernetes" {
    namespace     = "aira-a2a"
    secret_suffix = "agent-definitions"
  }
}

provider "agyn" {
  api_url = var.gateway_url
  # AGYN_API_TOKEN is supplied by the operator/CI environment.
}

variable "gateway_url" {
  type    = string
  default = "https://gateway.agyn.dev:2496"
  validation {
    condition     = can(regex("^https://[^/?#@]+(:[0-9]+)?/?$", var.gateway_url))
    error_message = "Use the authenticated HTTPS Gateway origin with certificate verification enabled."
  }
}
