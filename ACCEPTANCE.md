# Acceptance Report

Evidence below spans the preserved `kind-aira-a2a-lab` baseline and the new self-hosted Agyn backend. Each section identifies its environment; fake-agent tests and live-model evidence are deliberately separated.

## Durable Service Foundation (2026-09-13)

The new `src/service/main.ts` entry point is a development service, not a completed
production migration. The existing Agyn deployment and legacy controller remain
unchanged. `npm test` builds first and passes all 35 tests, including the original
10 tests. Dependencies are pinned to A2A SDK `1.1.0` and MCP SDK `1.30.0`.

| Check | Status | Evidence |
| --- | --- | --- |
| Transactional task storage | PASS, LOCAL | Scoped idempotency, conflicting retries, FIFO turns, immutable profiles, leases and restart durability; six separate Node processes contend without duplicate task/lease. |
| Authenticated A2A boundary | PASS, HTTP | Send/get/list/cancel/events ownership checks, tenant spoof rejection, history/pagination validation, credential rotation/revocation and Agent Card security serialization. |
| Subscription lifetime | PASS, HTTP/SSE | Disconnect releases admission without canceling work, reconnect sees durable state, revocation closes the stream, follow-ups retain the original profile after the configured default changes. |
| Reporting MCP | PASS, MCP HTTP | Official MCP client/server calls, execution-only credentials, ACK after store commit, exact retries, conflict/late report rejection and scoped token rotation. |
| Stop check | PASS, SUBPROCESS | Real hook subprocess calls HTTP checker; at most two reminders even with the same native turn ID; missing credentials/outage return stop, not success. Durable checks survive store reopen. |
| Worker recovery | PASS, SIMULATED PROVIDER | Lost dispatch ACK never resends; outcome-before-crash recovers to release; release failures retry; queued follow-up waits for removal evidence; outcome committed during a failed observation wins. |
| Agyn driver | PASS, SIMULATED GATEWAY | Deterministic instance lookup, no create on unresolved recovery, reporting setup before send, pause/resume and explicit workload removal evidence. |
| Service process | PASS, SUBPROCESS | Entry point binds real HTTP, rejects anonymous requests and exits cleanly on SIGTERM. No live work was dispatched by this test. |
| Focused daemon patch | PASS, GO TESTS | Pushed `spk-ai/agynd-cli:fix/codex-home-persistence`, commit `c933329`; full ordinary tests and build pass, targeted Codex persistence race tests pass. The broader daemon race suite finds an unrelated unchanged shell-test cleanup race. |
| Live Agyn MCP/hook delivery | PENDING | Operator installer contract exists, but it has not been installed or verified in a real Agyn runtime. |
| Native session after pod replacement | PENDING | Daemon unit test replaces ephemeral HOME while retaining state. This is not a live native Codex session recovery test. |
| Interrupted Agyn daemon turn | PENDING | Controller simulations do not prove safe daemon inbox redelivery or side-effect retry after pod replacement. |
| Hardened deployment and second live agent | PENDING | Network/sandbox enforcement, hard cancellation, operational recovery and a second live agent still require acceptance. |

The local Agyn platform was rechecked as healthy with zero workload Pods and five
retained bound PVCs. No VM policy was weakened and no live agent/PVC was deleted
for these tests. See [PRODUCTION.md](PRODUCTION.md) for all remaining gates,
[SERVICE.md](SERVICE.md) for setup boundaries and
[CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md) for upstream review units.

## Agyn Backend 0.4.0

Run on 2026-09-11 against the self-hosted Agyn local platform (chart `0.72.1`) in its separate Lima/k3s VM. Agent `@a2a-codex` used Codex runtime `0.147.0`, model `gpt-5.5`, a 10 GiB per-instance volume mounted at `/workspace`, and existing ChatGPT subscription authentication stored by Agyn.

