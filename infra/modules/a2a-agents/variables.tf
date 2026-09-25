# SPDX-License-Identifier: AGPL-3.0-only
variable "organization_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", var.organization_id))
    error_message = "organization_id must be an explicit UUID."
  }
}

variable "agents" {
  type = map(object({
    name              = string
    nickname          = string
    environment_id    = string
    role              = optional(string, "assistant")
    model_name        = optional(string)
    description       = optional(string)
    configuration     = string
    availability      = optional(string, "private")
    capabilities      = optional(list(string), ["compute-resources"])
    idle_timeout      = optional(string, "10s")
    instance_idle_ttl = optional(string, "24h")
    default_thread    = optional(string, "origin")
    final_message     = optional(string, "discard")
  }))
  validation {
    condition = length(var.agents) > 0 && length(var.agents) <= 100 && alltrue([
      for id, agent in var.agents : can(regex("^[A-Za-z0-9_-]{1,128}$", id)) &&
      can(regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", agent.environment_id)) &&
      can(jsondecode(agent.configuration)) && contains(["internal", "private"], agent.availability)
    ])
    error_message = "Provide 1-100 URL-safe profiles with explicit environment UUIDs, JSON configuration and valid availability."
  }
  validation {
    condition     = length(distinct([for agent in var.agents : agent.nickname])) == length(var.agents)
    error_message = "Agent nicknames must be unique."
  }
}
