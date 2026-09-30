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

Use only trusted database sources: restoring a dump can execute database code
supplied by its source. Run rehearsals in an isolated, newly owned environment
without access to the installed stack, host mounts or production credentials.
Keep admission closed and fence the old owner before a real restore. Dumps and
workspace/session archives remain sensitive even when their receipts are redacted.

Terraform state is separate from app databases and workspaces; back up all of
them with encrypted off-node retention. Keep admission closed and fence the old
writer during restores. Same-node PVC retention, mirrored disks and an etcd
snapshot alone are not a whole-stack backup. Require a replacement-node restore
drill and report its actual scope using [ACCEPTANCE.md](ACCEPTANCE.md).

## Hetzner Host Bootstrap

The [host playbook](ops/hetzner/bootstrap.yml) provisions a separate bare-metal
node; it does not migrate or expose the installed Agyn/A2A stack. Do not join
another cluster or attach existing workspace volumes implicitly.
The [production gates](PRODUCTION.md) still apply after Kubernetes is running.

First verify the Rescue SSH host key against the provisioning email and inspect
hardware, disk identities, existing data and SMART reports. Normally, verify
Robot Rescue/Reset access first; a Hetzner Cloud project invitation does not
grant it. Proceeding without that recovery path requires explicit owner
acceptance that a failed boot may need the server owner or Hetzner support.
Use Hetzner's [installimage](https://docs.hetzner.com/robot/dedicated-server/operating-systems/installimage/)
only after explicit approval of the exact disks and partition/RAID plan. Keep
that destructive, one-time operation separate from the repeatable host playbook.
Capture the installed OS's new SSH host key through the verified Rescue session
before rebooting; never bypass host-key verification to get past a reinstall.

Ansible uses the [pinned environment](ops/hetzner/requirements.txt) and upstream
K3s installer/binary checksums. Supply a private inventory shaped like the
[example](ops/hetzner/inventory.example.yml), with a dedicated SSH key and pinned
known-hosts file. Do not pass provider credentials or clone another node's keys.
Run the model-free checks first:

```sh
uv venv .state/host-tools --python 3.12
uv pip install --python .state/host-tools/bin/python -r ops/hetzner/requirements.txt
.state/host-tools/bin/python -m unittest discover -s ops/hetzner -p 'test_*.py'
.state/host-tools/bin/ansible-playbook --syntax-check \
  -i ops/hetzner/inventory.example.yml ops/hetzner/bootstrap.yml
.state/host-tools/bin/ansible-playbook \
  -i .state/hetzner/inventory.yml ops/hetzner/bootstrap.yml
```

The first run establishes the operator account from bootstrap root access.
Subsequent runs must connect as that operator, after draining and explicitly
approving maintenance. Check mode and hosted CI are not live acceptance.
Keep the Kubernetes API behind SSH/private administration, and verify external
denial over IPv4 and IPv6, API/Pod networking, restricted admission, persistent
volume recovery and a host reboot before deploying agents. Hardware KVM access
does not prove that an Android emulator can boot or that hostile APKs are isolated.

Use the [disposable acceptance helper](ops/hetzner/acceptance.py) for the live
checks. Read its `--help`, select the explicit host/node/key/known-hosts and private
receipt paths, then run `create`. It retains owned fixtures for an independently
approved reboot; run `verify --after-reboot` before `cleanup` with the same
receipt. Keep receipts private and retain failed runs rather than relabeling
them. The helper's public-port probes cover the supplied address only; IPv4
success does not establish IPv6 coverage when the operator lacks an IPv6 route.

Local etcd snapshots are not off-node backups and do not contain application
volume contents. Before cutover, choose an encrypted off-server destination,
back up the server token/configuration and all application data, and complete
the replacement-node restore drill described above. Mirrored HDDs are not a
substitute for backups; measure disk latency and emulator capacity before
admitting parallel work. Do not label this host production-ready based only on
successful OS/Kubernetes installation.

An encrypted bootstrap copy on an operator PC, tested in an agentless container
with no network, can establish datastore readability and archived-file integrity.
It does not establish automated retention, replacement-node workload recovery or
an Agyn recovery point. Keep its passphrase separate from the archive in the
approved secret-manager configuration. Server administrator keys must not be
injected into ordinary agent environments, even when stored in a shared config.
