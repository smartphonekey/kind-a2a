# Durable Execution Service

This is the new development service, separate from the preserved 0.4.0 lab
adapter. Its authenticated HTTP API, worker, provider driver, reporting MCP and
durable store are wired together by `src/service/main.ts`. It is not yet a
production deployment. See [PRODUCTION.md](PRODUCTION.md) for release gates and
[CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md) for upstream review boundaries.

## Run Requirements

Use a supported Node release with `node:sqlite`, then `npm ci && npm test`.
Configure an existing Agyn gateway and agent classes with per-instance durable
volumes. The worker does not create Kubernetes objects itself.

The service requires `A2A_SERVICE_CONFIG_FILE`, an operator-owned JSON file:

```json
{
  "environmentProfile": "trusted-local",
  "dbPath": "/absolute/private/service/tasks.sqlite",
  "credentialsFile": "/absolute/private/service/credentials.json",
  "reportingSetupExecutable": "/absolute/operator/install-execution-reporting",
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
returns without waiting; blocking and streaming requests have bounded waits and
can reconnect. Follow-ups set `message.taskId` and reuse that task's stored
profile. The API never accepts a runtime executable, image or Agyn handle in a
request. Task IDs and contexts do not grant cross-owner access.

Streaming snapshots omit history unless requested and send artifacts as separate
bounded artifact-update frames. `GetTask` provides the stored history/artifacts.

## Reporting Setup Contract

Live installation is not yet provided. The entry point deliberately requires an
operator installer rather than silently dispatching work without reporting.
Before dispatch, it invokes `reportingSetupExecutable` directly, without a shell,
passing one JSON document on stdin:

```json
{
  "executionId": "execution-id",
  "instanceId": "agyn-instance-id",
  "threadId": "agyn-thread-id",
  "profileId": "codex-v1",
  "reporting": { "url": "https://execution-service.example/reporting", "token": "<scoped-token>" }
}
```

The installer must configure the exact runtime's MCP endpoint and stop check,
without putting the token into prompts, transcripts, command arguments or logs.
It must be idempotent, finish within 120 seconds, and return only:

```json
{"executionId":"execution-id","instanceId":"agyn-instance-id","reportingConfigured":true}
```

An installer acknowledgement is not acceptance evidence by itself. Verify real
MCP discovery, calls and hook execution in the target workload. Agyn-native
delivery using trusted workload identity is an open architecture question; a
generic installer subprocess is a local integration boundary, not a proposed
Agyn public API.

The remote stateless Streamable HTTP MCP endpoint is `/reporting/mcp`. Its bearer
credential is bound to exactly one execution and instance. It cannot call A2A
methods or report on other executions. Tools are `report_progress`,
`report_artifact`, `report_outcome` and `get_execution_status`.

The Codex hook executable is `node dist/reporting/stop-hook.js`. It reads native
Stop input from stdin and `REPORTING_CONFIG_FILE`, a `0600` JSON file containing
`url` and `token`. HTTPS is required unless `allowInsecureLocal: true` is explicitly
set for a trusted lab. Register it through a trusted runtime-managed hook layer;
an untrusted repository must not be able to replace this configuration. It
reminds at most twice, then requests a stop and controller reconciliation.

## Recovery And Operations

- `GET /tasks/:taskId/events?after=<sequence>&limit=100` provides owner-scoped
  durable replay, independent of a lost SSE connection.
- A credential with `canReconcile: true` may POST `resolution` (`continue` or
  `fail`) and a nonempty `reason` to
  `/tasks/:taskId/executions/:executionId/reconcile`. Only an already stopped,
  uncertain execution is eligible. Inspect side effects before deciding; this
  does not replay the old message or restore skipped queued messages.
- The same privileged owner can issue/rotate an execution reporting credential
  at `/tasks/:taskId/executions/:executionId/reporting-credential`. This is an
  administrative recovery interface, not an agent-facing tool.
- Cancellation waits for removal evidence. A pause ACK, FAILED status or a
  reported outcome does not authorize the next queued turn.
- Database leases recover after process loss. A dispatch with no ACK is
  quarantined rather than resent. Provisioning with an unknown instance remains
  unresolved until provider identity and removal can be established.
- SIGTERM stops admission, HTTP connections and local workers. It leaves durable
  leases for a replacement worker; it does not claim all remote work was stopped.
  Bounded graceful draining and an operational supervisor remain release gates.
- SQLite WAL must use a local/PVC filesystem with working locks, not a network
  shared filesystem. This is not multi-node HA. Backup/restore, schema migration,
  deletion/retention and disaster recovery remain unverified.

An agent daemon can retry or redeliver work independently of this service. Until
its interrupted-turn execution journal is tested, controller fencing must not be
described as exactly-once execution or safe automatic side-effect recovery.
