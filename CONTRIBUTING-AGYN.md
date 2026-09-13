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
The persistence test simulates replacement of ephemeral HOME. Actual pod and
native-Codex-session continuation is a separate acceptance test, still pending.

Suggested PR description: explain the hardcoded path problem, the backward
compatibility rule, per-instance storage requirement, and the tests above. Do not
bundle A2A protocol handling, transcript analytics, runtime-image upgrades or
shell test fixes into this PR.

## Proposed Subsequent Contributions

| Review unit | Suggested home | Boundary |
| --- | --- | --- |
| Execution lifecycle and reporting contract | `agynio/architecture` | Start with [the draft proposal](docs/agyn-a2a-proposal.md), not a claim that it is accepted architecture. |
| Generic outcome check and persistent execution journal | `agynio/agynd-cli` | Runtime-neutral lifecycle policy; Codex/Claude translate hook mechanics only. No A2A state machine in an image. |
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
