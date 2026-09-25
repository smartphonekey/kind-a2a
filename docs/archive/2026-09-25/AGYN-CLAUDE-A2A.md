<!-- SPDX-License-Identifier: AGPL-3.0-only -->
> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Claude A2A Credential And Acceptance

September 25, 2026 follow-up to the
[in-place workspace migration](AGYN-WORKSPACE-MIGRATION.md). Claude was deliberately
untested during that September 24 upgrade. Its existing subscription credential
has now been updated from Doppler, and real parallel execution and same-task
continuation pass on the installed stack. Interrupted-turn quarantine and
explicit recovery also work. The initial negative REST admission check exposed
an incorrect HTTP status; its failed receipt is retained below. A subsequent
[app-only fix](#rest-conflict-fix) corrects the transport mapping.

## Credential Source

The existing `CLAUDE_CODE_OAUTH_TOKEN` secret was found in the shared agent and
AIRA development configurations in Doppler. Both resolved to the same value.
The operator fetched only the named Claude secrets, selected the shared agent
copy, and updated the existing Agyn Anthropic subscription's secret. The
subscription ID, environment attachment and agent profile were preserved.

No new token was generated, no Doppler secret was changed, and the host Claude
login was not modified. The credential was transferred in memory and verified
against Agyn's resolved secret; it was not written to a local token file, source,
manifest, evidence log or Git. Private receipts retain identity and fingerprint
checks only. No refresh token was copied.

For a future replacement, Anthropic documents `claude setup-token` as the command
for generating a long-lived subscription token for automated Claude Code runs.
It needs browser authorization and prints the token after approval. Store that
result in the secret manager, not in chat or a repository. Local MCP servers are
supported with this authentication method.
[Official authentication documentation](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).

The expiry of the **existing Doppler token** was not independently established;
the tests below verify that it works now, not that it has a fresh one-year
lifetime. This is a one-time secret synchronization, not an automatic Doppler
rotation controller. A later Doppler rotation must also update the existing Agyn
secret before it takes effect for this agent.

## Runtime Path

The web app selects the existing `claude` profile, model `claude-sonnet-5`.
Observed task Pods run native Claude Code `2.1.225`. The credential update needed
no service, A2A controller, workflow, image or agent-profile changes. The later
REST error fix is a separate app image update.

The runtime has a placeholder `CLAUDE_CODE_OAUTH_TOKEN`; Agyn's native LLM proxy
injects the actual subscription credential into the provider request. The
acceptance observer verifies the placeholder in each test Pod. The real token
is not a Pod environment value or a workspace file.

Browser access still uses the separate owner-scoped A2A web token documented in
[KUBERNETES.md](KUBERNETES.md#access). Do not put the provider OAuth token into the
web app's Access token field.

## Acceptance

This table records the initial credential acceptance, before the error fix.

Tests use the deployed service's authenticated A2A REST binding at
`/web-api/agents/claude`, not the default Codex endpoint or a local standalone
Claude process. Each message intent is recorded before submission; an ambiguous
response is inspected without resending the accepted work.

| Check | Result |
| --- | --- |
| Provider authentication | Real Claude file writes and MCP calls succeed through Agyn |
| Parallel task isolation | Two tasks overlap in separate Pods, PVCs and native sessions |
| Reporting | Acknowledged progress, artifact and outcome events |
| Compute release | Both first-turn Pods removed before explicit follow-ups |
| Completed-turn continuation | Both follow-ups retain their original PVCs, file markers and native session/transcript identities |
| Interrupted-turn quarantine | One append observed before exact test Pod removal; resources released, recovery required, automatic retry disabled |
| Negative REST admission status | **Failed:** unreconciled follow-up returns 500 instead of 409; no execution is created |
| Explicit interrupted-turn recovery | Separate recovery check passes: old request retired, one new read-only turn, original PVC/session retained, exactly one append |
| Final compute release | Zero task Pods or task Services; three new task workspaces retained |
| Original state | All 117 pre-existing PVC/PV identities and 53 Deployments unchanged; original 13 executions, including four uncertain executions, untouched |
| Browser inspection | Recovered Claude conversation and Compute released state at 1440, 390 and 320 pixels; no overflow or page errors |

### REST Conflict Error

The interrupted-turn script stopped at its negative admission assertion: an
unreconciled follow-up returned HTTP **500**, not the expected **409**. A read-only
database check confirmed that it created no execution and the original request
remained quarantined. This is not an authentication failure or evidence of a
retry, but the original acceptance script remains failed.

The original `src/service/a2a.ts` mapped store conflicts to
`JsonRpcTransportError` (`-32010`) for both bindings. The SDK's `restStatusFor`
mapped that transport-specific error to 500, and the browser adapter sanitized
the message. A focused local reproduction confirmed the mapping. No application
code was changed in that credential update. Clients must not infer that a 500
is safe to retry.

The subsequent recovery check recorded an explicit operator reconciliation,
then submitted a **new read-only message**, not a retry of the interrupted
append. It retained the original PVC UID, native Claude session and transcript
path. The file still contained exactly one line, reporting was acknowledged,
and the replacement Pod was removed. The failed original receipt is preserved
alongside this separate successful recovery receipt.

Private evidence is under `.state/claude-setup-token-Zrcf5a/`; the directory name
records the initial CLI attempt, not the final credential source. Browser/SSH
handoff attempts were stopped without generating a token before switching to
Doppler. Do not publish private configuration or credential material.

Evidence receipts are `installed.json`, `acceptance-parallel.json`,
`acceptance-interrupted.json` (failed HTTP assertion),
`interrupted-recovery.json` and `final-check.json`. Browser screenshots are
`claude-ui-{1440,390,320}.png`. The final audit also preserves the original
namespaces, cluster roles/bindings, network policies and Docker containers,
and confirms zero unconfirmed workloads. The read-only final-audit command
was rerun after correcting its local PATH; no agent request was resent.

These checks do not rerun the entire historical Claude lifecycle matrix. Real
provider approvals, cancellation, blocking/streaming conformance, FIFO load,
node partitions and hostile-repository isolation are outside this follow-up.
The earlier migration backup predates these new Claude workspaces and the
credential update; it is not a current whole-stack restore point. The trusted
local security and replacement-node recovery gates remain unchanged.

## REST Conflict Fix

Source `d8952aabce2bf2d7f6efaa9998d49f658d6d541c` is deployed to the Kubernetes
app on September 25. The handler explicitly selects the error binding: REST
admission conflicts return **409 / ABORTED**, capacity limits return
**429 / RESOURCE_EXHAUSTED**, and JSON-RPC retains `-32010` / `-32029`.
The SDK still parses and serializes protocol messages. The browser boundary
fills generic REST status names that SDK 1.1 otherwise renders as `UNKNOWN`;
known semantic errors keep their SDK mapping, and internal failures remain
redacted. No admission, idempotency, retry, routing or reconciliation policy
changed. No SDK or Agyn fork was required for this fix.

Seven regression tests cover interrupted and terminal tasks, reused message IDs,
task/owner limits, semantic errors and redaction through both bindings, including
stream rejection before SSE headers. The five admission cases failed with 500
before the fix. The complete suite now has **528 passing tests and one opt-in
PostgreSQL test skipped**; all **12 browser tests** and **13 packaged-image
transport/browser-boundary tests** pass.

The app database was backed up with SQLite's online API and restored into an
offline copy with identical schema/table hashes and passing integrity/foreign-key
checks. No worker or provider credentials were used for the restore. The
rollout preserved the Deployment identity and changed only its main/init image
references. All 120 pre-existing PVC/PV identities and the complete app database
were unchanged immediately after replacement. The local port-forward was
stopped for approximately 16 seconds and then restarted; the separate host
service on port 8083 was not restarted or upgraded.

Live verification uses a **new Claude task**. After one observed append and
intentional Pod removal, all six REST routes (send/stream on default, Codex and
Claude profile URLs) reject follow-ups with 409; both JSON-RPC methods reject
with `-32010`. The existing task's Claude binding remains authoritative on every
route. None of these eight rejected requests creates an execution. The full
interruption test now passes: explicit reconciliation retires the old request,
one new read-only turn keeps the original PVC/native session/transcript, the
file contains exactly one append, and compute is released. There is no automatic
retry or replay of the interrupted action.

The final audit preserves all 120 original PVC/PV identities and every
pre-existing application-data row, including the four earlier quarantined
executions; SQLite sequence counters advance for the new records. Only the
new test task adds a workspace and two execution records; zero task Pods or
Services remain. All 53 Deployment identities, namespaces, cluster-wide RBAC,
network policies and original Docker containers are preserved; only the owned
app's two image references changed. Registry adoption remains at 107 completed
workspaces with one historical quarantine and zero unconfirmed workloads.

The recovered Claude conversation and Compute released state pass browser checks
at 1440, 390 and 320 pixels with no overflow or page errors. An earlier
quarantined task remains read-only in the UI. Both local web services are ready.

Private evidence: `.state/a2a-rest-errors-vcc4n8/`, including `before.json`,
`app-before.sqlite`, `app-restored.sqlite`, `image.json`, `rollout.json` and
`acceptance-interrupted.json`, `final-check.json` and
`rest-fixed-ui-{1440,390,320}.png`. The first rollout preflight stopped before any
deployment change because its in-memory inventory retained undefined optional
fields; after matching the JSON serialization used for saved snapshots, the
guard and rollout passed. The read-only final registry audit was rerun after
correcting its command wrapper to forward SQL on stdin; no provider request was
resent. The failed initial credential receipt remains in its
original directory and is not rewritten as a pass. This app-only backup is not
a new coordinated workspace/provider backup or replacement-node recovery proof.
