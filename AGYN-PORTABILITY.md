# Agent Portability

Status: partial implementation, not a passed second-agent Agyn acceptance gate.
The A2A controller and workflows are unchanged. The existing live Agyn acceptance
still uses Codex; the checks below establish Claude reporting configuration and
native completed-turn session resumption separately.

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
  reminder/outcome sequence still needs live Agyn verification; see the
  [native Stop contract](https://code.claude.com/docs/en/hooks#stop-decision-control).

The existing required-init, inbox guard, workload identity and reporting-ACK
checks are unchanged. This adapter is not protection against a root agent
modifying its own runtime, or a repository overriding user-scoped configuration.

## Verified Evidence

On 2026-09-13:

- `npm test`: all 118 tests passed, including the 10 baseline tests. Added
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

1. Wire the reviewed SDK change into Agyn's daemon through a pinned dependency.
   Its current `claude-sdk-go v0.2.1` dependency has neither session option.
2. Add durable instance-to-Claude-session binding and explicit resume in the
   daemon. Select/persist identity before execution, reject conflicting or
   missing required state, and never substitute a new conversation after an
   uncertain turn. Keep inbox retirement/reconciliation separate.
3. Make the daemon honor `CLAUDE_CONFIG_DIR` for its state, settings and skills
   writes. It currently writes those under HOME even when the native CLI reads
   a relocated directory. Do not enable a profile based on this adapter alone.
4. Provision the private Claude environment and approved Agyn subscription
   reference. Host Claude Max authentication is available, but the local Agyn
   organization currently has only an OpenAI subscription reference. Do not
   switch to paid API inference or copy unrelated host configuration/history.
5. Run the same A2A task/stream, MCP progress/artifact/outcome, Stop reminder,
   parallel isolation, idle compute release, Pod replacement, cancellation and
   interrupted-turn recovery tests through Claude. Verify the same instance,
   task PVC and native session across follow-ups with changed Pod UIDs.

The acceptance criterion remains unchanged: select a different operator agent
profile without changing the A2A controller or workflow code. The broader
[production gates](PRODUCTION.md) remain open.
