# Production Readiness

Status: implementation in progress. The existing 0.4.0 Agyn adapter is a trusted
local lab, not a production deployment. Passing the baseline tests does not
remove any of the gates below.

Latest release blocker: a failed Pod exposed that Runners stamps `removedAt`
for metering, independently of deletion. The old contract is not sufficient.
The additive confirmation field passes source, real database, Gateway wire and
coordinated local failed-Pod acceptance. Stock deployments are restored while
the additive migration remains. All five native Codex regressions also pass on
the coordinated stack. Claude lifecycle, infrastructure fencing and production
rollout gates are still pending. See
[the incident and replacement contract](AGYN-REMOVAL.md).

## Objective

Expose Agyn agents over A2A with an isolated, durable environment per agent/task,
concurrent execution across tasks, serialized execution within a task, and no
running workload between turns. Follow-up messages retain the task's identity,
runtime profile, agent session and workspace. Switching the operator-selected
agent profile must not change the A2A controller or workflow implementation.

## Gates

| Gate | Status | Required evidence |
| --- | --- | --- |
| Existing behavior | Baseline preserved | Build and all 202 top-level tests pass on 2026-09-14 (221 including subtests), including the 10 baseline tests, on pinned Node 24.21.0 / SQLite 3.53.4. |
| Durable task ownership and execution | Module/process and live restart verified | Transactional submissions, scoped idempotency, FIFO turns, fenced leases and six-process contention pass. Live controller SIGKILL plus pod replacement recovers a pinned execution without redispatch. Remaining failover/storage boundaries need verification. |
| Authenticated protocol boundary | HTTP/SSE tests verified; deployment pending | Unauthorized and cross-owner send/get/list/cancel/events checks, disconnect/reconnect and subscription credential revocation pass. TLS deployment acceptance remains. |
| Protocol conformance | Blocking/stream lifetime and real agent continuation verified; full audit pending | [Protocol acceptance](A2A-PROTOCOL.md) now also passes on the coordinated removal stack: a 79.403-second blocking duplicate and two approximately 118-second streams across idle compute release and Pod replacement. Store-driven tests cover races, large snapshots, heartbeat/proxy behavior, bounded slow-reader cleanup, error envelopes and eight-reader fan-out. Error/validation conformance, production ingress, crash recovery and sustained load acceptance remain. |
| Reporting MCP and durable events | Live Codex verified in gated lab | Real progress/artifact/outcome calls, stdio-to-HTTP relay and private execution-scoped terminal delivery pass. Hardened delivery/deployment remains. |
| Stop outcome check | Both native reminders and required-init failure verified | Native Codex and Claude Stop reminders caused real MCP outcomes. The false cancellation notice on normal release is corrected; earlier two-turn Claude/Codex Pod tests pass. Required-init failure prevents native CLI startup in a real model-free fixture. Codex completed/streaming reminders also pass on the coordinated removal stack; full second-agent lifecycle remains. |
| Durable runtime | Completed, interrupted and concurrent continuation live verified | Same Agyn instance, native Codex session and PVC across changed pod UIDs. After explicit recovery, an unconditional append remains one line and the old inbox request is acknowledged without execution. Parallel follow-up also preserves identity while another task stays active. |
| Recovery and cancellation | Healthy-runner checks pass on the coordinated removal stack | The latest bounded/network-profile cancellation settled in 3.074s, after observed Pod deletion; its retained PVC showed a stopped heartbeat and no late-write marker. SIGKILL/pod-loss quarantine and explicit retirement also pass with all original/replacement workload confirmations. Unknown provider identities still cannot resume. Node partitions and late in-flight creates need fencing/reconciliation. |
| Compute release | Additive contract and controlled failed-Pod release live verified | [The replacement contract](AGYN-REMOVAL.md) passes a coordinated rollout: 15 held-Pod snapshots keep A2A release false despite billing end; physical absence and explicit confirmation precede settlement. No native CLI ran, no queued follow-up dispatched, and the PVC survived. Live old-server/TTL checks, production upgrade audit, orphan/late-create exclusion and node fencing remain required. |
| Parallelism | Real same-agent tasks and FIFO verified | [Two live tasks](AGYN-PARALLEL.md) ran in separate pods/PVCs/native sessions; an earlier queued follow-up did not block the other task. Follow-up claim occurred after old-pod removal and reused only its own state while the other task kept advancing. Final turns released all instance pods. |
| Agent portability | Combined diagnostic/session runtime verified through Codex; full gate pending | [Portability evidence](AGYN-PORTABILITY.md) includes earlier completed Claude recovery across changed Pod UIDs. SDK `54490e0` and daemon `7ed299f` now combine session and diagnostic patches; fake-client durable failure cases and an isolated native HTTP 401 probe pass. Real Codex completed/interrupted recovery also passes on the rebuilt image, whose binary was independently verified inside a live Agyn Pod. This is not another Claude A2A lifecycle pass. The historical native error and earlier 401 remain unexplained. Fresh Claude subscription authentication and streaming, parallel, cancellation and interrupted-side-effect acceptance remain. |
| Sandbox and network enforcement | Pod-network, parallel and lifecycle checks verified after local repair; full gate pending | The repeated credential-free preflight passed 92 checks; real concurrent tasks denied cross-pod TCP/UDP, and completion/interruption/cancellation have passing network-profile reruns. See [network evidence](AGYN-NETWORK.md) and [parallel scope](AGYN-PARALLEL.md). Adversarial hardening, cross-task overlay authorization and fail-closed bootstrap remain required. Unconfined is lab-only. |
| Resource containment | Per-container bounds, shared task-count admission and local A2A quota recovery verified; production gate pending | [Typed API, runner enforcement and flavor/MCP mapping](AGYN-RESOURCES.md) pass source tests, kernel probes and the coordinated five-scenario Codex sweep. [Database-wide admission](SERVICE.md#shared-execution-admission) pins the limit and retains unreleased reservations. [Native quota acceptance](AGYN-RESOURCES.md#native-namespace-quota-acceptance) covers effective init/sidecar accounting and competing starts. The [existing-task A2A rejection/recovery scenario](AGYN-RESOURCES.md#a2a-quota-recovery) passes with one persisted inbox receipt, explicit confirmation, no capacity-triggered retry and acknowledgement-only retirement. The separate first-PVC scenario below also passes. Whole-task cost reporting, agent OOM recovery, sizing, protected quota bootstrap and mandatory production profiles remain required. Stock deployments are restored with no permanent workload quota. |
| First-provision cleanup | Deployed first-PVC rejection and explicit recovery verified; production gate pending | [First-provision evidence](AGYN-RESOURCES.md#a2a-first-provision-recovery) includes the failed image-only rollout, missing Secret-read RBAC diagnosis and focused fix `9002f31`. Native quota stages now pass using the chart's service-account permissions, without Secret listing; both focused and combined race suites pass. The real A2A rerun preserves task/instance/volume identity, retires the rejected inbox item without execution and completes two native turns across Pod replacement. All 49 prior PVCs and 16 older Secret identities are unchanged; stock deployments and temporary RBAC are restored. The newer volume-ownership rerun below preserves all 50 prior claims. Named-PVC identity enforcement, crash-orphan reconciliation, late-create/node fencing and post-success Stop/Remove cleanup remain required. |
| Volume ownership | Closed-record and native PVC checks verified; production gate pending | [Runners fix and acceptance](AGYN-RESOURCES.md#closed-volume-ownership) preserve the complete identity tuple in an atomic reopen update; real PostgreSQL contention and combined first-provision A2A recovery pass. Independent [named-PVC fix `7d3238a`](AGYN-RESOURCES.md#named-pvc-ownership) passes source race tests and eight real concurrent Kubernetes creates, with all 51 prior claims unchanged. Its combined deployed A2A regression is pending. Sandbox open-record validation, safe deletion, authentication, infrastructure fencing and upgrade of all writers are still required. Stock Runners and k8s-runner are unchanged, not permanently fixed. |
| Startup reliability | Unexplained failure remains | One live workload became FAILED during setup before fault injection, with no reason exposed by Gateway. The accepted request was quarantined and cleanup confirmed removal. Passing fresh fixtures do not explain that failure; improve diagnosability and investigate it before release. |
| Operations | Local four-component rollout/restoration and migration verified | 59 subprocess cases cover dependency order/restoration, failures, conflicts, identity changes, busy-lab refusal, model-free preflight, quota and Secret-read guards. The latest volume-ownership recovery audit independently verified restored stock settings/UIDs/rollouts, removed temporary Role/RoleBinding, unchanged ClusterRole, zero workload Pods/Services/quotas, all 50 prior PVCs unchanged and 51 retained total. Five workload confirmations survived image downgrade; the new instance is paused with an active persistent/no-TTL workspace. This run had three rejected provisioning attempts before quarantine, not one; none admitted a Pod or ran the agent. Earlier quota, combined-runtime and eleven-workload evidence remains separate. A private pre-migration archive exists, but archive listing is not a restore test. Production admission/load, graceful draining, readiness, backup/restore, active upgrade, retention and disaster recovery remain required. |
| Upstream contribution | Twenty-one focused branches; proposal drafted | API `0125665`, Runners `890f759`, orchestrator `f83ce83` and Gateway wire-test branch `6d7d432`; independent SDK diagnostics `16286f3` and stacked daemon diagnostics `2afdfc1`. Runner chart `28d4562` adds native namespace quota; independent runner fix `9002f31` includes startup-secret cleanup and its named-read permission. Runners fix `5638dce` adds atomic closed-volume identity checks with CI PostgreSQL; combined `5f66067` passes deployed A2A recovery. Independent runner `7d3238a` adds named-PVC identity validation with source/native Kubernetes acceptance; combined A2A deployment is pending. Combined branches are for local acceptance only. Buf compatibility, full Runners/Gateway/SDK/runner race, real PostgreSQL, Gateway transport and controlled Kubernetes checks pass; daemon/orchestrator retain the disclosed broader race limitations. Existing upstream licenses remain; new service/reporting code is AGPL-3.0-only. No upstream PR submitted yet. |

Native session persistence is required for correct continuation. Bulk session
analytics, auto-improvement pipelines and prompt/tool customization UI are next
steps, not substitutes for the gates above.

## Contribution Boundaries

- `src/service/`: A2A task ownership, execution scheduling and durable events.
- Agyn adapter: translate provider operations; no LLM-specific control logic.
- Reporting MCP: generic progress and outcome contract, separate from chat.
- `agynio/agynd-cli`: generic persistent state location and lifecycle hooks.
- `agynio/architecture`: discuss the contract before declaring a native API.
- API/Gateway changes are separate PRs only where existing APIs cannot meet the
  agreed contract. Runtime images remain binary packaging.

The first storage implementation uses SQLite WAL on a single local/PVC
filesystem, with transactions and fencing across local worker processes. WAL
must not be put on a shared network filesystem. A production storage profile,
backup/restore procedure and failover tests remain release gates; this is not a
claim of multi-node HA.

The service and admission CLI now check for SQLite's
[WAL-reset fix](https://www.sqlite.org/wal.html#walreset) before opening the task
database. Node 24.21.0 / SQLite 3.53.4 passes the full suite; the former host
default Node 22.20.0 / SQLite 3.50.4 is rejected. This is a runtime prerequisite,
not a reproduction of the corruption race or a complete storage reliability
proof. Production runtime packaging, restore and migration acceptance remain.

## References

- [Service setup and current limitations](SERVICE.md)
- [Gated live integration and reproduction](AGYN-REPORTING.md)
- [Network enforcement failure, repair and acceptance](AGYN-NETWORK.md)
- [Live parallel tasks and same-task FIFO](AGYN-PARALLEL.md)
- [Compute resource enforcement and remaining profile acceptance](AGYN-RESOURCES.md)
- [Blocking/streaming protocol acceptance and remaining audit](A2A-PROTOCOL.md)
- [Second-agent portability evidence and remaining integration](AGYN-PORTABILITY.md)
- [Failed-Pod incident and explicit removal confirmation](AGYN-REMOVAL.md)
- [Contribution guide and patch evidence](CONTRIBUTING-AGYN.md)

- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Blocking SendMessage requirements](https://a2a-protocol.org/latest/specification/#322-sendmessageconfiguration)
- [Agyn architecture conventions](https://github.com/agynio/architecture)
- [Agyn daemon development](https://github.com/agynio/agynd-cli)
- [Current lab acceptance](ACCEPTANCE.md)
