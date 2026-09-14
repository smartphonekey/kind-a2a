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
- `fix/confirmed-workload-removal`, now `f83ce83` after `230977d`/`e0f57d8`:
  require the new `removal_confirmed_at` independently of billing's `removed_at`.
  Confirm absence by inspection, retain failed/stopped unconfirmed workloads,
  block replacement and hold volume TTL. Reject missing/wrong durable update
  acknowledgements before identity cleanup. This branch now requires local API
  generation from the separate confirmation contribution below.
- Local `lab/a2a-lifecycle-integration`, commit `cba941a`, combines these for
  earlier acceptance only; it does not include `f83ce83`. Neither does the old
  `lab/resource-integration` at `5edf8a4`. No upstream PR has been opened.

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
Kubernetes-specific controller logic. Immediate-stop uses existing APIs;
confirmed removal now requires the additive API and Runners changes below.
Discuss the confirmed-removal contract and node-partition fencing with maintainers;
a runner's `NotFound` is not proof against externally force-deleted pods or a late
in-flight start. Historical `removed_at` values need an operator drain/audit,
not a confirmation backfill. Broader generic sandbox paths still need migration
and acceptance; these agent-instance checks do not establish that entire contract.

## Removal Confirmation API And Storage

A [live failed-Pod incident](AGYN-REMOVAL.md) found that the separate Runners
service stamps `removed_at` on failed/stopped status for metering. The earlier
orchestrator-only fix could not make that field physical-removal evidence.
Preserve billing behavior and propose explicit confirmation in two review units:

