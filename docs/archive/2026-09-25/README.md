> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# AIRA A2A Lab

Trusted local proof of concept for isolated coding-agent tasks. The preferred backend now delegates execution lifecycle to self-hosted Agyn:

The [assistant-ui web workspace](WEB.md) adds browser chat with agent selection,
durable task history, streaming, artifacts and cancellation. Run `npm run start:web`
after the documented setup; the local URL is `http://127.0.0.1:8083/ui/`.

The [Kubernetes-hosted app](KUBERNETES.md) is now available at
`http://127.0.0.1:8084/ui/`, with its own durable task database. It uses the
installed Agyn backend; the rebased backend upgrade remains gated on workspace
adoption. This is still a trusted-local deployment.

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
trusted-local integration. The legacy adapter source is preserved; the installed
Agyn services now use the retained reviewed stack described below.

The current service now requires a separate [workload removal confirmation](AGYN-REMOVAL.md)
because Runners' billing timestamp can be set while a failed Pod remains.
Source/database fixes, coordinated local deployment, a model-free failed-Pod
test and all five Codex lifecycle regressions passed on that coordinated stack.
Those fixtures restored stock deployments afterward. The subsequent prepared
rollout is retained, with migrations through `0022`; restoring the old images is
no longer a supported rollback. Production hardening remains open.

