# SPDX-License-Identifier: AGPL-3.0-only
mock_provider "agyn" {}

variables {
  organization_id = "11111111-1111-4111-8111-111111111111"
  agents = {
    reviewer-v1 = {
      name           = "Reviewer"
      nickname       = "reviewer-v1"
      environment_id = "22222222-2222-4222-8222-222222222222"
      model_name     = "native-model"
      configuration  = jsonencode({ system_prompt = "Review changes" })
    }
  }
}

run "profile_binding" {
  command = apply
  override_resource {
    target = agyn_agent.profile["reviewer-v1"]
    values = { id = "33333333-3333-4333-8333-333333333333" }
  }
  assert {
    condition     = output.profiles == [{ id = "reviewer-v1", agentId = "33333333-3333-4333-8333-333333333333" }]
    error_message = "A2A bindings must use the provider-created identity and stable profile key."
  }
  assert {
    condition     = agyn_agent.profile["reviewer-v1"].model_name == "native-model" && agyn_agent.profile["reviewer-v1"].environment_id == var.agents["reviewer-v1"].environment_id
    error_message = "Agent definition must retain its native model and approved environment."
  }
}

run "reject_invalid_identity" {
  command = plan
  variables {
    organization_id = "not-an-id"
  }
  expect_failures = [var.organization_id]
}

run "reject_invalid_configuration" {
  command = plan
  variables {
    agents = {
      reviewer-v1 = {
        name           = "Reviewer"
        nickname       = "reviewer-v1"
        environment_id = "22222222-2222-4222-8222-222222222222"
        configuration  = "not JSON"
      }
    }
  }
  expect_failures = [var.agents]
}
