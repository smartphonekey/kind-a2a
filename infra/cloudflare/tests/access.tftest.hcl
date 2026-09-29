# SPDX-License-Identifier: AGPL-3.0-only
mock_provider "cloudflare" {}

variables {
  email_domains = ["smartphonekey.com"]
}

override_resource {
  target = cloudflare_zero_trust_access_application.ui
  values = { aud = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
}

run "private_google_workspace" {
  command = plan
  assert {
    condition     = cloudflare_zero_trust_access_application.ui.allowed_idps == toset([var.google_idp_id]) && !cloudflare_zero_trust_access_application.ui.allow_authenticate_via_warp
    error_message = "Only the selected Google identity provider may authenticate."
  }
  assert {
    condition     = cloudflare_zero_trust_access_application.ui.mfa_config == null && !cloudflare_zero_trust_access_application.ui.options_preflight_bypass
    error_message = "Respect the selected Google-only sign-in and authenticate preflight requests."
  }
  assert {
    condition     = cloudflare_zero_trust_access_policy.members.decision == "allow" && length(cloudflare_zero_trust_access_policy.members.include) == 1 && length(cloudflare_zero_trust_access_policy.members.require) == 1
    error_message = "Domain membership and the Google login method must both match."
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.ui.config.ingress[0].origin_request.access.required && cloudflare_zero_trust_tunnel_cloudflared_config.ui.config.ingress[1].service == "http_status:404"
    error_message = "The connector must validate Access and reject all unmatched routes."
  }
  assert {
    condition     = alltrue([for path in ["/", "/ui/", "/ui/assets/app.js", "/web-api/a2a/message:stream"] : can(regex(cloudflare_zero_trust_tunnel_cloudflared_config.ui.config.ingress[0].path, path))]) && alltrue([for path in ["/reporting/mcp", "/tasks", "/readyz", "/.well-known/agent-card.json", "/admin"] : !can(regex(cloudflare_zero_trust_tunnel_cloudflared_config.ui.config.ingress[0].path, path))])
    error_message = "Only the browser UI and browser API may reach the origin."
  }
}

run "reject_empty_membership" {
  command = plan
  variables { email_domains = [] }
  expect_failures = [var.email_domains]
}

run "reject_wildcard_hostname" {
  command = plan
  variables { hostname = "*.spkey.co" }
  expect_failures = [var.hostname]
}
