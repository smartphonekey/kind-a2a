# Agent Portability

Status: completed-turn Claude A2A/Pod recovery passes; the full portability gate
remains open. The A2A controller and workflows are unchanged. Claude has a
reporting adapter, focused daemon patches and an operator-selected live profile.
The evidence below separates successful completed-turn recovery from earlier
failures and the still-required interrupted/concurrent lifecycle scenarios.

The latest attempted interrupted-turn test failed before fault injection and
exposed an independent [workload-removal contract bug](AGYN-REMOVAL.md).
The historical successful profile below is no longer sufficient for the current
driver. Coordinated Runners/Gateway/orchestrator rollout is pending.

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

## Remaining Integration

Run the remaining streaming, parallel isolation, cancellation and interrupted-turn
recovery tests through Claude. Completed turns now verify the same instance,
task PVC and native session across follow-ups with changed Pod UIDs. Explain
the authentication failure below and test failures as well as successful turns.

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
