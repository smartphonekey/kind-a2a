<!-- SPDX-License-Identifier: AGPL-3.0-only -->
> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).


# Lost Preparation Recovery

Status: source, native Kubernetes and combined process acceptance verified on
2026-09-15. The expanded run passes 32 scenarios plus two owner groups and
parent (35 entries), including competing controllers. These dependent
contributions are **not installed**. The retained prepared/DNS stack is unchanged.

## Problem And Contract

Previously, a lost `PrepareWorkload` reply left a durable PREPARING/REMOVING
record without its native Pod UID. Retaining admission prevented a second
execution, but the controller could not discover and retire the gated Pod.
Operator-assisted fixture cleanup was not production recovery.

The new path is shared by agent-instance and sandbox controllers:

1. Persist REMOVING before attempting discovery. Recovery cannot reopen startup.
2. Call the new read-only `ObserveWorkloadPreparation` RPC with the original
   durable workload UUID and backend ID.
3. Accept only a gated, unscheduled, unexecuted Pod whose creation records the
   [atomic startup-Secret ownership contract](AGYN-PREPARED-SECRETS.md).
4. Match the complete Pod/backend/owner/volume identities against durable
   registry records. Sandbox human ownership is also checked against Agents.
5. Persist exact first-provision volume bindings through existing checked CAS,
   then the workload binding into REMOVING. Existing bindings stay unchanged.
6. Remove that exact Pod and confirm native absence through the existing
   prepared-removal contract. Retain the task workspace.

The native response includes only the exact binding, bounded identity labels,
Pod resource version and setup/deletion flags. It reads all named claims,
rejects missing/deleting/lost or replaced claims, and checks Pod resource
version across two reads and backend identity before/after observation. It
rejects main/init/ephemeral execution evidence. No Secret read/list or Kubernetes
write is performed by observation. This is not an atomic multi-resource snapshot
or an authenticated ownership receipt.

The new Pod marker is `agyn.io/preparation-recovery=pod-owned-secrets/v1`.
Older Pods without it remain blocked: their credentials may have been created
without ownership. Setup completion is not execution authorization. A late
prepare reply or competing recovery can supply only the same exact binding;
neither can restart execution. There is no A2A controller/workflow change and
no new registry migration, Gateway handler or RBAC permission.

**NotFound is not a safe-to-retry result.** An initially missing Pod may still
be created by an in-flight request. NotFound, Unimplemented, identity conflicts
and unverified ownership retain admission. Recovery never calls prepare or
activate and never substitutes name-only deletion.

## Contribution Boundaries

| Repository | Branch | Revision / Base |
| --- | --- | --- |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/prepared-outcome-observation) | `feat/prepared-outcome-observation` | `d6449dd`, based on inspection API `24b73ca` |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/feat/prepared-outcome-observation) | `feat/prepared-outcome-observation` | `6fdcc41`, based on atomic-Secret fix `1f33556` |
| [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/feat/prepared-outcome-recovery) | `feat/prepared-outcome-recovery` | source/unit `5d8a9c8`, process fixture `c2bb0e5`, based on `754e935` |

The registry remains `e7c42f4`, with schema through `0022`. These are dependent
review proposals, not stock releases or independent upstream-base patches.
All three focused branches are pushed. They retain each fork's existing license.
No upstream PR is submitted.

The focused controller branch does not include the installed DNS correction.
The separate `lab/prepared-recovery-native-dns` test combination (`b3ec0e2`)
retains that fix and passes build, vet excluding `assign`, and 666 selected race entries
(five gated skips and the same known race exclusion). Its live recovery subset
passes four scenarios plus both owner groups and parent (seven entries), with
zero failures/skips, in 108.025 seconds. It covers three-process replacement
after a lost prepare reply and overlapping recovery for both owner kinds.
This is source compatibility evidence, not an installed image, full A2A/native-
agent acceptance or an upstream PR unit.
Do not deploy the focused branch over the retained DNS-corrected stack alone.

## Source Verification

- API lint and breaking-change checks against `24b73ca` pass.
- Native full race suite: **551 passing entries**, seven gated/child skips;
  build and unfiltered vet pass.
- Controller ordinary suite: **663 passing entries**, five gated/child skips.
- Controller selected race suite: **662 passing entries**, five gated/child
  skips. Exactly the known `TestGroupMembershipConsumerLoopRetriesWithoutBlocking`
  race is excluded; this is not a clean unfiltered race claim.
- Focused recovery suite: **1,320 passing entries across 20 race repetitions**.
  It includes both owners, first/existing/zero-volume workspaces, invalid
  observations, competing RPC interleavings and failures before/after volume
  binding, workload binding, native removal and registry confirmation.
