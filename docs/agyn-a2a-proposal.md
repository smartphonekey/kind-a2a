<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Draft: Durable A2A Execution On Agyn

Status: external contribution proposal, not accepted Agyn architecture. This
document keeps cross-repository ownership decisions and maintainer questions;
implementation contracts are maintained with their source and tests.

## Objective

Allow one agent class to process isolated A2A tasks concurrently. Retain a task's
workspace and native session while releasing compute between serialized turns.
An operator-selected runtime profile should not require a different controller
or workflow. Durable state retention and compute lifecycle are separate concerns.

## Ownership

- The A2A connector owns authenticated task identity, submission deduplication,
  scheduling, protocol state, durable replay and client subscriptions.
- Agyn owns instances/threads, placement, durable volumes, workload identities,
  native runtime configuration and network/sandbox enforcement.
- Reporting carries progress, artifacts and outcomes independently of chat.
  MCP is its transport, not a scheduler.
- Runtime adapters translate native CLI mechanics. Runtime images package
  binaries; they do not own workflow or A2A semantics.

Keeping these boundaries separate allows Codex and Claude to share a controller
without forcing CLI-specific configuration or session formats into A2A.

## Execution Contract

The prototype's source is the authority for implemented behavior, not this draft.
From the repository root, scan and batch-inspect the selected owners:

```sh
npm run code:map -- scan --area src/service
npm run code:map -- inspect src/service/task-store src/service/worker src/service/agyn-driver
```

Database fencing does not fence external side effects or provider calls already
in flight. Exactly-once effects cannot be inferred from a lease or restored
session; infrastructure fencing remains a cross-system release requirement.

## Stop Check

Inspect `src/reporting/stop-check` and `src/reporting/agent-config` for implemented
hook/reporting behavior. Hook prompting is not a security boundary against a
malicious agent or repository; protection of runtime-managed configuration is a
deployment requirement, not something a model reminder can supply.

## Recovery Matrix

Recovery cases and executable failure tests belong with `src/service/worker`,
`src/service/task-store` and `src/service/agyn-driver`. The operational decision
to resume after uncertain effects requires explicit reconciliation; use
[service recovery](../SERVICE.md#recovery-and-operations). A second matrix here
would compete with the implementation as it changes.

## Questions For Maintainers

1. Where should the connector and generic reporting API live, and which language
   and storage service should a native implementation use?
2. Can workload identity plus Gateway authorization deliver a scoped execution
   binding? The trusted-local TerminalGateway installer is not a proposed public
   Agyn API.
3. Can instance/thread creation and message submission accept caller-owned
   idempotency keys, including recovery from a lost acknowledgement?
4. Which lifecycle authority can attest physical workload removal, independently
   of metering? The local removal-confirmation extension is not an accepted
   upstream API. How should that authority handle partitions, forced deletion
   and provider create requests still in flight?
5. How should the daemon journal execution intent and prevent automatic replay
   after interruption? The inbox-guard prototype must not require weakening
   self-only inbox permissions or moving A2A policy into the runtime.
6. Which lifecycle hook interface can work across native CLIs while leaving
   workflow policy outside the daemon?

## Evidence And Remaining Work

[Verification and acceptance](../ACCEPTANCE.md) describes checks and evidence
requirements;
[deployment](../KUBERNETES.md) identifies the installed combination, and
[contribution status](../CONTRIBUTING-AGYN.md) tracks review units. A local result
or a maintainer accepting a patch does not close the
[production gates](../PRODUCTION.md). Hardened agent isolation, authenticated
infrastructure fencing, replacement-node recovery and sustained release
validation remain independent obligations.
