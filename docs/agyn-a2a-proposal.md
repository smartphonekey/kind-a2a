# Draft: Durable A2A Execution On Agyn

Status: external contribution proposal, not accepted Agyn architecture.

## Objective

Allow one agent class to process many isolated A2A tasks concurrently. Bind each
task to a dedicated agent instance, conversation and durable volume set. Serialize
turns within a task; release compute between turns; reuse durable state on a
follow-up. An operator-selected profile must be swappable without changing the
A2A controller or workflow.

## Ownership

- The A2A connector owns authenticated task identity, request idempotency, queued
  executions, protocol state, replay and client subscriptions.
- Agyn owns agent classes/instances, threads, workload placement, durable volumes,
  workload identities, runtime configuration and network/sandbox enforcement.
- The reporting contract owns progress, artifacts and outcomes independently of
  free-form chat. MCP is a transport for that contract, not a scheduler.
- A runtime adapter translates the CLI's turn/stop/cancel mechanics. An agent
  runtime image packages binaries; it does not own workflow or A2A semantics.

## Execution Contract

One task has one immutable profile and runtime binding, and many ordered
executions. A scoped idempotency key or message ID identifies a submission. Reusing
an identity with different content is a conflict. A task ID is not authorization.

The controller records dispatch intent before invoking the provider. Active
execution ownership uses a generation and renewable lease. Database fencing
prevents stale workers from changing records; it does not fence external side
effects, provider requests already in flight, or a daemon's own message retry.

Reports have a caller-chosen event ID, validated content and a durable sequence.
Exact retries return the original acknowledgement; conflicting, cross-instance,
late or canceled reports fail. Report identity is derived from a trusted
execution binding. The model is not asked to select a task, instance or thread.

Outcomes distinguish `turn_done`, `task_completed`, `input_required` and `failed`.
Progress is never completion. A reported outcome precedes stopping, but the A2A
task does not advertise released resources until workload removal is observed.
Cancellation prevents new turns and wins over a concurrently reported outcome.

## Stop Check

Before accepting an agent stop, check whether that execution has an acknowledged
outcome. Remind the agent at most twice to report its outcome or question. Store
attempts durably and give each hook invocation an ID so retries are idempotent.
Do not use only the native turn ID: some CLIs retain it across stop reminders.
On exhaustion, cancellation or unavailable verification, stop work and reconcile;
do not replay potentially completed actions. Hook prompting is not a security
boundary against a malicious agent or repository.

## Recovery Matrix

| Interruption | Required action |
| --- | --- |
| Queued, no provider call | Claim once and start normally. |
| Provision acknowledgement lost | Reconcile deterministic instance identity and thread. Do not create another instance. |
| Dispatch intent committed, acknowledgement lost | Stop/quarantine and reconcile side effects. Do not resend automatically. Reuse is refused without a known provider request ID. |
| Running, no outcome, daemon or pod replaced | A persisted thread alone is insufficient. Persist intent before invocation, quarantine, and require explicit retirement of the old request before a new instruction. |
| Outcome committed, response lost | Return the original receipt on retry; finish compute release without re-executing. |
| Pause accepted, workload still present | Retry/observe release. Do not dispatch the next queued turn. |
| Completed turn, new follow-up | Reuse instance, native session and volume; create new execution credentials. |

## Questions For Maintainers

1. Where should the connector and generic execution/reporting API live, and which
   implementation language and storage service should a native version use?
2. Can workload identity plus Gateway authorization deliver and verify a scoped
   execution binding for MCP and hook calls? The local prototype's installer
   contract is not a proposed public Agyn API.
3. Can instance/thread creation and message submission accept caller-owned
   idempotency keys? Current protobuf requests do not provide them.
4. Which runner observation is the authoritative proof of workload removal?
   Stock `removed_at` can mean only deletion acceptance or runner contact loss.
   The focused orchestrator patch now waits for inspection to confirm absence,
   keeping failed-but-unremoved workloads tracked. What capability/fencing
   contract should cover node partitions, forced deletion and in-flight creates?
   An opt-in immediate stop on pause is separate from removal confirmation.
5. How should the daemon persist message execution intent and prevent automatic
   replay after an interrupted turn, including pending inbox redelivery?
   The independent `feat/durable-inbox-guard` prototype journals before invocation
   and uses a trusted message allowlist plus acknowledgement-only retirement.
   This is a proposed daemon contract, not a request to weaken self-only inbox
   permissions or put A2A policy inside the runtime.
6. Which lifecycle hook interface should work across supported CLIs while keeping
   the A2A state machine outside `agynd-cli`?

## Evidence And Remaining Work

The accompanying implementation tests scoped submissions, SQL transactions,
cross-process claims, MCP wire calls, durable receipts, bounded stop reminders,
HTTP authorization/revocation, FIFO work and injected release/dispatch failures.
It is a trusted local prototype. Live credential delivery, native Stop reminders,
completed-turn recovery, and explicit interrupted-turn recovery now pass. The
fault test kills the controller and replaces a pod after a non-idempotent append;
the follow-up keeps the native session/PVC and does not repeat the append.
One live hard-cancellation test now observes Pod deletion before settlement and
verifies a stopped heartbeat on the retained PVC. This is a healthy local-runner
result, not partition fencing. Enforced network/sandbox isolation, operational
recovery and a second live agent remain gates. See the dated acceptance report
for separate live evidence and deterministic tests.

The focused `CODEX_HOME` daemon patch is independently useful: it lets native
sessions and Agyn's native-session mapping use the same per-instance durable
directory without changing legacy paths by default.

References: [Agyn architecture](https://github.com/agynio/architecture),
[A2A specification](https://a2a-protocol.org/latest/specification/),
[Agyn daemon](https://github.com/agynio/agynd-cli),
[readiness gates](../PRODUCTION.md).
