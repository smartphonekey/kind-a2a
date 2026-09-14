<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Checked Volume Removal

Status: proposed API, registry implementation and native runner checks pass
focused and combined acceptance. The branches are pushed. The orchestrator and
sandbox callers are not migrated, no platform deployment changed, and this is
not production-ready end-to-end deletion.

A subsequent [workload-admission guard](#workload-admission) now passes real
PostgreSQL contention and upgrade tests on a dependent Runners branch. The
original checked-volume proposal alone does not include that protection.

## Implemented Contract

The registry creates checked volumes in provisioning with a positive lifecycle
revision. A checked bind validates the logical owner/class/key and pins the
physical name, backend UID and persistent identity labels. Pod replacement does
not change that binding. Begin-removal commits an immutable target before a
caller may invoke the backend; a lost acknowledgement requires rereading the
record, not discovering a new deletion target.

Checked updates use a database revision predicate. Triggers also reject older
binaries' lifecycle mutations once a record is checked, including after reopen.
They reject unprotection, retargeting, discarded pending intents and direct
checked-record deletion. Metering alone does not advance the lifecycle revision,
and checked updates preserve concurrently written billing samples.

The native runner compares the expected name/key/UID/ownership with a fresh GET
and deletes with both UID and resource-version preconditions. Kubernetes defines
these [atomic deletion preconditions](https://kubernetes.io/docs/reference/kubernetes-api/definitions/preconditions-v1-meta/).
The resource version may be refreshed, but the durable UID/owner target may not.
Legacy `RemoveVolume` and `RemoveWorkload(remove_volumes=true)` fail closed; there
is no compatibility escape flag. Ordinary workload removal retains disks.

A delete acknowledgement or a terminating claim is `PENDING`, not absence.
Only GET/NotFound returns `ABSENT`. The registry's confirmation operation requires
the matching intent ID and revision, then records confirmation separately from
billing `removed_at`. Its authorized caller must obtain the corresponding runner
evidence; the registry does not itself call the runner.

Explicit reopen validates every persistent ownership field. A pending intent
blocks reopen; a confirmed deleted generation clears its binding/intent before
a new physical incarnation is bound. Failed provisioning remains distinct from
removal and does not prove that an earlier create cannot still finish.

## Review Units

All three focused branches are named `feat/checked-volume-removal`:

| Repository | Commit / base | Scope |
| --- | --- | --- |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/checked-volume-removal) | `83fd4c8` on upstream `50ef648` | Additive separate checked RPCs, bound inventory identity, lifecycle revision and removal intent; [contract proposal](https://github.com/spk-ai/api/blob/feat/checked-volume-removal/CHECKED-VOLUMES.md). |
| [spk-ai/runners](https://github.com/spk-ai/runners/tree/feat/checked-volume-removal) | `bd7137f` on ownership fix `5638dce` | Registry operations, migration `0018`, old-writer database guards, unit and real PostgreSQL tests. |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/feat/checked-volume-removal) | `b073bcc` on inventory fix `40b35ce` | Native conditional deletion, persistent identity inventory and fail-closed legacy paths. |

Existing repository licenses are unchanged. No upstream PR or BSR release has
been submitted. Generated code is excluded; these sources require code generation
from the reviewed API proposal, not the currently published contract.

Separate `lab/checked-volume-removal` combinations preserve earlier patches:
API `ec2bfed` on `3c84a6a`, Runners `0492121` on `5f66067`, and runner
`a9e5071` on `d03831f`, followed by native fixture `0e58d1c` and documentation
`3c461c5`. They are pushed acceptance combinations, not bundled upstream PRs.

## Verification

Private evidence: `.state/agyn-checked-volume-10kpTP/`, 2026-09-14. Counts include
subtests. Earlier fixture compile failures remain in the evidence directory;
only the final completed runs below are passing evidence.

| Scope | Result |
| --- | --- |
| API | Focused and combined Buf lint pass; focused wire compatibility against upstream passes. This is not deployment compatibility. |
| Focused runner | Build; 165 race tests pass, no test skips. The new regressions fail before implementation (`runner-before.jsonl`). |
| Focused Runners | Build; 223 race tests pass, including disposable PostgreSQL acceptance, no test skips (`runners-final-complete-race.jsonl`). |
| Combined runner | Build; 344 race tests pass; four existing opt-in native tests are gated off (`combined-runner-final-race.jsonl`). |
| Combined Runners | Build; 231 race tests pass with both volume and workload-removal database fixtures enabled, no test skips (`combined-runners-all-live-race.jsonl`). |
| Native Kubernetes | All 11 PVC ownership/removal cases pass under the race detector (`runner-native-final-live.jsonl`). The other three opt-in runner native fixtures were not rerun. |
| A2A service | Build and all 244 tests pass on pinned Node 24.21.0, no skips (`service-tests.log`). No controller/workflow changes. |

PostgreSQL acceptance covers agent/sandbox lifecycles, independent-reader state,
intent recovery in a new server object, raw old-SQL rejection, pending/confirmed
reopen, ownership mismatches, stale generations and eight simultaneously blocked
checked updates with exactly one successful CAS. A second interleaving writes
metering after the checked operation reads, proving the update retains it.
The combined suite also reapplies migrations and preserves the earlier workload
removal-confirmation tests. This is not process-level failover acceptance.

Native acceptance ran 09:04:45-09:05:03 UTC in namespace
`runner-pvc-1670aa6f-a55`, UID `0f33ca8f-73f1-4c93-ac47-3495b4449475`.
It used real runner gRPC and real Kubernetes, with controlled mutations between
GET and DELETE. Kubernetes returned HTTP 409 for both replacement-UID and
same-UID ownership-change races. The claims remained present, and retries using
the old targets were refused. A synthetic fixture-owned finalizer held a claim
pending until normal release and observed absence. Only that synthetic finalizer
was released; Kubernetes protection and unrelated finalizers were never stripped.

The fixture's namespace forbids Pods and uses empty 1 MiB claims with an absent
storage class. No backing disks, model calls or provider credentials were used.
Ownership-checked cleanup confirmed namespace absence. The 09:07:53 UTC audit
confirms all 60 existing task PVC UIDs/specs/phases unchanged, zero task Pods,
Services or quotas, and all five stock deployment identities/images/readiness
unchanged. PostgreSQL used an isolated memory-backed container and uniquely named
schemas. Schema absence was checked before shutdown; asynchronous container
removal was subsequently confirmed and its temporary credential file removed.

## Workload Admission

The controller audit found a separate race: a follow-up can be admitted after
the TTL idle scan but before begin-removal. A volume revision and pinned PVC UID
do not observe insertion of a different workload row. Sixteen new regressions
reproduce this against the preceding registry: deletion accepts unconfirmed
workloads, and new workloads are accepted on pending/deleted/failed checked
volumes.

Runners branch
[`feat/volume-workload-admission`](https://github.com/spk-ai/runners/tree/feat/volume-workload-admission),
commit `f05b479`, adds migration `0019` and database error mapping. Its explicit
base is combined `0492121`, because it requires both workload-removal
confirmation (`0017`) and checked-volume lifecycle (`0018`). Review the
[incremental diff](https://github.com/spk-ai/runners/compare/0492121...f05b479),
not the entire combined stack as a single upstream proposal. It is pushed; no
upstream PR or API release has been submitted.

Database triggers coordinate admission and checked volume updates through a
written guard row keyed by `(owner_kind, owner_id)`. Different organizations do
not provide a way around the same owner's guard; different owners remain
independent. For checked owners, a new workload requires matching open volumes
and no unconfirmed predecessor. Stopped/failed plus billing end does not free
admission. Deletion and failed-generation reopen wait for explicit workload
removal confirmation. Stale provisioning failure cannot close a starting/running
owner's volume, while failure/stop and confirmation remain available for cleanup.

Old SQL cannot mutate a protected workload's identity, discard its confirmation
or delete its unconfirmed record. The guard does not advance volume revisions
for workload admission, so checked begin-removal itself must consult it. A real
guard-row write also rejects stale repeatable-read/serializable transactions;
the following queries in volatile triggers observe fresh committed state under
read committed. See PostgreSQL's
[snapshot semantics](https://www.postgresql.org/docs/16/xfunc-volatility.html)
and [transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).

Private evidence: `.state/agyn-volume-admission-FwO2Uh/`, 2026-09-14:

| Scope | Result |
| --- | --- |
| Before implementation | All 16 admission/removal regression cases fail for the intended reason (`admission-before-fixed-fixture.jsonl`). An earlier missing authorization stub caused a fixture panic; that separate log is not regression evidence. |
| Admission/error cases | 99 tests including subtests pass under the race detector (`admission-concurrent.jsonl`). Authorization writes use a stub; registry and PostgreSQL operations are real. |
| Forced contention | 48 cases cover agent/sandbox owners, all four PostgreSQL isolation settings, either race winner, rollback and competing starts. Tests observe actual blocker PIDs, admit another owner while blocked, join all operations and independently read committed state. |
| Upgrade | Seven tests including parent/subtests pass (`admission-migration.jsonl`): valid history survives, four contradictory histories atomically refuse migration, and repeated attempts do not rewrite records or partially install the guard. |
| Full Runners | Build, `go vet ./...`, and all 335 race tests (121 top-level) pass, no test skips, on Go 1.27.1. Both disposable volume and workload-removal PostgreSQL gates are enabled (`runners-full-race.jsonl`). Generated bindings use combined API `ec2bfed`. |

The 09:58:41 UTC audit confirms all 60 existing task claims unchanged, zero task
Pods/Services/quotas and all five stock deployments ready with unchanged UIDs and
images. No cluster objects or provider bindings were modified. Both disposable
PostgreSQL databases have no remaining fixture schemas; container removal and
temporary credential cleanup are recorded separately.

This is registry/database acceptance, not a new runner/controller/A2A lifecycle
sweep. Controller and sandbox callers remain unmigrated. Require migration
`0019` in the coordinated image/database rollout; the original checked RPCs or
`checked_lifecycle` flag alone do not prove admission protection. Owner-wide
admission requires explicit reopen of closed checked volumes. Guard rows need
retention handling, and the mechanism does not fence delayed/replayed backend
Start calls, authenticate removal evidence or resolve node/storage partitions.

## Remaining Work

- Migrate every orchestrator/TTL/sandbox volume creation, activation, failure,
  removal and missing-volume path to the checked APIs. Do not finalize from an
  incomplete scan or fall back to a name-only RPC. Validate returned revisions,
  intent identity and backend states; retry only the persisted target.
- Audit legacy records and all writers, including already-issued old deletions.
  Pin compatible API/client dependencies and migrations `0017`-`0019`, drain and
  roll out the coordinated stack, then run real registry/runner/controller/A2A
  acceptance. The database
  and native fixtures here are separate, not that end-to-end proof.
- Bind backend routing to the correct runner/namespace incarnation. Labels and
  UID matching are not caller authentication or proof that a caller dialed the
  correct backend when an object is absent. Retain the broader authorization,
  delayed-create, node-partition and storage-level fencing gates.
- Implement ownership-aware garbage collection and checked-record retention.
  Unknown disks remain retained; database guards are not protection against a
  privileged administrator disabling them.
- Complete the other [production gates](PRODUCTION.md), including Claude 401
  diagnosis, hardened sandbox/network/credentials/hooks, protocol conformance,
  load/failover, backup/restore, operational rollout and human-control workflows.
