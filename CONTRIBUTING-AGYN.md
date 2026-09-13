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

## Orchestrator Lifecycle Fixes

Two independent, runtime-neutral changes are pushed in
<https://github.com/spk-ai/agents-orchestrator>, based on upstream `ae7d0bf`:

- `feat/stop-inactive-instances`, commit `7a6c8ec`: explicit operator policy
  `STOP_INACTIVE_INSTANCES=true` stops paused/terminated instances despite fresh
  daemon keepalives. Default behavior is unchanged; unavailable lifecycle reads
  do not authorize immediate stops.
- `fix/confirmed-workload-removal`, commits `230977d` and `e0f57d8`: do not set `removed_at`
  from a stop ACK, runner outage or failure alone. Confirm absence by inspection,
  retain failed-but-unremoved workloads and block their replacements. Hold
  persistent-volume TTL until every workload has confirmed removal.
- Local `lab/a2a-lifecycle-integration`, commit `cba941a`, combines these for
  acceptance only. No upstream PR has been opened.

Both independent branches pass ordinary `go test ./...`; the combined branch
builds and passes `go test -race ./... -skip
TestGroupMembershipConsumerLoopRetriesWithoutBlocking -count=1`. The skipped
upstream test has an unsynchronized fake subscription flag between its consumer
goroutine and test assertions (`lifecycle_test.go`, `group_consumer.go`). The
unfiltered reconciler race suite was run and fails there; it is not claimed to
pass. Keep that separate from these lifecycle patches. A fresh source checkout
needs API generation first, as in the upstream Dockerfile/devspace setup;
ungenerated checkouts cannot run the Go suite. Exclude generated API churn from
the contribution.

These changes contain no A2A state machine, MCP protocol, agent prompt or
Kubernetes-specific controller logic. They use the existing Agents/Runner APIs.
Discuss the confirmed-removal contract and node-partition fencing with maintainers;
a runner's `NotFound` is not proof against externally force-deleted pods or a late
in-flight start. Historical `removed_at` values need an operator drain/audit.

## Runner Ingress Isolation

A separate chart-only contribution adds opt-in workload ingress denial without
changing the runner API, binary, egress policy or runtime RBAC:

- Fork: <https://github.com/spk-ai/k8s-runner>.
- Branch: `feat/workload-ingress-isolation`, commit `e914f23`, based on `baadc75`.
- Compare: <https://github.com/agynio/k8s-runner/compare/main...spk-ai:k8s-runner:feat/workload-ingress-isolation>.
- `bash scripts/verify-workload-egress-networkpolicy.sh` passes, including existing
  egress checks and new ingress selection/default/validation checks. No Go code
  changed; a fresh full runner Go suite was not run for this chart-only patch.
- Live credential-free probes passed 92 checks after repairing local K3s policy
  enforcement. Real two-turn Codex continuation and the Stop reminder also passed
  with this policy and a narrowly scoped local reporting allowance. See
  [the exact scope and limitations](AGYN-NETWORK.md).
- The branch is pushed; no upstream PR has been opened. Adversarial runtime
  isolation, parallel cross-task denial and fail-closed bootstrap remain required.

Keep the CNI enforcement incident separate from this chart proposal: adding a
NetworkPolicy cannot repair a controller that is not enforcing policies. Do not
describe the local K3s restart as a permanent bootstrap or runtime-code fix.

## Proposed Subsequent Contributions

| Review unit | Suggested home | Boundary |
| --- | --- | --- |
| Execution lifecycle and reporting contract | `agynio/architecture` | Start with [the draft proposal](docs/agyn-a2a-proposal.md), not a claim that it is accepted architecture. |
| Generic outcome check | `agynio/agynd-cli` | Runtime-neutral lifecycle policy; Codex/Claude translate hook mechanics only. The inbox journal is a separate focused branch above. No A2A state machine in an image. |
| Authenticated execution reports | API/Gateway or a focused service, subject to agreement | Derive instance and execution from authenticated context, not model arguments. ACK after durable commit. |
| A2A connector | A focused repository agreed with maintainers | Official A2A SDK, ownership and task mapping, typed provider interface. Agyn retains runner/PVC/network lifecycle. |
| Native session export | Separate proposal and PR | Export session artifacts without credentials; retention, access and deletion policy before analytics. |

No API, Gateway, runner or runtime-image fork is required to review the daemon
patches. The orchestrator fixes above belong in their own repository and review
units; further protocol/capability changes still require agreement on a contract.

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
