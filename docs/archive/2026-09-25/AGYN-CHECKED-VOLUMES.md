<!-- SPDX-License-Identifier: AGPL-3.0-only -->
> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).


# Checked Volume Removal

The dependent [backend-identity extension](AGYN-VOLUME-BACKEND.md) now adds
`RemoveVolumeBound`, immutable storage-scope binding and registry migration
`0021`. Wrong-runner and old-runner cases pass isolated combined acceptance.
The earlier checked API below remains historical evidence, not the latest
deployable profile; workload-start fencing and coordinated A2A rollout remain.

Status: proposed API, registry implementation, native runner checks and the
dependent orchestrator/sandbox migration pass component acceptance. The
[combined process fixture](#combined-process-acceptance) now also passes with
real PostgreSQL, registry RPCs, controller processes and native Kubernetes
deletion. The branches are pushed. Agents metadata and authorization writes
remain stubs in that fixture; no platform deployment changed, and coordinated
rollout with A2A acceptance is still unverified. This is not production-ready
end-to-end deletion.

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
sweep. The subsequent caller migration is recorded below. Require migration
`0019` in the coordinated image/database rollout; the original checked RPCs or
`checked_lifecycle` flag alone do not prove admission protection. Owner-wide
admission requires explicit reopen of closed checked volumes. Guard rows need
retention handling, and the mechanism does not fence delayed/replayed backend
Start calls, authenticate removal evidence or resolve node/storage partitions.

## Controller Migration

Orchestrator branch
[`feat/checked-volume-lifecycle`](https://github.com/spk-ai/agents-orchestrator/tree/feat/checked-volume-lifecycle),
commit `eebf4cf`, migrates all agent-instance and sandbox volume mutation call
sites. Its explicit base is combined orchestrator `f65a9f6`; review the
[incremental diff](https://github.com/spk-ai/agents-orchestrator/compare/f65a9f6...eebf4cf),
then rebase onto accepted prerequisites for an upstream proposal. It requires
combined API `ec2bfed`, checked runner `3c461c5`, and Runners guard `f05b479` with
migrations `0017`-`0019`. Generated LLM API churn is excluded. No upstream PR or
permanent image rollout was submitted.

Creation/reuse validates checked metadata and full logical ownership. Closed
generations require explicit CAS reopen; compensation holds only the revision
returned to the creating/reopening attempt. Bind pins name, UID and persistent
labels, with an additional sandbox-user lookup. Begin-removal must return a
validated durable intent before native deletion. Pending or unknown native
results never finalize a record; only checked absence followed by the matching
registry confirmation does. A fresh reconciler resumes the stored target,
including after lost begin/native/confirm replies. No legacy RPC fallback or
fresh-read compensation is allowed.

Sandbox cleanup includes failed, deleting and historical volume rows, and keeps
failed/stopped workloads reserved until explicit removal confirmation. It checks
the complete owner-scoped listing before stopping duplicate workloads. A
terminated sandbox remains discoverable while disk deletion is pending and is
finally deleted only after checked cleanup. Unbound/legacy volumes, unreachable
runners and unknown disks remain retained for explicit reconciliation. This does
not add permission to replay an interrupted A2A turn.

Private evidence: `.state/agyn-volume-controller-QeClur/`, 2026-09-14:

| Scope | Result |
| --- | --- |
| Reproduced gaps | New tests failed for a size-changing deletion reply, 12 malformed/duplicate/cyclic registry page cases, and two sandbox plans that performed cleanup before validating later ownership. These now pass. Earlier fixture/generation failures remain separate evidence, not business regressions. |
| Full ordinary Go suite | Build and 488 tests including subtests pass (`controller-final-ordinary.jsonl`); the opt-in native test is gated off in this run. |
| Selected race suite with native gate | 488 tests, 248 top-level, pass (`controller-final-scoped-race-native.jsonl`). Exactly `TestGroupMembershipConsumerLoopRetriesWithoutBlocking` is excluded; the native test is enabled. This is not an unfiltered full-race pass. |
| Remaining source checks | The unfiltered race run fails only in the unchanged group-consumer fake subscription. `go vet ./...` fails on the unchanged `ctx = ctx` in `start_decision.go:186`, also present at base `f65a9f6`; `go vet -assign=false ./...` passes. Neither baseline limitation is hidden or bundled into this contribution. |
| Native agent cleanup | Real runner gRPC and Kubernetes retain foreign/closed/untracked/late-created claims and reject ambiguous inventory. Delete acknowledgement leaves the row pending; a fresh reconciler confirms the original UID-bound intent after observed absence. |
| Native sandbox cleanup | The same fixture binds an unbound sandbox workspace from actual inventory with user ownership validation, retains the sandbox on pending deletion, then confirms the original target and finalizes it from a fresh reconciler. Registry and Agents services are fakes, not a deployed database. |

The final native run used namespace `orchestrator-volumes-ff9a9264-fe3`, UID
`ac82f70f-36ab-4928-83ac-e88527ca9ebc`. Seven empty 1 MiB claims used an absent
storage class, quota prohibited Pods, and the impersonated fixture account was
limited to its namespace's PVC inspection/deletion. The test removed only its
tracked agent and sandbox claims; five other fixture claims remained unchanged
until ownership-checked namespace cleanup confirmed absence. No backing disk,
model, provider credential or PostgreSQL container was used. These are new
reconciler objects over explicit fake registry state, not process/DB failover.

The 11:01:07 UTC audit confirms all 60 pre-existing task PVC UIDs/specs/phases
and labels unchanged, every platform deployment's UID/generation/images/readiness
unchanged, zero task Pods/Services/quotas and zero remaining fixture namespaces.
The stock deployments are still in place. No new A2A lifecycle sweep ran.

## Combined Process Acceptance

Follow-up [`5449301`](https://github.com/spk-ai/agents-orchestrator/commit/5449301)
on the same `feat/checked-volume-lifecycle` branch adds an opt-in real-registry
fixture without changing production logic or dependencies. It builds Runners
`f05b479` with actual migrations `0017`-`0019`, runs the native runner `3c461c5`,
and invokes the checked controller in separate OS processes. Both fixture
binaries and the parent/controller executable use Go's race detector.
[Reproduction and safety requirements](https://github.com/spk-ai/agents-orchestrator/blob/5449301/testdata/runners-volume-fixture/README.md)
are included with the contribution.

Private evidence: `.state/agyn-checked-stack-9QcvU1/`, 2026-09-14:

| Scope | Result |
| --- | --- |
| Full ordinary suite | Build and all 488 tests including subtests pass; live tests and the controller subprocess entry point are gated off (`controller-final-ordinary.jsonl`). |
| Selected race suite | 491 tests, 249 top-level, pass with both native fixtures enabled (`controller-final-selected-race-native.jsonl`). Exactly `TestGroupMembershipConsumerLoopRetriesWithoutBlocking` is excluded; the standalone child entry point skips because the live test invokes it in subprocesses. |
| Unfiltered checks | The full race run with live gates off has 487 passes and fails only the unchanged group-consumer test and its package. Full vet still fails on `start_decision.go:186` self-assignment; `go vet -assign=false ./...` passes. These are not unfiltered green results. |
| Combined process fixture | Agent and sandbox cases pass in 19.04s and 23.83s, 42.86s total. Independent `psql` connections compare persisted ownership, revisions, bindings and intents with actual registry responses. |
| Native retention regression | The earlier fake-registry/real-runner fixture also passes, in 23.42s. Its narrower scope remains separate. |

Each combined owner case verifies both race orderings. A controller pauses
after its idle scan, new work is admitted, and stale begin-removal is refused
without native deletion. Another owner admits independently. A billing-ended
failed workload still blocks a successor until explicit confirmation. In the
reverse ordering, committed begin-removal prevents admission.

The test SIGKILLs and joins both controller and registry at three boundaries:
after begin commit, after native deletion but before the controller consumes its
reply, and after registry confirmation but before owner finalization. Fresh
processes preserve the original intent and its physical UID. `PENDING` does not
finalize the registry; observed native absence precedes confirmation. Recovery
after confirmed deletion does not repeat native deletion or confirmation, and
the sandbox finalization counter advances only afterward. Explicit reopen then
binds a new PVC UID at the same name, rejects old-target replay, and reuses the
open generation without taking compensation ownership.

The first fixture attempt failed because registry read enrichment lacked an
Agents metadata stub. It cleaned up both namespaces and databases. That fixture
defect was corrected without weakening production registry checks; it was not
a production deletion regression. `stack-first.jsonl` preserves the failure,
with subsequent passing and extended-crash runs stored separately.

Agents metadata and authorization tuple writes are explicit stubs. The native
client uses a fixture-ID-checked loopback route, not the production overlay.
Workloads are unused admission reservations with synthetic historical retirement
times: no `StartWorkload`, model, A2A driver or real Agents finalization runs.
Only empty 1 MiB claims are used, with Pod quota zero and no backing storage.
PostgreSQL has a private loopback port, bounded resources and tmpfs storage;
only application processes are crashed, not PostgreSQL or a Kubernetes node.

The final 11:50:27 UTC audit confirms all 68 pre-existing PVC identities/specs/
phases/labels unchanged, including all 60 task claims; all 41 platform deployment
UIDs/generations/images/readiness are unchanged. There are zero task Pods,
Services or quotas, zero fixture namespaces, and no remaining fixture database
containers. Stock services remain deployed. This advances combined component
acceptance, not production authorization, storage failover or A2A rollout.

## Read-Only Upgrade Audit

The operator-only [audit command](../../../scripts/agyn-checked-volume-audit.mjs) now
collects the installed registry in one repeatable-read, read-only PostgreSQL
transaction, with statement/lock deadlines and rollback. Its SQL projects only
lifecycle/ownership fields, not credentials, runtime container settings or
failure messages. It reads PVC/Pod/client inventories before and after that
snapshot and verifies the selected namespace UID, PostgreSQL Pod UID and
database container incarnation. Changed or incomplete observations are refused
or flagged, not treated as absence.

The [pure audit module](../../../src/live/checked-volume-audit.ts) checks legacy records,
physical keys/names/UIDs and persistent owner labels, duplicate inventory,
cross-record ownership, unconfirmed workload reservations, bindings/intents,
and required migration/trigger metadata. It records the four installed client
deployments without treating image names as proof of compatibility. Sandbox-user
ownership requires the actual Agents service, not just matching PVC labels.

The command requires the repository's pinned Node runtime and a completed build.
Create a private output directory without changing the permissions of an
existing shared `.state` directory:

```bash
export AGYN_AUDIT_OUTPUT_DIR="$(mktemp -d "$PWD/.state/agyn-checked-upgrade-XXXXXX")"

AGYN_LIVE_ACCEPTANCE=trusted-local \
AGYN_KUBECONFIG="$ABSOLUTE_KUBECONFIG" \
AGYN_AUDIT_POSTGRES_POD=platform-postgres-0 \
AGYN_AUDIT_POSTGRES_UID="$OBSERVED_POSTGRES_POD_UID" \
AGYN_AUDIT_POSTGRES_USER=agyn \
AGYN_AUDIT_RUNNER_ID="$REVIEWED_RUNNER_ID" \
AGYN_AUDIT_NAMESPACE_UID="$OBSERVED_WORKLOAD_NAMESPACE_UID" \
node scripts/agyn-checked-volume-audit.mjs
```

Each run writes a new `capture-*/audit.json` in a mode-0700 directory with a
mode-0600 report. Configuration is checked before external reads; public,
symlinked or changed output directories are refused. Exit `2` means a completed
audit with findings; exit `1` means configuration/capture/report failure; exit
`0` means no findings in the implemented checks. **None authorizes rollout,
adoption or deletion.** Reports always keep those three permissions false.

On 2026-09-14, captures at 12:16:56 and 12:18:25 UTC in
`.state/agyn-checked-upgrade-sDbrVw/` returned the same 64 findings and identical
captured lifecycle fields. Both Kubernetes observation windows were stable:

- Migrations `0001`-`0017` are installed. `0018` and `0019` are absent.
- There are 61 unchecked volume records: 60 active records match 60 physical
  PVC names and persistent owner labels; one failed, unbound record has no
  physical match. That record is retained, not rewritten as deleted or empty.
- All 125 historical workloads have explicit removal confirmations. There are
  no task Pods and no observed owner conflicts or unconfirmed predecessors.
- Installed clients remain stock: orchestrator `0.23.0`, Runners `0.10.1`, runner
  `0.12.0`, Gateway `0.29.1`. Their readiness does not establish checked-API
  compatibility or prove that all possible writers have been drained.

The first CLI run correctly refused the existing mode-0775 `.state` directory;
the command now requires an explicitly private owned output directory rather
than changing shared permissions. The full service build and all **308 tests**
including subtests pass, with 64 new audit tests covering negative data cases,
read-only collection, partial/changed inventories, container replacement,
private output, exit codes and exclusion of sensitive subprocess output.
The 12:19:03 UTC external check confirms all 68 existing PVC identities/specs/
phases/labels and all 41 deployment UIDs/generations/images/readiness unchanged
since the prior acceptance, with zero task Pods/Services/quotas.

This is an observation tool, not a migration implementation or an atomic snapshot
across PostgreSQL and Kubernetes. It does not verify PVC contents/specifications
for adoption, live Agents ownership, backend authentication, in-flight/late
operations, node fencing, all SQL/API writers, or backup/restore. Matching legacy
PVCs still need explicit adoption under a drained, compatible stack; the failed
unbound record needs separate reconciliation. No schema, registry record, PVC,
deployment or authorization policy was changed by this audit.

## Legacy Adoption Guards

Dependent Runners branch [`feat/legacy-volume-adoption`](https://github.com/spk-ai/runners/tree/feat/legacy-volume-adoption),
commit `748d283`, builds on `f05b479` and adds migration
`0020_legacy_volume_adoption.sql`. It reuses `UpdateVolumeChecked(bind)` rather
than adding a second adoption API. This is an adoption precondition, not a
complete migration coordinator or an authorization mechanism.

The regression tests first reproduced three unsafe paths: adopting while a
matching workload was still unconfirmed, binding without a recorded physical
name, and implicitly converting failed legacy history through ordinary checked
reopen. Registry validation also accepted immutable targets the native runner
would reject, including transient workload/thread labels and invalid names.

The implementation now:

- Requires an active/provisioning legacy record with the same recorded physical
  name. Failed/deleted/unbound history is retained for explicit reconciliation.
  Ordinary checked reopen cannot opt a legacy record in.
- Serializes adoption with workload admission through the existing owner guard.
  Any unconfirmed predecessor blocks adoption, including billing-ended failures.
  A checked binding retry and subsequent compatible workload remain allowed.
- Preserves logical identity, size and metering history. The additive SQL
  trigger also guards direct adoption/reopen statements without rewriting any
  historical record during installation.
- Validates the current Kubernetes binding profile before making it immutable:
  native name/label syntax, bounded opaque UID, the eight persistent label keys,
  required managers, optional manager value and positive stored size. It rejects
  transient labels instead of silently changing the supplied identity.

Verification on 2026-09-14 is retained in
`.state/agyn-legacy-adoption-AFDUSG/`:

- `registry-race-final.jsonl`: all **419 tests** including subtests pass under
  the race detector with both disposable PostgreSQL gates enabled. Build, vet
  and module verification also pass. No test exclusion was added.
- Thirty-two blocked adoption/workload interleavings cover both owner kinds,
  all four PostgreSQL isolation settings, both orderings and winner rollback.
  Tests observe blocker PIDs, independent owner progress and committed state.
  The upgrade fixture starts at `0019`, installs/repeats `0020` without changing
  volume/workload/guard history, then verifies rejected raw-SQL writes.
- `combined-native.jsonl`: the existing combined process fixture passes for
  agent and sandbox owners using the new registry/migration, API `ec2bfed`,
  orchestrator `5449301` and native runner `3c461c5`. This reruns checked binding,
  admission/deletion races and application-process crash recovery against actual
  PostgreSQL and Kubernetes. It is a compatibility regression, not live legacy
  adoption or a new full orchestrator suite. Agents metadata/authorization
  writes remain stubs; no A2A driver, native Pod start or model runs.
- `service-full.tap`: all **313 service tests** pass, including **69 audit
  tests**. The audit now reports missing `0020`, missing/disabled adoption guards
  and inconsistent migration dependencies. It still grants no lifecycle authority.
- The 12:54:08 UTC read-only capture `capture-o698Wx/audit.json` finds the same
  61 legacy records, 60 retained task PVCs and 125 confirmed workloads. Its
  **65 findings** include the newly required, still absent `0020` migration;
  `0018`/`0019` are also absent. The additional finding is not new data damage.
- `native-before.json` / `native-after.json` confirm all **68 PVC identities,
  specs and phases**, all **52 deployment identities/generations/images/replica
  counts/readiness** across namespaces, and the namespace inventory unchanged.
  There are zero task Pods/Services/quotas. Disposable fixture namespaces and
  all three PostgreSQL containers are absent; preexisting storage is untouched.

The registry fixture binary SHA-256 is
`c27b037325fb3926e8a15273703015b092ef81c079c6ae366ca3b08d80305cef`;
the reused native fixture hash is
`e40d0f10f8ff4f88ba7e60456335795f0054f316dc697975db83d1ec80481f8e`.

No installed database migration, legacy record or deployment changed. The
failed unbound installed record is still retained. These guards do not prove
all writers are drained, authenticate the selected backend/caller, check actual
sandbox human ownership, audit previous checked bindings, or fence already-issued
deletes, delayed creates and partitioned nodes. Explicit adoption/reconciliation
under a compatible drained stack, followed by full A2A acceptance, remains open.

## Remaining Work

- Use the read-only legacy inventory above to implement explicit adoption and
  reconciliation; complete the all-writer audit, including already-issued old deletions.
  Pin compatible API/client dependencies and migrations `0017`-`0020`, drain and
  roll out the coordinated stack, then run real registry/runner/controller/A2A
  acceptance. The combined process fixture now covers admission/deletion and
  application-process replacement, but its stubbed Agents metadata, unused
  workload reservations and empty claims are not that full lifecycle proof.
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
