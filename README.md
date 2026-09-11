# AIRA A2A Lab

Trusted local proof of concept for isolated coding-agent tasks:

```text
A2A client -> session coordinator -> one Kubernetes Sandbox per A2A task
                                      |-- runner harness
                                      |-- ACP agent over stdio
                                      |-- task-owned PVC and ACP session
                                      +-- Pod suspended when the turn terminates
```

The controller owns A2A state, task scheduling, Sandbox lifecycle, approvals, transcripts, artifacts, and the operator-selected profile. The runner owns a protocol-neutral harness. New tasks use `codex-acp-review-v1`; migrated legacy workspaces retain `codex-direct-v1` and are not silently switched.

Pinned components include Kubernetes Agent Sandbox `v0.5.2`, A2A JS SDK `1.0.0`, ACP SDK `1.4.0`, Codex ACP `1.11.0`, Codex CLI `0.153.4`, and Gemini CLI `0.46.0`.

## Task Lifecycle

The server-generated A2A `taskId` is the isolation and persistence key. Every new task receives a distinct Sandbox, Pod, PVC, agent process, and ACP session. Tasks can execute concurrently up to `AIRA_MAX_ACTIVE_SANDBOXES`; additional tasks wait for capacity rather than sharing a container.

After completion, failure, or cancellation, the controller sets that Sandbox to `Suspended` and waits for its Pod to disappear. This releases CPU and memory while retaining the Sandbox resource, PVC, files, transcript, profile, and ACP session metadata.

A message continuing the same nonterminal or `INPUT_REQUIRED` task uses the same `taskId`, resumes the same Sandbox/PVC, and loads the same ACP session. A2A terminal tasks are immutable: a follow-up after `COMPLETED`, `FAILED`, `CANCELED`, or `REJECTED` must create a new task. The client `followup` command keeps the A2A context and sets `referenceTaskIds`, but still receives a new isolated runtime.

The deprecated caller-provided `metadata.workspaceId` no longer controls placement. Untrusted requests cannot select a Sandbox name, executable, profile, or secret.

## Run

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

`./scripts/cleanup.sh` suspends all lab workloads while preserving PVCs. `./scripts/cleanup.sh --delete-data` deletes this lab cluster and local-path data; it is never run automatically.

## Protocol References

- [A2A task and continuation semantics](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [Maintained Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Gemini CLI ACP mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)
