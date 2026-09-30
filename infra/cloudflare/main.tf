# SPDX-License-Identifier: AGPL-3.0-only
terraform {
  required_version = ">= 1.16.0, < 1.17.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.26.0"
    }
  }
  # Bootstrap state is private and separate from Agyn's agent-definition state.
  backend "local" {}
}

provider "cloudflare" {} # CLOUDFLARE_API_TOKEN is injected, never committed.

variable "account_id" {
  type = string
}
variable "zone_id" {
  type = string
}
variable "hostname" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$", var.hostname))
    error_message = "Use an exact DNS hostname, not a wildcard or path."
  }
}
variable "team_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]+(?:-[a-z0-9]+)*$", var.team_name))
    error_message = "Use the existing Cloudflare Access team name."
  }
}
variable "google_idp_id" {
  type = string
}
variable "email_domains" {
  type = set(string)
  validation {
    condition     = length(var.email_domains) > 0 && alltrue([for domain in var.email_domains : can(regex("^[a-z0-9]+(?:[.-][a-z0-9]+)*\\.[a-z]{2,}$", domain))])
    error_message = "Specify the approved Google email domains explicitly."
  }
}

variable "tenant" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,128}$", var.tenant))
    error_message = "Use the existing A2A tenant identity; changing it does not migrate task owners."
  }
}

# Reuse the existing Google integration; this stack cannot change its credentials.
resource "cloudflare_zero_trust_access_policy" "members" {
  account_id       = var.account_id
  name             = "kind-a2a Google members"
  decision         = "allow"
  session_duration = "1h"
  include          = [for domain in sort(tolist(var.email_domains)) : { email_domain = { domain = domain } }]
  require          = [{ login_method = { id = var.google_idp_id } }]
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_zero_trust_access_application" "ui" {
  account_id                  = var.account_id
  name                        = "AIRA A2A Workspace"
  domain                      = var.hostname
  type                        = "self_hosted"
  allowed_idps                = [var.google_idp_id]
  auto_redirect_to_identity   = true
  allow_authenticate_via_warp = false
  app_launcher_visible        = true
  allow_iframe                = false
  http_only_cookie_attribute  = true
  same_site_cookie_attribute  = "lax"
  enable_binding_cookie       = true
  options_preflight_bypass    = false
  session_duration            = "1h"
  policies                    = [{ id = cloudflare_zero_trust_access_policy.members.id, precedence = 1 }]
  # Operator decision: Google authentication, without an additional Access MFA challenge.
  # Account-wide MFA and the Google IdP's own requirements are not owned here.
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "ui" {
  account_id = var.account_id
  name       = "kind-a2a-ui"
  config_src = "cloudflare"
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "ui" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.ui.id
  config = {
    ingress = [{
      hostname = var.hostname
      path     = "^/(ui(/.*)?|web-api/.*)?$"
      # Cluster HTTP is not end-to-end TLS, including on the production target.
      # The origin's additive NetworkPolicy must precede its public deployment.
      service = "http://aira-a2a.aira-a2a.svc.cluster.local:8080"
      origin_request = {
        http_host_header = var.hostname
        access = {
          required  = true
          team_name = var.team_name
          aud_tag   = [cloudflare_zero_trust_access_application.ui.aud]
        }
      }
    }, { service = "http_status:404" }]
  }
  lifecycle { prevent_destroy = true }
}

# Access and the allowlisted tunnel route must exist before the hostname routes.
resource "cloudflare_dns_record" "ui" {
  zone_id    = var.zone_id
  name       = var.hostname
  type       = "CNAME"
  content    = "${cloudflare_zero_trust_tunnel_cloudflared.ui.id}.cfargotunnel.com"
  proxied    = true
  ttl        = 1
  depends_on = [cloudflare_zero_trust_tunnel_cloudflared_config.ui]
  lifecycle { prevent_destroy = true }
}

output "browser" {
  value = {
    origin = "https://${var.hostname}"
    cloudflareAccess = {
      issuer       = "https://${var.team_name}.cloudflareaccess.com"
      audience     = cloudflare_zero_trust_access_application.ui.aud
      tenant       = var.tenant
      emailDomains = sort(tolist(var.email_domains))
    }
  }
}
output "tunnel_id" { value = cloudflare_zero_trust_tunnel_cloudflared.ui.id }