| Check | Status | Evidence |
| --- | --- | --- |
| Real Codex turn | PASS | A2A task `33819042-f4ac-4bea-9987-b9c853fd3da9` created `/workspace/a2a-state.txt` and returned `FIRST_TURN_OK`. |
| Same-task reuse | PASS | Three later messages reused thread `a574f55f-49d5-4cf0-af6b-247ffd312972`, instance `d6c593ca-ef80-4e34-acff-e0e59094ab46`, and its PVC; recovery returned `RECOVERY_OK`. |
| Adapter restart recovery | PASS | The adapter process and A2A client stream were restarted between turns. SQLite restored the same Agyn binding and the next turn read the persisted file. |
| Explicit task completion | PASS | `finish` returned `FINISHED_OK`, A2A state `COMPLETED`, and requested instance pause without deleting its PVC. |
| Parallel task isolation | PASS | Tasks `5f127172-5717-43c9-a81b-5a1010f025de` and `bd42c642-dcc6-4103-a4ff-6bf2bcadfcb3` ran concurrently as distinct Pods, threads, instances and 10 GiB PVCs; they returned isolated `ALPHA_DONE` and `BETA_DONE` results. |
| Resource release | PASS | After successful turns, workload Pod count reached zero while all three PVCs remained bound. Agyn Pod removal is asynchronous after the pause request. |
| First-turn cancellation binding | PASS | The task-to-instance binding is persisted immediately after Agyn thread creation, before the first prompt completes, so cancellation can locate the correct instance. |
| Hard cancellation | LIMITED | Agyn accepted the pause for task `25771781-6be9-442a-94ed-61ca8f64cd8a`, eventually removed its Pod, but the already-running `sleep 120` and response completed first. The adapter reports uncertain side effects and never automatically retries. |
| Approval round trip | BLOCKED | Current Agyn Codex daemon configuration forces noninteractive `approval_policy=never`; it exposes no permission request for the A2A coordinator to resolve. The legacy ACP backend retains the tested explicit approval path. |
| Interrupted-turn reconciliation | NOT IMPLEMENTED | Completed-turn restart is proven. An adapter crash during an active Agyn turn is not automatically reconciled and must remain an explicit operator recovery case. |

Deterministic tests cover the generic Agyn backend mapping, one instance per task, pause/resume, and reuse. Live verification also confirmed that no host Codex `auth.json` is mounted in Agyn workloads; credentials are injected through the operator-created Agyn subscription.

## Deterministic Tests

| Check | Status | Evidence |
| --- | --- | --- |
| Store migration and profile persistence | PASS | Legacy workspaces retain direct-Codex threads; ACP session/provider and execution/turn fields persist. |
| Duplicate submission | PASS | The original terminal task is returned for the same initial idempotency key. |
| Task runtime mapping | PASS | Two tasks in one context map to distinct Sandbox and PVC records. |
| Permission correlation and replay | PASS | Fake ACP request/response IDs correlate; `session/load` replay remains observable. |
| Cancellation | PASS | Fake ACP returns the protocol `cancelled` stop reason. |
| Unsupported capability | PASS | A required missing `loadSession` capability fails closed. |
| Interrupted side effect | PASS | Fake agent writes once then exits; the harness reports uncertainty, does not retry, and explicit recovery leaves one marker. |

These tests validate coordinator and ACP edge behavior only. They do not establish compatibility with a second real agent.

## Task-Scoped Lifecycle 0.3.0

| Check | Status | Evidence |
| --- | --- | --- |
| One runtime per task | PASS | Tasks `90899d44-ae7b-4920-a1fe-bf6def352491` and `a6b9cefe-2f1e-4fe1-ad10-a18ede65a15b` ran simultaneously in different Pods with different 2 GiB PVCs and ACP sessions. |
| Filesystem isolation | PASS | The two concurrent tasks exported distinct `isolation.txt` values, `task-a` and `task-b`, from their own PVCs. |
| Resource release | PASS | Both task Sandboxes transitioned to `Suspended`, both task Pods disappeared, and both PVCs remained bound after terminal completion. Only the controller Pod remained running. |
| Same-task message reuse | PASS | Task `d92e5012-58c6-4f1a-8687-6a7e1cb5e3b5` received an A2A `continue ... accept` message while `INPUT_REQUIRED`; it resolved the original permission on the same runtime/session, created `continuation.txt`, completed, and then suspended. |
| Terminal follow-up isolation | PASS | Follow-up task `172e4e60-21f8-4f7d-a998-5e6b18ded27c` retained its parent's context and `referenceTaskIds`, but received a new task ID, Sandbox, PVC, and ACP session as required for isolation. |
| Live idempotency | PASS | Reusing `lifecycle-task-a` returned task `90899d44-ae7b-4920-a1fe-bf6def352491`; Sandbox count did not change and the replacement prompt did not execute. |
| Cancellation and release | PASS | Task `d2e913ef-95dd-4cca-bee9-709d8dacaf8d` was canceled during a bounded 30-second command; ACP returned `stopReason: cancelled`, A2A remained `CANCELED`, and its Sandbox suspended. |
| Active capacity | PASS | Two task Pods were admitted concurrently. `AIRA_MAX_ACTIVE_SANDBOXES=2` bounds active CPU/memory while excess task requests wait for a slot. |

