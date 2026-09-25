<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Acceptance Summary

This page summarizes the latest recorded verification of the installed
trusted-local Agyn/A2A stack. It is not a production certificate or a new test
run. Application source: `d8952aa`; backend: schema `0027` and the
[revisions in KUBERNETES.md](KUBERNETES.md#backend-revisions).
The remaining release criteria are in [PRODUCTION.md](PRODUCTION.md).

## Automated Checks

| Check | Recorded result | Scope |
| --- | --- | --- |
| Application suite | 528 pass; one opt-in PostgreSQL test skipped | Build and service regression tests, not a fresh full backend PostgreSQL run |
| Browser suite | 12 pass | Model-free service/assistant-ui integration |
| Packaged-image HTTP/browser boundary | 13 pass | REST/JSON-RPC admission mapping and redaction; no external network |
| Migration crash matrix | 16 scenarios pass | Real Kubernetes/PostgreSQL and three-process replacement; not node loss or database crash |
| Migration coordinator | 64 checkpoint/lost-reply cases | Both owner paths |
| Migration registry/controller | Full race suites pass; controller vet passes | Reviewed migration sources and selected API |

See the archived [application/Claude report](docs/archive/2026-09-25/AGYN-CLAUDE-A2A.md#rest-conflict-fix)
and [migration report](docs/archive/2026-09-25/AGYN-WORKSPACE-MIGRATION.md#verification)
for commands, source identities and the exact scope of each result.

## Installed-Stack Checks

| Behavior | Verified result |
| --- | --- |
| Task isolation | Codex and Claude checks run parallel tasks in separate Pods/PVCs/native sessions |
| Completed-turn continuation | Replacement Pods keep the task's original workspace, file markers and native session |
| Interrupted-turn recovery | Follow-ups are rejected until explicit reconciliation; a new read-only turn sees one observed append, without replay of the interrupted action |
| Reporting | Real MCP progress, artifact and outcome acknowledgements |
| Compute release | Confirmed removal before settlement; no task Pods/Services after the latest checks |
| Workspace migration | 107 active workspaces adopted in place; one unbound failed record remains quarantined |
| Preservation | Existing workspace identities and application rows, including older uncertain executions, remain intact |
| Browser | Recovered Claude history and read-only quarantine state at 1440, 390 and 320 pixels without overflow or page errors |
| Local backup/restore | Registry and workspace/session restore checks; app SQLite integrity, foreign-key, schema and content comparisons |

The Codex checks accompany the backend migration. Claude was tested separately
on that installed stack, not during the migration itself.

## Transport Errors

REST conflicts return `409 / ABORTED`; capacity rejection returns
`429 / RESOURCE_EXHAUSTED`. JSON-RPC retains `-32010` / `-32029`.
The live uncertain-task check rejects six REST send/stream routes and both
JSON-RPC methods without creating another execution. Reaching a different
profile URL does not change the existing task's immutable Claude binding.

The fix changes transport mapping, not admission or retry policy. The original
failed 500-versus-409 receipt remains in the archive; it is not counted as a pass.

## What These Results Do Not Prove

- A restored native session does not establish exactly-once execution or safe
  automatic retry. Completed-turn continuation and interrupted-turn reconciliation
  are different acceptance cases.
- Earlier reviewed stacks have cancellation, parallel/FIFO, streaming and native
  Stop-reminder evidence. The latest app/Claude check does not rerun that entire
  matrix or exercise real provider approvals.
- Local process replacement and controlled Pod deletion do not prove node
  fencing, partition recovery or rejection of every delayed infrastructure action.
- Resource/network fixtures do not certify hostile-repository or tenant isolation.
- Local backups are not a current encrypted off-node whole-stack restore point.
  A clean replacement-node drill is still required.
- Session analytics/export and remote editor takeover are not implemented.

## Reproduce Source Checks

```sh
nvm use
npm ci
npm --prefix web ci
npm test
npm exec --prefix web -- playwright install chromium
npm run test:web
node --test scripts/k8s-manifests.test.mjs
```

Live fixtures require explicit trusted-local gates, reviewed component revisions
and operator-controlled credentials. Their archive commands document particular
test environments; do not rerun them blindly against active workspaces.

Historical counts, failures, legacy ACP results and preservation receipts remain
in the [evidence archive](docs/archive/README.md). Private databases, credentials,
transcripts and screenshots are excluded from Git.
