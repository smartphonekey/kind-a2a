<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Kubernetes A2A Deployment

The A2A service and assistant-ui web application run on the existing single-node
Agyn K3s cluster. The backend is upgraded in place through registry schema
`0027`. This is a **trusted-local deployment**, not a production release.
Current release gates are in [PRODUCTION.md](PRODUCTION.md).

## Access

Open **http://127.0.0.1:8084/ui/**. The owner-scoped A2A access token is in:

```text
/home/alex/work/aira-a2a-lab/.state/agyn-upstream-deploy-94iKDb/access-token
```

This mode-0600 file is excluded from Git. It is not an OpenAI, Anthropic or Agyn
token. The installed credential expires October 1, 2026 and has reconciliation
permission; do not distribute it as an ordinary user credential.

The enabled user unit `aira-a2a-k8s-forward.service` maintains a loopback-only
8084-to-8080 port-forward and reconnects after app Pod replacement. Its template
is [ops/aira-a2a-k8s-forward.service](ops/aira-a2a-k8s-forward.service).

```sh
systemctl --user status aira-a2a-k8s-forward.service
kubectl --kubeconfig .state/agyn-kubeconfig -n aira-a2a get deployment,pod,pvc,service
curl --fail http://127.0.0.1:8084/readyz
```

The host service on port 8083 has a separate database and credentials. It is not
a replica or failover target for the Kubernetes app, and it has not received
the app-only `d8952aa` rollout. Do not copy a database and start another writer.

## Installed App

- Namespace `aira-a2a`, one replica, `Recreate` strategy, ClusterIP Service only.
- App source `d8952aabce2bf2d7f6efaa9998d49f658d6d541c`, image
  `docker.io/library/aira-a2a-service@sha256:5e772d0c375eec76ddbc3d7ce56ac1675e8d873ae8105f3d2ade148c7f550804`.
  The running image uses Node 24.21.0, SQLite 3.53.4 and UID 1000.
- PVC `aira-a2a-data`, 1 GiB, `local-path`; database
  `/data/private/tasks.sqlite`. This claim must outlive app Pod replacement.
- Requests 50m CPU / 128 MiB; limits 500m / 512 MiB. Restricted Pod Security,
  read-only root filesystem, RuntimeDefault seccomp, dropped capabilities,
  no privilege escalation and no service-account token or RBAC grant.
- Secret `aira-a2a-config` holds service configuration, token digests, Agyn
  identity credentials and the public local CA. Initialization copies private
  files into memory with 0700/0600 permissions; provider tokens are not copied
  into the app Pod. Gateway/terminal TLS verification stays enabled.
- Codex and Claude profiles share a two-execution admission ceiling. Separate
  tasks have separate instances/PVCs/sessions; follow-ups keep their binding.
  Workload Pods are removed between turns.

The app policy permits port 8080 only from the two configured agent IDs in
`agyn-workloads`; a separate additive policy allows their reporting egress.
App egress is restricted to DNS and the ingress gateway. Reporting uses cluster
HTTP with explicit `A2A_ALLOW_INSECURE_LOCAL_REPORTING=true`.
These settings do not harden the root agent runtime or establish complete
hostile-code isolation.

## Backend Revisions

The fork branches below are pushed but not merged into their `main` branches.
They identify the installed backend combination, not a public Agyn release.

| Component | Fork branch | Source revision |
| --- | --- | --- |
| API | `spk-ai/api:feat/volume-anchor-migration` | `0b9feaf` |
| Registry | `spk-ai/runners:feat/volume-anchor-migration` | `627a1aa` |
| Orchestrator | `spk-ai/agents-orchestrator:feat/volume-anchor-migration` | `fc93b1d` |
| Native runner | `spk-ai/k8s-runner:sync/2026-09-24-volume-adoption` | `0ed8c5c` |
| Gateway | `spk-ai/gateway:sync/2026-09-24-resource-lifecycle` | `7d8267d`, generated against the selected API |

