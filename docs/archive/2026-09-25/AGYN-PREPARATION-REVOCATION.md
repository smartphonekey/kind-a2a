<!-- SPDX-License-Identifier: AGPL-3.0-only -->
> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).


# Interrupted First-Provision Recovery

Status: native, registry and controller implementation with trusted-local
process acceptance on 2026-09-15. All four dependent branches are pushed, and
the complete existing execution regression passes. Nothing from this milestone
is installed. The retained prepared/DNS stack still uses registry migrations
through `0022`.

## Behavior

An accepted preparation can be interrupted before its first Pod or PVC exists.
NotFound does not prove the operation is over. This extension adds durable
native evidence that activation was revoked before it was claimed, followed by
a separate cleanup observation and registry confirmation.

1. The controller persists unbound `REMOVING` intent with the exact workload and
   persistent-volume anchors. A complete, verified gated Pod can still use the
   earlier exact-binding recovery path.
2. For an unobservable preparation, native revocation competes atomically with
   activation on the workload owner's UID/resource version. A previously claimed
   activation is refused, even if its Pod is now absent.
3. An immutable native ConfigMap records the revocation. Its UID identifies the
   receipt; it is not a fabricated Pod UID. The native owner is conditionally
   deleted only after the journal is verified.
4. The controller persists that exact proof using both registry revisions.
   Proof alone keeps admission blocked. A restarted controller observes the
   stored receipt instead of rediscovering it as an ordinary Pod binding.
5. Native observation reports current owner/Pod absence and a complete partition
   of found PVC bindings and absent volume IDs. Pending/invalid responses retain
   admission. Known PVC UIDs cannot be replaced or reclassified as first provision.
6. Newly discovered PVCs are bound through checked-volume CAS before a separate
   registry cleanup confirmation. The database rechecks the partition under its
   owner/admission lock, rejecting a competing bind that invalidates absence.

Confirmed workloads retain proof and observation as immutable history, with no
ordinary Pod binding or Pod-removal receipt invented. An explicit later turn
may reuse the same workspace and original allocation reservation. Recovery does
not dispatch prepare/activate or replay an agent request.

An absent native owner without a matching journal remains unproven. Old-server
or missing-capability errors no longer trigger owner deletion that would erase
the opportunity to obtain proof. Known-workspace loss requires reconciliation.

## Verification

| Check | Result |
| --- | --- |
| API lint and additive breaking check | Pass against the preceding anchored-retirement contract |
| Native source full race suite | 678 passing entries; seven gated live/helper skips |
| Native revocation acceptance | 14 scenarios plus parent: 15 passing entries, no failures/skips |
| Registry full race suite | 838 passing entries, no failures/skips; both disposable PostgreSQL gates enabled |
| Controller ordinary suite | 875 passing entries; seven gated live/helper skips |
| Controller selected full race suite | 874 passing entries; seven gated skips; exactly the previously documented group-consumer test race excluded |
| Combined revocation process acceptance | 16 scenarios plus two owner groups and parent: 19 passing entries, no failures/skips |
| Existing execution regression | Complete rerun: 38 scenarios plus two owner groups and parent, 41 passing entries, no failures/skips, on focused controller source `b08d43b` |
| DNS-compatible controller combination | 879 ordinary and 879 unfiltered race entries; seven gated skips; unfiltered vet/build pass; the same 19-entry native revocation matrix passes |
| Gateway resource lifecycle forwarding | 363 full race entries, no failures/skips; unfiltered vet/build pass with matching generated API |
| Builds and vet | All three Go builds pass; native/registry vet pass; controller passes `go vet -assign=false`, while unfiltered vet retains the unrelated `start_decision.go:186` self-assignment |

The native test includes both owner kinds with zero/persistent volumes, six
actual SIGKILL boundaries, both activation/revocation CAS orderings and real
delayed Pod/PVC CREATE replies. Old activation is rejected; natural gated-Pod
GC and exact PVC reuse by an explicit new model-free workload are observed.

