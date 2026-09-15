# Contributing This Work To Agyn

Keep contributions independently reviewable. An A2A implementation should not
require maintainers to adopt this entire lab or change a runtime image's role.

## Ready For Focused Review

The dependent [resource-anchor registry proposal](AGYN-ANCHOR-REGISTRY.md) now
has source, PostgreSQL contention and historical-upgrade evidence. API and
Runners branches remain separate from native runner/controller contributions.
It is not installed and no upstream PR is submitted; both controller paths,
anchored-volume retirement and coordinated rollout remain required.

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

## Runner Workload RBAC

The separate [runner workload RBAC placement fix](AGYN-RUNNER-RBAC.md) is pushed
as `fix/workload-namespace-rbac`, `92b25e9`, based on upstream `baadc75`.
It keeps the runner account in the release namespace while placing namespaced
workload grants in `workloadNamespace`. It adds Helm-rendering tests without
changing runtime code or broadening rules. Independent and prepared-branch
tests pass; the installed local permission matrix passes 57 checks. The local
RBAC overlay is not a reconciled Helm platform release. No upstream PR is open.

## Prepared Secret Ownership

The [atomic prepared Secret ownership follow-up](AGYN-PREPARED-SECRETS.md) is
pushed as `fix/prepared-secret-ownership` in `spk-ai/k8s-runner`, based on the
prepared-inspection/RBAC proposal `73c3a20`. Implementation/unit commit `856d1b4`
is separate from crash-fixture commit `1f33556`. Credentials are created only
after their gated Pod, with exact Pod ownership in the CREATE; readiness commits
after acknowledged credential setup. The A2A controller/workflow and API schema
are unchanged. All 521 native race entries pass, and real Kubernetes tests cover
four SIGKILL checkpoints plus delayed credential writes after owner removal.

This is a dependent review proposal, not an independent upstream-base patch.
It is not installed, and no upstream PR is submitted. Unknown prepare discovery,
registry/controller reconciliation and durable external credential revocation
remain separate contracts; the fixture's operator-assisted cleanup does not
implement them.

## Lost Preparation Recovery

The [dependent recovery follow-up](AGYN-PREPARED-RECOVERY.md) keeps three focused
review boundaries:

- API `feat/prepared-outcome-observation`, `d6449dd`, based on inspection API
  `24b73ca`: read-only intent observation, with no safe-to-retry absence result.
- k8s-runner `feat/prepared-outcome-observation`, `6fdcc41`, based on atomic-Secret
  fix `1f33556`: versioned ownership marker, gated/unexecuted Pod and complete
  claim validation, bounded identity output and GET-only observation.
- agents-orchestrator `feat/prepared-outcome-recovery`, source/unit `5d8a9c8`
  and process acceptance `c2bb0e5`,
  based on `754e935`: validate durable owner/volume intent, bind through existing
  CAS into REMOVING, and retire the exact Pod without prepare/activate replay.

Registry `e7c42f4` and migration `0022` are unchanged. A2A workflow/controller
code, Gateway handlers and RBAC grants do not change. Both owner paths have
source, real PostgreSQL/Kubernetes and controller-process recovery evidence;
the report distinguishes native fixtures from full A2A/native-agent acceptance.
NotFound, unsupported/old writers and unverifiable ownership retain admission.

All three focused branches are pushed. No upstream PR is submitted and nothing
is installed. The focused controller
branch omits the installed DNS correction; the separate
`lab/prepared-recovery-native-dns` combination (`b3ec0e2`) passes 666 selected
race entries and a seven-entry real process/Kubernetes recovery subset. It is
not an upstream review unit or permission to replace the retained stack. Delayed
Pod/PVC creation, durable credential cleanup, authentication and node/storage
fencing remain separate requirements.

## Native Resource Anchors

The [dependent native ownership capability](AGYN-RESOURCE-ANCHORS.md) remains
separate from its pending registry/controller integration:

- API `feat/resource-anchors`, `3b25d03`, based on `d6449dd`: metadata reservation,
  anchored preparation and workload-anchor retirement; bindings retain exact
  owner UIDs. Anchor absence explicitly does not confirm child absence.
