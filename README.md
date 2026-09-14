# AIRA A2A Lab

Trusted local proof of concept for isolated coding-agent tasks. The preferred backend now delegates execution lifecycle to self-hosted Agyn:

```text
A2A client -> A2A adapter -> Agyn Gateway -> one agent instance per A2A task
                                           |-- Codex runtime
                                           |-- task-owned thread and PVC
                                           +-- Pod removed between turns
```

Agyn owns Kubernetes scheduling, workload lifecycle, persistent volumes, runtime networking and Codex execution. The local adapter owns A2A state and the durable one-to-one mapping from A2A task to Agyn thread/instance. Agyn does not expose A2A natively, which is why that adapter remains local code. See [AGYN.md](AGYN.md) for setup, commands, lifecycle semantics and current limitations.

The earlier custom kind/Agent Sandbox/ACP implementation remains intact as a comparison and rollback backend. Its controller owns A2A state, Sandbox lifecycle, approvals, transcripts and artifacts; its runner owns the protocol-neutral ACP harness. Existing workspaces retain their recorded profiles and are not silently migrated.

The live Agyn installation uses CLI `0.19.0`, platform chart `0.72.1`, Codex runtime `0.147.0` and model `gpt-5.5`. Repository dependencies use A2A JS SDK `1.1.0`, MCP SDK `1.30.0`, ACP SDK `1.4.0`, Codex ACP `1.11.0`, and the legacy Kubernetes Agent Sandbox `v0.5.2` integration.

The separate durable service now has [live-tested reporting and native-session
recovery](AGYN-REPORTING.md) using focused daemon and orchestrator patches. It remains a gated
trusted-local integration; the legacy adapter and original deployment are preserved.

The current service now requires a separate [workload removal confirmation](AGYN-REMOVAL.md)
because Runners' billing timestamp can be set while a failed Pod remains.
Source/database fixes, coordinated local deployment, a model-free failed-Pod
test and all five Codex lifecycle regressions pass. Stock deployments are
restored; the additive database migration remains. The older integration images
are not compatible, and production hardening/rollout remain open.

[Live network checks](AGYN-NETWORK.md) found and locally repaired missing CNI
enforcement despite installed policies. Pod-network isolation has separate
evidence; the real runtime is not yet a hardened sandbox.