[Live network checks](AGYN-NETWORK.md) found and locally repaired missing CNI
enforcement despite installed policies. Pod-network isolation has separate
evidence; the real runtime is not yet a hardened sandbox.
An independent [native runner transport fix](AGYN-RUNNER-TRANSPORT.md) now
restricts plaintext TCP to readiness when Ziti is enabled. Source, loopback RPC
and subprocess tests pass; live policy and deployment acceptance remain open.

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
now also passes [combined process acceptance](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance)
with real PostgreSQL, registry RPCs, controller processes and native Kubernetes
deletion. Admission/deletion races and SIGKILL at three lifecycle boundaries
pass for agent and sandbox owners. Agents metadata and authorization writes are
still stubs in that process fixture; full A2A lifecycle acceptance, production
garbage collection and coordinated production rollout remain open. The reviewed
combination is now installed in the local lab.
The [read-only upgrade audit](AGYN-CHECKED-VOLUMES.md#read-only-upgrade-audit)
now records the installed legacy-data and client state without granting rollout,
adoption or deletion authority. Explicit legacy reconciliation remains necessary.
Dependent [legacy-adoption guards](AGYN-CHECKED-VOLUMES.md#legacy-adoption-guards)
now reject unconfirmed predecessors and implicit legacy reopen, with registry
race, upgrade and combined native regression tests passing. Migration `0020`
is now installed with the reviewed stack; this does not authorize automatic
legacy-volume adoption or deletion.

[Backend-bound volume operations](AGYN-VOLUME-BACKEND.md) now retain namespace
identity across inventory, bindings and deletion confirmation. A distinct RPC
rejects old-runner fallback; real controller/registry/Kubernetes acceptance
preserves the original workspace on wrong-runner routing. Prepared starts now
pin their backend; authenticated backend identity, infrastructure fencing and
coordinated production rollout remain open.

The next [prepared-workload proposal](AGYN-PREPARED-WORKLOADS.md) adds gated Pod
creation and exact-identity activation with claim deletion protection. Native
race tests and real Kubernetes execution/resume and replacement-race tests pass.
[Registry persistence](AGYN-PREPARED-REGISTRY.md), [controller migration and combined
model-free execution/crash acceptance](AGYN-PREPARED-CONTROLLERS.md) also pass.
[Gateway wire checks, guarded rollout tooling and an offline restore/migration
rehearsal](AGYN-PREPARED-ROLLOUT.md) now support the retained local deployment.
Real Codex completed-turn continuation passes through the prepared APIs with
the same native session and exact PVC identity across two removed Pods.
The complete interrupted scenario now also passes: controller SIGKILL and Pod
loss preserve a single non-idempotent side effect, quarantine requires explicit
retirement, and the follow-up resumes the same native session without replay.
That investigation fixed a terminal-readiness race by waiting for published
running main-container inventory before the single ticket request. All five
Codex lifecycle scenarios now pass on the final corrected service and retained
stack. [Prepared-stack Claude acceptance](AGYN-PREPARED-CLAUDE.md) now passes
completed/interrupted recovery, cancellation and streaming; three parallel
attempts failed with native 401. A subsequent [native DNS reproduction and
fix](AGYN-NATIVE-DNS.md) prevents parallel resolver bypass and is installed on a
prepared-compatible orchestrator. All five scenarios now pass for both Claude
and Codex with the stock proxy, plus a separate Claude diagnostic parallel run.
Cleanup retains all 83 prior claims, with 97 total and zero task Pods/unconfirmed
removals. Sustained reliability and the production gates remain open.
[Scoped runner RBAC](AGYN-RUNNER-RBAC.md) passes 57 allow/deny probes. The latest
service build and all 449 tests pass, with no skipped tests.

A subsequent [prepared startup Secret fix](AGYN-PREPARED-SECRETS.md) creates
credentials with atomic Pod ownership and keeps interrupted setup unactivatable.
Its native race suite and isolated Kubernetes acceptance pass, including four
real runner SIGKILL checkpoints and delayed credential creation after Pod
removal. That dependent contribution is not installed and does not itself
implement unknown-prepare recovery or durable credential revocation.

The follow-up [lost preparation recovery](AGYN-PREPARED-RECOVERY.md) adds native
read-only observation and checked controller retirement of a verified gated,
unexecuted Pod after a lost prepare reply. Source, native Kubernetes and combined
PostgreSQL/process-crash checks pass without prepare/activate replay. NotFound
still retains admission; initially absent/late creates and credential revocation
remain open. These focused contributions are not installed, and the retained
prepared/DNS stack and existing workspaces remain unchanged.

The next [native resource-anchor capability](AGYN-RESOURCE-ANCHORS.md) passes
source and real Kubernetes tests for delayed Pod/PVC creation, owner replacement
and activation/revocation races. Workload and volume ownership have separate
lifetimes. Dependent [registry persistence](AGYN-ANCHOR-REGISTRY.md) now passes
source, real PostgreSQL contention and upgrade-preservation checks, including a
fixed cancellation/replacement-reservation race. The dependent
[controller integration](AGYN-ANCHOR-CONTROLLERS.md) now migrates both owner paths,
validates real assembler labels and preserves the actual inbox thread separately
from the registry's legacy instance alias. Source, PostgreSQL upgrade and final
combined native process/crash checks pass. The separate DNS-compatible lab branch
retains the installed resolver fix and passes its native compatibility subset.
Its full source race suite also passes after an independent test-only repair.
Initially absent resource reconciliation, checked anchored-volume retirement and
coordinated rollout remain unfinished; none of these anchor contributions is installed.

The subsequent [preparation-revocation implementation](AGYN-PREPARATION-REVOCATION.md)
adds durable native proof and separate registry cleanup confirmation for an
initially absent, unbound preparation. Native, database and combined process
acceptance pass, including late workspace discovery without execution replay.
It preserves original PVC ownership and does not change A2A routing or workflow
code. These contributions are not installed; coordinated rollout, credential
cleanup, authenticated fencing and production hardening remain open.

The [anchored registry backup](AGYN-ANCHORED-BACKUP.md) now restores and rehearses
the new ownership/recovery metadata offline, including pending histories and
database guard definitions. The actual installed database and all workspaces
remain unchanged. This is not an automatic workspace-adoption or rollout path.

The dependent [existing-workspace adoption](AGYN-VOLUME-ANCHOR-ADOPTION.md) now
passes native source and Kubernetes crash/owner-GC acceptance while retaining
the original PVC and its contents. It is not installed; registry admission and
adoption persistence, the coordinator and complete-stack restore remain open.

The [September 24 upstream sync](AGYN-UPSTREAM-SYNC.md) fast-forwards four fork
`main` branches and rebases the active contribution stacks on new branches,
preserving the original tested heads. It reconciles upstream workload flavors
with explicit resource bounds without changing A2A routing. The report records
verification and the unchanged installed-stack boundary.

The first [production target](PRODUCTION.md#first-deployment-target) is single-node
self-hosted Kubernetes with tested backup/restore.

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
