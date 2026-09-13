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
| Existing behavior | Baseline verified | Build and 10 existing tests passed on 2026-09-13; preserve these tests. |
| Durable task ownership and execution | Module/process and live restart verified | Transactional submissions, scoped idempotency, FIFO turns, fenced leases and six-process contention pass. Live controller SIGKILL plus pod replacement recovers a pinned execution without redispatch. Remaining failover/storage boundaries need verification. |
| Authenticated protocol boundary | HTTP/SSE tests verified; deployment pending | Unauthorized and cross-owner send/get/list/cancel/events checks, disconnect/reconnect and subscription credential revocation pass. TLS deployment acceptance remains. |
| Reporting MCP and durable events | Live Codex verified in gated lab | Real progress/artifact/outcome calls, stdio-to-HTTP relay and private execution-scoped terminal delivery pass. Hardened delivery/deployment remains. |
| Stop outcome check | Live Codex reminder verified | Native Stop reminder caused the real agent to report its missing outcome. Durable reminder bounds and outage behavior have subprocess tests. Second-agent behavior and live failing-init fault injection remain. |
| Durable runtime | Completed and interrupted recovery live verified | Same Agyn instance, native Codex session and PVC across changed pod UIDs. After explicit recovery, an unconditional append remains one line and the old inbox request is acknowledged without execution. New-service parallel isolation remains separate. |
| Recovery and cancellation | Interrupted recovery verified; hard cancel pending | Live SIGKILL/pod-loss quarantine and explicit retirement pass. Generic daemon journal tests cover lost ACKs, process death and competing starts. Unknown provider request identities cannot resume. Bounded hard cancellation remains required. |
| Compute release | Completed and quarantined turns live verified | Settlement waits for Agyn removedAt evidence, including the gated replacement after interruption. Follow-up uses another pod. Hard cancellation during an active command remains unverified in the new service. |
| Parallelism and portability | Pending | Concurrent isolated live tasks; same-task FIFO; second real agent profile with unchanged controller/workflows. |
| Sandbox and network enforcement | Pending | Nonprivileged workloads, restricted mounts/service accounts, enforced egress and cross-task denial; explicit runtime isolation profile. Unconfined is lab-only. |
| Operations | Pending | Bounded admission, backpressure, graceful shutdown, readiness, backup/restore, schema migration and retention tests; deployment and rollback instructions. |
| Upstream contribution | Three focused patches pushed; proposal drafted | Persistence `c933329`, required-init `591543b` and inbox guard `8b6056c` are independent branches in `spk-ai/agynd-cli`. Ordinary Go suites and focused race checks pass. No upstream PR submitted yet. |

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
- [Contribution guide and patch evidence](CONTRIBUTING-AGYN.md)

- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Agyn architecture conventions](https://github.com/agynio/architecture)
- [Agyn daemon development](https://github.com/agynio/agynd-cli)
- [Current lab acceptance](ACCEPTANCE.md)