- k8s-runner `feat/resource-anchors`, `72a1cc8`, based on `6fdcc41`: atomic Pod/PVC
  ownership, separate persistent volume lifetime, one-Pod selection and an
  activation claim contending with revocation on the same native object.

Native ordinary/full race suites and real Kubernetes delayed-create/CAS/GC
acceptance pass. The fixture includes no production registry or A2A agents.
Both branches are dependent proposals, not independent upstream-base patches;
fork licensing is unchanged. No upstream PR is submitted and nothing is
installed. The registry must persist anchor UIDs before creation authority,
both controller paths must migrate, and anchored-volume retirement/all-writer
guards still need implementation. Do not deploy this runner alone.

## Orchestrator Lifecycle Fixes

The independent [workload DNS correction](AGYN-NATIVE-DNS.md) is pushed as
`fix/workload-dns-interception`, `204b5e9`, based on upstream `ae7d0bf`. It removes
the ordinary fallback resolver from Ziti-enabled agent/sandbox workloads and
readiness checks while keeping explicit upstream forwarding in the tunneler.
Regressions fail before the fix and pass afterward; a credential-free fixture
with the actual native Claude CLI reproduces the bypass and its corrected
controls. There is no A2A or prepared-workload API change in this focused patch.
The separate `lab/prepared-native-dns` combination is for local acceptance,
not the upstream review boundary. No upstream PR has been opened.

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

## Volume Inventory And Retention

Two independent, runtime-neutral fixes address destructive reconciliation
decisions. [Full source/native evidence and remaining gates](AGYN-VOLUME-SAFETY.md)
include red regressions on unchanged upstream code and a combined-stack rerun.

