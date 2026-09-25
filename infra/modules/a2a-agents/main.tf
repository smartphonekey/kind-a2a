# SPDX-License-Identifier: AGPL-3.0-only
terraform {
  required_version = ">= 1.7.0, < 2.0.0"
  required_providers {
    agyn = {
      source  = "agynio/agyn"
      version = "0.12.0"
    }
  }
}

# Environments are reviewed external prerequisites. They own runtime images,
# retained storage, required init/reporting gates, resource bounds and credentials.
# This module intentionally cannot manage instances, tasks, Pods or volumes.
resource "agyn_agent" "profile" {
  for_each          = var.agents
  organization_id   = var.organization_id
  name              = each.value.name
  nickname          = each.value.nickname
  role              = each.value.role
  environment_id    = each.value.environment_id
  model_name        = each.value.model_name
  description       = each.value.description
  configuration     = each.value.configuration
  availability      = each.value.availability
  capabilities      = each.value.capabilities
  idle_timeout      = each.value.idle_timeout
  instance_idle_ttl = each.value.instance_idle_ttl
  default_thread    = each.value.default_thread
  final_message     = each.value.final_message

  lifecycle {
    prevent_destroy = true
  }
}

output "profiles" {
  value = [for id in sort(keys(var.agents)) : {
    id      = id
    agentId = agyn_agent.profile[id].id
  }]
}
