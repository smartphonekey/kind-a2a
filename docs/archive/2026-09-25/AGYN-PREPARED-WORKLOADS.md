<!-- SPDX-License-Identifier: AGPL-3.0-only -->
> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).


# Prepared Workload Acceptance

Status: native API/runner implementation and isolated real Kubernetes acceptance
verified on 2026-09-14. [Registry binding storage and guards are now verified
separately](AGYN-PREPARED-REGISTRY.md). [Both controller paths are now migrated
and component-tested](AGYN-PREPARED-CONTROLLERS.md), with separate native
inspection acceptance. Combined prepared-lifecycle acceptance and coordinated
A2A rollout remain open. Installed
platform services remain stock. This is not a production-ready deployment.

## Why Two Phases

Inventory/removal identity checks did not protect `StartWorkload`: its Pod used
PVC names and could execute before the controller compared physical identities.
A preflight GET alone would not prevent deletion/recreation after that read.

The new native path uses three distinct RPCs:

1. `PrepareWorkload` validates the backend and supplied existing claim bindings,
   creates a gated Pod, and returns its UID plus every named volume identity.
   Missing/replaced bound claims are never recreated. Only proven first-provision
   volumes may be omitted from the request's expected bindings.
2. `ActivateWorkload` requires that exact binding, acquires per-Pod deletion
   holds on the claims and removes the scheduling gate with Pod UID and resource
   version preconditions. Competing Pod holds, wrong identities and unavailable
   backends stop activation. Repeating the same active binding does not replay
   an agent message or create another Pod.
3. `RemovePreparedWorkload` deletes the exact Pod incarnation, then observes its
   absence before releasing only its own claim holds. Workspace deletion remains
   a separate checked operation. Temporary Secrets belong to the exact Pod UID
   and are removed by Kubernetes GC, not by name-only credential deletion.

Preparation verifies Kubernetes >=1.30 and requests strict Pod field validation.
Trusted admission must preserve the gate. The chart adds only namespaced
PVC/Secret patch rights, not Secret listing or cluster mutation rights.
The distinct RPCs require explicit capability support; callers must never fall
back to legacy Start/Stop/Remove when a server returns Unimplemented.

These choices follow Kubernetes [scheduling readiness](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-scheduling-readiness/),
[API concurrency/validation](https://kubernetes.io/docs/reference/using-api/api-concepts/)
and [finalizer](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
semantics. A claim hold prevents name reuse; it does not authenticate the caller
or fence a partitioned node's storage access.

## Contribution Boundaries

- API: [`spk-ai/api`, `feat/prepared-workloads`](https://github.com/spk-ai/api/tree/feat/prepared-workloads),
  `53e0817`, based on combined API `ad5405b`.
- Native runner: [`spk-ai/k8s-runner`, `feat/prepared-workloads`](https://github.com/spk-ai/k8s-runner/tree/feat/prepared-workloads),
  production/unit change `d92930c`, based on combined runner `2968787`; live
  fixture `2ee4b73` and independent absence check `4023808` are separate follow-ups.

These are dependent proposals with their original repository licenses. They
are not standalone upstream-base fixes, published APIs or drop-in images. The
prior focused branches and baseline `ef0e75d` remain unchanged. No PR was opened.

## Evidence

- The existing A2A service rebuild and all **323 tests** also pass on pinned
  Node 24.21.0. No service/controller implementation changed in this stage.

- Build, vet and all **468 ordinary native race-test entries** pass. Existing
  lifecycle/transport tests remain enabled. Four older opt-in Kubernetes
  fixtures were not run; the new fixture runs separately. The direct transport
  child entry is exercised by its parent.
- Prepared-workload unit tests pass **1,060 entries across 20 repetitions**,
  covering lost activation replies, restart/idempotency, changed identities,
  UID/RV conflicts, competing holds, exact-UID Secret ownership and gated errors.
- The final live fixture passes **three scenarios plus their parent** against
  Kubernetes `v1.33.1+k3s1`, through real RPCs and the chart's service-account
  permissions. It uses bounded Node probe containers, not a model/runtime agent.
- Twelve observations show the first Pod remains unscheduled with no running
  containers before activation. Two real successful turns retain one PVC/file
  across different Pod UIDs; both workload removals are independently confirmed.
- A real PVC DELETE between hold acquisition and gate removal stays pending;
  same-name recreation is rejected. A delayed activation PATCH after same-name
  Pod replacement fails, leaving the replacement gated.
- Prepared temporary Secret ownership is checked; GC completes before namespace
  cleanup. All fixture namespaces and temporary GET-only cluster RBAC are
  confirmed absent. No model credentials or subscription bindings were used.

The first fixture run lacked required supporting-container limits and failed
before workload creation. Its resources were removed; the fixture configuration
was corrected without relaxing production validation. Later native runs pass.

Private evidence: `.state/agyn-prepared-workloads-v34BHY/`, including
`native-race-final.jsonl`, `prepared-repeat.jsonl`, `native-live-independent.jsonl`,
`service-full.tap`,
the earlier failure, before/after snapshots and a fresh read-only upgrade audit.
Reproduction commands and exact native behavior are in the fork's
`PREPARED-WORKLOADS.md`.

## Installed State

Before/after comparisons preserve all **68 PVCs, 52 deployments and 170 cluster
RBAC objects** (95 roles, 75 bindings). The 14:56:10 UTC audit finds 61 legacy
registry volumes, 60 retained task PVCs, 125 confirmed workload records and zero
task Pods. Migrations `0018`-`0021` are absent. Its 66 findings permit no adoption,
deletion or rollout. No installed service, task data or database was changed.

## Required Next

- Integrate the separately verified immutable binding storage and registry
  admission/CAS guards. Migrate both agent and sandbox controllers,
  including cancellation, uncertain prepare replies and crash recovery.
- Reconcile late gated creates, delayed hold writes and interrupted startup
  Secret ownership. A late activation cannot create a Pod; late preparation can
  still leave a gated orphan. Never infer permission to execute from a name.
- Enforce authenticated runner routes and ownership; prevent out-of-protocol
  changes to gates, holds or identity metadata. Drain/disable legacy writers.
- Complete node/storage/clone fencing, sandbox hardening, explicit legacy
  reconciliation, coordinated migrations/clients and the full A2A/model sweep.
- Keep the remaining reliability, storage recovery, operations, approval and
  contribution gates in [PRODUCTION.md](PRODUCTION.md) open.
