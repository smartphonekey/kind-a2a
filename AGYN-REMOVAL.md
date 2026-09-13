<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Workload Removal Confirmation

Status: a live failure disproved the old timestamp contract. The additive API,
Runners persistence, orchestrator, A2A driver and installer fixes pass source tests; the
real PostgreSQL migration and persistence checks also pass. Coordinated image
rollout and live fault acceptance are still pending. This is not a production
release or a successful interrupted-turn test.

## Observed Failure

On 2026-09-13 a Claude interrupted-turn fixture failed before fault injection.
The native SDK returned an error result. The corrected daemon refused to publish
success or acknowledge the inbox, leaving its durable journal pending. The
service quarantined the accepted execution and did not automatically redispatch.
However, it then incorrectly recorded `runtime.stopped` and resource release
while the failed Pod object remained:

| Observation | Evidence |
| --- | --- |
| Task | `24eca313-a0c3-4ce5-babc-c7247489848f` |
| Execution | `f0cdd4c1-242a-428c-a255-7b3c686f8c01` |
| Workload | `c8b1c701-4324-4913-81a0-0185d00da070` |
| Pod UID | `e9a97145-518d-4ba7-b565-e7e0c4aa8d32` |
| Billing end, `removedAt` | `19:43:48.429383Z` |
| Service `runtime.stopped` | `19:43:48.620Z` |
| Independent API/Pod snapshot | At `19:46:06.142Z`, the same Pod was still `Failed`. |

All main and init containers, including the restartable sidecar, had terminated.
This was not evidence of an agent still executing; it was a false assertion of
physical removal and a leaked failed Pod. The cleanup wrapper correctly refused
to downgrade the integration deployments while a workload Pod remained.

