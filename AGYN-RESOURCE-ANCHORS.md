<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Native Resource Anchors

Status: native source and isolated Kubernetes acceptance verified on 2026-09-15.
The API/native capability is implemented; registry/controller integration is
not. Nothing is installed. The retained prepared/DNS stack, schema through
`0022`, existing workspaces and provider bindings are unchanged.

Subsequent [registry persistence and contention tests](AGYN-ANCHOR-REGISTRY.md)
now pass in a separate dependent contribution. Both controller paths, cleanup
contracts and the coordinated rollout are still unfinished.

## Problem And Contract

The preceding [lost preparation recovery](AGYN-PREPARED-RECOVERY.md) can retire
a present, verified gated Pod. Initially missing resources remain ambiguous:
a delayed Pod/PVC CREATE can still commit after a NotFound observation.
Read-then-create checks or timeouts do not exclude those writes.

This dependent native capability introduces metadata-only ownership records:

1. `ReserveResourceAnchor` creates an immutable-identity ConfigMap and returns
   its exact backend/owner/UID. The registry must persist this identity before
   granting resource-creation authority. Reservation itself creates no compute,
   workspace or credentials.
2. `PrepareAnchoredWorkload` attaches the workload anchor's UID in the gated
   Pod CREATE. PVC CREATE carries a separate persistent volume anchor's UID.
   Credentials retain their exact Pod ownership from the preceding fix.
3. Before credentials, the runner pins one Pod UID on the workload anchor.
   Before activation writes, it claims activation on the same anchor. These
   metadata writes and revocation DELETE use UID/revision preconditions.
4. Revocation either wins that conflict, or the exact potentially activated Pod
   must be removed first. A lost claim acknowledgement or a still-present gate
   does not permit skipping that removal.
5. A delayed Pod CREATE retains the deleted owner UID and stays gated. Observe
   its garbage collection separately: anchor ABSENT is not child absence.
   Same-name replacement owners cannot adopt the old child.
6. Volume anchors and exact PVC bindings survive compute release. Their eventual
   retirement requires a separate checked contract, not workload-anchor removal.

Bindings and volume inventory retain the anchors. Consumed workload anchors
cannot prepare replacement Pods. Unanchored preparation rejects anchored
workspaces, and `RemoveVolumeBound` rejects explicitly anchored targets even
when their PVC is absent. These native checks do not replace all-writer guards.

The design uses Kubernetes [owner references](https://kubernetes.io/docs/concepts/overview/working-with-objects/owners-dependents/),
[asynchronous garbage collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)
and [conditional API operations](https://kubernetes.io/docs/reference/using-api/api-concepts/).
Ownership labels, namespace IDs and metadata records are not authentication or
proof that a partitioned node has stopped executing.

## Focused Contributions

| Repository | Branch | Revision / Base |
| --- | --- | --- |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/resource-anchors) | `feat/resource-anchors` | `3b25d03`, based on observation API `d6449dd` |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/feat/resource-anchors) | `feat/resource-anchors` | `72a1cc8`, based on native observation `6fdcc41` |

Both are dependent proposals, not stock releases or drop-in images. Existing
fork licenses are retained. No upstream PR is submitted. The native chart adds
only ConfigMap get/create/patch/delete in its workload grant, without list/watch;
its default scope remains the configured workload namespace. No installed
RBAC changes are made. API generation excludes unrelated LLM bindings.

## Verification

- API lint and breaking-change checks against `d6449dd` pass.
- Native ordinary and unfiltered race suites: **610 passing entries each**, with
  seven gated/child skips and no failures. Regeneration from the committed API
  also passes the full race suite. Build and unfiltered vet pass.
- Focused anchor suite: **53 passing entries**; **1,060 passing entries** across
  20 race repetitions, with zero failures/skips.
- Final native Kubernetes run: **15 scenarios plus parent**, with zero
  failures/skips, in **236.223 seconds**. The initial 14-scenario run also passes.
- The unchanged A2A service rebuild and all **449 tests** pass, zero skips.

The native run retains all eight earlier prepared-workload cases, including
four actual runner SIGKILL checkpoints and late Secret creation. Seven new cases
verify agent/sandbox durable workspace reuse, zero-volume execution, actual
activation-claim PATCH 404 after revocation, stale anchor DELETE 409 after
activation, and late Pod/PVC CREATE. The late-Pod cases observe natural GC before
explicit Pod cleanup, including with a replacement same-name owner. The late-PVC
case verifies no old Pod was created and successfully reuses the exact PVC.

These are real native gRPC/Kubernetes operations with bounded fixed Node
programs. They are not A2A/provider-agent acceptance or registry/controller
recovery. The fixture parent tracks the native bindings. New anchor-claim lost
acknowledgements use fake clients and are distinct from the real runner SIGKILL
checkpoints inherited from the preceding preparation implementation.

The previously timed-out race tests reentered the same fake client's lock.
Independent clients sharing the fixture tracker corrected that test defect;
real Kubernetes subsequently verified both CAS orderings. Earlier compile,
label-fixture and chart-expectation failures remain recorded separately, not
reported as passing runs.

## Preservation And Reproduction

Before/after snapshots match all **105 existing PVCs**, **52 deployments**, **10
namespaces**, **96 ClusterRoles** and **76 ClusterRoleBindings**, including the
recorded identities/specifications/readiness. There are zero task Pods.
Both fixture namespaces and exact owned RBAC are confirmed absent. No installed
data is deleted, no finalizers are stripped, and no cluster service is restarted.

Private evidence: `.state/agyn-resource-anchors-EPJWhO/`. The
[native reproduction](https://github.com/spk-ai/k8s-runner/blob/72a1cc8/RESOURCE-ANCHORS.md)
documents API generation, source checks, explicit opt-in, scoped fixture RBAC
and the pinned model-free image. Fixture namespace deletion is not an
implementation of production anchored-volume retirement.

## Remaining Integration

1. Persist immutable workload/volume anchor identities in the registry before
   any Pod/PVC write authority. Add migrations and old-writer guards; a returned
   preparation binding is too late for this ordering.
2. Migrate both agent and sandbox controllers, including reservation lost replies,
   cancellation, process replacement and recovery of initially absent resources.
   Admission must not be released merely because an anchor was removed.
3. Implement checked anchored-volume retirement, delayed claim-hold reconciliation,
   metadata-orphan cleanup and durable child/credential cleanup. Preserve legacy
   records until their ownership can be explicitly reconciled.
4. Upgrade all writers together, retain the DNS correction and rerun the complete
   Codex/Claude A2A matrix before deploying this dependent capability.
5. Close the other [production gates](PRODUCTION.md): authenticated owner/backend
   authority, credential revocation, node/storage fencing, sandbox/network
   hardening, TLS, packaging, backup/failover and sustained reliability.

Session persistence already works. Session analytics, auto-improvement,
prompt/tool customization and editor takeover remain subsequent features; this
native milestone does not claim production readiness.
