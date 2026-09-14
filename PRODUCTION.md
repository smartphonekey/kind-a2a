# Production Readiness

Status: implementation in progress. The existing 0.4.0 Agyn adapter is a trusted
local lab, not a production deployment. Passing the baseline tests does not
remove any of the gates below.

Latest release blocker: a failed Pod exposed that Runners stamps `removedAt`
for metering, independently of deletion. The old contract is not sufficient.
The additive confirmation field passes source, real database, Gateway wire and
coordinated local failed-Pod acceptance. Stock deployments are restored while
the additive migration remains. All five native Codex regressions also pass on
the coordinated stack. All five Claude lifecycle scenarios also have passing
fixtures across separate reviewed runs, but earlier native authentication
failures remain unexplained. Reliability, infrastructure fencing and production
rollout gates are still pending. See
[the incident and replacement contract](AGYN-REMOVAL.md).

The latest [checked-volume acceptance](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance)
now combines real PostgreSQL, registry RPCs, controller process replacement and
native Kubernetes deletion. It does not use the A2A driver or deployed Agents
service, and does not remove the coordinated rollout or infrastructure gates.

The separate [native transport restriction](AGYN-RUNNER-TRANSPORT.md) now closes
the full plaintext control API alongside a Ziti-enabled runner at source level.
Independent and combined race/startup tests pass; real overlay-policy audit,
backend incarnation and deployed acceptance remain open. No deployment changed.

## Objective

Expose Agyn agents over A2A with an isolated, durable environment per agent/task,
concurrent execution across tasks, serialized execution within a task, and no
running workload between turns. Follow-up messages retain the task's identity,
runtime profile, agent session and workspace. Switching the operator-selected
agent profile must not change the A2A controller or workflow implementation.

## Gates