Root cause is in the separate **Runners service**, not `k8s-runner`:
[upstream `dc4b3a5`](https://github.com/agynio/runners/commit/dc4b3a566ae8ffe283fbe1d6ba71d17f5439e368)
stamps `removed_at` when a workload becomes failed/stopped to end metering.
[Upstream `f76154d`](https://github.com/agynio/runners/commit/f76154d9e2a8b9c3c68ea115b22b4442e428a89c)
backfills older terminal records for the same reason. The deployed Runners
`0.10.1` has this behavior. A runner failure report can therefore set the field
without any deletion inspection, even with our earlier orchestrator patches.
Those patches and the old A2A driver incorrectly treated a metering timestamp as
physical-removal evidence.

## Focused Fixes

Billing semantics are preserved. Removal observation gets a separate field:

| Review unit | Branch and commit | Scope |
| --- | --- | --- |
| [API](https://github.com/spk-ai/api/tree/feat/workload-removal-confirmation) | `feat/workload-removal-confirmation`, `0125665` | Add optional `Workload.removal_confirmed_at` (28) and `UpdateWorkloadRequest.removal_confirmed_at` (9); document `removed_at` as metering end. |
| [Runners](https://github.com/spk-ai/runners/tree/feat/workload-removal-confirmation) | `feat/workload-removal-confirmation`, `890f759` | Migration `0017`, scan/serialize the new field, terminal-only explicit updates, retain first confirmation on retries, prevent reopening confirmed workloads. |
| [Orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/fix/confirmed-workload-removal) | `fix/confirmed-workload-removal`, `f83ce83` | Track failed/stopped agents until confirmed absence; hold replacement and volume TTL; require the exact persisted confirmation ACK before identity cleanup. |
| A2A service | `src/service/agyn-driver.ts` | Ignore billing end for release. Require all workload confirmations, including the pinned workload; an empty list after an acknowledged dispatch cannot establish release. |
| Reporting installer | `src/service/agyn-reporting-installer.ts` | Do not hide failed/stopped unconfirmed predecessors when selecting the one running workload for setup. |

The new field is not inferred from runner status reports or historical records.
The orchestrator inspects persisted/returned workload IDs and legacy aliases;
present workloads and unavailable runners block confirmation. An older Runners
server that ignores the new update field cannot supply the required ACK. No
model-specific logic was added to the controller or workflow.

This records a trusted controller's runner observation, not node-level fencing.
Forced deletion, partitioned nodes and late in-flight creates remain unresolved.
The broader generic sandbox lifecycle also needs migration and acceptance; the
agent-instance tests do not establish that all sandbox paths use this contract.

## Verification

- API: `buf lint` and `buf breaking --against '.git#branch=main'` pass.
- Runners: `go test ./...` and full `go test -race ./...` pass.
- Runners real PostgreSQL acceptance also passes with `-race`: apply actual
  migrations twice, leave historical terminal rows unverified, authenticate a
  runner failure report, end billing without confirmation, retain the first
  explicit confirmation across retries and new connections, and reject reopening
  with PostgreSQL check-constraint error `23514`.
- Orchestrator: ordinary full Go suite passes. The race suite passes with the
  previously disclosed `TestGroupMembershipConsumerLoopRetriesWithoutBlocking`
  excluded; an unfiltered race-suite pass is not claimed. Focused removal/TTL
  race checks pass, including old-server and wrong-workload acknowledgements.
- Lab: build and all 124 top-level tests pass (135 including subtests). Cases
  distinguish billing end from confirmation, empty and wrong-workload lists,
  mismatched images and incomplete/stale deployment rollouts. Five real installer
  subprocess cases against a fake Gateway verify that only confirmed predecessors
  may be ignored during workload selection; no terminal or model is started.
- A direct credential-free invocation rejected a missing reviewed Runners image
  before Gateway credential lookup or fixture creation. No model call was made.

Private live failure, retained metadata and operator-cleanup evidence are in
`.state/agyn-reporting-live-Q1g9Uf/`. The real database acceptance is in
`.state/runners-removal-postgres-bapUSU/evidence.json`; its bounded disposable
PostgreSQL container was removed. The deployed platform database was not changed.
These database checks do not prove Kubernetes absence or Gateway field forwarding.

Operator cleanup verified the failed Pod's exact UID and terminated containers,
deleted only that Pod, removed the two unchanged fixture policies, and restored
the original runner/orchestrator deployments. The task PVC was retained. The
temporary Claude subscription, attachment and encrypted Agyn secret were deleted;
host authentication files were not changed. The native error's cause remains
unclassified; do not call it the earlier 401 or count it as interrupted recovery.

## Coordinated Rollout Required

1. Review/publish the API contract and regenerate Runners, Gateway and orchestrator
   code from it. For the bounded profile, combine the independent resource and
   confirmation API branches in a lab-only integration branch.
2. Drain new A2A admission and audit existing workloads. Apply the additive
   Runners migration without backfilling confirmation from billing/status data.
   Build and verify Runners/Gateway and combined orchestrator images together.
3. Extend the operator deployment wrapper to manage the new Runners/Gateway
   images with the same identity/conflict/rollout safeguards. Its existing
   two-component restoration tests do not cover this new rollout.
4. Run credential-free failure/deletion and old-server compatibility tests
   through Gateway and actual Pods before any further model acceptance. Observe
   absence independently; verify no replacement or PVC TTL before confirmation.
5. Repeat the completed, interrupted, cancellation, parallel and streaming
   scenarios for the selected agent profiles. Preserve the separate interrupted
   side-effect reconciliation requirement.

`src/live/agyn-reporting.ts` now requires explicit `AGYN_LIVE_RUNNERS_IMAGE` and
`AGYN_LIVE_GATEWAY_IMAGE` values and fully observed matching deployments before
accessing Gateway credentials. This is an operator preflight, not automatic
feature detection or proof that an arbitrarily named image implements the API.
The service itself has no Kubernetes credentials.

The previously documented orchestrator images `cba941a` and `5edf8a4` and stock
Runners/Gateway are not a valid current acceptance stack. Setting new image
variables to stock images does not make them compatible. The old reproduction
commands remain historical evidence, not instructions for a validated rollout.
Earlier successful runs with independent Pod observations retain that limited
evidence; they do not repair the failed-workload contract. See
[production gates](PRODUCTION.md) and [contribution boundaries](CONTRIBUTING-AGYN.md).
