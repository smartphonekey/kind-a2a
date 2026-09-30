<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Kubernetes A2A Deployment

This repository contains reusable application code, manifest factories and
Terraform roots. Actual inventories, domains, identity bindings, release pins
and deployment workflows belong in an operator-controlled private repository.
It is not a production release; the gates in [PRODUCTION.md](PRODUCTION.md) apply.

## Cluster Roles

Keep test and production configuration, state, credentials and workspaces
separate. Select an explicit kubeconfig/context or pinned SSH target and verify
cluster identity before writes. Do not infer the target from a shell default.
Testing never authorizes deleting retained tasks or volumes.

## Access

Record actual browser origins, Google domains and operator credential locations
privately. Browser access, machine API credentials and provider subscriptions
are different trust boundaries. The host service is not a failover replica of a
Kubernetes app. See [browser prerequisites](WEB.md#browser-boundary).

## Installed App

Use the private release inventory and live observations, not an old acceptance
report. Preserve the installed application's PVC, configuration Secret and task
ownership. [serviceManifests](scripts/k8s-manifests.mjs) owns packaging, including
initialization and generated-client conversion contracts.

## Backend Revisions

Pin the complete compatible source/image/schema combination in private release
configuration. The [contribution guide](CONTRIBUTING-AGYN.md) identifies code
owners, not a deployable release. Updating every fork to `main` is not an upgrade
procedure. Locally imported image names do not establish registry availability.

## Cloudflare Access

[The Terraform root](infra/cloudflare/main.tf) requires explicit account, zone,
hostname, IdP, tenant and allowed-domain inputs. Keep those in private JSON input
files and supply a private backend configuration. Preserve the existing tenant
identity and state; changing tenant values does not migrate task ownership.
Inject provider credentials separately, never through committed variable files.

Use [cloudflareManifests](scripts/cloudflare-manifests.mjs) with an explicit
environment and production node. Test connectors remain disabled. Supply only
the connector token through its existing Kubernetes Secret. Install the additive
origin-side NetworkPolicy when deploying the app. Connector readiness does not
establish origin readiness or working browser authentication.

## Agent Definitions In Git

[The root](infra/agyn/agents.tf) and [module](infra/modules/a2a-agents/main.tf)
manage definitions, not per-task pods. Definitions and import provenance belong
in private inputs. Existing tasks must not be repointed to different agents;
add versioned profiles instead. Compatible environments and subscription bindings
are separate prerequisites. The focused provider pin is in
[provider-source.json](infra/agyn/provider-source.json).

Use `npm run agents:provider`, `npm run agents:check` and `npm run test:gitops`
for credential-free validation. Live [helper](scripts/agyn-terraform.mjs) commands
require explicit `--vars` and `--backend` files. Its `--help` describes manual
saved-plan approval and CI deployment arguments. Preserve backend namespace and
state suffix during a configuration-repository move; verify a no-op plan before
enabling writers. Do not initialize a new empty state as a migration shortcut.

Public CI has no deployment job. The private configuration repository owns
protected-branch review, an isolated deployment runner, scoped identities and
automatic apply after merge. The [CI guard](scripts/agyn-terraform-ci.mjs) rejects
unprotected branches, stale jobs and mismatched repository/workflow identities.
Moving the workflow requires updating external runner-group restrictions too.

A successful apply does not roll out the app's profile configuration. Render a
candidate with `agents:render`, then perform a drained configuration rollout.

## Packaging And Upgrades

Build with [the image recipe](ops/Dockerfile.a2a-service) and its
[context allowlist](.dockerignore). Promote immutable image digests, not floating
branches. A GitOps controller must have one owner per resource and must preserve
writer drain, migrations, readiness and retained storage. Do not let it prune
namespaces, task PVCs, dynamic agent pods or resources owned by another controller.

Backend upgrades require compatible API/client/schema revisions and a verified
writer drain. Do not restore older images against a newer schema or blindly retry
an ambiguous migration. Preserve reviewed RBAC overlays across chart upgrades.

## Credentials And Recovery

Provider credentials belong to scoped subscription bindings, not browser login
or Git. Do not give agent pods the operator's full secret-manager configuration.
Keep sensitive plans, logs and state outside Git and public CI artifacts.
Recheck effective authorization and both allowed and denied traffic after changes.
For interrupted executions, follow [service recovery](SERVICE.md#recovery-and-operations)
and inspect side effects before authorizing another turn.

## Backup And Restore Scope

Terraform state is separate from app databases and workspaces; back up all of
them with encrypted off-node retention. Keep admission closed and fence the old
writer during restores. Same-node PVC retention, mirrored disks and an etcd
snapshot alone are not a whole-stack backup. Require a replacement-node restore
drill and report its actual scope using [ACCEPTANCE.md](ACCEPTANCE.md).
