> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Agent Portability

Status: completed-turn recovery, explicit interrupted-turn recovery, streaming,
cancellation and parallel/FIFO Claude fixtures pass across separate reviewed
local runs. The reliability/production gate remains open. The A2A
controller and workflows are unchanged. Claude has a
reporting adapter, focused daemon patches and an operator-selected live profile.
The evidence below separates successful lifecycle fixtures from unresolved
native authentication and earlier unclassified failures.

The pre-fix deployment evidence is the [prepared-stack Claude report](AGYN-PREPARED-CLAUDE.md):
completed continuation, explicit interrupted recovery, cancellation and streaming
pass, but three parallel attempts fail with native 401. The historical five
scenario passes below are not a passing five-scenario sweep on this newer stack.
Request diagnostics now distinguish proxied Messages calls from other traffic;
the failing instance has no recorded Messages call in the latest attempt.
That report did not prove a cause. Its temporary diagnostics/credentials were
cleaned up and its upgraded services retained. The subsequent
[native DNS reproduction and correction](AGYN-NATIVE-DNS.md) demonstrates an
actual CLI interception bypass, installs the focused resolver fix on the
prepared-compatible orchestrator, and passes all five scenarios for both Claude
and Codex with the stock proxy, plus a Claude diagnostic parallel run. All 83
prior claims remain intact; there are 97 retained task claims and zero task Pods
or unconfirmed removals. All 449 service tests pass.

An earlier interrupted-turn test failed before fault injection and
exposed an independent [workload-removal contract bug](AGYN-REMOVAL.md).
The historical successful profile below is no longer sufficient for the current
driver. Coordinated local rollout, model-free failed-Pod acceptance and all five
Codex lifecycle regressions now pass. Refreshed Claude completed-turn recovery
and a fresh interrupted-turn recovery also pass, as distinguished below from
the failed interruption sweep. The fresh lifecycle sweep below also passes
streaming, cancellation and parallel isolation. Native error investigation is
still required; those successes do not classify or repair earlier failures.
An isolated native HTTP 401 diagnostic now passes without provider credentials
or a model backend. It verifies the proposed diagnostic path, not the cause of
the historical failures or another Claude A2A lifecycle scenario.

## Reporting Adapter

`src/reporting/agent-config.ts` selects configuration from the `sdk` field in the
operator-selected runtime image's `/agyn/config.json`. An A2A request cannot
supply an executable or choose these paths. Unsupported or malformed runtime
manifests fail before setup acknowledgement.

