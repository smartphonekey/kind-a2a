# Acceptance Report

Run on 2026-09-11 against `kind-aira-a2a-lab` with ChatGPT subscription authentication. Fake-agent tests and live-model evidence are deliberately separated.

## Deterministic Tests

| Check | Status | Evidence |
| --- | --- | --- |
| Store migration and profile persistence | PASS | Legacy workspaces retain direct-Codex threads; ACP session/provider and execution/turn fields persist. |
| Duplicate submission | PASS | The original terminal task is returned for the same workspace/idempotency key. |
| Permission correlation and replay | PASS | Fake ACP request/response IDs correlate; `session/load` replay remains observable. |
| Cancellation | PASS | Fake ACP returns the protocol `cancelled` stop reason. |
| Unsupported capability | PASS | A required missing `loadSession` capability fails closed. |
| Interrupted side effect | PASS | Fake agent writes once then exits; the harness reports uncertainty, does not retry, and explicit recovery leaves one marker. |

These tests validate coordinator and ACP edge behavior only. They do not establish compatibility with a second real agent.

## Live Codex Through ACP

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

The original `runner-alpha` and `runner-beta` Sandboxes are suspended, not deleted. Their PVCs and database mappings remain; migrated records are pinned to `codex-direct-v1`, and the existing beta thread is preserved. Active `runner-acp-one` and `runner-acp-two` each retain their own PVC and ACP session. The controller PVC is unchanged.

Resource policy remains: controller request `250m` CPU / `256Mi`, limit `2 CPU` / `1Gi`; runner request `500m` / `1Gi`, limit `2 CPU` / `3Gi`; maximum two running Sandboxes. Runner seccomp remains explicitly `Unconfined`; kind CNI network enforcement, VM isolation, untrusted repositories, and editor compatibility are not claimed.