| Deployment | Installed immutable image |
| --- | --- |
| `runners` | `docker.io/library/a2a-agyn-migration-runners@sha256:30135da84301c64f0d1ef8005fef54c397fd898dbf4d340a6498df676818d716` |
| `gateway` | `docker.io/library/a2a-agyn-migration-gateway@sha256:6d8f558893437d0820c677f066b8f6d27a8ec4afc03f7c3cccd6f596b6b25372` |
| `agents-orchestrator` | `docker.io/library/a2a-agyn-migration-orchestrator@sha256:2de348ad22ec7af3c641d85971208c0103d5ebd2e2be28bf2d6761cc7b568000` |
| `k8s-runner` | `docker.io/library/a2a-agyn-candidate-runner@sha256:7c921e48156fb470d194880ce0f56536b08c4e6753d5c070e27308e7c072f7e3` |

These are locally imported images. The runner image name does not imply a
separate candidate deployment. Daemon/SDK integration and independent review
units are described in [CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md); this inventory
is not yet a complete reproducible production release manifest.

## Packaging And Upgrades

[ops/Dockerfile.a2a-service](ops/Dockerfile.a2a-service) builds the service,
reporting bundle and web assets. Its deny-by-default context excludes operator
state, credentials, Git metadata and host dependencies.

```sh
docker build -f ops/Dockerfile.a2a-service \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t aira-a2a-service:reviewed .
agyn local load-image --instance agyn aira-a2a-service:reviewed
node --test scripts/k8s-manifests.test.mjs
npm test
npm run test:web
```

Wait for import to finish and independently verify the immutable digest in the
VM's containerd. A host Docker tag alone does not identify the running image.

[scripts/k8s-manifests.mjs](scripts/k8s-manifests.mjs) returns eight nonsecret
wire-JSON resources given a pinned image, ingress IP, exact TLS hostnames and
agent UUIDs. Secret creation is a separate operator step. It does not install
Agyn, migrate its registry or attach subscriptions. Do not overwrite an existing
namespace with the installer.

When using the generated Kubernetes JavaScript client, pass each wire object
through `asKubernetesClientObject()` before `KubernetesObjectApi.create()`.
The client models ingress `from` as `_from`; bypassing the structured conversion
can drop restrictions. Verify stored specs and both allowed and denied traffic.

For an app update, drain submissions and active work first. Use UID/resource-
version preconditions and patch only the owned Deployment's init/main image
references. Preserve its PVC and Secret. Secret rotation also requires a drained
restart because private configuration is copied during initialization.
Browser reauthentication is expected; task history must survive.

Backend upgrades require compatible API/client/schema revisions and verified
writer drain. Existing workspaces have already been adopted through `0027`;
do not recreate them, fabricate adoption receipts or restore older backend
images against the upgraded schema. Resume an ambiguous migration using its
existing plan. No automatic rollback or blind retry is authorized.

## Credentials And Recovery

Provider credentials belong to Agyn subscription bindings, not browser login.
Claude uses an existing secret-manager token synchronized into that binding;
the native proxy injects the credential and task Pods use a placeholder.
Future secret-manager rotations must also update Agyn; automatic propagation
and the existing token's expiry have not been established.

Interrupted executions stay read-only until the privileged reconciliation API
records a decision. Inspect side effects before authorizing a new turn. Missing
request identities may require failure and provider-side investigation rather
than continuation. See [service recovery](SERVICE.md#recovery-and-operations).

## Backup And Restore Scope

Local acceptance verifies app SQLite online backup/offline restore, fresh-PVC
restore with schema/content/integrity checks, registry migration rehearsal and
workspace/session archive comparisons. The coordinated migration recovery point
contains the registry, 109 workspace/app claims and both app databases.

That coordinated snapshot predates later Claude tasks and credential changes.
The app-only image update has a separately verified SQLite backup, not a new
coordinated whole-stack backup. Neither proves replacement-node recovery,
off-node encrypted retention or restoration of every Agyn database/key.
A PVC on the same node is not a backup; deleting the namespace or data claim can
destroy local-path state.

Current verification scope is in [ACCEPTANCE.md](ACCEPTANCE.md).
Detailed [migration evidence](docs/archive/2026-09-25/AGYN-WORKSPACE-MIGRATION.md)
and [Claude/transport evidence](docs/archive/2026-09-25/AGYN-CLAUDE-A2A.md) are
archived records, not commands to replay on the installed stack.
