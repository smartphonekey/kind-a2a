<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Agyn Integration

This guide records the external prerequisites and trust decisions for using
Agyn. The [adapter](src/service/agyn-driver.ts) owns its implementation contract.

A stock Agyn installation alone is not compatible. Use the
[installed inventory](KUBERNETES.md#backend-revisions), not a generic
`agyn local upgrade`, to identify the tested combination. Fork/review boundaries
are in [CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md).

## Ownership And Lifecycle

Cross-project responsibilities remain a maintainer decision in the
[architecture proposal](docs/agyn-a2a-proposal.md#ownership), not an accepted
upstream API. Operators must control profiles, runtime images, subscription
bindings and security/resource policy; task input must not choose that authority.
Use the [code-map workflow](skills/code-map/SKILL.md) for implemented lifecycle
rules, rather than treating this guide as another state-machine specification.

## Runtime Requirements

Operator-managed Codex and Claude profiles need retained per-instance workspaces
and native session directories, compatible required-init/reporting/inbox-guard
support, valid subscription bindings, explicit resource bounds and the intended
network allowances. Workloads must reach the configured reporting endpoint.
Do not repoint a profile used by existing tasks; introduce a new versioned ID.

Manage these definitions through the [reviewed Terraform workflow](KUBERNETES.md#agent-definitions-in-git).
Compatible environments and subscription bindings are prerequisites, not created
by the agent-definition module.

The native configuration and installation owners are
[agent-config](src/reporting/agent-config.ts) and
[agyn-reporting-installer](src/service/agyn-reporting-installer.ts).
[Service setup](SERVICE.md#reporting-setup-contract) covers the operator trust boundary.

## Run And Operate

Use [KUBERNETES.md](KUBERNETES.md) for the installed app and
[WEB.md](WEB.md) or [SERVICE.md](SERVICE.md#run-requirements) for a separately
configured host instance. Neither launcher provisions a compatible backend.

`AGYN_PROFILE` selects the host launcher's existing operator login. That login,
provider subscription credentials and owner-scoped A2A/browser credentials are
separate. Secret-manager rotation does not automatically update an Agyn
subscription; synchronization remains an authorized operator responsibility.

## Boundaries

The native integration is not the legacy ACP harness and does not provide its
human-approval bridge. Native session retention is not centralized export,
analytics or authenticated editor takeover. Trusted-local root runtimes and
mutable reporting/hooks are not hardened for hostile repositories; app Pod
restrictions do not close that boundary.

Use [verification and acceptance](ACCEPTANCE.md) for checks and evidence
requirements, and [production readiness](PRODUCTION.md) for release requirements.
The old `start:agyn` adapter remains in source for comparison; historical instructions
are reachable through the [archive index](docs/archive/README.md), not current
deployment or rollback procedures.