- API: [spk-ai/api](https://github.com/spk-ai/api/tree/feat/workload-removal-confirmation),
  `feat/workload-removal-confirmation`, `0125665`, based on `50ef648`.
  Add optional timestamps to Workload and UpdateWorkloadRequest, not runner
  failure reports. Buf lint and breaking checks against main pass.
- Runners: [spk-ai/runners](https://github.com/spk-ai/runners/tree/feat/workload-removal-confirmation),
  `feat/workload-removal-confirmation`, `890f759`, based on `f76154d`.
  Add migration `0017` without backfilling historical records, require terminal
  state, retain the first confirmation and prevent reopening with a database
  constraint. No A2A, agent prompt or Kubernetes dependencies are introduced.

Both branches are pushed, with existing repository licenses retained. Runners
ordinary and full race suites pass. A bounded disposable PostgreSQL test also
passes under the race detector, exercising actual migrations, authenticated
runner reporting, billing/confirmation separation, retry durability and the
reopening constraint. No deployed database was changed. These tests do not prove
Gateway forwarding or Kubernetes deletion.

The API must be published before default BSR builds can consume it; the consumer
READMEs describe local source generation. The coordinated images are now built
and loaded using lab-only API `3c84a6a` and orchestrator `d77e7d5` integration
branches. The four-component wrapper passes 41 subprocess cases and now has
real local rollout/restoration and model-free failed-Pod acceptance: billing
ended while a held Pod still blocked A2A release, then explicit confirmation
and independent absence preceded settlement. The migration remains after stock
image restoration. See [the evidence and limitations](AGYN-REMOVAL.md).
All five native Codex lifecycle regressions now pass on that coordinated stack,
with explicit confirmation evidence, retained task PVCs and verified stock
restoration. Claude lifecycle and production rollout remain pending. No upstream
PR has been submitted.

### Gateway Wire Acceptance

- Fork: [spk-ai/gateway](https://github.com/spk-ai/gateway).
- Branch: `test/workload-removal-confirmation`, `6d7d432`, based on deployed
  release `0.29.1` (`d2b485a`), with test-fake compatibility prerequisite `04bbf7d`.
- Compare: <https://github.com/agynio/gateway/compare/main...spk-ai:gateway:test/workload-removal-confirmation>.
- Full `go test -race ./...` passes after regeneration. Actual gRPC and Connect
  HTTP transports verify the JSON confirmation field, independent billing end,
  workload identity, pagination and caller metadata. The backend is a fake;
  this is not deployed authentication, database or Pod-deletion acceptance.
- Four existing test fakes embed their generated interfaces, matching the repo's
  current pattern, because new internal API RPCs otherwise prevented compilation.
  No production Gateway handler, permission or model-specific logic changed.

The branch and identical `lab/removal-integration` are pushed. Existing AGPL
licensing is retained. Generated API files and local image packaging are not in
the proposed review unit; no upstream PR has been opened.

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
- The branch is pushed; no upstream PR has been opened. [Real parallel tasks](AGYN-PARALLEL.md)
  also pass cross-pod TCP/UDP denial. Adversarial runtime isolation, cross-task
  overlay authorization and fail-closed bootstrap remain required.

Keep the CNI enforcement incident separate from this chart proposal: adding a
NetworkPolicy cannot repair a controller that is not enforcing policies. Do not
describe the local K3s restart as a permanent bootstrap or runtime-code fix.

## Compute Resource Contract

Three new focused branches implement opt-in CPU/memory allocations without
putting A2A or model-specific behavior in the runner or orchestrator:

- API: [spk-ai/api](https://github.com/spk-ai/api/tree/feat/container-resource-limits),
  `a760da3`, based on `50ef648`. Add typed `ContainerSpec.resources` with the
  required `compute-resources` capability as its compatibility guard.
- Runner: [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/feat/container-resource-limits),
  `1e7def5`, based on `baadc75`. Require complete main bounds, validate before
  Kubernetes access, apply explicit operator defaults to all supporting roles,
  and advertise the capability only when enforcement is configured.
- Orchestrator: [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/feat/container-resource-limits),
  `d732aa9`, based on `ae7d0bf`. Pass selected flavor/MCP bounds only for opted-in
  agents. Preserve legacy behavior and keep the A2A controller unchanged.

Each branch is named `feat/container-resource-limits` and is pushed. API changes
must land/publish before downstream default BSR builds work; READMEs include
local API generation for reviewing the dependent consumers. No upstream PR is
submitted. Existing repository licenses are retained.

Buf lint/breaking, ordinary Go suites, full runner race tests and assembler race
tests pass. A real credential-free Kubernetes test verifies cgroups, CPU
throttling, OOM handling and neighbor progress. The combined Agyn resource profile
also passes completed, parallel/FIFO, interrupted and cancellation scenarios,
with nine bounded Pods, main cgroup evidence and restored deployments. See [exact evidence and remaining
acceptance](AGYN-RESOURCES.md). These allocations do not establish whole-task
quotas or sandbox hardening.

`lab/resource-integration` branches preserve the existing runner ingress and
orchestrator lifecycle/removal patches for subsequent acceptance, not for
bundling into upstream PRs. Runner `4dd12a8` and orchestrator `5edf8a4` are pushed;
ordinary combined Go suites and runner Helm checks pass. The combined
orchestrator race suite passes with the previously documented unrelated test
excluded. All 82 standalone lab tests remain passing, including 26 deployment
wrapper cases. The A2A controller and workflow code did not change for this
resource profile. Aggregate admission, accounting and production hardening are
not established by the tiny agent fixtures.

## Native Workload Quota

An eighteenth focused branch adds opt-in namespace-wide admission using the
existing Kubernetes ResourceQuota controller, without changing the runner
binary, API, A2A controller or workflow:

- Fork: [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner).
- Branch: `feat/workload-resource-quota`, commit `28d4562`, based on `baadc75`.
- Compare: <https://github.com/agynio/k8s-runner/compare/main...spk-ai:k8s-runner:feat/workload-resource-quota>.
- Explicit CPU/memory request/limit totals and Pod object count are required.
  The chart validates its rendered runner namespace binding and stays disabled
  by default. It introduces no fallback resource allocations or scoped bypass.
- Helm render/negative tests use the existing Kubernetes parsers and run in the
  existing Go CI. Full `GOMAXPROCS=4 go test -race ./...`, `go build ./...`,
  Helm lint and existing network-policy checks pass.
- The branch is pushed with existing AGPL licensing preserved. No upstream PR
  has been submitted; review this chart change independently of resource/API work.

The separate `lab/quota-integration` branch combines resource and chart patches
for a credential-free Kubernetes test, not an upstream review unit. Test source
`dc67264` with API `3c84a6a` passes real per-key quota rejection, init/sidecar
accounting, completed-Pod counting, six competing starts and verified cleanup.
The ordinary combined runner race suite also passes with live fixtures disabled.
[Evidence and reproduction](AGYN-RESOURCES.md#native-namespace-quota-acceptance)
distinguish this from the separate [native A2A quota-recovery scenario](AGYN-RESOURCES.md#a2a-quota-recovery),
which now passes on the coordinated local stack at standalone commit `56fb179`.
That scenario retains the existing task/PVC/session and explicitly retires a
rejected inbox request without changing the controller, worker, driver or any
Agyn binary. Six proof tests and nine wrapper cases bring the lab suite to 205
tests. Those operator fixtures remain AGPL-3.0-only; keep them, the local image
and acceptance evidence out of the focused chart proposal. First-provision A2A
recovery, production quota bootstrap and mandatory profiles remain open; the
independent runner startup fix below has its own native acceptance.

## Startup Secret Cleanup

A nineteenth focused branch fixes resource handling discovered while tracing
first-provision failures. It has no dependency on the resource/quota chart,
additive removal API, A2A controller, workflow or agent runtime:

- Fork: [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner).
- Branch: `fix/startup-secret-cleanup`, commit `fcd7cf6`, based on `baadc75`.
- Compare: <https://github.com/agynio/k8s-runner/compare/main...spk-ai:k8s-runner:fix/startup-secret-cleanup>.
- Attempt-scoped cleanup covers PVC and partial-Secret failures, preserves
  durable claims, and retains credentials after uncertain Pod creation.
- Cleanup checks ownership/content and UIDs, uses conditional deletion, observes
  absence and remains bounded after caller cancellation. It never adopts a
  conflicting Secret or removes a finalizer. Unconfirmed cleanup is diagnostic,
  not authorization to retry a workload.
- Published `buf generate`, `go build ./...` and the full race suite pass
  (146 tests including subtests; 101 top-level). The 12 new unit tests cover 34
  cases including subtests, separate from seven real native quota scenarios.
- The opt-in credential-free test passed in 32.77s, including partial-PVC
  retention/reuse and confirmed cleanup. No Pod/agent ran and all 49 existing
  task PVCs and four stock deployments remained unchanged.

[Exact evidence and reproduction](AGYN-RESOURCES.md#native-first-provision-failures)
are recorded separately from A2A recovery. The test uses the existing Kubernetes
SDK and native quota controller, not new resource accounting or a fake API. Its
explicit kubeconfig loader adds only the client's existing indirect dependencies.
Keep crash-orphan reconciliation, PVC ownership enforcement, Stop/Remove changes
and coordinated A2A deployment in separate review units. The fork retains its
existing AGPL license; the branch is pushed and no upstream PR has been opened.

## Claude SDK Session Selection

A separate SDK-only contribution adds `Options.SessionID` and `Options.Resume`
and rejects their simultaneous use before starting a process. Existing default
arguments and permission behavior are unchanged. The SDK does not copy session
files, fall back to a new conversation, or decide whether interrupted work can
be retried.

- Fork: [spk-ai/claude-sdk-go](https://github.com/spk-ai/claude-sdk-go).
- Branch: `feat/session-resumption`, commit `0cdc814`, based on `bc88c1b`.
- Compare: <https://github.com/agynio/claude-sdk-go/compare/main...spk-ai:claude-sdk-go:feat/session-resumption>.
- `go test ./...` and `go test -race ./...` pass. Subprocess tests verify exact
  argument forwarding, default compatibility and pre-spawn validation.
- The opt-in native test passes with Claude Code `2.1.270` and an existing Max
  subscription: two text-only turns, no tools, different processes, same session
  and recovered random marker. [Evidence and limits](AGYN-PORTABILITY.md).
- Upstream MIT licensing is retained. The branch is pushed; no upstream PR has
  been submitted. Daemon session mapping and A2A portability are separate work,
  not part of this small SDK patch.

## Claude Daemon Contributions

Two additional independent daemon branches are pushed, both based on upstream
`495920a`:

- `feat/claude-session-persistence` (`f29925c`): opt-in durable session binding,
  exact native transcript resume, ownership locking, fail-closed state checks
  and `CLAUDE_CONFIG_DIR` support. It temporarily pins the SDK branch above.
- `fix/claude-error-results` (`1b1dd62`): treat nil/error SDK results as terminal
  failures before publishing or acknowledging the inbox. No SDK fork or A2A
  dependency is needed to review this fix.

Ordinary Go suites and focused race tests pass. The combined local branch
`lab/claude-reporting-integration` (`beb1f23`) is for acceptance, not a bundled
upstream PR. [Portability evidence](AGYN-PORTABILITY.md) records the real
authentication and stop-notice failures found during Agyn testing, separately
from the passed native process and completed A2A/Pod recovery tests. These forks retain their existing licenses;
the standalone reporting/service changes retain AGPL-3.0-only.

## Claude Failure Diagnostics

Two additional focused review units improve observability, not retry behavior:

- SDK [feat/result-diagnostics](https://github.com/spk-ai/claude-sdk-go/tree/feat/result-diagnostics),
  `16286f3`, based on upstream `bc88c1b`: preserve subtype, optional HTTP error
  status and terminal reason. Legacy results remain compatible and full
  `go test -race ./...` passes. This keeps MIT and does not include the separate
  session-selection contribution.
- Daemon [fix/claude-error-diagnostics](https://github.com/spk-ai/agynd-cli/tree/fix/claude-error-diagnostics),
  `2afdfc1` after `b884d27`, stacked on `fix/claude-error-results` (`1b1dd62`): format only
  allowlisted metadata while preserving the terminal failure/no reply/no ACK
  contract. It keeps the existing daemon license. Ordinary Go tests and focused
  `go test -race ./internal/daemon -run 'ClaudeError|ClaudeDiagnostic' -count=1`
  pass with an isolated HOME. The unrelated full daemon race failure remains.

Both branches are pushed, bringing the then-current focused branch count to seventeen; no
upstream PR is submitted. Review the daemon diff against its error-result
prerequisite, and replace its temporary SDK fork pin with an upstream release
before merge. The native opt-in test passed using the real packaged CLI and a
credential-free loopback HTTP 401 fixture in a network-denied Pod, with no model
backend. [Evidence and limitations](AGYN-PORTABILITY.md#native-failure-diagnostics)
separate that diagnostic proof from the still-unexplained provider failures.
The lab's operator/Dockerfile/subprocess tests are separate AGPL-3.0-only code;
do not include Kubernetes or A2A wiring in the proposed SDK/daemon changes.
The lab-only SDK combination `lab/session-diagnostics-integration` (`54490e0`)
and daemon `lab/claude-diagnostics-integration` (`7ed299f`) are pushed, with a
rebuilt digest-pinned init image. The combination passes ordinary daemon and
focused race tests, three fake-client durable failure cases, and the isolated
native HTTP 401 probe. The first combined native probe caught an empty-path
fixture incompatibility; `2afdfc1` fixes the test without relaxing production
configuration checks. [Combined evidence](AGYN-PORTABILITY.md#combined-runtime)
records the exact scope. Keep these integration merges and the combined-only
test out of the focused upstream proposals.
Completed and interrupted Codex task recovery also pass on that exact image,
with independently verified binary identity, all five durable workload-removal
confirmations, restored stock deployments and 48 retained PVCs. These regressions
do not replace the still-required Claude provider/lifecycle acceptance.

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

Local service verification is `nvm use`, then `npm ci && npm test`; see the
[patched SQLite runtime requirement](SERVICE.md#run-requirements). The tests use temporary
databases, official MCP/A2A transports, independent worker processes and fake
provider fault injection. Live Agyn acceptance is not replaced by these tests.

The [durable admission limit](SERVICE.md#shared-execution-admission), its operator
CLI and runtime checks belong to the focused A2A service. They use SQLite's
existing transaction/constraint machinery and add no agent-specific logic or
Agyn API changes. The separate native quota contribution above now has controlled
runner/Kubernetes and existing-task A2A recovery acceptance, not a production
rollout or protection across every namespace. These new service files retain
AGPL-3.0-only; no upstream branch or PR is changed by the service admission work.