- Codex retains its system TOML MCP/Stop configuration and required MCP setting.
- Claude receives its Stop hook in `settings.json` and the stdio reporting MCP
  at user scope in `.claude.json`. Both default HOME and `CLAUDE_CONFIG_DIR`
  layouts are supported by this adapter, matching the native CLI's
  [configuration locations](https://code.claude.com/docs/en/settings) and
  [MCP user scope](https://code.claude.com/docs/en/mcp#user-scope).
- Existing tools, tracing hooks, user state and permission policy are preserved.
  Rehydrating durable Claude configuration reuses only exact existing reporting
  entries; conflicting entries and duplicate/altered reporting hooks fail closed.
- Both Claude documents are parsed and validated before mutation. A write
  failure prevents the configured ACK; this is not a multi-file transaction.
  Configuration files remain private, and the execution token stays in the
  separate ephemeral binding file.
- The command hook response fields work for both CLIs. The existing
  `codexStopOutput` export is retained for compatibility. Claude's actual
  reminder/outcome sequence has now run through Agyn; see the
  [native Stop contract](https://code.claude.com/docs/en/hooks#stop-decision-control).

The existing required-init, inbox guard, workload identity and reporting-ACK
checks are unchanged. This adapter is not protection against a root agent
modifying its own runtime, or a repository overriding user-scoped configuration.

## Verified Evidence

On 2026-09-13:

- Initial `npm test`: all 118 tests passed, including the 10 baseline tests. Added
  manifest selection, configuration preservation/reuse/failure cases and real
  authenticated HTTP installation checks for Claude.
- Native Claude Code `2.1.270` discovered and connected to the reporting MCP
  with fresh isolated HOME, then with relocated `CLAUDE_CONFIG_DIR`. Each also
  reconnected after configuration reuse with one Stop hook. This probe supplied
  no credentials and made no model calls.
- Private configuration evidence:
  `.state/claude-reporting-config-tZ4zoq/evidence.json`.

Reproduce the credential-free native configuration probe:

```sh
npm run build
CLAUDE_REPORTING_CONFIG_ACCEPTANCE=true node dist/live/claude-reporting-config.js
```

The independent [Claude SDK session branch](https://github.com/spk-ai/claude-sdk-go/tree/feat/session-resumption),
commit `0cdc814`, adds explicit new-session and resume options without A2A or
Agyn daemon dependencies. Ordinary and full race tests pass. Its opt-in native
test also passed using the already-available Max subscription:

- Two text-only turns, tools disabled, private fresh configuration/workspace.
- Different native processes: PIDs `3982907` and `3982967`.
- Same native session: `17e23708-fbfd-4551-a0c7-a95032030cbd`.
- The second process recovered a random marker provided only in the first turn.
- Independent native transcript inspection found two user and two assistant
  messages, model `claude-sonnet-5`, and zero tool calls.
- The supplied token was absent from all seven retained fixture files. No
  host authentication files were changed or Agyn subscription bindings added.
- Private native evidence:
  `.state/claude-sdk-session-2635264719/evidence.json`.

This proves completed-turn native process recovery, not Pod replacement, a
second A2A task, approval handling, or interrupted-side-effect recovery. The
SDK branch keeps its upstream MIT license; the new service adapter is
AGPL-3.0-only. No upstream PR has been submitted.

## Native Failure Diagnostics

Two focused contributions preserve error metadata without logging message bodies:

- SDK `feat/result-diagnostics`, `16286f3`, based on upstream `bc88c1b`:
  expose result subtype, optional `api_error_status` and `terminal_reason` in
  `TurnResult`. These fields match the
  [official SDK result schema](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py).
  Full SDK race tests pass, including legacy/unknown values and malformed status
  rejection. This branch is independent of session selection and retains MIT.
- Daemon `fix/claude-error-diagnostics`, now `2afdfc1` after `b884d27`, stacked on
  `fix/claude-error-results`: allowlist diagnostic names and HTTP 400-599, keep
  the terminal error sentinel, and do not publish or ACK failed turns. Bodies,
  arbitrary stop reasons and native session identifiers are not logged. Ordinary
  Go tests and focused `ClaudeError|ClaudeDiagnostic` race tests pass. The broader
  daemon race-suite exclusion is unchanged. Both branches are pushed; no PR has
  been submitted. The daemon's temporary SDK fork pin needs an upstream release.

On 2026-09-13 at 23:09 UTC, `TestClaudeDiagnosticNative401` passed with actual
Agyn-packaged Claude Code `2.1.225`, running as UID 1000. A test-owned loopback
server consumed a bounded request body and returned HTTP 401 with
`x-should-retry: false`; tools and auto-update were disabled. The actual CLI/SDK
returned `result_subtype=success`, `terminal_reason=api_error`, `api_status=401`.
The daemon treated it as terminal and made zero Threads replies or inbox ACKs.
No model backend, provider credential or Agyn subscription was used. Threads
are a test double: this is not a full deployed task lifecycle test.

- Private evidence: `.state/agyn-claude-diagnostic-live-y3ivej/evidence.json`.
- Pod UID: `5d5115d2-6c2d-4e3e-8c1a-463c6d7dee57`; native test took 0.80 seconds.
- Test image: `docker.io/library/a2a-claude-diagnostics@sha256:ac0a80c019928ea48a36c004da0722c33fb4ebd144827793ae57d129d5cffd9c`.
- Test-binary SHA-256: `8a3f5ee789e0f1f4f1ef2c962955f2265e7dd3828e86167ab89bca62c4c9e9a7`;
  its source tree was subsequently committed as daemon `b884d27`.
- Runtime image: `registry.agyn.dev/agyn-platform/claude@sha256:c431db3091a76154ff6be7620f54204fffe30555f1f14adf182b9140c325deb4`.
- The bounded test Pod had RuntimeDefault seccomp, read-only root filesystems,
  no capabilities, no service-account token and only emptyDir mounts. The
  packaged-runtime init container explicitly ran as root to copy its files;
  the native test container was nonroot. No PVC or host directory was mounted.
- A run-specific deny-all ingress/egress policy was installed. The preceding
  credential-free network preflight passed all 92 checks in
  `.state/agyn-network-live-aJahHm/evidence.json`. This is local CNI evidence,
  not adversarial or fail-closed bootstrap acceptance.
- UID-precondition cleanup observed both Pod and policy absence. All 46 prior
  PVC UIDs/phases were unchanged. A separate post-run audit also verified the
  four stock deployment UIDs/images/generations, zero workload Pods/Services
  and only the original workload egress policy. No deployment was changed.

The operator script is `scripts/agyn-claude-diagnostics.mjs`; build its test
image with `ops/Dockerfile.claude-diagnostics` and a reviewed Linux/amd64
`go test -c` binary named `agynd-daemon.test`. It requires explicit
`AGYN_LIVE_ACCEPTANCE=trusted-local`, `AGYN_KUBECONFIG`,
`AGYN_CLAUDE_DIAGNOSTIC_IMAGE` and `AGYN_CLAUDE_DIAGNOSTIC_RUNTIME_IMAGE`.
Both images must be digest-pinned and the workload namespace must be idle.
The test image must already be registered by digest in the selected VM;
`agyn local load-image` importing only its tag did not satisfy `imagePullPolicy: Never`.
Run `node scripts/agyn-claude-diagnostics.mjs` after the network preflight.
Nine subprocess tests cover success, unsafe preconditions, native failure,
lost create acknowledgements and resource/PVC identity changes. Uncertain
creation/removal retains isolation and requires operator reconciliation.

Three earlier diagnostic attempts are failures, not passes: image registration
consumed the first Pod's deadline, and two earlier HTTP/initialization fixtures
timed out. Their private records are `agyn-claude-diagnostic-live-5qj2bn`,
`agyn-claude-diagnostic-live-La7esu` and `agyn-claude-diagnostic-live-GjN8br`
under `.state`. All owned Pods/policies were removed and PVCs retained.
The final controlled, explicitly non-retryable response does not establish
general provider retry behavior or explain either historical native error.

### Combined Runtime

The lab-only SDK branch `lab/session-diagnostics-integration` (`54490e0`) now
combines the two focused SDK patches. Daemon `lab/claude-diagnostics-integration`
(`7ed299f`, after merge `e103e3f`) pins that version and preserves the session,
required-init and durable inbox guards. These are acceptance branches, not
bundled upstream proposals. Both are pushed. Full SDK race tests, ordinary
daemon tests and focused session/Claude/journal/init race tests pass; broader
daemon race limitations are unchanged. Three combined fake-client cases verify
that API errors, nil results and wrong-session results leave the inbox pending,
with no reply/ACK or second SDK call after selecting the same retained session.

The combined native HTTP 401 probe also passes:
`.state/agyn-claude-diagnostic-live-nW8G5U/evidence.json`, Pod UID
`967078b2-d4a6-4b66-b744-cf490c984692`. Claude `2.1.225` reported the same safe
metadata and zero replies/ACKs; its test took 1.75 seconds. The same nonroot,
network-denied, model-free constraints apply. Cleanup removed its Pod/policy
and retained all 46 PVCs. A fresh CNI preflight passed 92 checks in
`.state/agyn-network-live-yjibD7/evidence.json`.

The first combined probe (`agyn-claude-diagnostic-live-Bkx6vY` under `.state`)
failed before native startup because the fixture explicitly set an empty
`CLAUDE_CONFIG_DIR`. The persistence adapter rejects empty configured paths.
Focused follow-up `2afdfc1` unsets that optional variable while preserving test
environment restoration; no production validation was weakened. The failed
probe was cleaned up without changing PVCs. This fixture error does not explain
the historical provider failures below.

The replacement init image is
`docker.io/library/a2a-agynd-reporting-init@sha256:97dee776b0866e3324da20d3ac511239928dd73971af45e6748b9f9b98f18b70`,
locally tagged `a2a-agynd-reporting-init:7ed299f`. Its Dockerfile now pins both
the Node and upstream init bases by digest; this does not harden the agent
profile. Build provenance, source/compiler versions and hashes are retained in
`.state/agyn-claude-integration-build-9ETYpY/build.json`. Independent inspection
of a live Agyn Pod verified the init digest and daemon binary hash; see
`runtime-binary.json` in that directory. The A2A controller/workflows were not
changed for the combination. Use this image instead of `beb1f23` for subsequent
coordinated acceptance; the older resource-only rollout is still insufficient.

Completed and interrupted Codex A2A regressions then passed on that exact image,
using the existing ChatGPT subscription reference and no new provider credential:

- Completed: `.state/agyn-reporting-live-LioGJ7/evidence.json`, task
  `da803c2e-bd2c-4c30-ae48-19f57af732b7`. Two Pods retained native session
  `01a09d2f-2112-7613-bdda-eaa303f668d2` and PVC
  `pv-a044956c-1ac-8831b288-183`. The real Stop reminder elicited an MCP outcome.
- Interrupted: `.state/agyn-reporting-live-FznliS/evidence.json`, task
  `890ab0ed-afe7-469d-b5b9-44f3f10eb6cf`. Controller loss and replacement required
  explicit reconciliation. Native session `01a09d30-7744-7681-b24e-4e93c4e0806c`
  and PVC `pv-f47d3cf0-57e-999ebd83-9ef` survived three Pods; the unconditional
  append stayed exactly one line, and the old journal entry became `ack_only`
  without another SDK turn for that request.
- All five Pods' container specs and main cgroups matched the selected bounds. All five
  workload confirmations were verified in PostgreSQL after stock restoration.
  The independent audit in `.state/agyn-lifecycle-deploy-JWbEw3/post-restore.json`
  verified original deployment UIDs, images, managed settings and readiness,
  zero workload Pods/Services, only the original policy and 48 retained PVCs,
  including all 46 prior UIDs/phases unchanged. `retention.json` also verifies
  both new instances paused with persistent workspace definitions and no TTL.

These are Codex regressions, not the outstanding Claude lifecycle sweep. Agyn
had no Claude subscription reference, and the host Max access token expired at
23:40 UTC on 2026-09-13; the expiry was checked without exporting its value.
A refreshed Claude subscription login was requested. No stale token was bound,
no paid API fallback was selected, and host credentials were not changed.
For unattended operation, credential provisioning/rotation needs an explicit
operator policy: [Claude documents a subscription setup token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token),
while [Agyn subscriptions reference managed secrets](https://github.com/agynio/architecture/blob/main/architecture/agyn-cli.md#subscription-commands).
The fixture refresh prerequisite is not proof of a production rotation policy.

On 2026-09-14 the operator refreshed the host login. A metadata-only check at
04:46 UTC confirmed `loggedIn=true`, `authMethod=claude.ai`, subscription type
`max`, and access-token expiry at `12:43:54Z`. No token value was printed or
written to evidence. Agyn still had no Claude subscription binding at this
checkpoint. The subsequent temporary bindings and actual execution results are
recorded below; successful login alone is not acceptance.

### Refreshed Subscription Acceptance

The first sweep after login, `.state/agyn-claude-lifecycle-XmgbFo/`, ran at
04:59-05:04 UTC on 2026-09-14 using the combined diagnostic/session daemon,
Claude runtime `2.1.225` and model `claude-sonnet-5`:

- Completed recovery passed in `.state/agyn-reporting-live-adJWdg/`, task
  `e06feafc-0032-497b-9fce-225b67c4a136`. Changed Pod UIDs retained native session
  `3f3e5d3a-60be-4556-bd1c-f12a8d569350` and PVC
  `pv-96b31f71-505-566d98ab-45d`. Native MCP reports, Stop reminder and confirmed
  compute release passed on both turns.
- Interrupted recovery did not pass in `.state/agyn-reporting-live-TB3ovb/`,
  task `e87146ba-89f9-4cba-9f20-3b18cd7316f1`. The append, gated replacement,
  quarantine and explicit reconciliation occurred, but the subsequent native
  follow-up failed without an outcome. Streaming/cancellation/parallel were
  not run because the sweep stopped at this failure.
- Read-only retained-PVC inspection found exactly one append, the original
  request `ack_only`, the follow-up `pending`, and unchanged native session
  `706e5a2c-023f-469f-abf2-009614bd9f15`. No native agent was started by inspection.
  Both message-filtered and workload-level tracing contained only invocation
  records, not a provider status. This failure remains unclassified, not an
  established HTTP 400/401 or proof of safe completed interrupted recovery.
- The four stock deployments and temporary named-Secret read grant were
  restored. All 51 previous claims and 16 older Secret identities were unchanged;
  53 claims remained and no workload Pods/Services/quotas remained. The owned
  subscription, credential and two attachments were deleted and absence checked.
  Host login contents were unchanged; none of 19 retained evidence files
  contained the temporary provider token.

A fresh interrupted-only test then passed with the same reviewed agent/runtime
stack and unchanged A2A controller/workflows. It did not retry or edit the failed
task. Evidence: `.state/agyn-claude-interrupted-Aduaph/` and
`.state/agyn-reporting-live-l0lxoq/`, task
`9dd8c389-7021-47b4-9d9b-afc56678bc81`. Three different Pod UIDs retained instance
`4f00abdf-08d1-486e-b1ab-b25ccd177fdd`, native session
`69b23941-6a57-4095-b81a-4acd5e932217` and PVC `pv-4f00abdf-08d-9764aa2a-a73`.
After explicit reconciliation the old request became `ack_only`, the append
remained exactly once, and the new turn reported its artifact/outcome and
released compute. All three workloads have explicit removal confirmations.
Stock services/RBAC were restored, all 53 previous claims survived and 54 were
retained. The temporary credential/subscription/attachment were removed;
16 evidence files were credential-free and the host login was unchanged.
This fresh pass does not explain or erase the earlier failure.

The remaining-scenarios sweep, `.state/agyn-claude-remaining-x0vAy5/`, stopped on
streaming follow-up failure. Task `33460d05-4dc0-4190-8649-b3eca72eafbc` in
`.state/agyn-reporting-live-QvVQlO/` completed its first turn, then resumed in
Pod UID `c8a5295d-062f-4cd7-812e-0ffe9b39a27f`. This time the observer captured
`claude_result_error`, `result_subtype=success`, `terminal_reason=api_error`,
`api_status=401`; the daemon exited with code 1 and left the execution
quarantined without a successful outcome. The misleading native `success`
subtype did not override `IsError`. No raw error body was stored. Cancellation
and parallel scenarios were not run. This is not a passing streaming test.

All 54 previous claims survived, 55 were retained, and stock deployments/RBAC
were restored with zero workload Pods/Services/quotas. The temporary managed
credential/subscription/attachment were deleted; all 16 fixture evidence files
were token-free and host login contents were unchanged. Its token was not due
to expire until 12:43:54 UTC, hours after the failure. Expiry metadata alone
does not prove a credential is accepted by the provider.

The inspected Agyn credential path gives Claude an environment placeholder;
the native LLM proxy resolves the attached subscription and replaces the
outbound Authorization header. Deployed proxy `0.14.0` corresponds to
`agynio/llm-proxy` tag `v0.14.0` (`dd1a3fb`); see its
[binding resolution](https://github.com/agynio/llm-proxy/blob/dd1a3fb757ac4f742bbffbb4ac3daec462943642/internal/native/server.go)
and [native forwarder](https://github.com/agynio/llm-proxy/blob/dd1a3fb757ac4f742bbffbb4ac3daec462943642/internal/proxy/native.go).
The newer upstream refusal-logging commit `212b0a8` changes the platform
handler, not this native path. The next investigation must
distinguish credential resolution/interception from upstream refusal. The
runtime's 401 alone does not prove either cause, and it does not classify the
older interruption failure retroactively. No proxy or native CLI patch/upgrade
was deployed as part of these tests.

A subsequent bounded, network-denied inspector mounted only the streaming
fixture PVC read-only. Its identity and contents were retained, its Pod/policy
were removed, and no native CLI or provider credential was supplied. Native
session `31dd0b7f-aba8-4cd0-a785-5f20166d6a02` still mapped to the same instance;
the first inbox request was `ack_only` and the failed follow-up remained
`pending`, with no new assistant/tool response after the follow-up. The native
transcript and absent debug log did not retain the HTTP error body. Consequently
the 401 is supported by live runtime diagnostics, not inferred from transcript
contents. Metadata-only evidence is `retained-inspection.json` in the sweep
directory. No failed task was replayed or its history repaired.

### Runtime Diagnostic Capture

Live reporting acceptance now starts a separate read-only diagnostic observer
before submitting tasks. It remains responsive during synchronous operator
probes and stops during cleanup. `runtime-diagnostics.json` retains validated
agent/instance/workload/Pod identities, bounded container states, exit codes and
allowlisted daemon/result error metadata. Raw logs, termination messages,
environment values and provider response bodies are never persisted. The
observer cannot control, delete or retry an execution. Pod log reads do not
support UID preconditions; known replacements are rejected, but this is not a
security boundary against privileged name replacement or forged agent logs.

Build and all 230 service tests (including subtests) pass, with nine new parser
and subprocess cases for redaction, foreign/ambiguous identities, replaced Pods,
failed inventory, vanished logs and bounded shutdown. The fresh interrupted
test captured all three Pods in 248 successful inventory polls. The original
fault-injection exit and gated replacement failure are expected test actions,
not diagnoses of the earlier unexplained native failure. Missing log reads are
counted rather than treated as proof of success. This is acceptance diagnostics,
not a production runtime-error storage/export implementation.

### Fresh Lifecycle Sweep

On 2026-09-14, 06:52:34-06:59:30 UTC, a fresh sweep passed streaming,
cancellation and parallel/FIFO acceptance. Evidence:
`.state/agyn-claude-proxy-HlTcIe/`, service source `9eed23d`. The agent profile
remained Claude Code `2.1.225` / `claude-sonnet-5`, with the reviewed daemon,
Runners, Gateway, orchestrator and bounded runner images from the preceding
failed sweep. Only the native proxy diagnostic image was added; A2A controller,
workflow and agent runtime code were unchanged.

- Streaming: task `20cf10fc-90c7-406a-aab5-cc89ed2e4bb9`, evidence
  `.state/agyn-reporting-live-Hj7r5o/`. The blocking duplicate waited 82.288s;
  both streams remained open for about 111.645s, including an idle interval
  with no task Pod. Replacement Pod UIDs retained instance
  `81e1fe08-1d5d-4ca8-a6d5-82a17aa6fd22`, native session
  `ae92f954-2c13-41bc-aecc-4309f5635f31`, the same PVC and unchanged marker.
  Real Stop/MCP outcome delivery and both confirmed removals passed.
- Cancellation: task `49fdb1f1-4811-4195-b965-68e3f310a351`, evidence
  `.state/agyn-reporting-live-Yv9Y5z/`. Settlement took 8.568s and followed
  observed Pod deletion. The retained workspace showed the deliberate SIGTERM
  trap, a stopped heartbeat and no late-write marker. A canceled task could
  not be resumed.
- Parallel: tasks `f622e09a-5015-4356-9fe7-6000696356bc` and
  `77a6ac09-e163-4857-a348-0d9459d9a38c`, evidence
  `.state/agyn-reporting-live-R2bkd0/parallel.json`. Two instances/PVCs/native
  sessions advanced concurrently. The earlier queued A follow-up ran only
  after A's old Pod was removed, retaining A's session/workspace while B kept
  advancing. Cross-Pod TCP/UDP and reporter-to-owner API checks passed. All
  three turns settled with confirmed removal and idle compute release.

Credential-free preflight `43fa73bc` passed 92 checks and removed its fixtures.
The three runtime observers all finished; parallel capture recorded one failed
inventory poll, so it is not evidence of uninterrupted observation. None
captured a native Claude error result. The exact running proxy binary SHA-256
matched the reviewed build, as recorded in
`.state/agyn-native-proxy-build-PW8Lu8/binary-audit.json`.
The bounded proxy snapshot in `.state/agyn-lifecycle-deploy-ZZPd1F/` captured
six HTTP 404 and two HTTP 304 responses, but no 401. These non-2xx responses did
not imply a failed agent turn; diagnostic logs are not task outcomes. A fresh
pass and a bounded snapshot without 401 do not explain the earlier failures.

Independent post-restoration PostgreSQL/Gateway checks verified six retained
removal confirmations, four paused instances and four active persistent/no-TTL
workspaces. All 56 prior PVC UIDs/specs/phases and 16 older Secret identities
were unchanged; 60 workspace PVCs remain. All five stock deployments were
restored with original UIDs/settings and observed readiness, temporary RBAC
was removed, and no task Pods/Services/quotas remained. The temporary
subscription, managed credential and three attachments were deleted with
absence checks. The host credential file was unchanged and 29 fixture/evidence
files passed the cleanup credential scan.

### Native Proxy Refusal Diagnostics

The focused LLM proxy branch `feat/native-refusal-diagnostics`, `8abd410`, adds
native-path diagnostics on top of the deployed `v0.14.0` source, without taking
the newer platform-path raw error-body logging. Non-2xx responses retain their
status, headers and body; no request retry is added. An 8 KiB bounded capture
produces only validated UUID bindings, status, credential/OAuth-beta presence
booleans and allowlisted error categories. Unknown, encoded, oversized and
interrupted bodies are not classified from a partial prefix. The provider's
reported reason is not an independently established credential failure cause.

The model-free Go race run passes 103 tests including subtests (78 top-level)
with `TestStreamToClientCannotRelayGzip` explicitly excluded. That existing test
also fails on untouched `v0.14.0` with Go 1.27.1: compressed data can contain its
searched plaintext substring. It is unchanged on the focused diagnostic branch.
The separate `fix/gzip-relay-test` branch, `c8f2c51`, checks exact encoded bytes
with default and stored-block compression; its full race suite passes 76 tests
including subtests. Combined `lab/native-refusal-integration`, `c59786d`, passes
the build and all 106 race tests (79 top-level), with no exclusions. Only that
test file differs from the deployed diagnostic source; no runtime behavior is
added by the combination. All branches are pushed; no upstream PR is open.
The service build and all 244 tests pass, including 11
new rollout cases and three safe-projection tests.

`AGYN_LIVE_LLM_PROXY_IMAGE` opts the trusted-local lifecycle wrapper into a
digest-pinned fifth deployment. Idle, deployment UID, optimistic patch and
restoration guards still apply. Before restoring the stock proxy, it reads a
bounded log snapshot from the exact observed Pod and stores only a validated
projection in `proxy-diagnostics.json`. Pod replacement, restart, image drift
or a failed capture fails acceptance without suppressing restoration of fields
still owned by the run. Raw log text is not stored. The snapshot is limited to
200 lines / 64 KiB; an empty result does not prove that no earlier refusal
occurred. This is operator acceptance evidence, not production error storage or
an authoritative agent outcome channel.

## Remaining Integration

All five Claude lifecycle scenarios now have passing local fixtures across
separate reviewed runs. These are not sustained reliability or production
rollout acceptance. Recovery keeps the same instance, task PVC and native
session across changed Pod UIDs.
Explain the captured 401 and earlier unclassified failures; a passing fresh
fixture alone does not establish reliable recovery or resolve those incidents.

The acceptance criterion remains unchanged: select a different operator agent
profile without changing the A2A controller or workflow code. The broader
[production gates](PRODUCTION.md) remain open.

## Daemon Contributions

- `feat/claude-session-persistence`, commit `f29925c`, based on upstream
  `495920a`. It pins the SDK fork at
  `v0.2.2-0.20260913182401-0cdc8146a9d6`; an upstream SDK release should replace
  that temporary dependency before merge.
- `fix/claude-error-results`, commit `1b1dd62`, independently based on the same
  upstream commit. An SDK result with `IsError=true` (or nil) must not publish a
  successful reply, acknowledge the inbox or enter automatic turn retry.
- Combined local branch `lab/claude-reporting-integration`, commit `beb1f23`,
  includes the existing required-init, inbox guard and Codex persistence patches.
  The focused branches do not depend on A2A or Kubernetes APIs. All are pushed;
  no upstream PR has been opened.
- Ordinary Go suites pass for each focused branch and the combination. Focused
  daemon/bridge race tests pass; 100 repeated concurrent session-allocation
  tests pass. This does not supersede the unrelated full daemon race-suite
  failure documented in the contribution guide.

Claude persistence is opt-in through `AGYN_CLAUDE_SESSION_DIR`. The daemon
reserves a UUID before starting the CLI, fsyncs the binding and takes an advisory
filesystem lock. It pins the agent, instance, native state location and actual
working directory. Replacement selects one verified native transcript by exact
path, never by a latest-session search. Missing/corrupt/ambiguous state fails
closed, including a reserved session with no native history. CLI shutdown
precedes lock release. This is not fencing against escaped processes or failed
nodes and does not establish safe replay of interrupted external side effects.

The daemon also relocates settings, user state and skills under
`CLAUDE_CONFIG_DIR`. The dedicated session-mapping leaf must not be precreated;
mount its parent workspace. Both private directories must be per instance.

## Operator Profile

`AGYN_LIVE_AGENT_PROFILE_FILE` selects a strict reference-only JSON document:

```json
{
  "version": 1,
  "sdk": "claude",
  "model": "claude-sonnet-5",
  "runtimeImageId": "cc5825ad-c598-435a-824a-96c7d4a2944f",
  "runtimeImageTag": "2.1.225",
  "subscriptionId": "00000000-0000-4000-8000-000000000001"
}
```

Use catalog and approved subscription IDs from the target Agyn installation;
the subscription ID above is an example, not a usable credential. The fixture
verifies the subscription vendor. Unset retains the Codex profile. Unknown keys,
credentials and executable/controller overrides are rejected. Neither the A2A
request nor workflow selects the native binary or credential.

Both profiles set `WORKSPACE_DIR=/workspace` explicitly. Claude also sets
`CLAUDE_CONFIG_DIR=/workspace/.claude` and
`AGYN_CLAUDE_SESSION_DIR=/workspace/.agyn/claude-session`. The main container's
native CLI and inspector use Agyn's packaged musl libraries; the reporting Node
wrapper keeps its own libraries separate. Native evidence exports identity
metadata, not message bodies. Parallel proof compares normalized provider
identities rather than nonexistent Codex fields in Claude records.

The recorded tests used the resource/network wrapper in [AGYN-RESOURCES.md](AGYN-RESOURCES.md)
with `AGYN_LIVE_INIT_IMAGE=a2a-agynd-reporting-init:beb1f23` and the profile-file
variable. That old stack must be upgraded before another acceptance run; see
[AGYN-REMOVAL.md](AGYN-REMOVAL.md). Claude runtime `2.1.225` was inspected at digest
`sha256:c431db3091a76154ff6be7620f54204fffe30555f1f14adf182b9140c325deb4`;
the combined init image is
`sha256:0b8a6acca261790c5d3b7ac56442d65a85df68727871796e1c53326bfb945969`.
The catalog's CLI-version tags differ from older GitHub release tags. See its
[packaging source](https://github.com/agynio/agyn-runtime-claude/blob/ca566e7/Dockerfile).

## Live Failure Evidence

1. `.state/agyn-reporting-live-tLlAPP/evidence.json`, task
   `c0d8e94e-750a-4e6d-8db1-424e1519d8a2`: first-turn progress, artifact, native
   Stop reminder, outcome and compute release passed. Replacement resumed
   native session `5d748463-7164-49ef-b055-63f97e05aa9b`, then received a native
   `401 Invalid bearer token`. The service quarantined it without redispatch.
   Read-only retained-PVC inspection found the old daemon had nevertheless
   marked the error result completed in its inbox journal; `1b1dd62` fixes
   that separate error-handling defect. The fixture also omitted
   `WORKSPACE_DIR`, leaving the daemon at its `/tmp` default; this is now
   explicit. Stock deployments were restored and no workloads were retained.
2. `.state/agyn-reporting-live-mZBry5/evidence.json`, task
   `594d8f0e-71bc-4e0f-b95c-76b966892dcc`: native `2.1.225`, session
   `fee1b84c-afdb-4e3b-8796-e32244800d11`, actual `/workspace` binding and main
   cgroups were observed. The follow-up authenticated but skipped its work
   because normal post-outcome release had inserted a cancellation notice in
   its persistent conversation. The artifact assertion failed; an outcome
   alone did not pass acceptance. The reporting policy now lets acknowledged,
   non-canceled turns finish their native Stop normally during release and
   names the execution in reminders/stop notices. Genuine cancellation and
   missing-outcome release still stop. Regression tests cover these distinctions.
3. `.state/agyn-reporting-live-Q1g9Uf/evidence.json`, task
   `24eca313-a0c3-4ce5-babc-c7247489848f`: the intended interrupted-turn test
   failed on a native error result before injection or the append side effect.
   The corrected daemon left the inbox journal pending and did not acknowledge
   success. The service quarantined the execution without automatic redispatch,
   but wrongly accepted billing `removedAt` while the failed Pod remained.
   Read-only native metadata showed no tool calls or synthetic error body, so
   the native failure is unclassified, not an established recurrence of the 401.
   A later UID-checked, read-only PVC inspection found only native transcript
   metadata and no surviving debug log; see the private
   `.state/agyn-reporting-live-Q1g9Uf/diagnostic-metadata.json`. It did not
   recover a failure status or establish a cause.
   The failed fixture Pod required UID-checked operator deletion; the PVC was
   retained and stock deployments restored. Temporary subscription credentials
   were removed. Source fixes and remaining rollout are in [AGYN-REMOVAL.md](AGYN-REMOVAL.md).

None of these failures is evidence of safe interrupted-turn recovery. The first
authentication failure remains unexplained: the stored subscription matched the
unexpired host token, and a fresh direct native two-process test with that token
passed (`.state/claude-sdk-session-2211818625/evidence.json`, session
`4e56f872-1ec1-4dbf-a93c-2273ac8f2844`, tools disabled). A subsequent successful
authentication does not explain the earlier failure.

The receiver also now waits up to 30 seconds for an absent init gate because
workload RUNNING can precede its creation. It requests no credential before gate
validation and raw terminal mode. Unsafe, malformed or mismatched gates still
fail immediately. Eleven deterministic cases cover this race; this does not
explain the older unrelated setup failure in the production report.

## Passed Completed-Turn Recovery

After the reporting correction, the same two-turn acceptance passed with
Claude Code `2.1.225` and `claude-sonnet-5`:

- Evidence: `.state/agyn-reporting-live-Wu4XrZ/evidence.json`.
- Task: `a5889aa9-1cd8-453e-8979-d72321b990b1`.
- Instance: `4ed9ec6f-244d-4564-9a99-04222adca83c`.
- Native session: `08c6222f-23bf-48c3-93d4-f29c3438092f`.
- PVC: `pv-4ed9ec6f-244-d4db1e86-a8c`.
- Pod UIDs: `1fa3d20f-f80a-4787-9c0b-35a4614db4d2`, then
  `80707af2-632e-4616-be70-0f0292497a99`.
- Real progress, artifact and outcome calls; the first native Stop reminder
  elicited the missing outcome. The follow-up published the existing file
  contents without rewriting it. Both turns settled INPUT_REQUIRED with
  resources released and the instance reusable.
- Both main cgroups enforced `cpu.max=200000 100000` and
  `memory.max=2147483648`. All seven container/init roles had the expected
  resource bounds. The same scoped network policies were checked on both Pods.
- The wrapper restored stock runner/orchestrator images and managed settings;
  fixture Pods and policies were removed while the task PVC was retained.
  Restoration record: `.state/agyn-lifecycle-deploy-5Af9Oy/before.json`.

At this completed-turn checkpoint the build and suite passed 122 top-level tests (133 including
the receiver's 11 subcases). This result proves completed-turn continuation, not
safe interrupted-side-effect recovery, streaming recovery or parallel Claude
isolation. The earlier 401 remains an open reliability issue, not a resolved
problem merely because this fresh fixture passed.

The same completed-turn test then passed again through Codex without changes to
the A2A controller/workflow: `.state/agyn-reporting-live-97DJ89/evidence.json`,
task `cd4bbe28-6ce1-4b1b-96e2-9a2422812961`, native session
`01a09c3d-5453-74d3-b757-d4e16e7fadcb`, and PVC
`pv-6444f154-8ed-31774766-979`. Pod UIDs changed from
`ee2db24f-05ef-4dfa-a925-547c1cb5f3e9` to
`331ced2f-82b5-48b3-a4f2-321938d2a3e7`. Stock deployments and policies were
restored after this regression check as well.

The temporary Claude Max subscription, its three fixture-environment
attachments and its encrypted local Agyn secret were deleted after acceptance;
absence of the subscription/secret was independently checked. Host Claude
credentials were not changed. The retained profile documents are evidence,
not live credentials; another run needs a fresh approved subscription reference.
The native OAuth token was absent from all 28 scanned local evidence files.
