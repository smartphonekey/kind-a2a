# SPDX-License-Identifier: AGPL-3.0-only
locals {
  organization_id = "92e4cc65-e85d-4241-bd7a-bad877df30a6"
  # Keep existing public profile IDs and runtime identities. New variants use new
  # versioned keys and new agents; never repoint a profile used by stored tasks.
  agents = {
    codex = {
      existing_id    = "739100eb-7d54-4408-9e33-b7b32914e03e"
      name           = "A2A Web Codex"
      nickname       = "a2a-web-codex-v1"
      environment_id = "4fbfc0ca-fb03-4b02-ae75-f373f88eb397"
      model_name     = "gpt-5.5"
    }
    claude = {
      existing_id    = "8fe877b6-b32b-493e-ba2c-dfc9d1077f78"
      name           = "A2A Web claude"
      nickname       = "a2a-web-claude-v1"
      environment_id = "974a73a2-33a9-4e3d-87f6-f79344129f3b"
      model_name     = "claude-sonnet-5"
    }
  }
}

module "agents" {
  source          = "../modules/a2a-agents"
  organization_id = local.organization_id
  agents = { for id, agent in local.agents : id => merge({
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
  for_each = { for id, agent in local.agents : id => agent.existing_id if try(agent.existing_id, null) != null }
  to       = module.agents.agyn_agent.profile[each.key]
  id       = each.value
}

output "a2a_profiles" {
  value = module.agents.profiles
}
