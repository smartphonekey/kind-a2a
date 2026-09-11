# Acceptance Report

Run on 2026-09-11, cluster `kind-aira-a2a-lab`, with ChatGPT subscription authentication.

| Test | Status | Evidence |
| --- | --- | --- |
| Adapter idempotency | PASS | `npm test` passed the deterministic SQLite duplicate-store test. |
| A2A discovery/streaming | PASS | Official A2A client fetched the Agent Card and received submitted, working, progress, and input-required events. |
| Real coding task | PASS | Codex resumed thread `01a08f3e-22a4-7c01-bb3e-4b7f70cd1ea3`, created `math.js` and `math.test.js`; `node --test` passed in `runner-beta`. |
| Approval round trip | PASS | A controller-mediated `item/commandExecution/requestApproval` was accepted and the requested write/test command executed. |
| Recovery after a completed turn | PASS | `runner-beta` Sandbox was deleted and recreated against its existing PVC; the same Codex thread was resumed for the next task. |
| Recovery during an interrupted turn | NOT YET TESTED | The controller persists a task before provisioning and reports failures rather than retrying side effects, but a pod-loss mid-turn test has not established a safe replay policy. Thread restoration alone is insufficient evidence of safe retry. |
| Isolation | PARTIAL | `runner-alpha` and `runner-beta` have distinct Sandbox names and bound PVCs. A dedicated automated cross-mount assertion remains to add. |
| Duplicate handling | PASS | Deterministic adapter test covers the extension; live duplicate call was not repeated to conserve subscription usage. |
| Cancellation | IMPLEMENTED, NOT LIVE-ASSERTED | A2A `cancelTask` calls runner `turn/interrupt`; live test deferred to avoid another subscription turn. |
| Transcript export | PASS | `/transcripts/<task-id>` captured ordered timestamps, IDs, Codex notifications, approval requests, errors, and rate/token metadata without hidden reasoning. |

Observed resource policy: controller request `250m` CPU/`256Mi`, limit `2 CPU`/`1Gi`; each runner request `500m`/`1Gi`, limit `2 CPU`/`3Gi`; at most two workspaces. The two active runner limits plus controller remain within the requested 6 CPU/12 GiB lab envelope.
