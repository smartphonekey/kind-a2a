<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Prepared Controller Acceptance

Status: both controller startup paths are migrated and component-tested on
2026-09-14. Exact-binding inspection also passes independent native Kubernetes
acceptance. The new registry, controllers and runner have **not yet been tested
together through A2A**. Nothing is permanently deployed or production-ready.

## Implemented

- Agent and sandbox startup share the prepared lifecycle. Neither production
  startup path calls legacy `CreateWorkload` or `StartWorkload`; unsupported new
  RPCs do not trigger fallback. Legacy records retain their existing cleanup path.
- Backend and every named workspace are checked before reservation. Known PVC
  bindings must match the selected backend and current inventory. An old or
  reopened unbound record is not treated as a new disk. Only this attempt's
  initial-create receipt permits first provisioning without a binding.
- The controller persists reservation/preparation, checked volume bindings,
  exact Pod binding and activation authorization before native execution.
  A cancellation during prepare may attach the receipt only for cleanup.
- Read-only `InspectPreparedWorkload` verifies Pod/backend/PVC identity, native
  activation state and active claim holds. It does not activate or repair a Pod.
  Sandbox STARTING becomes RUNNING only after exact-binding container readiness.
- Reconciliation observes committed states without prepare/activation replay.
  Unknown prepare outcomes retain admission. Only unused RESERVED records can
  abort without native absence; known bindings require an exact ABSENT receipt.
  Pending deletion, billing end and malformed acknowledgements do not release
  the task. An exited main process is retired without replaying its inbox.
- Profile-specific assembly, identity mapping, enrollment setup, resource
  metadata and runner placement remain covered by the migrated tests. The A2A
  service and workflow code were not changed for this migration.

## Contributions

Three more dependent branches, beyond the prior 36 focused contributions and
four native/registry prepared-workload branches:

| Repository | Branch | Commit | Base |
| --- | --- | --- | --- |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/prepared-workload-inspection) | `feat/prepared-workload-inspection` | `24b73ca` | `4f957e5` |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/feat/prepared-workload-inspection) | `feat/prepared-workload-inspection` | `1a5a7b6` | `4023808` |
| [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/feat/prepared-workloads) | `feat/prepared-workloads` | `20647af` | `3445cbe` |

All are pushed. They require prepared registry `e7c42f4`, its migration `0022`
and preceding dependencies. These are proposals on dependent acceptance stacks,
not standalone upstream PRs or published APIs. Original repository licenses and
baseline `ef0e75d` remain unchanged. No upstream PR was opened.

## Verification

| Scope | Result |
| --- | --- |
| Ordinary controller suite | 597 passing test entries including subtests. |
| Selected controller race suite | 596 passing entries; exactly the unchanged `TestGroupMembershipConsumerLoopRetriesWithoutBlocking` is excluded. |
| Repeated controller lifecycle suite | 2,360 passing entries across 20 repetitions, no failures/skips. |
| Unfiltered controller checks | The race run fails in the unchanged group-consumer fake subscription. Full vet still reports `ctx = ctx` at `start_decision.go:186`; build and `go vet -assign=false ./...` pass. |
| Native runner | Build/vet and all 493 ordinary race-test entries pass. |
| Native Kubernetes fixture | All three scenarios plus parent pass, including inspection before/after activation, after removal and against a replacement Pod. |
| API | Lint and additive breaking check against `4f957e5` pass. Matching local API generation is documented in the controller/runner branches. |
| A2A service regression | Build and all 323 tests pass on Node 24.21.0. |

Controller tests use explicit independent in-memory native/registry fixtures and
real assembler entry points, not legacy-to-new RPC test shims. New Reconciler
objects model restart recovery; this is not real process-SIGKILL or database
acceptance. The two existing opt-in controller/native fixtures and their child
entry point were not enabled in these controller runs. The separate prior
[registry database acceptance](AGYN-PREPARED-REGISTRY.md) remains valid within its
own scope, not upgraded to a combined pass by these tests.

The native fixture created `runner-prepared-wnlkz`, UID
`104f904d-b202-48ef-a99c-dde6b6601d83`. Twelve gated observations preceded real
model-free execution; two turns used different Pod UIDs and the same PVC UID.
Claim deletion and same-name replacement races remained protected. Temporary
Secrets were garbage-collected; fixture namespace and GET-only RBAC absence
were explicitly confirmed. It used no registry, A2A agent or model credentials.

Before/after snapshots match for all **68 PVCs**, **52 deployments** and **170
cluster RBAC objects**. No installed database, deployment, task workspace or
quota was modified. Private evidence is in
`.state/agyn-prepared-controller-ZAxrEc/`, including `verification.json`, final
test logs and sanitized resource snapshots. Early failures were old startup
test expectations and fixture compilation issues, corrected without restoring
legacy fallback or weakening production checks.

## Next

1. Run real prepared registry/controller/native execution together, then the
   full A2A lifecycle with Codex and Claude, cancellation and process-crash windows.
2. Implement explicit uncertain/late-prepare observation and reconciliation,
   including partial Secret ownership. Quarantine is not resource recovery.
3. Make credential cleanup durable across lost removal confirmations and retain
   backend placement for owners without volume pins.
4. Close authenticated-route/all-writer enforcement, node/storage fencing,
   legacy adoption/draining, coordinated rollout and the other
   [production gates](PRODUCTION.md). Native session analytics and customization
   remain subsequent work, not evidence of readiness.