A2A terminal tasks remain immutable. Runtime reuse applies to additional messages on a nonterminal task, including `INPUT_REQUIRED`; a request after terminal completion creates a new task runtime.

## Earlier ACP Harness Baseline

| Required check | Status | Evidence |
| --- | --- | --- |
| A. Discovery and streaming | PASS | Agent Card loaded and A2A streamed ordered real message, progress, tool, session, and turn events. |
| B. Coding, artifacts, tests | PASS | Task `f229bff0-72bc-4074-8011-803393438325` created `sum.js` and `sum.test.js`; `node --test` passed 1/1 in `runner-acp-one`. |
| C. Independent workspaces | PASS | `acp-one` and `acp-two` have distinct ACP sessions, Sandboxes, and bound 2 GiB PVCs. |
| D. Follow-up session reuse | PASS | Task `39400042-c7fd-429a-aedd-766db6fe4ad3` loaded the existing `acp-two` session and completed. |
| E. Genuine approval | PASS | `codex-acp-review-v1` emitted a real permission request; coordinator `allow_once` produced exact `workspace-id.txt` output. |
| F. Completed-turn Pod replacement | PASS | `runner-acp-one` Pod UID changed from `4405d225-d62f-4769-bce5-4ddc23374276` to `4d4a9461-70a3-4f2e-aec3-6edd2b3c5813`; task `b6fb1208-b16f-4c3b-bb46-2f6d8742c265` resumed the same session/PVC. |
| G. Live duplicate | PASS | Resubmitting `acp-live-after-replace-2` returned task `b6fb1208-b16f-4c3b-bb46-2f6d8742c265`; persisted transcript stayed at 50 events and no second turn ran. |
| H. Live cancellation | PASS | Task `8f9d1ee2-1d16-41a8-a8df-8ef24201b718` canceled a bounded 30-second wait and ended A2A state `CANCELED` with ACP `stopReason: cancelled`. |
| I. Transcript durability/redaction | PASS | Controller-PVC transcripts survived controller/runner replacements; no token-shaped credential values were found. The literal field name `Authorization` may appear redacted. |
| Interrupted turn | PASS | Task `1bf0fd6f-dc32-4e49-ad28-aa8dc111da39` wrote one harmless marker, then lost its Pod. It failed with `uncertainSideEffects: true`, `automaticRetry: false`; no duplicate marker appeared. Explicit recovery task `c15e81d4-2f44-4e84-b30a-8714226e6388` resumed the session and completed with the marker still present once. |

ACP observable updates are stored with controller sequence/timestamp plus runner event ID, runner sequence, timestamp, source protocol, execution ID, normalized event, and redacted raw protocol fields where available. Exact duplicate update frames are suppressed within a turn without repeating task side effects. No access to hidden chain-of-thought is claimed.

## Portability And Editor

| Check | Status | Evidence |
| --- | --- | --- |
| Gemini native ACP profile | ADDED, BLOCKED LIVE | Installed Gemini CLI `0.46.0` rejected existing free-tier auth before ACP initialization with `UNSUPPORTED_CLIENT`; no billing or credential changes were made. |
| ACP editor bridge | NOT IMPLEMENTED | Core harness work was prioritized. Coordinator ownership, authenticated transport, and explicit takeover/return semantics remain required. |

## Preserved State And Limits

The original `runner-alpha`, `runner-beta`, `runner-acp-one`, and `runner-acp-two` Sandboxes are suspended, not deleted. Their PVCs and database mappings remain, migrated direct records stay pinned to `codex-direct-v1`, and the existing beta thread is preserved. New task-scoped Sandbox records and PVCs are also retained in suspended mode. The controller PVC is unchanged.

Resource policy remains: controller request `250m` CPU / `256Mi`, limit `2 CPU` / `1Gi`; runner request `500m` / `1Gi`, limit `2 CPU` / `3Gi`; maximum two running Sandboxes. Runner seccomp remains explicitly `Unconfined`; kind CNI network enforcement, VM isolation, untrusted repositories, and editor compatibility are not claimed.
