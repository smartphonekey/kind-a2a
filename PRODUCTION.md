# Production Readiness

Status: implementation in progress. The existing 0.4.0 Agyn adapter is a trusted
local lab, not a production deployment. Passing the baseline tests does not
remove any of the gates below.

## Objective

Expose Agyn agents over A2A with an isolated, durable environment per agent/task,
concurrent execution across tasks, serialized execution within a task, and no
running workload between turns. Follow-up messages retain the task's identity,
runtime profile, agent session and workspace. Switching the operator-selected
agent profile must not change the A2A controller or workflow implementation.

## Gates

| Gate | Status | Required evidence |
| --- | --- | --- |
| Existing behavior | Baseline preserved | Build and all 118 tests pass on 2026-09-13, including the 10 baseline tests. |
| Durable task ownership and execution | Module/process and live restart verified | Transactional submissions, scoped idempotency, FIFO turns, fenced leases and six-process contention pass. Live controller SIGKILL plus pod replacement recovers a pinned execution without redispatch. Remaining failover/storage boundaries need verification. |
| Authenticated protocol boundary | HTTP/SSE tests verified; deployment pending | Unauthorized and cross-owner send/get/list/cancel/events checks, disconnect/reconnect and subscription credential revocation pass. TLS deployment acceptance remains. |
| Protocol conformance | Blocking/stream lifetime and real agent continuation verified; full audit pending | [Protocol acceptance](A2A-PROTOCOL.md) includes a real 79.326-second blocking send and two approximately 110-second streams across idle compute release and Pod replacement. Store-driven tests cover races, large snapshots, heartbeat/proxy behavior, bounded slow-reader cleanup, error envelopes and eight-reader fan-out. Error/validation conformance, production ingress and sustained load acceptance remain. |
| Reporting MCP and durable events | Live Codex verified in gated lab | Real progress/artifact/outcome calls, stdio-to-HTTP relay and private execution-scoped terminal delivery pass. Hardened delivery/deployment remains. |
| Stop outcome check | Live Codex reminder verified | Native Stop reminder caused the real agent to report its missing outcome. Durable reminder bounds and outage behavior have subprocess tests. Second-agent behavior and live failing-init fault injection remain. |
| Durable runtime | Completed, interrupted and concurrent continuation live verified | Same Agyn instance, native Codex session and PVC across changed pod UIDs. After explicit recovery, an unconditional append remains one line and the old inbox request is acknowledged without execution. Parallel follow-up also preserves identity while another task stays active. |
| Recovery and cancellation | Healthy-runner checks also pass under enforced network policy | The network-profile cancellation settled in 6.551s, after observed Pod deletion; its retained PVC showed a stopped heartbeat and no late-write marker. SIGKILL/pod-loss quarantine and explicit retirement also pass under that policy. Unknown provider identities still cannot resume. Node partitions and late in-flight creates need fencing/reconciliation. |
| Compute release | Corrected contract and healthy local Pod checks verified | Patched orchestrator confirms runner NotFound before removedAt and retains failed/unreachable workloads. Live deletion observation preceded cancellation settlement; completed/interrupted tests independently found no instance Pods on settlement. Stock/historical timestamps only prove acknowledgement, not physical absence. Upgrade drain/audit and infrastructure fencing remain required. |
| Parallelism | Real same-agent tasks and FIFO verified | [Two live tasks](AGYN-PARALLEL.md) ran in separate pods/PVCs/native sessions; an earlier queued follow-up did not block the other task. Follow-up claim occurred after old-pod removal and reused only its own state while the other task kept advancing. Final turns released all instance pods. |
| Agent portability | Claude configuration and native process resume verified; full gate pending | [Portability evidence](AGYN-PORTABILITY.md) covers native MCP discovery/reconfiguration and two real text-only turns across Claude process replacement. Daemon state mapping/config relocation, Agyn subscription binding and the same full A2A/Pod acceptance remain. Same-profile concurrency and fake-driver tests do not establish this gate. |
| Sandbox and network enforcement | Pod-network, parallel and lifecycle checks verified after local repair; full gate pending | The repeated credential-free preflight passed 92 checks; real concurrent tasks denied cross-pod TCP/UDP, and completion/interruption/cancellation have passing network-profile reruns. See [network evidence](AGYN-NETWORK.md) and [parallel scope](AGYN-PARALLEL.md). Adversarial hardening, cross-task overlay authorization and fail-closed bootstrap remain required. Unconfined is lab-only. |
| Resource containment | Per-container bounds and real-agent lifecycle verified; aggregate gate pending | [Typed API, runner enforcement and flavor/MCP mapping](AGYN-RESOURCES.md) pass source tests and live kernel probes. Completed, parallel/FIFO, interrupted and cancellation tests pass using the bounded profile; nine Agyn Pods have matching specs/main cgroups. Aggregate admission/accounting, agent OOM recovery, production sizing and mandatory production-profile enforcement remain required. Stock deployment was restored after testing. |
| Startup reliability | Unexplained failure remains | One live workload became FAILED during setup before fault injection, with no reason exposed by Gateway. The accepted request was quarantined and cleanup confirmed removal. Passing fresh fixtures do not explain that failure; improve diagnosability and investigate it before release. |
| Operations | Pending; local streaming resilience and two-component restoration verified | 27 subprocess cases cover scenario forwarding, restoration, partial deployment, lost patch acknowledgement, rollout failure, external edits, identity changes and busy-lab refusal. Live restoration, capability withdrawal and zero leftover Pods were independently checked again after streaming acceptance. Bounded HTTP backpressure tests pass; production admission/load, graceful draining, readiness, backup/restore, schema migration, retention and disaster recovery still need acceptance. |
| Upstream contribution | Ten focused branches; proposal drafted | Existing daemon/lifecycle/ingress and resource branches plus Claude SDK session selection `0cdc814`. The SDK passes ordinary/race and native completed-turn process recovery checks. Resource checks include Buf compatibility, ordinary Go suites, full runner and assembler race suites, and live kernel containment. Unrelated upstream race-test failures remain disclosed. No upstream PR submitted yet. |

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

## References

- [Service setup and current limitations](SERVICE.md)
- [Gated live integration and reproduction](AGYN-REPORTING.md)
- [Network enforcement failure, repair and acceptance](AGYN-NETWORK.md)
- [Live parallel tasks and same-task FIFO](AGYN-PARALLEL.md)
- [Compute resource enforcement and remaining profile acceptance](AGYN-RESOURCES.md)
- [Blocking/streaming protocol acceptance and remaining audit](A2A-PROTOCOL.md)
- [Second-agent portability evidence and remaining integration](AGYN-PORTABILITY.md)
- [Contribution guide and patch evidence](CONTRIBUTING-AGYN.md)

- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Blocking SendMessage requirements](https://a2a-protocol.org/latest/specification/#322-sendmessageconfiguration)
- [Agyn architecture conventions](https://github.com/agynio/architecture)
- [Agyn daemon development](https://github.com/agynio/agynd-cli)
- [Current lab acceptance](ACCEPTANCE.md)
