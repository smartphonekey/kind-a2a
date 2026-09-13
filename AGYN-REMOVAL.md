<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Workload Removal Confirmation

Status: a live failure disproved the old timestamp contract. The additive API,
Runners persistence, orchestrator, A2A driver and installer fixes now pass a
coordinated local rollout and a real, model-free startup-failure/deletion test,
in addition to source, PostgreSQL and Gateway wire checks. All five Codex native
lifecycle scenarios now also pass on that coordinated stack. The stock
deployments are restored; the additive database migration remains. Second-agent
acceptance, infrastructure fencing and the other production gates remain open.
The model-free failure test and native interrupted-turn test are separate proofs,
not a production release or a claim of safe automatic side-effect retry.

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
| [Gateway](https://github.com/spk-ai/gateway/tree/test/workload-removal-confirmation) | `test/workload-removal-confirmation`, `6d7d432` after `04bbf7d` | Verify the generated gRPC-to-JSON path; update four existing test fakes for current API compatibility. No production handler changes. |
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
- Gateway: full `go test -race ./...` passes. A real gRPC client and Connect HTTP
  handler preserve explicit confirmation separately from billing for failed and
  stopped workloads. Identity, pagination and downstream caller metadata also
  survive the wire round trip. The Runners backend is a fake, not the deployed
  database, and this test does not exercise the public authentication boundary.
- Lab: build and all 146 top-level tests pass (157 including subtests). Cases
  distinguish billing end from confirmation, empty and wrong-workload lists,
  mismatched images and incomplete/stale deployment rollouts. Five real installer
  subprocess cases against a fake Gateway verify that only confirmed predecessors
  may be ignored during workload selection; no terminal or model is started.
- Deployment wrapper: all 41 subprocess cases pass. Runners and Gateway are now
  required alongside the existing images. Dependencies roll out first and
  restore last; partial deployment, lost patch ACKs, rollout failures, missing
  images, external edits, replaced identities and newly busy workloads are
  covered. No acceptance child starts after setup failure. Image-only targets
  leave their entire existing environment untouched.
- The model-free startup scenario has seven additional proof/program tests:
  exact Pod/container ownership, optimistic finalizer updates, preservation of
  unrelated finalizers, premature release/replacement rejection, and a sentinel
  which prevents model execution even if a daemon ignores the required failure.
- A direct credential-free invocation rejected a missing reviewed Runners image
  before Gateway credential lookup or fixture creation. No model call was made.

Private live failure, retained metadata and operator-cleanup evidence are in
`.state/agyn-reporting-live-Q1g9Uf/`. The real database acceptance is in
`.state/runners-removal-postgres-bapUSU/evidence.json`; its bounded disposable
PostgreSQL container was removed. That isolated database test did not change the
deployed platform database. The subsequent rollout below did apply the additive
migration. Database checks alone do not prove Kubernetes absence or Gateway
field forwarding.

Operator cleanup verified the failed Pod's exact UID and terminated containers,
deleted only that Pod, removed the two unchanged fixture policies, and restored
the original runner/orchestrator deployments. The task PVC was retained. The
temporary Claude subscription, attachment and encrypted Agyn secret were deleted;
host authentication files were not changed. The native error's cause remains
unclassified; do not call it the earlier 401 or count it as interrupted recovery.

## Coordinated Integration Build

The lab-only API branch `lab/removal-resource-integration` at `3c84a6a` combines
the independent resource and confirmation contracts. The orchestrator branch of
the same name at `d77e7d5` adds the new confirmation patch to its earlier resource
integration. Both are pushed; focused contribution branches remain separate.
Runners stays at `890f759`. Gateway is based on deployed release `0.29.1`
(`d2b485a`), with only the test/documentation commits above. No upstream PR exists.

All three consumers were regenerated from that exact API checkout. Runners full
race tests and combined orchestrator race tests pass again, retaining the
documented orchestrator exclusion. The orchestrator repository happens to track
two generated LLM files; their regenerated hashes are recorded in the build
evidence rather than committed as unrelated generated API churn.

These local images were built, loaded and temporarily deployed for the startup
acceptance below. They are **not the currently deployed stock images**:

| Operator variable | Image |
| --- | --- |
| `AGYN_LIVE_RUNNERS_IMAGE` | `a2a-agyn-runners:890f759-api3c84a6a` |
| `AGYN_LIVE_GATEWAY_IMAGE` | `a2a-agyn-gateway:6d7d432-api3c84a6a` |
| `AGYN_LIVE_ORCHESTRATOR_IMAGE` | `a2a-agyn-orchestrator:d77e7d5-api3c84a6a` |

The existing bounded runner `a2a-agyn-runner:4dd12a8` and daemon/init
`a2a-agynd-reporting-init:beb1f23` remain separate components. The new images
preserve digest-pinned stock runtime bases and their non-root users. Each image's
packaged binary was copied from a never-started, owned inspection container and
matched against the build SHA-256; the container was then removed. This verifies
packaging, not service startup or cluster authorization.

Private build metadata, binary hashes, image IDs and load receipts are in
`.state/agyn-removal-build-7oANrz/build.json` and `images.json`. Build commands use
`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w'`.
Dockerfiles are `ops/Dockerfile.agyn-runners`, `ops/Dockerfile.agyn-gateway` and
`ops/Dockerfile.agyn-orchestrator`; their contexts contain only the respective
compiled binary. Native credentials and transcripts are not image inputs.

A read-only pre-rollout audit matched all 38 existing PVCs to active tracked
volumes, persistent definitions without TTL, and paused/terminated instances.
Private identity/retention evidence is in
`.state/agyn-removal-preflight-NLbe4Y/evidence.json`. This is a point-in-time audit,
not an admission lock. Recheck it before shared deployment changes and compare
the recorded PVC UIDs afterward. No retained PVC was changed by this build.

## Live Startup Failure Acceptance

On 2026-09-13 the required-init fixture passed through the real A2A service,
reporting installer, authenticated Gateway, Runners database, orchestrator and
Kubernetes runner. It used a separate private environment/agent with no native
subscription attached. Platform mode requires a registered model UUID as
metadata; the test never invokes that model. Its required init script replaces
only the fixture's Pod-local CLI entry point with a non-networking sentinel,
installs the ordinary reporting gate, then exits with code 47 on an explicit
operator trigger. No fake provider response or synthetic agent outcome is used.

| Observation | Evidence |
| --- | --- |
| Task / execution | `ea5897ee-dcf9-4e7e-beaf-58226ea7f086` / `a6841c1b-a680-460e-b270-1327f0d256ce` |
| Workload / Pod UID | `2dac2757-915f-4f68-b404-8f6d0b715e62` / `f1e8974d-4a57-409b-bc23-6c6f86a0e8b8` |
| Billing end | `21:43:50.760955Z` |
| Held-deletion checks | 15 passing snapshots, `21:43:51.081Z` through `21:44:06.174Z` |
| Operator released its finalizer | `21:44:07.394Z` |
| Persisted removal confirmation | `21:44:07.824618Z` |
| A2A `runtime.stopped` | `21:44:08.740Z` |

During every held snapshot the exact failed Pod still existed with its deletion
timestamp/finalizer, all its containers had terminated, billing had ended,
`removalConfirmedAt` was absent, and `resourcesReleased` was false. A queued
follow-up did not claim or dispatch. After finalizer release, settlement required
independent Pod absence and explicit confirmation for the same workload. The
task required recovery with automatic retry disabled; it did not become reusable
or successfully completed merely because init failed.

A bounded, read-only inspector verified the retained PVC's failure marker and
found no sentinel invocation, native mapping or session directory. Pod specs and
main-container cgroups matched the selected bounded profile. The original 38
PVCs, one retained from fixture setup debugging, and the successful fixture's PVC
remain Bound with unchanged UIDs: 40 total. The two fixture policies and inspector
were removed, and all four stock deployment images/managed settings were restored.
An independent PostgreSQL read confirmed both timestamps survived that downgrade.

Private evidence: `.state/agyn-removal-live-MMjqbl/evidence.json` and
`post-restore.json`; deployment snapshot `.state/agyn-lifecycle-deploy-BqQwTs/`.
The pre-migration custom-format database archive is in
`.state/agyn-removal-db-backup-zXxGAY/`; its archive contents were listed/verified,
but a restore test is **not** claimed. The additive column/constraint remain in
the deployed database, with no billing-to-confirmation migration backfill.

Two earlier fixture setup attempts are not passes: `Vqtbox` used native-mode
model metadata in platform mode and was rejected before task creation; `bt03tl`
assumed the Kubernetes container was named `main` instead of selecting the
instance-bound container. That attempt stopped before fault injection, and its
Pod was removed by reconciliation. After verifying explicit confirmation and
absence, operator cleanup removed its exact policies and restored the retained
deployments. Those fixture errors and cleanup evidence are retained separately.

The [Kubernetes finalizer](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
deliberately holds the API object, not a still-running process. This test does
not prove node fencing, forced-deletion safety, late-create exclusion, all
possible orphan Pods, or safe retry of interrupted side effects. The fixture
uses a persistent volume with **no TTL**, so live TTL scheduling is not proved.
Old-server compatibility still needs live checks. Native Codex lifecycle
regressions are recorded separately below.

After the retention audit and backup, the local reproduction command is:

```sh
env NODE_EXTRA_CA_CERTS=/home/alex/.agyn/local/certs/agyn-local-ca.pem \
  AGYN_KUBECONFIG=/home/alex/work/aira-a2a-lab/.state/agyn-kubeconfig \
  AGYN_LIVE_ACCEPTANCE=trusted-local \
  AGYN_LIVE_PLATFORM_MODEL_ID=6c310b50-0767-4ac0-ac9e-334bcdbc9731 \
  AGYN_LIVE_RUNNERS_IMAGE=a2a-agyn-runners:890f759-api3c84a6a \
  AGYN_LIVE_GATEWAY_IMAGE=a2a-agyn-gateway:6d7d432-api3c84a6a \
  AGYN_LIVE_ORCHESTRATOR_IMAGE=a2a-agyn-orchestrator:d77e7d5-api3c84a6a \
  AGYN_LIVE_INIT_IMAGE=a2a-agynd-reporting-init:beb1f23 \
  AGYN_LIVE_RUNNER_IMAGE=a2a-agyn-runner:4dd12a8 \
  AGYN_LIVE_COMPUTE_RESOURCES=true \
  AGYN_LIVE_SUPPORTING_RESOURCES='{"requestsCpu":"50m","requestsMemory":"64Mi","limitsCpu":"500m","limitsMemory":"256Mi"}' \
  AGYN_LIVE_RUNNER_CHART=/home/alex/work/agyn-contrib/k8s-runner/charts/k8s-runner \
  AGYN_LIVE_INSPECTOR_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 \
  node scripts/agyn-live-lifecycle.mjs startup-failure
```

The UUID is local model-registry metadata, not a portable model ID or permission
to run inference. The wrapper refuses a missing UUID before any deployment
change. Do not supply a native-agent profile/subscription file to this scenario.

## Native Lifecycle Regression

On 2026-09-13, the same coordinated Runners/Gateway/orchestrator, daemon and
bounded runner images passed all five native Codex scenarios in one wrapper run.
Codex `0.147.0` used `gpt-5.5` through the existing ChatGPT subscription reference;
no model credential was read/copied and no new paid API inference was enabled.
The A2A controller, scheduler, driver and workflow code were unchanged for this
regression. Only the operator fixture's removal-evidence checks were strengthened.

| Scenario | Evidence and result |
| --- | --- |
| Completed | Task `7d9cb099-3365-42b4-a0d4-7d2a77fd4b56`, `agyn-reporting-live-X8yets`: two turns, different Pod UIDs, same PVC/native session/marker; explicit confirmation and independent absence at each release. |
| Interrupted | Task `fbeec2d1-8544-4d8e-b4f1-9c4f1b099733`, `agyn-reporting-live-QLyLlJ`: after an unconditional append, service SIGKILL and Pod replacement left exactly one marker line. The replacement stayed gated; explicit reconciliation retired the old request without replay before continuation. All three workload records have confirmation. |
| Cancellation | Task `4e892f59-a231-467d-a856-b332238b7dbc`, `agyn-reporting-live-wPHIbq`: the tool survived an operator SIGTERM, then A2A cancellation settled 3.074 seconds after the request, with Pod deletion independently observed before settlement. Two read-only PVC samples showed an unchanged heartbeat and no late-write marker. |
| Parallel/FIFO | Agent `91fd5868-7a48-4d72-8df8-c8eb337d3b5c`, `agyn-reporting-live-czDtiH`: two tasks retained separate instances, threads, PVCs and native sessions. The queued same-task turn reused only its own state after old-workload confirmation while the other task kept running. Cross-task reporting returned 401 and cross-Pod TCP/UDP failed with passing listener controls. |
| Streaming | Task `9e3c17ec-0bf5-4126-8d7c-9d4a5bfc5abf`, `agyn-reporting-live-lKkffR`: blocking duplicate returned after 79.403 seconds; two streams stayed open for 118.315/118.312 seconds across idle compute release and Pod replacement, then closed at COMPLETED with the exact durable suffix. |

The single-task fixture now pins the acknowledged workload to an independently
inspected Pod and verifies every inspected replacement too. Empty lists, missing
pins, duplicates, foreign instances, nonterminal status, missing confirmation
and invalid timestamps cannot pass. Returned workload records are saved with
each turn. Billing and confirmation timestamps are independent; no relative
ordering between them is assumed.

The credential-free network preflight passed 92 checks, run `1176b203`, and
removed its probes: `.state/agyn-network-live-ZL3S0I/evidence.json`. Eleven
native/gated Pods across the five scenarios had matching main/supporting CPU
and memory specifications and main cgroup bounds. All fixture policies were
removed after workload absence. The original 40 PVC UIDs are unchanged; six new
task PVCs remain Bound, for 46 total. Every retained volume remains persistent
with no TTL, and its owner is paused or terminated.

Independent post-run reads verified original deployment UIDs, stock images,
managed environment fields and complete rollouts. The stock runner advertises
only `docker` again. PostgreSQL retains explicit confirmation for all eleven
workloads after the image downgrade. These are point-in-time retention and
restoration audits, not admission locking or a backup restore test.

Private per-scenario evidence is under `.state/` in the directories above;
parallel observations also have `parallel.json`. The deployment snapshot and
cross-run audits are `.state/agyn-lifecycle-deploy-c75cqq/{before,post-restore,native-summary}.json`.

After the same retention/image and network preflights, use the image, resource,
chart, inspector and CA environment from the model-free command above, omit
`AGYN_LIVE_PLATFORM_MODEL_ID`, and run:

```sh
node scripts/agyn-live-lifecycle.mjs completed interrupted cancellation parallel streaming
```

These are Codex-only trusted-local results. They do not complete Claude
lifecycle acceptance, node/late-create fencing, old-server/TTL checks, production
hardening, or streaming across a controller crash. Restored stock images still
do not implement the new service's required contract.

## Remaining Rollout Work

1. Review/publish the API contract before downstream default BSR builds can
   consume it. Local coordinated generation/build is verified above; publication
   and maintainer agreement are not claimed.
2. Drain new A2A admission and audit existing workloads. Apply the additive
   Runners migration without backfilling confirmation from billing/status data.
   This passed in the idle local lab, not an active production upgrade.
3. The four-component local rollout/restoration passed above. Production
   deployment, backup restore, draining and rollback acceptance remain.
   Restoring an older image does not remove the migration or its constraints.
4. The model-free failure/deletion test passed. Add live old-server compatibility,
   TTL scheduling and stronger infrastructure failure tests without weakening
   confirmation or permitting automatic side-effect replay.
5. The completed, interrupted, cancellation, parallel and streaming Codex
   regressions pass above. Repeat the relevant lifecycle scenarios for Claude
   and investigate its native errors. Preserve the separate interrupted
   side-effect reconciliation requirement; completed-turn recovery is not enough.

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