- Controller build and vet excluding `assign` pass. Unfiltered vet still reports
  the unchanged self-assignment in `start_decision.go:186`.
- A2A service rebuild and all **449 tests** pass, with zero failures/skips.

The new native tests failed with the unimplemented handler. The controller's
positive recovery tests failed with its old stop wiring. A preliminary test
compile error caused by pointer-valued volume instance IDs was corrected and
is recorded separately from those genuine red regressions. Generated LLM API
churn is excluded from the final source checks and commits.

## Native And Process Acceptance

The native Kubernetes suite passes **eight scenarios plus parent**, with no
failures/skips. Four real runner SIGKILL cases now discover interrupted Pod
bindings through the actual new RPC, independently verify Pod/PVC identities,
retire exact Pods and observe Secret GC. Existing execution/resume, stale
activation, claim holds and two late Secret writes after Pod deletion also pass.

The final combined suite passes **32 scenarios plus two owner groups and
parent**, with zero failures/skips, in 639.088 seconds. It uses real
PostgreSQL/migrations, registry/native gRPC servers, separate
controller OS processes and Kubernetes execution. It includes:

- Lost prepare reply followed by SIGKILL/replacement of controller, registry and
  native runner. Fresh production recovery discovers and retires the gated Pod.
- SIGKILL of recovery after observation, first-provision volume binding and
  workload binding. Fresh controllers finish removal without redispatch.
- Cancellation during an in-flight prepare response. Recovery retires the Pod
  before the late reply reaches its caller; startup cannot subsequently execute.
- An initially missing preparation keeps REMOVING admission on NotFound.
- Overlapping recovery controllers converge on the same exact removal. A
  paused observer accepts the other controller's committed result without
  repeating native removal or redispatching startup, for both owner kinds.
- Existing parallel/follow-up, lost activation ACK, removal crash and unused
  reservation cases. New-Pod/same-PVC follow-up checks full prior file contents;
  retired unexecuted turns leave no earlier side effects.

The initial 33-entry combined run also passes. The expanded run adds the two
competing-controller cases; neither run skips other prepared lifecycle cases.

These fixtures execute fixed bounded Node probes, not A2A agents or provider
models. Registry Agents metadata/authorization tuple writes and sandbox owner
lookup are explicit stubs. Real overlay authorization, complete orchestrator
event-loop recovery, daemon inbox/session recovery, model approvals and
production credential revocation are outside this evidence.

## Preservation And Reproduction

Both initial and final before/after snapshots match all **105 existing PVCs**, **52
deployments**, **10 namespaces**, **96 ClusterRoles** and **76
ClusterRoleBindings**, including identities and the recorded spec/status fields.
There are zero task Pods. Fixture namespaces, exact owned RBAC and disposable
databases are cleaned without stripping finalizers or changing installed data.

Private evidence: `.state/agyn-prepared-recovery-Ci74qf/` contains red tests,
native/full selected controller race logs, repeated recovery tests, the initial
native/process runs and matching snapshots. The final fixture/source/service
run, DNS-compatible source/live checks and final matching snapshots are in
`.state/agyn-prepared-recovery-final-1XfBO5/`.

The fork's [native reproduction](https://github.com/spk-ai/k8s-runner/blob/6fdcc41/PREPARED-WORKLOADS.md)
and [controller fixture](https://github.com/spk-ai/agents-orchestrator/tree/c2bb0e5/testdata/runner-prepared-fixture)
document API generation, opt-in gates, scoped identities and image requirements.
Generate only the required API paths; do not commit unrelated generated LLM
bindings. All three fixture application binaries use the race detector.

## Remaining Production Gates

1. Fence/reconcile initially absent and delayed Pod/PVC creates and delayed
   claim holds. Admission retention is not complete resource recovery.
2. Track Secret GC and external pull/Ziti credential revocation durably, and
   reconcile older ownerless credentials.
3. Enforce all-writer upgrades, authenticated backend/owner authority, legacy
   adoption rules, zero-volume placement pins and node/storage fencing.
4. Test the coordinated DNS-compatible rollout and full real-agent matrix before
   installing this follow-up. Existing installed-agent acceptance does not cover
   these undeployed changes.
5. Keep the other [production gates](PRODUCTION.md), including sandbox hardening,
   resource accounting, TLS, backup/failover, load, packaging and upstream review.

Native session persistence remains working baseline behavior. Session analytics,
auto-improvement and prompt/tool customization do not replace these release gates.
