# Contributing This Work To Agyn

Keep contributions independently reviewable. An A2A implementation should not
require maintainers to adopt this entire lab or change a runtime image's role.

## Ready For Focused Review

`agynio/agynd-cli`: honor `CODEX_HOME` for Codex config, authentication placeholders
and native-session mappings, with unchanged legacy paths when unset.

- Fork: <https://github.com/spk-ai/agynd-cli>
- Branch: `fix/codex-home-persistence`
- Commit: `c933329`
- Compare: <https://github.com/agynio/agynd-cli/compare/main...spk-ai:agynd-cli:fix/codex-home-persistence>
- Local checkout: `/home/alex/work/agyn-contrib/agynd-cli`
- The branch is pushed; an upstream PR has not been opened.

Reproduce the upstream development checks:

```sh
buf generate buf.build/agynio/api --path agynio/api/gateway/v1 --include-imports
env -u CODEX_HOME go test ./...
go build ./...
env -u CODEX_HOME go test -race ./internal/daemon \
  -run 'Codex(State|Relocated|Mapping)|WriteCodex|CodexAuth|Placeholder' -count=1
```

These checks passed locally. Full `go test -race ./internal/daemon` additionally
found a race in the unchanged `shells.go` title refresher and `shells_test.go`
cleanup globals. That broader suite is not passing; do not describe it as such.
The persistence unit test simulates replacement of ephemeral HOME. A separate
live Agyn test now also verifies changed pod UIDs with the same native session
and PVC; see [the integration evidence](AGYN-REPORTING.md).

Suggested PR description: explain the hardcoded path problem, the backward
compatibility rule, per-instance storage requirement, and the tests above. Do not
bundle A2A protocol handling, transcript analytics, runtime-image upgrades or
shell test fixes into this PR.

### Required Init Scripts

A second independent daemon patch addresses a behavior discovered during live
integration: nonzero init exits are logged but otherwise ignored. It adds the
operator opt-in `AGYN_INIT_SCRIPTS_REQUIRED=true`, preserves the default behavior,
and treats context cancellation as a real setup failure in either mode.

- Branch: `feat/required-init-scripts`, commit `591543b`.
- Compare: <https://github.com/agynio/agynd-cli/compare/main...spk-ai:agynd-cli:feat/required-init-scripts>
- `env -u CODEX_HOME go test ./...` and focused
  `go test -race ./internal/daemon -run 'InitScript' -count=1` passed.
- The branch is pushed; no upstream PR has been submitted.

This patch contains no A2A, MCP or terminal-delivery logic. The local integration
branch combines the focused patches only to test the runnable system. The lab's
Node/init-image packaging is not part of the proposed daemon PRs.

### Durable Inbox Guard

A third independent patch adds a runtime-neutral, opt-in inbox journal. It
persists intent before the SDK turn and completion before the inbox ACK, so an
ambiguous prior attempt cannot silently rerun and an ACK retry does not repeat
the agent. An optional trusted control file allows one message and retires exact
older message IDs through instance-owned acknowledgement only.

- Branch: `feat/durable-inbox-guard`, commit `8b6056c`.
- Compare: <https://github.com/agynio/agynd-cli/compare/main...spk-ai:agynd-cli:feat/durable-inbox-guard>
- Ordinary Go tests and
  `go test -race ./internal/inboxjournal ./internal/daemon -run 'Journal|InboxControl' -count=1` pass.
- Tests cover process death after a side effect, competing process starts,
  lost ACKs, pending/corrupt state, exact message binding and explicit retirement.
- The branch and combined integration branch are pushed; no upstream PR has been submitted.

The daemon stores no prompt text and knows nothing about A2A tasks, reporting
tokens, HTTP controllers or workflow policy. The coordinator must audit recovery
and verify the previous workload stopped before installing a new control file.
This is a replay guard, not exactly-once execution or a root-agent security
boundary. The control-file contract is a review proposal, not an accepted Agyn
API; discuss it with maintainers before extending Gateway.

## Proposed Subsequent Contributions

| Review unit | Suggested home | Boundary |
| --- | --- | --- |
| Execution lifecycle and reporting contract | `agynio/architecture` | Start with [the draft proposal](docs/agyn-a2a-proposal.md), not a claim that it is accepted architecture. |
| Generic outcome check | `agynio/agynd-cli` | Runtime-neutral lifecycle policy; Codex/Claude translate hook mechanics only. The inbox journal is a separate focused branch above. No A2A state machine in an image. |
| Authenticated execution reports | API/Gateway or a focused service, subject to agreement | Derive instance and execution from authenticated context, not model arguments. ACK after durable commit. |
| A2A connector | A focused repository agreed with maintainers | Official A2A SDK, ownership and task mapping, typed provider interface. Agyn retains runner/PVC/network lifecycle. |
| Native session export | Separate proposal and PR | Export session artifacts without credentials; retention, access and deletion policy before analytics. |

No API, Gateway, runner or runtime-image fork is required just to review the
current daemon patch. Fork additional repositories only after agreeing on the
contract and identifying the smallest owning module.

## Reviewability Rules

- Preserve the existing acceptance tests; add failure tests beside each change.
- Pin dependencies and use upstream APIs, schemas and SDKs rather than custom
  protocol parsers. SDK 1.1.0 fixes the cross-entry-point error and list-serialization
  problems reproduced by the HTTP tests here.
- Separate completed-turn recovery from interrupted-turn recovery. Never claim
  exactly-once side effects from a restored transcript or an application lease.
- Describe explicitly what is live-tested, simulated, and still a release gate.
- Exclude databases, credentials, transcripts, kubeconfigs and generated code.
- See [LICENSING.md](LICENSING.md) for the new service's AGPL-3.0-only scope.

Local service verification is `npm ci && npm test`. The tests use temporary
databases, official MCP/A2A transports, independent worker processes and fake
provider fault injection. Live Agyn acceptance is not replaced by these tests.