[Real parallel-task acceptance](AGYN-PARALLEL.md) verifies separate workspaces and
native sessions on the same agent, queued follow-ups after pod removal, and
cross-pod TCP/UDP denial. The opt-in [bounded profile](AGYN-RESOURCES.md) now also
passes those scenarios with explicit per-container CPU/memory bounds; aggregate
task admission and [native quota recovery](AGYN-RESOURCES.md#a2a-quota-recovery)
now have separate acceptance. A focused [startup-secret fix](AGYN-RESOURCES.md#native-first-provision-failures)
also passes real first-provision quota tests and combined A2A recovery with
named-PVC ownership validation. Stock services were restored afterward.
Mandatory production profiles, sizing and sandbox hardening remain
required.

[Volume retention and inventory fixes](AGYN-VOLUME-SAFETY.md) now prevent
orphan deletion inferred from stale/scoped registry snapshots and reject incomplete
runner inventories. Independent and combined native checks pass, with all
existing task PVCs preserved. The next [checked-volume contract](AGYN-CHECKED-VOLUMES.md)
now passes API, registry and native runner acceptance, including real Kubernetes
stale-delete rejection. A dependent registry admission guard also passes real
PostgreSQL concurrency and migration tests, preventing follow-up admission from
racing checked deletion. The dependent [orchestrator/sandbox caller migration](AGYN-CHECKED-VOLUMES.md#controller-migration)
now passes ordinary tests and a selected race suite with real runner/Kubernetes
agent and sandbox cleanup. Its registry is a fake; combined end-to-end acceptance,
production garbage collection and coordinated rollout remain open. These fixes
are not permanently deployed.

The new [durable execution service](SERVICE.md) adds authenticated A2A routing,
transactional queued turns, reporting MCP, bounded outcome checks and a recoverable
worker. It is a development implementation with explicit [production gates](PRODUCTION.md),
not a replacement for the live acceptance evidence below. See the
[Agyn contribution guide](CONTRIBUTING-AGYN.md) for the focused daemon patch and
proposed upstream boundaries. New service code has scoped [AGPL-3.0 licensing](LICENSING.md).

## Agyn Quick Start

After provisioning `@a2a-codex` as described in [AGYN.md](AGYN.md):

```bash
npm ci
npm run build
npm run start:agyn
```

In another shell:

```bash
AIRA_URL=http://127.0.0.1:8082 npm run client -- submit "Create a function and tests" unique-key
AIRA_URL=http://127.0.0.1:8082 npm run client -- continue <task-id> "Continue this task" continuation-key
AIRA_URL=http://127.0.0.1:8082 npm run client -- finish <task-id> "Run tests and finish" finish-key
```

Successful nonterminal turns request workload release and return `INPUT_REQUIRED`, allowing a later message to resume the same Agyn instance and PVC. `finish` explicitly makes the A2A task terminal. New task IDs always receive separate instances and can run in parallel.

## Legacy Task Lifecycle

The server-generated A2A `taskId` is the isolation and persistence key. Every new task receives a distinct Sandbox, Pod, PVC, agent process, and ACP session. Tasks can execute concurrently up to `AIRA_MAX_ACTIVE_SANDBOXES`; additional tasks wait for capacity rather than sharing a container.

After completion, failure, or cancellation, the controller sets that Sandbox to `Suspended` and waits for its Pod to disappear. This releases CPU and memory while retaining the Sandbox resource, PVC, files, transcript, profile, and ACP session metadata.

A message continuing the same nonterminal or `INPUT_REQUIRED` task uses the same `taskId`, resumes the same Sandbox/PVC, and loads the same ACP session. A2A terminal tasks are immutable: a follow-up after `COMPLETED`, `FAILED`, `CANCELED`, or `REJECTED` must create a new task. The client `followup` command keeps the A2A context and sets `referenceTaskIds`, but still receives a new isolated runtime.

The deprecated caller-provided `metadata.workspaceId` no longer controls placement. Untrusted requests cannot select a Sandbox name, executable, profile, or secret.

## Legacy kind/ACP Run

`./scripts/deploy.sh` creates or updates only `kind-aira-a2a-lab`. It copies `$HOME/.codex/auth.json` into the namespaced `aira-codex-auth` Secret without printing or committing it. ChatGPT subscription authentication must already work with `codex login`; this does not switch to API-billed inference.

```bash
npm run build
./scripts/deploy.sh
./scripts/port-forward.sh
```

Create a new task and task-owned Sandbox:

```bash
npm run client -- submit "Create a small function and tests" task-unique-key
```

Continue the same task while it is nonterminal or `INPUT_REQUIRED`:

```bash
npm run client -- continue <task-id> "Here is the requested input" continuation-key
```

For an ACP permission represented as `INPUT_REQUIRED`, `continue <task-id> accept` or `continue <task-id> decline` resolves the pending request through the same task runtime.

Create an isolated follow-up task after the first task is terminal:

```bash
npm run client -- followup <completed-task-id> "Extend the implementation" followup-key
```

When an update reaches `INPUT_REQUIRED`, URL-encode its `requestId` and resolve it through the task coordinator:

```bash
curl -X POST -H 'content-type: application/json' --data '{"decision":"accept"}' \
  'http://127.0.0.1:8081/tasks/<task-id>/approvals/<url-encoded-request-id>'
```

`accept` selects ACP `allow_once` when offered; `decline` selects `reject_once`. An absent, invalid, timed-out, or disconnected response is canceled, never approved.

```bash
npm run client -- task <task-id>
npm run client -- cancel <task-id>
curl 'http://127.0.0.1:8081/tasks/<task-id>/runtime'
curl 'http://127.0.0.1:8081/transcripts/<task-id>'
npm run test:live -- <task-id> [<task-id> ...]
```

## Profiles

| Profile | Harness | Approval behavior | Status |
| --- | --- | --- | --- |
| `codex-agyn-v1` | Agyn-managed Codex runtime | Noninteractive; no approval bridge | Preferred execution backend; live tested |
| `codex-acp-review-v1` | ACP via `codex-acp` | Explicit coordinator approval | Default; live tested |
| `codex-acp-v1` | ACP via `codex-acp` | Adapter agent mode | Live tested |
| `codex-direct-v1` | Codex app-server fallback | Direct translation | Rollback and migrated workspaces |
| `gemini-acp-v1` | Native `gemini --acp` | Negotiated ACP permission requests | Added; live initialization blocked by current login |

The ACP client implements stable ACP v1 `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, session updates, and permission requests. It advertises no client filesystem or terminal capabilities. Agents operate inside their task Sandbox, which is the authoritative filesystem. MCP servers are an operator-controlled empty list; prompts cannot inject MCP commands.

ACP session IDs remain opaque. Provider resume metadata is stored separately. Codex ACP currently maps an ACP session to a Codex thread internally, but controller and workflow code do not depend on that detail.

## Persistence And Recovery

SQLite records A2A context/task, execution/turn, profile/harness, ACP session, provider resume metadata, Sandbox/PVC, and Pod UID identities. `/state/workspace` and agent state live on the task PVC; transcripts live on the controller PVC.

A repeated initial `metadata.idempotencyKey` returns the original persisted task without creating another runtime. Reusing a message ID on the same task does not start another turn. Idempotency keys are an AIRA extension; A2A message and task identifiers remain authoritative.

Pod replacement or task resumption loads the same PVC and ACP session. Mid-turn disconnects fail with `uncertainSideEffects: true` and `automaticRetry: false`; session restoration alone does not make retrying side effects safe.

An ACP prompt completion means the harness turn ended. AIRA marks an A2A task complete only after the terminal turn event and artifact export succeed; it does not independently prove project-specific acceptance criteria.

## Migration And Rollback

Database migrations are additive. Existing `thread_id` values are copied to `session_id`; prior workspace-scoped records and PVCs remain pinned to `codex-direct-v1`. They can be inspected or explicitly resumed, but new requests always use task-scoped runtimes.

Automatic in-place profile changes remain unsupported because session formats and auth bindings may differ. Roll back by deploying the earlier controller image; leave the additive SQLite columns and PVCs in place.

## Gemini And Editors

Gemini CLI has maintained native ACP mode. The installed login fails before `initialize` with `UNSUPPORTED_CLIENT` / ineligible Code Assist tier, so no second-agent compatibility claim is made. After an eligible login, create `aira-gemini-auth`, set `AIRA_DEFAULT_PROFILE=gemini-acp-v1`, deploy, and use a new task.

No editor bridge is implemented. A safe bridge still requires authenticated localhost transport and a task control lease with explicit takeover and return. Direct editor-to-runner attachment would bypass coordinator ownership and is unsupported.

## Security Boundaries

This is a trusted local execution lab, not an untrusted-repository service. Pods share the kind node kernel. Runners are non-root, non-privileged, drop capabilities, deny privilege escalation, and receive no service-account token, Docker socket, host mounts, Kubernetes credentials, host home, or another task's PVC. The controller alone has namespace-scoped Sandbox/PVC RBAC.

kindnet does not enforce NetworkPolicy here. Codex workspace-write currently requires bubblewrap behavior blocked by Docker's default seccomp, so runner `Unconfined` seccomp remains explicit. Do not use untrusted repositories or broader credentials until network enforcement and sandbox hardening are implemented.

The Agyn backend is also a trusted local lab. It uses a separate Lima/k3s VM and Agyn-managed workload networking, but its Codex daemon currently runs with noninteractive approvals. Agyn pause is cooperative for an already-running command, so cancellation records `uncertainSideEffects: true` and never retries automatically.

`./scripts/cleanup.sh` suspends all lab workloads while preserving PVCs. `./scripts/cleanup.sh --delete-data` deletes this lab cluster and local-path data; it is never run automatically.

## Protocol References

- [A2A task and continuation semantics](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [Maintained Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Gemini CLI ACP mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)
- [Agyn platform](https://github.com/agynio/platform)
- [Agyn architecture](https://docs.agyn.io/introduction/architecture)
- [Agyn Gateway API](https://docs.agyn.io/build-extend/gateway-api)