Registry tests use real migrations, RPCs, direct SQL and independent reads.
They cover stale revisions, restart, erased/changed proof, skipped confirmation,
known/missing/replaced workspaces and a real bind between validation and UPDATE.
Upgrade from schema 0025 preserves full workload/volume/owner-guard snapshots,
including reserved, unbound-removing, bound-removing and removed histories for
both owner kinds. Native receipts in these registry tests are synthetic.

The combined fixture kills the original controller before first native
preparation, then kills/replaces the recovery controller, registry and native
runner after native revocation, persisted proof, native observation or persisted
confirmation. Every checkpoint runs with and without a late fixture PVC.
Independent SQL and ConfigMap reads verify retained evidence. Explicit follow-up
verifies an empty prior-effects history and the same late PVC UID. An independent
task continues heartbeating across each process replacement.

The late PVCs in this combined fixture are explicit fixture API CREATEs, not
previously admitted network operations. The separate native delayed-CREATE tests
cover that boundary. The database itself is not crashed. Agent metadata and
authorization writes are fixture stubs; these checks do not exercise provider
approvals, actual Codex/Claude agents, the full controller event loop or A2A.
The [real-agent web acceptance](WEB.md#local-acceptance) remains separate evidence
on the installed older stack.

The existing execution regression first passed 38 entries but failed in the
final sandbox cleanup when its shared 12-minute owner-group context expired.
Its child operation had not exhausted its independent 120-second deadline.
The expanded nineteen-scenario group now has a 15-minute aggregate budget;
the child limits, protocol assertions and cleanup checks are unchanged. The
complete rerun finished at 09:48 UTC with 41 passing entries, no failures/skips
and successful fixture cleanup. The failed run is not counted as passing
acceptance. This existing execution matrix ran on focused source `b08d43b`;
the DNS-compatible combination separately passed the 19-entry revocation matrix,
not another complete execution-matrix run.

## Compatibility And Verification Fixes

Gateway `af4dc71` on `test/resource-lifecycle-forwarding` verifies the actual
gRPC-to-Connect JSON boundary with synthetic registry records. Both owner kinds
retain workload/volume anchors, original reservations, revocation proof and
cleanup observation, mixed found/absent workspaces, and anchored PVC retirement.
Every applicable Get/List route preserves filters, pagination and caller
identity. Large revisions remain exact decimal strings; absent evidence is not
invented. No production forwarding or authorization handler changed. Fresh API
generation must also include internal identity and Ziti services, not just the
public Gateway definition. The corrected complete-generation suite passes;
earlier enum-typo and missing-generated-package failures do not.

Independent orchestrator `0035aff` removes the existing `ctx = ctx` no-op and its
stale identity-dropping comment, without changing authorization behavior. Its
257 ordinary and 200 repeated start-decision race entries and unfiltered vet
check pass. Together with the separate group-consumer test repair, this permits
unfiltered validation of the DNS-compatible source (`6669c08`) without
suppressing `assign` or excluding a test. These fixes do not establish that
every Agyn repository is race-free.

Independent daemon `2aac6e7` on `fix/shell-title-worker-lifetime` makes the shell
title worker cancelable and joinable, and defers cleanup in `Daemon.Run`. It
leaves tmux and persistent sessions intact. The unchanged repeated shell tests
reproduced a race with restored test paths; fixed tests wait for worker exit
and cover cancellation while a refresh is held in flight. All 383 upstream
ordinary/full race entries and 100 repeated focused race entries pass, as do
unfiltered vet and build. The existing local daemon source combined with this
fix (`0497e02`) passes 458 ordinary and 458 full race entries with two opt-in
native tests skipped, plus unfiltered vet/build. No init image has changed.

## Preservation

The completed revocation run's independent before/after snapshots match all
108 prior PVCs, 52 deployment specifications/readiness values, ten namespaces,
96 ClusterRoles and 76 ClusterRoleBindings. There are zero installed task Pods.
Its owned namespaces, PostgreSQL containers and application processes were
cleaned up without deleting installed workspaces, stripping finalizers, global
pruning, Docker/Kubernetes restart or provider credential changes.

Private logs, summaries and fixture binaries are in
`.state/agyn-preparation-revocation-mIpODB/`. Successful source runs include
`native-revocation-final-race`, `registry-revocation-upgrade-verified-race`,
`controller-revocation-final-default` and `controller-revocation-final-selected-race`.
Native acceptance is `native-revocation-live-serializable-spec`; combined
acceptance is `controller-revocation-live-owned-pvc`. Its preservation receipt
is `controller-bt8VB5/after.json`.

The failed execution regression also cleaned up and matched the complete
installed snapshot (`regression-iie2R4/after.json`). The corrected regression
and DNS-compatible crash matrix share the untouched installed baseline in
`regression-complete-f9edcE/before.json`; their final comparison in `after.json`
matches every installed resource recorded above, with no fixture namespaces or
installed task Pods remaining. The corrected regression is
`controller-revocation-existing-complete`; the DNS-compatible run is
`controller-revocation-dns-live`; Gateway is `gateway-resource-complete-race`.

Earlier failed evidence remains failed: a null operation in a serialized crash
fixture, a migration-generation quoting error, an omitted fixture PVC ownership
annotation, and comparing enriched GetWorkload display names against an update
response in the upgrade assertion. Fixes did not relax native ownership, SQL
immutability or installed permissions. The actual row snapshots were unchanged.

## Contributions

All four dependent checkouts use `feat/preparation-revocation`:

| Repository | Commit | Scope |
| --- | --- | --- |
| [API](https://github.com/spk-ai/api/tree/feat/preparation-revocation) | `23d3073` | Additive native revocation and two-step registry evidence |
| [Native runner](https://github.com/spk-ai/k8s-runner/tree/feat/preparation-revocation) | `3260fb4` | Atomic revocation, durable native journal and read-only observation |
| [Registry](https://github.com/spk-ai/runners/tree/feat/preparation-revocation) | `302b7c8` | Migration 0026, immutable proof and workspace/admission guards |
| [Controller](https://github.com/spk-ai/agents-orchestrator/tree/feat/preparation-revocation) | `0c414b8` (source `b08d43b`) | Both owner paths, combined process recovery and complete execution regression |

The controller worktree is
`/home/alex/work/agyn-contrib/orchestrator-preparation-revocation`. Each focused
repo has `PREPARATION-REVOCATION.md` and reproduction instructions. Fork licenses
are unchanged; this report is AGPL-3.0-only. No upstream PR or BSR publication
is claimed. These are not DNS-compatible deployment images.

Gateway, context cleanup and daemon worker fixes above are pushed as separate
reviewable branches. The DNS-compatible controller combination is pushed at
`e5d7a53` (source `6669c08`) on `lab/preparation-revocation-native-dns`. The daemon
combination is pushed at `03422b6` (source `0497e02`) on
`lab/claude-shell-worker-integration`. These lab branches are not upstream
proposals or permission to deploy over existing workspaces.

## Still Required

This closes the source protocol gap for an initially absent, unbound preparation
with complete persisted resource anchors. It does not resolve the earlier A2A
accepted-request gap where no registry workload was created. It also does not
make an interrupted executed turn safe to retry: potentially completed side
effects still require explicit reconciliation, even if its session is restored.

Existing unanchored workspaces still require explicit owner adoption before
this controller can resume them. The installed rollout verifier continues to
reject schemas newer than `0022`; its guard has not been weakened to permit an
unreviewed upgrade. The subsequent [anchored backup](AGYN-ANCHORED-BACKUP.md)
now covers ownership/revocation metadata and offline restore/rehearsal. Its
distinct receipt does not authorize coordinated migration or workspace adoption.

Durable child/credential cleanup and receipt retention, authenticated all-writer
and node/storage fencing, DNS-compatible all-writer rollout and both real-agent
A2A matrices remain required. Hardened sandbox/network profiles, TLS, backup,
failover, operational packaging and sustained reliability remain
[production gates](PRODUCTION.md). The overall production goal remains active.
