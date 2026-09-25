<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Claude A2A Credential And Acceptance

September 25, 2026 follow-up to the
[in-place workspace migration](AGYN-WORKSPACE-MIGRATION.md). Claude was deliberately
untested during that September 24 upgrade. Its existing subscription credential
has now been updated from Doppler, and real parallel execution and same-task
continuation pass on the installed stack. Interrupted-turn quarantine and
explicit recovery also work, but the negative REST admission check exposed an
incorrect HTTP status, documented below. This is not a clean full acceptance pass.

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
Observed task Pods run native Claude Code `2.1.225`. No service, A2A controller,
workflow, image or agent-profile changes were needed.

The runtime has a placeholder `CLAUDE_CODE_OAUTH_TOKEN`; Agyn's native LLM proxy
injects the actual subscription credential into the provider request. The
acceptance observer verifies the placeholder in each test Pod. The real token
is not a Pod environment value or a workspace file.

Browser access still uses the separate owner-scoped A2A web token documented in
[KUBERNETES.md](KUBERNETES.md#access). Do not put the provider OAuth token into the
web app's Access token field.

## Acceptance

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

`src/service/a2a.ts` maps store conflicts to `JsonRpcTransportError` (`-32010`).
The SDK's `restStatusFor` maps that transport-specific error to 500, and the
browser adapter sanitizes the message. A focused local reproduction confirms
the mapping. Fixing the REST conflict/capacity mapping and adding cross-binding
tests remains follow-up work; no application code was changed in this credential
update. Clients must not infer that a 500 is safe to retry.

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