| Gate | Status | Required evidence |
| --- | --- | --- |
| Existing behavior | Baseline preserved | Build and all 313 tests including subtests pass on 2026-09-14, including the 10 baseline tests and 69 read-only upgrade audit tests, on pinned Node 24.21.0 / SQLite 3.53.4. |
| Durable task ownership and execution | Module/process and live restart verified | Transactional submissions, scoped idempotency, FIFO turns, fenced leases and six-process contention pass. Live controller SIGKILL plus pod replacement recovers a pinned execution without redispatch. Remaining failover/storage boundaries need verification. |
| Authenticated protocol boundary | HTTP/SSE tests verified; deployment pending | Unauthorized and cross-owner send/get/list/cancel/events checks, disconnect/reconnect and subscription credential revocation pass. TLS deployment acceptance remains. |
| Native runner transport | Source, loopback RPC and startup verified; live overlay/rollout pending | [Independent transport fix `c5c467e` / `d0ef963`](AGYN-RUNNER-TRANSPORT.md) restricts plaintext TCP to exact unary readiness when Ziti is enabled. Anonymous/forged-metadata control calls, all streams and future registered services are denied; pending/failed enrollment stays restricted. All 152 independent race tests and 400 test entries across ten repeated transport runs pass. Combined checked-runner `28d77ea` passes 386 race tests, including plaintext checked-removal denial. Build/vet pass. Kubernetes fixtures were not enabled; the startup test uses a fake Kubernetes client and loopback Gateway. Standalone plaintext mode, actual Dial/Bind policy audit, per-owner authorization, backend incarnation, revocation and coordinated deployment remain open. |
| Protocol conformance | Blocking/stream lifetime and real agent continuation verified; full audit pending | [Protocol acceptance](A2A-PROTOCOL.md) now also passes on the coordinated removal stack: a 79.403-second blocking duplicate and two approximately 118-second streams across idle compute release and Pod replacement. Store-driven tests cover races, large snapshots, heartbeat/proxy behavior, bounded slow-reader cleanup, error envelopes and eight-reader fan-out. Error/validation conformance, production ingress, crash recovery and sustained load acceptance remain. |
| Reporting MCP and durable events | Live Codex and Claude verified in gated lab | Real progress/artifact/outcome calls, stdio-to-HTTP relay and private execution-scoped terminal delivery pass. Claude parallel acceptance also verifies distinct execution credentials and rejects reporter access to owner APIs. Hardened delivery/deployment remains. |
| Stop outcome check | Both native reminders and required-init failure verified | Native Codex and Claude Stop reminders caused real MCP outcomes. The false cancellation notice on normal release is corrected; two-turn Claude/Codex Pod tests pass. Required-init failure prevents native CLI startup in a real model-free fixture. Both profiles have completed/streaming reminder evidence; Claude interrupted/cancellation/parallel fixtures also pass separately. Reliability and hardened hook enforcement remain open. |
| Durable runtime | Completed, interrupted and concurrent continuation live verified | Same Agyn instance, native Codex session and PVC across changed pod UIDs. After explicit recovery, an unconditional append remains one line and the old inbox request is acknowledged without execution. Parallel follow-up also preserves identity while another task stays active. |
| Recovery and cancellation | Healthy-runner checks pass on the coordinated removal stack | Bounded/network-profile cancellation settled in 3.074s for Codex and 8.568s in the fresh Claude run, after observed Pod deletion; retained PVC checks showed stopped heartbeats and no late-write markers. SIGKILL/pod-loss quarantine and explicit retirement also pass with all original/replacement workload confirmations. Unknown provider identities still cannot resume. Node partitions and late in-flight creates need fencing/reconciliation. |
| Compute release | Additive contract and controlled failed-Pod release live verified | [The replacement contract](AGYN-REMOVAL.md) passes a coordinated rollout: 15 held-Pod snapshots keep A2A release false despite billing end; physical absence and explicit confirmation precede settlement. No native CLI ran, no queued follow-up dispatched, and the PVC survived. Live old-server/TTL checks, production upgrade audit, orphan/late-create exclusion and node fencing remain required. |
| Parallelism | Real same-agent tasks and FIFO verified for both profiles | [Two live Codex tasks](AGYN-PARALLEL.md) and the [fresh Claude scenario](AGYN-PORTABILITY.md#fresh-lifecycle-sweep) ran in separate pods/PVCs/native sessions; an earlier queued follow-up did not block the other task. Follow-up claim occurred after old-pod removal and reused only its own state while the other task kept advancing. Final turns released all instance pods. |
| Agent portability | Claude lifecycle fixtures verified; reliability/production gate pending | Completed-turn continuation and explicit interrupted-turn recovery pass in separate reviewed runs. The [fresh lifecycle sweep](AGYN-PORTABILITY.md#fresh-lifecycle-sweep) adds streaming, cancellation and parallel/FIFO passes without changing the A2A controller/workflows. An earlier streaming follow-up failed with captured `api_status=401`, `terminal_reason=api_error`, and daemon exit 1; older native failures remain unclassified. Native proxy diagnostics now work, but the latest bounded capture contained no 401, so credential resolution/interception versus upstream refusal is not diagnosed. These successes do not establish sustained reliability or resolve the incidents. |
| Sandbox and network enforcement | Pod-network, parallel and lifecycle checks verified after local repair; full gate pending | The repeated credential-free preflight passed 92 checks; real concurrent tasks denied cross-pod TCP/UDP, and completion/interruption/cancellation have passing network-profile reruns. See [network evidence](AGYN-NETWORK.md) and [parallel scope](AGYN-PARALLEL.md). Adversarial hardening, cross-task overlay authorization and fail-closed bootstrap remain required. Unconfined is lab-only. |
| Resource containment | Per-container bounds, shared task-count admission and local A2A quota recovery verified; production gate pending | [Typed API, runner enforcement and flavor/MCP mapping](AGYN-RESOURCES.md) pass source tests, kernel probes and the coordinated five-scenario Codex sweep. [Database-wide admission](SERVICE.md#shared-execution-admission) pins the limit and retains unreleased reservations. [Native quota acceptance](AGYN-RESOURCES.md#native-namespace-quota-acceptance) covers effective init/sidecar accounting and competing starts. The [existing-task A2A rejection/recovery scenario](AGYN-RESOURCES.md#a2a-quota-recovery) passes with one persisted inbox receipt, explicit confirmation, no capacity-triggered retry and acknowledgement-only retirement. The separate first-PVC scenario below also passes. Whole-task cost reporting, agent OOM recovery, sizing, protected quota bootstrap and mandatory production profiles remain required. Stock deployments are restored with no permanent workload quota. |
| First-provision cleanup | Deployed first-PVC rejection and explicit recovery verified; production gate pending | [First-provision evidence](AGYN-RESOURCES.md#a2a-first-provision-recovery) includes the failed image-only rollout, missing Secret-read RBAC diagnosis and focused fix `9002f31`. Native quota stages now pass using the chart's service-account permissions, without Secret listing; both focused and combined race suites pass. The real A2A rerun preserves task/instance/volume identity, retires the rejected inbox item without execution and completes two native turns across Pod replacement. All 49 prior PVCs and 16 older Secret identities are unchanged; stock deployments and temporary RBAC are restored. The newer volume-ownership rerun below preserves all 50 prior claims. Named-PVC identity enforcement, crash-orphan reconciliation, late-create/node fencing and post-success Stop/Remove cleanup remain required. |
| Volume ownership | Closed-record, native PVC and combined A2A checks verified; production gate pending | [Runners ownership](AGYN-RESOURCES.md#closed-volume-ownership) passes real PostgreSQL contention and deployed recovery. Independent named-PVC `7d3238a` passes source/native Kubernetes tests; combined `641e2f7` now passes build, full race, credential-rollback/PVC-conflict tests and [deployed first-provision A2A acceptance](AGYN-RESOURCES.md#combined-a2a-acceptance). The rejected request is retired without execution and two native turns retain workspace/session identity. Sandbox open-record validation, safe deletion, authentication, late-create/node fencing and upgrade of all writers remain required. Stock services are restored, not permanently fixed. |
| Volume inventory and orphan retention | Independent and combined native checks verified; production gate pending | [Orchestrator retention `72e1b22` and complete runner inventory `40b35ce`](AGYN-VOLUME-SAFETY.md) prevent stale/scoped-list orphan deletion and reject incomplete/ambiguous inventory. Both fixes and combined `f65a9f6`/`d03831f` pass source and real runner/Kubernetes acceptance. All 60 existing PVC identities/specs/phases are unchanged; fixture namespaces are gone. Registry/Agents clients in this test are fakes, no platform deployment changed, and no new A2A lifecycle sweep ran. Authenticated incarnation-bound deletion, physical confirmation, ownership-aware garbage collection, all-writer rollout and late-create/node fencing remain required. Truly unknown disks are retained, not automatically reclaimed. |
| Checked volume deletion | Combined process acceptance verified; coordinated A2A rollout pending | [Checked removal](AGYN-CHECKED-VOLUMES.md) adds immutable bindings/intents, revision CAS, old-writer guards and physical-absence confirmation. Caller migration `eebf4cf` routes every orchestrator/sandbox volume mutation through checked APIs. [Follow-up `5449301`](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance) now verifies real PostgreSQL/migrations, registry RPCs, controller subprocesses and native Kubernetes deletion for both owner kinds. SIGKILL after begin, native deletion and registry confirmation preserves committed state; old-UID replay cannot delete a replacement. Build and 488 ordinary tests pass; 491 selected race tests pass with both native fixtures enabled and exactly the known group-consumer test excluded. Unfiltered race/vet limitations remain. Agents metadata and authorization writes are stubs; A2A acceptance, backend identity, authorization, all-writer rollout, garbage collection and late-create/node fencing remain required. All 68 existing PVCs, including 60 task claims, and all 41 platform deployments are unchanged; nothing is permanently deployed. |
| Workload admission and volume deletion | Registry contention and combined controller/native races verified; rollout pending | [Dependent Runners guard `f05b479`](AGYN-CHECKED-VOLUMES.md#workload-admission) serializes checked-owner admission with deletion, retains unconfirmed predecessor reservations and protects workload identity/confirmation from old SQL. Build, vet and all 335 registry race tests pass with both real PostgreSQL fixtures enabled. Forty-eight blocked interleavings cover both owner kinds, all isolation settings, rollback and competing starts while another owner progresses. Upgrade refuses contradictory history without rewriting it. [Combined process acceptance](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance) now forces both controller/registry admission-deletion orderings against native PVCs, preserves another owner's progress and verifies process recovery with independent SQL reads. Workloads are unused reservations, not native Pod starts. Coordinated migrations `0017`-`0019`, all-writer audit and A2A rollout remain required; this does not establish late-create/node fencing. |
| Checked-volume upgrade | Read-only installed-state audit verified; adoption/drain pending | [The audit command](AGYN-CHECKED-VOLUMES.md#read-only-upgrade-audit) uses a read-only MVCC registry snapshot, before/after Kubernetes inventories, pinned namespace/PostgreSQL identities and private reports. The latest 12:54:08 UTC capture still finds 61 legacy records: 60 active records match retained PVC ownership, one failed unbound record has no physical match. All 125 workloads are confirmed; migrations `0018`-`0020` are absent and stock clients remain. Its 69 tests pass within the 313-test service suite; the latest 65 findings include the newly required adoption guard. No installed data or deployment changes were made. Findings are not rollout/adoption/deletion authority; explicit legacy reconciliation, full writer draining, compatible clients, backend fencing and coordinated A2A acceptance remain required. |
| Legacy volume adoption | Registry guards, upgrade and native compatibility verified; coordinator/drain pending | [Dependent Runners `748d283`](AGYN-CHECKED-VOLUMES.md#legacy-adoption-guards) reuses checked bind with a known recorded name, zero unconfirmed predecessors and immutable persistent identity; ordinary reopen cannot opt legacy failures in. Migration `0020` preserves historical rows and serializes adoption with workload admission. All 419 registry race tests pass, including 32 blocked interleavings, both owner kinds and all isolation settings; build/vet/module verification pass. The combined process/native fixture also passes with the new registry. It does not adopt installed data, authenticate the backend, drain writers or fence delayed operations. All 68 existing PVC identities/specs/phases and all 52 deployment identities/generations/images/replica counts/readiness across namespaces are unchanged. Full A2A rollout and explicit legacy reconciliation remain required. |
| Startup reliability | Native authentication failure classified; cause still open | Earlier unexplained native/setup failures remain. A Claude streaming follow-up produced a safely captured HTTP 401 result and was quarantined, with confirmed removal. Later completed/interrupted and streaming/cancellation/parallel passes do not explain it. Read-only runtime observation and bounded native-proxy diagnostics now retain safe metadata; they are acceptance diagnostics, not production runtime-error storage or authoritative outcomes. Investigate the credential/proxy/provider boundary before release. |
| Operations | Coordinated local rollout, restoration, retention and migration verified | 70 subprocess cases cover rollout/restoration and guards, including optional proxy diagnostics. The latest Claude sweep verifies all five stock deployment UIDs/settings/readiness restored, temporary Role/RoleBinding removed, unchanged ClusterRole, zero task Pods/Services/quotas, all 56 prior claim UIDs/specs/phases and 16 older Secret identities unchanged, and 60 retained claims. Independent database/Gateway checks retain six removal confirmations and four paused instances with active persistent/no-TTL workspaces. Temporary provider bindings were deleted; the host credential file is unchanged. Prior failure and PVC-recovery audits remain separate. Production admission/load, draining, readiness, storage backup/restore, active upgrade, retention and disaster recovery remain required. |
| Upstream contribution | Thirty-two focused branches; no upstream PR submitted | API, Runners, orchestrator, Gateway, SDK and runner branches retain their separate review boundaries and licenses; new service/reporting code is AGPL-3.0-only. Independent named-PVC `7d3238a` and deployed combined `641e2f7` remain unchanged. LLM-proxy diagnostics, the gzip test correction, volume retention/inventory fixes, three [checked-volume branches](AGYN-CHECKED-VOLUMES.md), the dependent [owner-admission guard](AGYN-CHECKED-VOLUMES.md#workload-admission), [checked caller migration `eebf4cf`](AGYN-CHECKED-VOLUMES.md#controller-migration), its [process-acceptance follow-up `5449301`](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance) [legacy-adoption guard `748d283`](AGYN-CHECKED-VOLUMES.md#legacy-adoption-guards) and [native transport restriction `d0ef963`](AGYN-RUNNER-TRANSPORT.md) are pushed. The checked contract is a proposal requiring coordinated dependencies, not a published API or drop-in image. Acceptance combinations are not bundled upstream proposals. Other suites retain their documented scopes; broader daemon/orchestrator race and vet limitations remain disclosed. See [the contribution guide](CONTRIBUTING-AGYN.md). |

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

- [Native runner transport restriction and remaining authentication gates](AGYN-RUNNER-TRANSPORT.md)
- [Service setup and current limitations](SERVICE.md)
- [Gated live integration and reproduction](AGYN-REPORTING.md)
- [Network enforcement failure, repair and acceptance](AGYN-NETWORK.md)
- [Live parallel tasks and same-task FIFO](AGYN-PARALLEL.md)
- [Compute resource enforcement and remaining profile acceptance](AGYN-RESOURCES.md)
- [Volume inventory, orphan retention and deletion-safety gates](AGYN-VOLUME-SAFETY.md)
- [Checked volume API, registry guards and native deletion acceptance](AGYN-CHECKED-VOLUMES.md)
- [Blocking/streaming protocol acceptance and remaining audit](A2A-PROTOCOL.md)
- [Second-agent portability evidence and remaining integration](AGYN-PORTABILITY.md)
- [Failed-Pod incident and explicit removal confirmation](AGYN-REMOVAL.md)
- [Contribution guide and patch evidence](CONTRIBUTING-AGYN.md)

- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Blocking SendMessage requirements](https://a2a-protocol.org/latest/specification/#322-sendmessageconfiguration)
- [Agyn architecture conventions](https://github.com/agynio/architecture)
- [Agyn daemon development](https://github.com/agynio/agynd-cli)
- [Current lab acceptance](ACCEPTANCE.md)
