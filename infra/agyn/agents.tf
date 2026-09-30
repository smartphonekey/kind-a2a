# SPDX-License-Identifier: AGPL-3.0-only
variable "organization_id" {
  type = string
}

variable "agents" {
  # The child module validates the execution contract after defaults are merged.
  # existing_id is import provenance, not part of the agent resource schema.
  type = any
}

module "agents" {
  source          = "../modules/a2a-agents"
  organization_id = var.organization_id
  agents = { for id, agent in var.agents : id => merge({
    role              = ""
    availability      = "private"
    capabilities      = ["compute-resources"]
    idle_timeout      = "10s"
    instance_idle_ttl = "24h"
    default_thread    = "origin"
    final_message     = "discard"
    configuration = jsonencode({
      system_prompt = trimspace(file("${path.module}/a2a-instructions.txt"))
    })
  }, agent) }
}

# Imports are permanent provenance, not resource-creation requests. The plan
# policy rejects any change to an existing agent, including a missing import.
import {
  for_each = { for id, agent in var.agents : id => agent.existing_id if try(agent.existing_id, null) != null }
  to       = module.agents.agyn_agent.profile[each.key]
  id       = each.value
}

output "a2a_profiles" {
  value = module.agents.profiles
}