- Orchestrator: [fix/retain-untracked-volumes](https://github.com/spk-ai/agents-orchestrator/tree/fix/retain-untracked-volumes),
  core `79580bb`, native fixture/docs `72e1b22`, based on `ae7d0bf`. Retain disks
  absent from the filtered/stale registry snapshot; reject malformed and
  duplicate runner inventories before changing records. The optional Kubernetes
  fixture is a separate commit from the production fix and unit tests.
- Runner: [fix/complete-volume-inventory](https://github.com/spk-ai/k8s-runner/tree/fix/complete-volume-inventory),
  `40b35ce`, based on `baadc75`. Missing/empty/padded/duplicate keys on managed
  PVCs return `FailedPrecondition`, without a partial successful inventory.
- Combined lab branches `lab/volume-retention-integration` (`f65a9f6`) and
  `lab/volume-inventory-integration` (`d03831f`) preserve earlier lifecycle,
  resource and named-PVC fixes for acceptance, not for bundled upstream PRs.

All branches are pushed; no upstream PR has been submitted. Neither fix changes
A2A, models, API schemas, database migrations or runtime images. Existing
repository licenses remain intact. Unknown disks are now retained rather than
automatically deleted: discuss this explicit architecture-policy change and
ownership-aware garbage collection with maintainers. Production deletion
preconditions, node fencing and rollout remain separate requirements.

Independent orchestrator build and 326 ordinary tests pass; 325 race tests pass
with the known group-consumer test explicitly excluded. Independent runner build
and all 124 race tests pass. Combined builds, 363 scoped orchestrator race tests,
303 runner race tests, and the separate native retention fixture pass. Existing
opt-in live tests gated off in those suites are not counted as rerun. The native
fixture uses real runner RPCs and Kubernetes with fake registry/Agents clients;
no deployed database or A2A lifecycle acceptance is implied.

## Checked Volume Lifecycle

Three additional focused branches implement a proposed coordinated contract:

| Repository | Branch / commit | Review boundary |
| --- | --- | --- |
| `spk-ai/api` | `feat/checked-volume-removal`, `83fd4c8` | Distinct checked RPCs, lifecycle revision, bound physical identity and durable removal intent. Base: upstream `50ef648`. |
| `spk-ai/runners` | `feat/checked-volume-removal`, `bd7137f` | Registry state machine/CAS, additive database migration and old-writer guards. Based on the separate owner-reopen fix `5638dce`. |
| `spk-ai/k8s-runner` | `feat/checked-volume-removal`, `b073bcc` | Conditional native deletion and fail-closed legacy removal. Based on complete inventory `40b35ce`. |

[Acceptance and scope](AGYN-CHECKED-VOLUMES.md) record focused/combined race suites,
real PostgreSQL lifecycle/contention and native Kubernetes deletion races.
Existing repository licenses are preserved; branches are pushed, with no upstream
PR or published API release. Generate from the reviewed API proposal to test
these branches. Native fixture and combined-stack commits are separate lab
integration artifacts, not part of a bundled upstream change.

The dependent caller migration below is now tested; deployment is still pending. Review the API
contract and dependency/rollout plan with maintainers before proposing activation;
do not deploy a runner that rejects legacy deletion while its callers still use it.

## Checked Owner Admission

A further registry-only review unit prevents follow-up admission from racing
checked volume removal:

- Fork/branch: `spk-ai/runners`, `feat/volume-workload-admission`, commit `f05b479`.
- Explicit base: combined `0492121`, requiring workload confirmation migration
  `0017` and checked volumes `0018`. The new migration is `0019`.
- [Review only the incremental diff](https://github.com/spk-ai/runners/compare/0492121...f05b479).
  Rebase this dependent unit onto accepted prerequisites before an upstream PR;
  do not submit the combined ancestry as an undifferentiated patch.
- Scope: owner-scoped database admission, predecessor confirmation, immutable
  protected workload evidence, guarded volume deletion/reopen and upgrade audit.
- Evidence: build, vet and 335 full race tests pass with both real PostgreSQL
  fixtures enabled; 48 forced interleavings cover all isolation settings and
  prove unrelated owners still progress. See
  [the acceptance report](AGYN-CHECKED-VOLUMES.md#workload-admission).

The branch is pushed and the existing license is unchanged. No upstream PR has
been submitted. This is not controller integration, native backend fencing or a
production rollout; it requires the coordinated contract and all-writer audit.

## Checked Volume Controller

The next dependent review unit migrates orchestrator and sandbox volume writers:

- Fork/branch: `spk-ai/agents-orchestrator`, `feat/checked-volume-lifecycle`,
  production change `eebf4cf`, process-acceptance follow-up `5449301`.
- Explicit base: combined orchestrator `f65a9f6`; required API `ec2bfed`, native
  runner `3c461c5` and Runners owner-admission guard `f05b479`.
- [Review the incremental diff](https://github.com/spk-ai/agents-orchestrator/compare/f65a9f6...eebf4cf).
  Rebase onto accepted prerequisites before submitting an upstream PR.
- Scope: checked creation/reuse/reopen, immutable binding, owned-revision failure
  compensation, persisted deletion intents, physical confirmation and sandbox
  finalization. Malformed listings/replies fail closed; legacy callers are not
  used as fallback. No A2A controller/workflow or generated API changes.
- Evidence: build and 488 ordinary tests pass; a selected 488-test race suite
  passes with real runner/Kubernetes agent and sandbox cleanup. Exactly the
  known group-consumer race test is excluded. The unchanged self-assignment also
  prevents an unfiltered vet pass. See [the precise acceptance scope](AGYN-CHECKED-VOLUMES.md#controller-migration).
- Follow-up evidence: the selected race suite now passes 491 tests with both
  native fixtures enabled. The new fixture uses real PostgreSQL/migrations,
  registry RPCs, controller subprocesses and native Kubernetes deletion. It
  forces both admission/deletion orderings and SIGKILL after begin, native
  deletion and registry confirmation for both owner kinds. Independent SQL
  reads verify committed state; same-name replacement rejects old-UID replay.
  [Exact boundaries and reproduction](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance)
  retain the same unrelated full-race/vet limitations.

The branch is pushed, with the existing license unchanged and no upstream PR.
The earlier native fixture uses a fake registry; the new combined fixture uses
the actual registry, while Agents metadata and authorization writes remain
stubs. No model, native workload start or A2A driver runs in this fixture.
Coordinated A2A acceptance, legacy-record audit, all-writer rollout, backend
authorization/incarnation binding and infrastructure fencing remain open.

The standalone A2A repository also contains an AGPL-3.0-only, read-only
[upgrade audit](AGYN-CHECKED-VOLUMES.md#read-only-upgrade-audit), with a pure
analysis module, private-report CLI and 69 tests. It inventories the real lab
without rewriting legacy records or treating observed absence as deletion
authority. It remains operator-side integration code, not another Agyn fork
branch or an adoption API proposal. The full service suite now passes 313 tests.

## Legacy Volume Adoption

- Fork/branch: [`spk-ai/runners`, `feat/legacy-volume-adoption`](https://github.com/spk-ai/runners/tree/feat/legacy-volume-adoption),
  commit `748d283`, based on the owner-admission guard `f05b479`.
- Scope: strengthen existing checked bind, require a recorded legacy name and
  zero unconfirmed predecessors, prevent implicit legacy reopen, preserve
  metering history and add migration `0020`. No new RPC, generated API changes
  or A2A controller/workflow changes.
- Current Kubernetes-profile validation uses the native runner's pinned
  `k8s.io/apimachinery` validators instead of reimplementing name/label parsing.
  Backend-neutral identity validation would need a separate agreed contract.
- Evidence: all 419 registry race tests with both real PostgreSQL fixtures,
  build, vet and module verification pass. The combined checked-process/native
  fixture also passes with this registry and real migrations. See
  [the adoption guard acceptance](AGYN-CHECKED-VOLUMES.md#legacy-adoption-guards).

The branch is pushed with the repository's existing license retained; no
upstream PR has been opened. Keep the incremental diff separate from its
prerequisites and rebase after those contracts are accepted. This does not
implement operator adoption approval, writer draining, backend authentication,
late-create/node fencing or an installed rollout. Failed/unbound legacy records
remain retained for explicit reconciliation.

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

## Volume Backend Identity

Four dependent [backend-identity contributions](AGYN-VOLUME-BACKEND.md) are
pushed on `feat/volume-backend-identity`: API `72394f4`, native runner `bdcb67a`,
Runners registry `c3b5338` and orchestrator `3445cbe`. They pin the storage scope
through inventory, durable bindings/intents and physical absence confirmation.
The distinct `RemoveVolumeBound` RPC rejects old-runner capability rather than
silently ignoring a new precondition. There is no fallback to older deletion.

The native implementation and namespace GET-only RBAC, registry migration
`0021`, caller migration and operator audit are separate ownership boundaries.
The 495-test selected controller race suite includes actual PostgreSQL,
Kubernetes and process recovery; 186 independent/409 combined native tests,
423 registry race tests and 323 service tests also pass. Known unrelated
unfiltered orchestrator race/vet failures remain disclosed. Workload-start
pinning, authentication, fencing and rollout are not established by these tests.
Acceptance-only API `ad5405b` and runner `2968787` are not bundled upstream PRs.

## Prepared Workloads

The two additional dependent [prepared-workload proposals](AGYN-PREPARED-WORKLOADS.md)
are on `feat/prepared-workloads` in the API and native-runner forks. API `53e0817`
adds separate prepare/activate/bound-removal RPCs; runner `d92930c` implements
gated creation, UID/RV-checked activation, per-Pod claim holds and Pod-owned
temporary Secrets. Live fixture `2ee4b73` and independent absence check `4023808`
are separate follow-up commits. All 468
ordinary native race entries, 1,060 repeated prepared entries, build and vet
pass; real Kubernetes execution/resume and replacement-race checks pass too.

These branches are based on acceptance combinations, not standalone upstream
bases. The combined execution follow-up below is not full A2A acceptance or a
production rollout.
[Two more dependent registry branches](AGYN-PREPARED-REGISTRY.md), API `4f957e5`
and Runners `e7c42f4` on `feat/prepared-workload-registry`, now add immutable
bindings, state/revision CAS, owner/backend pins and database old-writer guards.
All 538 registry race tests, 2,320 repeated entries, build and vet pass against
disposable PostgreSQL; native observations and authorization are fixtures, not
combined native/A2A acceptance. Keep their original licenses and review the
contract with maintainers before declaring it an Agyn API. Do not bundle them
into the independent transport proposal below. No upstream PR was opened.

[Three further dependent proposals](AGYN-PREPARED-CONTROLLERS.md) are now pushed:
API `24b73ca` and runner `1a5a7b6` on `feat/prepared-workload-inspection`, plus
orchestrator `20647af` on `feat/prepared-workloads`. Both agent and sandbox starts
use the shared prepared lifecycle; exact-binding inspection never activates or
repairs a Pod. All 597 ordinary controller entries, 596 selected race entries
and 2,360 repeated entries pass. Native inspection passes 493 ordinary race
entries and separate real Kubernetes scenarios. Existing unfiltered controller
race/vet limits remain disclosed. Those earlier component tests alone did not
establish combined execution.

Follow-up `754e935` on the same orchestrator branch is pushed and adds real
PostgreSQL/registry/controller-method subprocess/native Kubernetes execution
acceptance: 22 scenarios plus three parent/group entries, with 16 joined SIGKILLs.
Both owner kinds cover parallel execution, durable follow-up, cancellation,
lost activation ACK and removal crashes. Independent SQL reads check persisted
bindings, confirmations and owner/backend pins. The final selected race suite
passes 625 entries with all three live fixtures enabled; ordinary tests pass 597.
The known unfiltered race/vet failures remain. All 68 prior PVCs, 52 deployments
and 170 cluster RBAC objects are unchanged. Unknown preparation is quarantined,
not recovered. This is model-free execution, not full A2A/daemon/session or
production authentication acceptance. No installed upgrade or upstream PR was
made. See [the exact scope](AGYN-PREPARED-CONTROLLERS.md#combined-execution-acceptance).

An eighth dependent prepared branch is now pushed in the Gateway fork:
[`test/prepared-workload-forwarding`, `127e007`](https://github.com/spk-ai/gateway/tree/test/prepared-workload-forwarding),
based on `6d7d432`, generated against API `24b73ca`. It adds no production route
or handler behavior. All 276 Gateway race-test entries, build and vet pass;
70 Connect HTTP/gRPC round trips preserve complete prepared responses and exact
64-bit JSON revisions for agent and sandbox owners. Backend/authentication are
fixtures, not production authorization evidence. Keep the matching API-generation
requirement explicit. No upstream PR is open.

The separate [local rollout/backup/proof tools](AGYN-PREPARED-ROLLOUT.md) belong
in this AGPL service repository, not in that Gateway contribution. Offline
restoration and migration of installed registry data pass. The reviewed stack
is now retained locally, and real Codex completed-turn continuation passes
through the prepared APIs. That is not the full real-agent lifecycle matrix or
whole-platform disaster recovery. Keep the independent
[workload-namespace RBAC correction](AGYN-RUNNER-RBAC.md) separate from the
dependent prepared-workload contract.

## Runner Control Transport

- Fork/branch: [`spk-ai/k8s-runner`, `fix/ziti-control-listener`](https://github.com/spk-ai/k8s-runner/tree/fix/ziti-control-listener),
  production change `c5c467e`, fixture guard `d0ef963`, based on upstream `baadc75`.
- Scope: separate the plaintext health listener from the full API when Ziti is
  enabled. Only exact unary readiness remains available on TCP. Registered
  control methods and streams reject unauthenticated access, including before
  enrollment. No new API, prompt, workflow or credential format.
- Evidence: 152 independent race tests, build and vet pass; ten repeated
  transport/startup runs pass 400 test entries. Lab-only combination `28d77ea`
  with checked runner `3c461c5` and API `ec2bfed` passes 386 race tests, including
  plaintext checked-removal rejection. Native Kubernetes fixtures were not run.
- [Acceptance and exact limits](AGYN-RUNNER-TRANSPORT.md) distinguish source,
  loopback RPC and subprocess evidence from actual overlay-policy/deployment
  acceptance. The startup fixture uses a fake Kubernetes client and Gateway.

The focused and integration branches are pushed, with the existing license
retained; no upstream PR has been opened. Submit the focused branch separately
from the checked-volume proposals. Clients using TCP against a Ziti-enabled
runner need a migration; disabling Ziti is not a security fix. Standalone
plaintext mode, live policy audit, backend incarnation and production rollout
remain explicit boundaries.

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
and acceptance evidence out of the focused chart proposal. This existing-task
fixture does not prove first-provision recovery; the separate startup fix and
later first-PVC A2A acceptance below cover that controlled case. Production quota
bootstrap and mandatory profiles remain separate gates.

## Startup Secret Cleanup

A nineteenth focused branch fixes resource handling discovered while tracing
first-provision failures. It has no dependency on the resource/quota additions,
additive removal API, A2A controller, workflow or agent runtime:

- Fork: [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner).
- Branch: `fix/startup-secret-cleanup`, commit `9002f31` (`fcd7cf6` plus required
  Secret-read RBAC and authorization coverage), based on `baadc75`.
- Compare: <https://github.com/agynio/k8s-runner/compare/main...spk-ai:k8s-runner:fix/startup-secret-cleanup>.
- Attempt-scoped cleanup covers PVC and partial-Secret failures, preserves
  durable claims, and retains credentials after uncertain Pod creation.
- Cleanup checks ownership/content and UIDs, uses conditional deletion, observes
  absence and remains bounded after caller cancellation. It never adopts a
  conflicting Secret or removes a finalizer. Unconfirmed cleanup is diagnostic,
  not authorization to retry a workload.
- At `fcd7cf6`, published `buf generate`, `go build ./...` and the full race suite pass
  (146 tests including subtests; 101 top-level). The 12 new unit tests cover 34
  cases including subtests, separate from seven real native quota scenarios.
- The initial opt-in credential-free test passed in 32.77s, including partial-PVC
  retention/reuse and confirmed cleanup. No Pod/agent ran and all 49 existing
  task PVCs and four stock deployments remained unchanged.
- Deployed acceptance then found the missing `get secrets` permission. The
  chart now adds only named reads, without list/watch. Full race suites pass;
  the native seven-case matrix passes in 19.97s through an impersonated service
  account with the chart's Role, instead of administrator-backed runner calls.

[Exact evidence and reproduction](AGYN-RESOURCES.md#native-first-provision-failures)
are recorded separately from A2A recovery. The test uses the existing Kubernetes
SDK and native quota controller, not new resource accounting or a fake API. Its
explicit kubeconfig loader adds only the client's existing indirect dependencies.
Keep crash-orphan reconciliation, PVC ownership enforcement, Stop/Remove changes
and coordinated A2A deployment in separate review units. The fork retains its
existing AGPL license; the branch is pushed and no upstream PR has been opened.

The separate [`lab/startup-integration`](https://github.com/spk-ai/k8s-runner/tree/lab/startup-integration)
branch at `6ab2e20` combines this fix with `lab/quota-integration` (`e6e83e7`).
Generation against the combined API source `3c84a6a`, `go build ./...` and the
full `go test -race ./...` suite pass. Compute-resource validation still occurs
before any startup Secret or PVC write. Only the README needed manual conflict
resolution; the focused contribution remains independently reviewable. The
[deployed first-PVC recovery](AGYN-RESOURCES.md#a2a-first-provision-recovery)
also passes with the combined binary and an explicit namespace-scoped read grant:
same task/instance/volume, rejected-request retirement, two native turns across
Pod replacement, zero idle compute and preserved storage. The failed image-only
run, targeted cleanup and stock/RBAC restoration are recorded separately. The
operator fixtures are AGPL-3.0-only and stay out of the focused runner proposal.

## Closed Volume Ownership

A twentieth focused branch fixes an ownership overwrite in Runners' closed
volume reopening. It is independent of the additive API, removal confirmation,
runner startup cleanup and A2A implementation:

- Fork: [spk-ai/runners](https://github.com/spk-ai/runners).
- Branch: `fix/volume-owner-reopen`, commit `5638dce`, based on `f76154d`.
- Compare: <https://github.com/agynio/runners/compare/main...spk-ai:runners:fix/volume-owner-reopen>.
- A conditional SQL update matches the complete existing volume identity and
  never assigns a new owner. Null-safe sandbox fields preserve same-owner
  recovery; conflicts keep the existing `AlreadyExists` contract and leave all
  stored fields unchanged. No schema or public API change is required.
- Tests first reproduced 22 mismatched-owner/identity writes and a foreign-owner
  race against unchanged upstream. The fixed full race suite passes 169 tests
  including subtests, with no skips; the real PostgreSQL matrix passes twenty
  repeated runs. CI now enables it using a disposable PostgreSQL service.
- Published BSR generation, build, workflow lint and diff checks pass. Existing
  repository AGPL licensing is retained. The branch is pushed; no upstream PR
  has been submitted.

The separate `lab/volume-owner-integration` branch at `5f66067` combines it with
`890f759` and passes 177 race-enabled tests with both real PostgreSQL fixtures
enabled, generated against the combined API `3c84a6a`. Both branches are pushed.
[Acceptance evidence and limits](AGYN-RESOURCES.md#closed-volume-ownership) stay
in this lab. The combined binary was verified in a running Pod, then passed the
unchanged first-provision A2A recovery scenario: rejected request retirement,
same-owner reopening, two native turns across Pod replacement, zero idle compute
and preserved workspace/session identity. All 50 prior claims and 16 older
Secret identities survived, stock services/RBAC were restored, and the five
workload-removal confirmations remained in PostgreSQL. This is a tested local
integration, not an upstream release or permanent deployment.

Physical-PVC reuse, sandbox open-record validation, fencing and
authentication remain separate review units; do not turn this targeted fix
into a new A2A-specific storage API.

## Named PVC Ownership

A twenty-first focused branch checks the Kubernetes claim itself before reuse:

- Fork: [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner).
- Branch: `fix/pvc-owner-reuse`, commit `7d3238a`, based on `baadc75`.
- Compare: <https://github.com/agynio/k8s-runner/compare/main...spk-ai:k8s-runner:fix/pvc-owner-reuse>.
- Every named volume requires an explicit, nonempty `labels.volume_key`.
  Existing claims must match stable ownership/management labels and storage
  requirements. Matching names alone no longer authorize reuse. Same-owner
  claims survive changing workload/thread labels without mutation.
- Validation also covers admission responses and the fresh read after a
  competing create returns `AlreadyExists`. Quota, permission and uncertain
  errors are returned without adoption, relabeling or deletion.
- Published BSR generation, build and the full race suite pass: 187 passing
  test entries, 97 top-level. The opt-in native test is skipped by default and
  separately passes all six cases using the chart's service-account permissions.
  Eight real simultaneous stale reads produce four matching-owner successes and
  four foreign-owner rejections, retaining one claim identity.
- All 51 original workspaces and four deployment specs/UIDs were unchanged;
  both the initially failed fixture and passing fixture namespaces are absent.
  [The acceptance report](AGYN-RESOURCES.md#named-pvc-ownership) preserves the
  initial fixture failure and cleanup evidence.

The branch is pushed, retains the repository's AGPL license and has no upstream
PR. It changes no API, A2A controller or workflow. Unkeyed custom callers require
an explicit migration; this intentional validation change needs maintainer
review. Startup Secret cleanup remains a separate dependency for credentialed
deployments. Lab-only `lab/pvc-owner-integration` (`641e2f7`) combines the patches
with resources/quota and is pushed separately. Build, full race tests, a new
credential-rollback/PVC-conflict matrix and native Kubernetes ownership tests
pass, retaining all 53 existing claims. The subsequent combined first-provision
A2A regression also passes: quota rejection, credential cleanup, explicit
request retirement and two native Codex turns across replacement. Independent
database/Gateway checks confirm five removed workloads and a paused instance
with a persistent/no-TTL workspace; all 55 previous claims survived. Stock Agyn
was restored, not permanently upgraded. This is not RPC authentication, single-writer fencing, safe
name-only volume deletion or protection from privileged claim replacement.

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

## Native Proxy Refusal Diagnostics

- Fork: <https://github.com/spk-ai/llm-proxy>.
- Branch: `feat/native-refusal-diagnostics`, now `17c0f0f` after `8abd410`, based on deployed
  upstream `v0.14.0` (`dd1a3fb`). This deliberately does not bundle the newer
  unrelated platform-path raw-body logging commit.
- Scope: bounded, allowlisted native non-2xx and Anthropic SSE error diagnostics, correlated with
  existing metering. It does not change credentials, paths, bodies, status,
  headers, subscription resolution or retry policy.
- Model-free evidence: 30 new tests including subtests cover hostile/oversized
  content, UUID/header projection, streaming delivery, read/write failure,
  exact response forwarding and failed-metering correlation. Build passes.
- Race run: 118 tests including subtests pass with the existing
  `TestStreamToClientCannotRelayGzip` excluded. Its substring assertion fails
  identically on untouched upstream with Go 1.27.1; it remains unchanged and
  the full unfiltered suite is not claimed to pass.
- Existing AGPL licensing is retained. The branch is pushed; no upstream PR
  has been opened. The lab's image/rollout/evidence code is a separate
  AGPL-3.0-only integration, not part of the proxy proposal.

A separate `fix/gzip-relay-test` branch, `c8f2c51`, fixes only the existing test's
compression-dependent assertion. Default and explicitly uncompressed DEFLATE
blocks must both preserve the encoded wire bytes without producing parsed SSE
usage. The full race suite passes 76 tests including subtests. The combined
initial `lab/native-refusal-integration`, `c59786d`, passed build and all 106 race tests
(79 top-level) without exclusions; it differs from diagnostic source `8abd410`
only in that test file. Both branches are pushed and neither has an upstream
PR. Keep the independent test correction separate from the native diagnostics
proposal.

The actual `8abd410` diagnostic image also ran during the successful fresh
Claude streaming/cancellation/parallel sweep. Its running binary was checked by
hash, diagnostics were projected before Pod removal, and the stock proxy was
restored. No 401 occurred in that bounded capture; this is not a fix or root
cause for the earlier native authentication failures. See
[the live evidence](AGYN-PORTABILITY.md#fresh-lifecycle-sweep).

The subsequent SSE addition `17c0f0f` observes only the first declared Anthropic
`event: error` from unencoded SSE, with the existing 8 KiB diagnostic bound and
allowlists. It retains the actual HTTP status (including 200), relays original
bytes incrementally and does not change retry, metering or agent outcomes.
Combined `c47f0e5` passes all 121 race entries with the separate gzip correction.
Existing parser buffering and HTTP-200 error-stream metering remain separate
hardening work. No captured live SSE error has explained the native 401.

A dependent review unit is pushed as `feat/native-request-diagnostics`,
`f4ddd0f`. `NATIVE_REQUEST_DIAGNOSTICS=true` explicitly enables fixed metadata
before forwarding and when headers or a transport failure arrive; it defaults
off. Only validated binding/call UUIDs, endpoint/method/content-type categories,
stream and credential-presence booleans, and the actual status are logged. No
raw URLs, queries, headers, models, body keys/values or credentials are recorded.
Build/vet and 136 selected race entries pass, again excluding only the known
gzip test. The current combined branch `ab57552` passes all 139 race entries
without test exclusions; its only difference from `f4ddd0f` is the separate
gzip test correction. Both branches are pushed; no upstream PR is open.

The [prepared-stack Claude report](AGYN-PREPARED-CLAUDE.md) records the failed
parallel attempt under each diagnostic generation and the passing streaming
fixture. The latest failed instance has no recorded Messages request while its
peer has four successful proxied Messages calls. This narrows the investigation;
it is not a credential fix or proof of reliable parallel execution. All temporary
proxy overlays and subscription credentials are removed afterward. Main's
bounded diagnostic projections and existing regressions pass all 444 tests.

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
