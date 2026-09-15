<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Prepared Startup Secret Ownership

Status: source, race tests and isolated real Kubernetes/process acceptance
verified on 2026-09-15. This dependent runner fix is pushed, **not installed**.
The retained DNS-corrected prepared stack remains unchanged. Unknown-prepare
recovery and the other [production gates](PRODUCTION.md) remain open.

## Failure And Fix

The previous prepared path created temporary image-pull/inline-file Secrets
before its Pod, then attached Pod ownership with a later PATCH. A runner crash
between those writes could leave an ownerless credential. Its cleanup records
were in memory and could not survive SIGKILL. Lost/rejected Pod-create responses
also occurred after credential creation.

The follow-up changes only the native prepared startup path:

1. Validate the request and stage temporary Secret specifications in memory.
2. Create an unschedulable Pod in native `preparing` state and validate its UID
   and exact backend/workspace binding. No temporary Secret has been written.
3. Create each Secret with that Pod's name and UID in `ownerReferences` in the
   CREATE itself. There is no separate owner-attachment window.
4. After every Secret response is acknowledged and checked, commit native
   `prepared` state with a Pod UID/resource-version checked PATCH. The scheduling
   gate stays in place until the separate registry-authorized activation.

Incomplete setup cannot activate after runner restart. A delayed readiness write
cannot enable a replaced/changed Pod. Even a delayed Secret CREATE after owner
deletion remains owned by the deleted UID and is subject to Kubernetes GC.
No prepared-path name-only deletion or adoption is used. Legacy `StartWorkload`
retains its existing startup rollback behavior. No API schema, A2A controller,
workflow or RBAC grant changes are needed for this ownership correction.

This uses Kubernetes [Pod scheduling readiness](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-scheduling-readiness/),
[owner references](https://kubernetes.io/docs/concepts/overview/working-with-objects/owners-dependents/)
and [conditional API updates](https://kubernetes.io/docs/reference/using-api/api-concepts/).
It does not turn Pod absence into credential-cleanup confirmation or provide
node/storage fencing.

## Contribution

- Fork: [`spk-ai/k8s-runner`](https://github.com/spk-ai/k8s-runner).
- Branch: [`fix/prepared-secret-ownership`](https://github.com/spk-ai/k8s-runner/tree/fix/prepared-secret-ownership).
- Base: prepared-inspection/RBAC runner `73c3a20`.
- Implementation and unit regression commit: `856d1b4`.
- Real crash/late-write fixture commit: `1f33556`.
- Required local API: `api-prepared-inspection`, `24b73ca`.

The commits retain the runner repository's license. This is a focused dependent
proposal, not an independent upstream-base fix or a drop-in replacement for a
stock platform. No upstream PR is submitted. Native reproduction commands and
the contract are in the fork's
[PREPARED-WORKLOADS.md](https://github.com/spk-ai/k8s-runner/blob/1f33556/PREPARED-WORKLOADS.md).

## Evidence

New tests failed before the implementation: eight failing test entries showed
credentials written before Pod ownership, credential writes on failed/uncertain
Pod creation, and lack of a retained incomplete-setup checkpoint.

After the fix:

- Build and unfiltered `go vet ./...` pass.
- Ordinary and full native race suites each pass **521 test entries**. Seven
  opt-in/child test entries skip outside their gates; no failures are excluded.
- Prepared tests pass **1,880 entries over 20 race-enabled repetitions**. The
  dedicated crash child is not directly enabled in that repetition command.
- The explicit Kubernetes run passes **eight scenarios plus the parent**, with
  zero failures/skips. It runs from 00:00:24 to 00:01:22 UTC on 2026-09-15.
- The A2A service rebuild and all **449 tests** pass, without failures/skips.

The native run retains the existing real execution/resume, PVC deletion-hold
and stale activation checks. Four new subprocess cases SIGKILL the runner's
production prepare method after committed API writes but before their replies
reach that method:

| Last Committed Write | Retained Native State | Owned Secrets |
| --- | --- | --- |
| Gated Pod CREATE | `preparing` | 0 |
| First Secret CREATE | `preparing` | 1 |
| Last Secret CREATE | `preparing` | 2 |
| Readiness PATCH | `prepared`, still gated | 2 |

The parent confirms each child was live before killing it and waits for the
actual SIGKILL exit. It independently checks exact Pod/Secret ownership, rejects
activation for incomplete setup and observes Pod removal and Secret GC. Runner
deferred cleanup cannot explain those results. A separate case holds the first
Secret request until after exact Pod deletion, then confirms both late Secret
CREATEs commit and their credentials are garbage-collected without Pod revival.

The fixture uses chart-scoped service-account impersonation, a deny-network
namespace and bounded model-free Node probes. It uses synthetic credentials, not
provider tokens, native agent sessions or the A2A driver. For cleanup the parent
reads the interrupted binding as an operator; **automatic controller/registry
recovery of unknown prepare outcomes is not implemented by this fixture**.

## Preservation

Namespace `runner-prepared-pnbg2`, UID
`b4fc7996-ca4f-414a-af9d-acf7eb04d8a4`, and its temporary GET-only cluster RBAC
are confirmed absent. No installed Deployment or registry migration changed.
Read-only snapshots preserve all **105 existing PVC identities/specs/phases**,
all **52 deployment identities/spec hashes/readiness**, all **10 namespaces**,
and all **96 ClusterRoles/76 ClusterRoleBindings**. Task compute remains zero.

The first snapshot comparison rejected generated SDK object prototypes versus
JSON-restored plain objects. The operator now compares normalized JSON fields;
the original capture is retained and all resource comparisons pass. Production
code and safety assertions were not relaxed.

Private evidence is in `.state/agyn-prepared-secrets-oOsriD/`: red-test evidence,
ordinary/race/repeated/native JSONL, service test output and before/after resource
snapshots. Generated APIs and private operator files are not committed.

## Next Boundaries

1. Add exact-identity observation and registry/controller reconciliation for a
   lost prepare response, without repeating startup or authorizing execution.
2. Fence/reconcile delayed Pod/PVC creates, including an initially absent Pod.
   A single NotFound response is not evidence that an in-flight create is over.
3. Track credential GC and external pull/Ziti credential revocation durably;
   reconcile credentials left ownerless by older writers. This fix prevents the
   new ownership window, not all credential retention or revocation failures.
4. Test coordinated writer upgrades and real-agent acceptance before deployment.
   Keep the remaining security, storage, operations and contribution gates open.
