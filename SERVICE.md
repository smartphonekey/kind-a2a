# Durable Execution Service

This is the new development service, separate from the preserved 0.4.0 lab
adapter. Its authenticated HTTP API, worker, provider driver, reporting MCP and
durable store are wired together by `src/service/main.ts`. It is not yet a
production deployment. See [PRODUCTION.md](PRODUCTION.md) for release gates and
[CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md) for upstream review boundaries.

## Run Requirements

Select the pinned Node runtime with `nvm use` (`nvm install` if necessary), then
run `npm ci && npm test`. `.nvmrc` pins Node 24.21.0; its bundled SQLite was
verified locally as 3.53.4. The service and admission CLI reject missing,
unrecognized or unpatched SQLite versions before opening the task database.
SQLite documents a rare multi-connection
[WAL-reset corruption bug](https://www.sqlite.org/wal.html#walreset), fixed in
3.51.3 and later, with backports to 3.50.7 and 3.44.6. The guard accepts those
backport branches too. The previously used Node 22.20.0 bundles 3.50.4 and is no
longer suitable for these service entry points. This pin does not change the
machine's default Node, agent runtime images or existing database contents.

Configure an existing Agyn gateway and agent classes with per-instance durable
volumes. The worker does not create Kubernetes objects itself.

The current driver requires the additive `removalConfirmedAt` contract in
Runners, Gateway and the orchestrator. Stock Agyn and the earlier local
integration images are incompatible: `removedAt` ends metering and can be set
while a failed Pod still exists. Source, real database, Gateway wire and a
coordinated local failed-Pod test pass, as do all five native Codex lifecycle
regressions on the coordinated stack. The stock deployments were restored;
the database migration alone does not make them compatible. All five Claude
lifecycle scenarios have passing fixtures across separate runs, but earlier
native authentication failures and production deployment remain unresolved. See
[the incident and rollout requirements](AGYN-REMOVAL.md). Do not start new tasks
on the old stack expecting them to settle with this driver.

The separate [volume retention/inventory fixes](AGYN-VOLUME-SAFETY.md) now pass
source and native Kubernetes checks, including the combined patch stack. They
are not deployed to the stock services. The proposed
[checked-volume API/registry/runner implementation](AGYN-CHECKED-VOLUMES.md) now
passes source and native acceptance, but orchestrator/sandbox callers are not
migrated and no deployment changed. End-to-end deletion, authoritative garbage
collection and infrastructure fencing still need work; retained disks
must not be treated as disposable just because one registry scan omits them.

The service requires `A2A_SERVICE_CONFIG_FILE`, an operator-owned JSON file:

```json
{
  "environmentProfile": "trusted-local",
  "dbPath": "/absolute/private/service/tasks.sqlite",
  "credentialsFile": "/absolute/private/service/credentials.json",
  "reportingSetupExecutable": "/absolute/checkout/dist/service/agyn-reporting-installer.js",
  "host": "127.0.0.1",
  "port": 8083,
  "publicUrl": "http://127.0.0.1:8083",
  "reportingUrl": "https://execution-service.example/reporting",
  "defaultProfile": "codex-v1",
  "profiles": [{ "id": "codex-v1", "agentId": "00000000-0000-0000-0000-000000000001" }],
  "concurrency": 2,
  "turnTimeoutMs": 600000
}
```

Replace the example agent ID with an actual Agyn class ID. Profile IDs are
immutable versioned operator configuration: add an ID to change an existing
profile, rather than repointing a task's old ID at a different agent.
Do not point `dbPath` at the old lab database. Legacy tasks are not automatically
assigned an owner or imported; that requires an explicit migration.

Set `AGYN_GATEWAY_URL`, `AGYN_TOKEN`, `AGYN_ORGANIZATION_ID` and `AGYN_IDENTITY_ID`
through the operator environment, as for the existing Agyn adapter. A local CA
may be supplied with `NODE_EXTRA_CA_CERTS`. Then run `npm run start:service`.

Only the explicit `trusted-local` environment profile is accepted in this
development entry point. It does not modify seccomp or weaken a cluster's policy.
Network enforcement and a validated hardened deployment remain release work.

## Shared Execution Admission

`concurrency` is a durable execution-count ceiling for **all** workers sharing
one service database, across owners and agent profiles. Worker construction
initializes the stored limit on first use, even without queued tasks. Every
subsequent worker must match it; a mismatch fails before the service listens or
calls the provider. Claims recheck it inside the existing SQLite write
transaction. A database trigger also prevents the previous claim SQL path from
exceeding an initialized ceiling; it does not make mixed-version operation a
supported upgrade procedure.

A claimed execution reserves one slot from provisioning through confirmed
release. An outcome, cancellation request, expired lease or lost worker does
not free the slot. Recovery takes over the same reservation. Only settlement
after confirmed removal frees it; a stopped but uncertain task then remains
blocked for its own follow-ups until explicit reconciliation. Idle durable
workspaces and queued turns do not consume execution slots. This is not a
count of physical containers: one task can have supporting containers, and
unexpected/late provider workloads still require infrastructure reconciliation.

The additive schema keeps existing tasks, events and runtime bindings. On
initial adoption, old reservations may already exceed the configured ceiling.
They remain counted and recoverable; no new execution is admitted until enough
reservations settle. Do not delete/recreate the database to reset the limit.

To change the limit:

1. Stop upstream submissions. Let accepted work settle, or cancel it and wait
   for confirmed removal under the existing worker configuration. Inspect any
   ambiguous provider state. SIGTERM alone does not drain remote workloads.
2. Stop all service workers. Inspect the existing database using the patched
   Node runtime:

   ```sh
   node dist/service/admission-cli.js --db /absolute/private/service/tasks.sqlite
   ```

3. With `reserved: 0`, atomically compare the old limit and set the new one:

   ```sh
   node dist/service/admission-cli.js --db /absolute/private/service/tasks.sqlite --expect 2 --max-active 4
   ```

4. Set `concurrency: 4` in every worker's configuration and restart them. Retain
   the command result with the deployment audit. A stale expected limit or any
   unreleased reservation causes a nonzero exit without changing the limit.

The CLI uses an existing absolute regular file, refuses symlinks/missing paths,
and checks for the service's task tables read-only before schema initialization.
It has no force option, provider credentials or agent-facing endpoint. A valid
service database receives the same additive schema initialization as the
service. Queued work and retained task state survive the change.

Verification includes six barrier-synchronized processes, conflicting limits,
operator-change races, all unreleased phases, expired-lease recovery, the legacy
SQL guard, and two workers retaining a slot while a fake provider delays
release. These are local process/storage tests, not a new live Agyn acceptance.
Different databases and directly created Agyn workloads are outside this budget.
The separate [native quota acceptance](AGYN-RESOURCES.md#native-namespace-quota-acceptance)
proves controlled runner/Kubernetes admission. The coordinated local
[A2A quota-recovery scenario](AGYN-RESOURCES.md#a2a-quota-recovery) now also verifies
retained inbox/workspace state and explicit reconciliation after a rejected
follow-up, without changing this scheduler. The independent
[runner startup-secret fix](AGYN-RESOURCES.md#native-first-provision-failures)
also passes native first-provision quota rejection and partial-PVC retention,
and now passes [combined first-provision A2A recovery](AGYN-RESOURCES.md#combined-a2a-acceptance)
with named-PVC ownership validation. Stock services are restored after acceptance;
production rollout, whole-task CPU/RAM accounting, storage/PID/IO limits,
fairness and sustained-load sizing remain separate work.

## Client Authentication

`credentialsFile` is a regular file with mode `0600` containing an array:

```json
[{
  "sha256": "<hex SHA-256 digest of a random base64url bearer token>",
  "tenant": "organization-id",
  "subject": "workflow-service",
  "expiresAt": "2026-12-01T00:00:00Z",
  "canReconcile": false
}]
```

Generate tokens from at least 32 cryptographically random bytes. Keep plaintext
tokens in a secret manager or private client file, not this repository. Replace
the credentials file atomically to rotate/revoke credentials. The authorizer
reloads it for every request and while a subscription is open. The service has
no unauthenticated fallback and never trusts caller-supplied tenant headers.

Use `Authorization: Bearer <token>`, `Content-Type: application/json` and
`A2A-Version: 1.0` with the official A2A JSON-RPC methods at `/a2a`. Discovery is
public at `/.well-known/agent-card.json`. Use TLS at a trusted ingress for any
non-loopback client or reporter traffic. Browser origins are rejected; there is
no browser authentication flow in this service.

`SendMessage` persists and queues an execution. `configuration.returnImmediately`
returns without waiting. Blocking sends wait for the submitted execution to
settle and the task to be terminal or interrupted; they no longer return a
partial success after 30 seconds. Follow-ups set `message.taskId` and reuse that task's stored
profile. The API never accepts a runtime executable, image or Agyn handle in a
request. Task IDs and contexts do not grant cross-owner access.

JSON-RPC streams follow the task across interrupted states and subsequent turns,
closing on terminal status, disconnect, authorization failure or service shutdown.
An open stream does not keep an agent container running. Subscribing to an already
terminal task returns `UnsupportedOperationError`; use `GetTask` to inspect it.
Disconnecting a blocking send or stream does not cancel an accepted execution.

Streams start with an atomic task snapshot. History is omitted unless requested
and may be further limited to fit the initial frame. Small snapshots include all
artifacts; larger ones deliver artifacts in separate bounded updates marked with
`metadata.snapshotSequence`. Subsequent durable status/artifact updates carry
their own increasing `metadata.eventSequence`. Snapshot replay is not a new event.
The initial task also exposes its atomic `metadata.snapshotSequence` cursor.
Idle streams send keepalive comments every 15 seconds. A reader that cannot drain
a write within 10 seconds is disconnected and releases its admission slot.
Event-source failures use sanitized SDK error envelopes, not task outcomes.
`GetTask` provides stored history/artifacts. See [protocol acceptance and remaining
work](A2A-PROTOCOL.md), including production ingress and load-test boundaries.

## Reporting Setup Contract

The Agyn installer is now implemented and live-tested with the gated local
environment in [AGYN-REPORTING.md](AGYN-REPORTING.md). The daemon must include the
required-init and inbox-guard patches and the environment must opt in. Stock Agyn logs failed init
scripts and continues, so an init script alone is NOT a startup safety gate.

Agyn only starts an agent pod after an inbox message arrives. The service records
dispatch intent, sends the message once, persists the returned request ID, then invokes `reportingSetupExecutable`
directly, without a shell, passing one JSON document on stdin. The trusted init
gate holds the daemon before the agent CLI starts until reporting is configured:

```json
{
  "executionId": "execution-id",
  "instanceId": "agyn-instance-id",
  "threadId": "agyn-thread-id",
  "profileId": "codex-v1",
  "requestId": "agyn-message-id",
  "retiredRequestIds": ["settled-predecessor-message-id"],
  "reporting": { "url": "https://execution-service.example/reporting", "token": "<scoped-token>" }
}
```

The installer configures the exact runtime's MCP relay and stop check,
without putting the token into prompts, transcripts, command arguments or logs.
It must finish within 120 seconds and return only:

```json
{"executionId":"execution-id","instanceId":"agyn-instance-id","workloadId":"agyn-workload-id","reportingConfigured":true}
```

It waits for the instance's one live workload, then uses Agyn's authenticated
TerminalGateway with an immutable argv command and a short-lived WebSocket
ticket. The receiver disables terminal echo and acknowledges the instance,
workload and pinned runtime digest before accepting any credential bytes. The
token is written to a private, ephemeral file, not the task PVC. The gate checks
the authenticated execution status and installs the managed MCP/Stop config
before releasing startup. The relay uses the official MCP SDK over stdio and
Streamable HTTP; no new A2A or MCP wire format is introduced.

The runtime's operator-provided `/agyn/config.json` selects the reporting config
adapter. Codex uses system TOML; Claude uses its settings and user MCP JSON
files. Unknown runtimes fail setup. Claude completed/interrupted recovery,
streaming, cancellation and parallel/FIFO fixtures now pass in separate reviewed
local runs with the focused daemon patches and an explicit subscription binding.
Earlier native authentication failures remain unexplained. See
[AGYN-PORTABILITY.md](AGYN-PORTABILITY.md).

The gate also installs a trusted inbox control file authorizing only the current
provider message. The daemon's durable journal records intent before the agent
runs and completion before its inbox ACK. Settled predecessor requests are
acknowledged without agent execution. Re-entry cannot replace a configured gate;
an ambiguous installer result is quarantined, not retried with a new binding.

The installer ACK requires exact execution/instance/workload identity plus a successful
remote exit. An ambiguous send/setup is quarantined, never automatically resent.
The worker pins that workload ID; a missing, stopped or replacement workload is
an interruption, even if Agyn still reports the instance as ACTIVE.
Live MCP calls, a native Stop reminder, pod removal and same-session continuation
passed, independently of the installer ACK. Native workload-identity delivery
remains an architecture question; this terminal-based installer is an explicit
trusted-local boundary, not a proposed Agyn public API.

The remote stateless Streamable HTTP MCP endpoint is `/reporting/mcp`. Its bearer
credential is bound to exactly one execution and instance. It cannot call A2A
methods or report on other executions. Tools are `report_progress`,
`report_artifact`, `report_outcome` and `get_execution_status`.

The standalone Codex hook executable is `node dist/reporting/stop-hook.js`. It reads native
Stop input from stdin and `REPORTING_CONFIG_FILE`, a `0600` JSON file containing
`url` and `token`. HTTPS is required unless `allowInsecureLocal: true` is explicitly
set for a trusted lab. Register it through a trusted runtime-managed hook layer;
an untrusted repository must not be able to replace this configuration. The lab's
root agent can still modify runtime files, so this is not yet a hardened boundary. It
reminds at most twice, then requests a stop and controller reconciliation.

## Recovery And Operations

- `GET /tasks/:taskId/events?after=<sequence>&limit=100` provides owner-scoped
  durable replay, independent of a lost SSE connection.
- A credential with `canReconcile: true` may POST `resolution` (`continue` or
  `fail`) and a nonempty `reason` to
  `/tasks/:taskId/executions/:executionId/reconcile`. Only an already stopped,
  uncertain execution is eligible. Inspect side effects before deciding; this
  does not replay the old message or restore skipped queued messages.
  A dispatch whose provider request ID was lost cannot continue; fail it and
  retain its paused environment for provider-side investigation. For a known
  request, the next workload receives an acknowledgement-only retirement entry.
  Retirement discards the old inbox item; it does not assert the side effects
  completed successfully. The decision, actor and reason remain in durable events.
- The same privileged owner can issue/rotate an execution reporting credential
  at `/tasks/:taskId/executions/:executionId/reporting-credential`. This is an
  administrative recovery interface, not an agent-facing tool.
- Cancellation waits for removal evidence. A pause ACK, FAILED status or a
  reported outcome does not authorize the next queued turn.
  This requires explicit `removalConfirmedAt` for every workload, including the
  pinned identity. Runners can set `removedAt` on failed/stopped status purely to
  end metering; it is never sufficient release evidence. See
  [the coordinated API/Runners/orchestrator changes](AGYN-REMOVAL.md).
  `STOP_INACTIVE_INSTANCES=true` is explicit operator policy for stopping busy
  paused instances; it is not the upstream default. The service cannot attest
  provider behavior from a timestamp or image name alone.
- Database leases recover after process loss. A dispatch with no ACK is
  quarantined rather than resent. Provisioning with an unknown instance remains
  unresolved until provider identity and removal can be established.
- SIGTERM stops admission, HTTP connections and local workers. It leaves durable
  leases for a replacement worker; it does not claim all remote work was stopped.
  Bounded graceful draining and an operational supervisor remain release gates.
- SQLite WAL must use a local/PVC filesystem with working locks, not a network
  shared filesystem. This is not multi-node HA. Backup/restore, schema migration,
  deletion/retention and disaster recovery remain unverified.
- Drain old workers before upgrading the service/daemon profile together. An
  existing running execution without a pinned workload ID is quarantined rather
  than adopted. Never roll back the daemon alone under an inbox-guard profile.
  Also drain/audit workloads created by older orchestrators before trusting their
  state; historical billing timestamps must not be backfilled as confirmation.
  Runner/node partitions, force-deleted pods and late
  in-flight creates need infrastructure fencing and explicit reconciliation;
  these are not solved by the local cancellation test.

An agent daemon can retry or redeliver work independently of this service. The
ephemeral startup gate prevents an unprepared replacement from starting Codex;
the opt-in durable journal prevents replay of a pending inbox attempt. Neither
controller fencing nor this journal makes external side effects exactly once.
The journal and control file must be protected from the agent in a hardened
deployment; the current trusted-local root agent does not provide that boundary.
