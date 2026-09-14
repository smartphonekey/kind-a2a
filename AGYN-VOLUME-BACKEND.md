<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Backend-Bound Volume Operations

Status: source, real PostgreSQL and isolated native Kubernetes acceptance passed
on 2026-09-14. These are contribution proposals, not an installed upgrade or a
production-ready A2A deployment.

## Finding And Contract

Checked deletion previously pinned a PVC name, UID and ownership, but not the
storage scope queried by the runner. A runner redirected to another namespace
could return `ABSENT` for a still-retained disk in the original namespace.
The registry/controller accepted that result without a backend identity.

The new contract carries an immutable `backend_id` in inventory items/envelopes,
stored bindings/intents and deletion confirmations. The native runner uses
`kubernetes-namespace/v1/<name>/<uid>` from actual Namespace GETs, before and after
the namespaced observation. Namespace deletion, replacement, missing permissions
or backend failure cannot become PVC absence. A runner restart or ordinary
namespace metadata update preserves identity. See
[Kubernetes object IDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#uids).

Deletion uses a separate `RemoveVolumeBound` RPC. Older runners return
`Unimplemented` instead of silently dropping a new request precondition. The
updated runner refuses the older checked-deletion RPC before contacting
Kubernetes; the controller never falls back. UID/resource-version preconditions
still protect the PVC itself, and no finalizers are stripped.

The controller rejects unknown/mixed inventories and responses that differ from
the stored backend. A foreign empty inventory does not mark the original
workspace lost. Registry confirmation requires both the stored intent and
matching backend; migration `0021` rejects unidentified bindings through old SQL
writers and refuses incompatible existing history without rewriting it.

The chart adds GET-only access to the configured namespace object through a
separate ClusterRole/Binding. `workloadNamespace` must match `KUBE_NAMESPACE`.
There is no namespace-list/write or other-namespace permission. Externally
managed RBAC needs the same scoped grant, following
[Kubernetes named-resource RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-resources).

## Contribution Boundaries

| Repository | Focused Branch | Head | Base |
| --- | --- | --- | --- |
| [API](https://github.com/spk-ai/api/tree/feat/volume-backend-identity) | `feat/volume-backend-identity` | `72394f4` | `83fd4c8` |
| [Native runner](https://github.com/spk-ai/k8s-runner/tree/feat/volume-backend-identity) | `feat/volume-backend-identity` | `bdcb67a` | `b073bcc` |
| [Runners registry](https://github.com/spk-ai/runners/tree/feat/volume-backend-identity) | `feat/volume-backend-identity` | `c3b5338` | `748d283` |
| [Orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/feat/volume-backend-identity) | `feat/volume-backend-identity` | `3445cbe` | `5449301` |

These dependent proposals retain each repository's license. Acceptance-only API
`ad5405b` and runner `2968787` combine earlier proposals, including the
[transport restriction](AGYN-RUNNER-TRANSPORT.md). All branches are pushed; no
upstream PR was submitted. No A2A controller, workflow or model logic changed.

## Verification

Private evidence is in `.state/agyn-volume-backend-WM0twX/`.

| Check | Result |
| --- | --- |
| Before implementation | Native, registry and controller regressions reproduced unidentified/wrong-backend acceptance. |
| API | Buf lint and schema compatibility against the prior checked contract pass. A distinct RPC provides fail-closed capability negotiation, not merely additive fields. |
| Native runner | All 186 independent race tests pass, including namespace lookup races, stable restart identity, old-RPC rejection and Helm RBAC rendering. Build/vet pass. |
| Combined runner | All 409 race tests pass, including plaintext denial for the new RPC and startup/enrollment checks. Build/vet pass. Four opt-in native runner fixtures were not enabled; the transport child helper runs through its parent. |
| Registry | All 423 race tests pass with both disposable PostgreSQL fixtures enabled. Migration tests verify both owner kinds, atomic refusal of unidentified history, repeatability, unchanged rows and old-SQL rejection. Build/vet pass. |
| Controller capability tests | Ten race-detector repetitions produce 40 passing test entries. A real old-runner gRPC service receives zero legacy deletion calls and cannot cause confirmation. |
| Selected controller/native suite | All 495 tests including subtests pass with both live fixture gates enabled. Exactly the pre-existing group-consumer test is excluded; the child helper runs through its parent. The combined native runner and real registry/PostgreSQL are used. |
| Known unrelated limits | Unfiltered race testing still exposes the unchanged group-consumer fake-subscription race; full vet still fails at `start_decision.go:186`. `go vet -assign=false` passes. These are not unfiltered green claims. |
| A2A service/audit | Build and all 323 tests pass on pinned Node 24.21.0, including 79 read-only upgrade audit tests. |

For both agent and sandbox owners, actual wrong-runner routing preserves the
original PVC and independently read database binding. Controller/registry
subprocess crashes at begin, native deletion and confirmation retain the original
intent and recover. Existing admission/deletion races and native retention tests
also pass. Fixture identities cannot list namespaces, read another namespace or
access Secrets.

These are empty, unprovisioned fixture claims. No task Pod, agent, model or A2A
driver runs in this acceptance; Agents metadata/authorization remain fixtures.
This is not actual OpenZiti enrollment/policy, workload-start or node fencing.

## Installed State And Remaining Work

The fresh read-only audit at **14:08:17 UTC** still finds 61 legacy registry
records, 60 retained task PVCs and 125 confirmed workload records. There are no
task Pods. Migrations `0018`-`0021` are absent; the 66 findings grant no adoption,
deletion or rollout authority. Stock platform deployments remain installed.

Before/after checks preserve all 68 PVC identities/specifications/phases, 52
deployment identities/generations/images/replica counts/readiness, 95 ClusterRole
identities/rules and 75 ClusterRoleBinding identities/subjects/role references.
Binding list order changed, but the keyed objects are identical. Temporary
namespace/RBAC resources and disposable PostgreSQL containers were removed.

Next requirements remain explicit:

- Pin workload-start/resume operations to the expected backend and PVC before
  execution. Inventory/removal checks alone do not protect a delayed Start.
- Audit authenticated runner routes, caller authorization and actual overlay
  policies. Cluster cloning/restore that duplicates namespace UIDs requires a
  separate epoch/fencing policy; self-reported identity is not authentication.
- Fence delayed creates/deletes, partitioned nodes and storage access.
- Reconcile legacy records, drain every writer, coordinate migrations/clients
  and rerun the complete A2A lifecycle through the upgraded deployed stack.
- Complete the other [production gates](PRODUCTION.md), including sandbox
  hardening, Claude authentication reliability, operations and storage recovery.
