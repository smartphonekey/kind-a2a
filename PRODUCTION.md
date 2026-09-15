# Production Readiness

Status: implementation in progress. The existing 0.4.0 Agyn adapter is a trusted
local lab, not a production deployment. Passing the baseline tests does not
remove any of the gates below.

Current installed state: the reviewed prepared Agyn stack is deployed and
retained locally, with registry migrations through `0022`, digest-pinned images
and scoped runner RBAC. All four upgraded services are ready. Completed-turn
Codex A2A continuation passes with the same session and exact PVC identity
across two removed Pods. The [rollout report](AGYN-PREPARED-ROLLOUT.md) is the
current deployment record; restoration/no-deployment statements in historical
fixture rows below describe those earlier tests, not permission to restore old
clients onto the upgraded registry.

Latest acceptance: all five Codex lifecycle scenarios pass on the final
readiness-corrected service and retained prepared stack. Controller SIGKILL and
Pod loss preserve a non-idempotent append; explicit reconciliation retires the
old request without replay. Cancellation, parallel/FIFO work, blocking/streaming
continuation and completed-turn recovery also pass. Final read-only verification
finds four ready upgraded services, 57 passing permission checks, 60 unchanged
original PVCs, 72 retained task claims and zero task Pods/unconfirmed removals.
That is the final Codex snapshot, before the newer Claude fixtures. The
[prepared-stack Claude report](AGYN-PREPARED-CLAUDE.md) now verifies completed
continuation, explicit interrupted recovery, cancellation and streaming. Three
parallel attempts fail with native 401; request metadata points toward routing
or pre-forwarding investigation but does not establish a cause. Final cleanup
retains all 72 prior claims, 83 total task claims and zero task Pods/unconfirmed
removals. The subsequent [native DNS correction](AGYN-NATIVE-DNS.md) is retained
on the prepared-compatible orchestrator and passes all five scenarios for both
Claude and Codex with the stock proxy, plus a Claude diagnostic parallel run.
All 83 prior claims are preserved, with 97 total and zero task Pods/unconfirmed
removals. The
credential-free native fixture reproduces the dual-resolver interception bypass
and verifies single/unavailable-resolver controls. Infrastructure fencing,
security, sustained reliability and operations gates remain.

The subsequent [prepared Secret ownership correction](AGYN-PREPARED-SECRETS.md)
passes source/full race tests and eight isolated native Kubernetes scenarios,
including four runner SIGKILL checkpoints and two late credential writes after
Pod removal. It stages Secrets until the gated Pod exists and creates ownership
atomically, then commits setup readiness separately. All 105 existing PVCs and
52 deployment snapshots are unchanged. This dependent fix is **not installed**;
that fix alone does not implement unknown-prepare discovery/reconciliation.

The next [lost preparation recovery proposal](AGYN-PREPARED-RECOVERY.md) now
passes source, native Kubernetes and combined PostgreSQL/controller-process
acceptance for present, verified gated Pods. Recovery persists removal intent,
observes exact identities and uses existing checked binding/removal commands,
without replaying preparation or activation. Initially absent/late Pod/PVC
creates still retain admission and require fencing/reconciliation. These changes
are **not installed**; external credential revocation, all-writer upgrades and
the coordinated DNS-compatible real-agent rollout remain release work.

The [native resource-anchor follow-up](AGYN-RESOURCE-ANCHORS.md) now passes
ordinary/full race and isolated Kubernetes acceptance, including actual delayed
Pod/PVC creation and both activation/revocation CAS orderings. It separates
transient workload owners from persistent volume owners. Registry persistence,
controller migration, checked anchored-volume retirement and all-writer rollout
are **not implemented** by this native milestone. It is **not installed** and
does not close the overall initially absent/late-create recovery gate.

The dependent [anchor registry integration](AGYN-ANCHOR-REGISTRY.md) now passes
618 full race entries with both real PostgreSQL gates enabled, plus 1,600
repeated focused entries. It persists owner identities and exact reservation
receipts before preparation authority, rejects old writers, and preserves
existing prepared history through migration `0023`. It is **not installed**;
checked anchored-volume retirement, durable cleanup and coordinated A2A rollout
remain required. The later [controller integration](AGYN-ANCHOR-CONTROLLERS.md)
implements both owner paths and fixes actual inbox-thread validation with
additive registry migration `0024`. It passes 761 ordinary and 760 selected race
entries; registry ordinary/full race runs pass 620 each. A DNS-compatible source
combination also passes. Final combined native acceptance passes 41 entries,
with no failures/skips; its separate DNS-compatible subset passes seven entries.
All 105 existing PVCs and 52 deployment snapshots are unchanged. None of these
changes is installed.

The dependent [anchored workspace retirement](AGYN-ANCHORED-RETIREMENT.md)
now passes source, real PostgreSQL and combined native/process verification.
Eight crash scenarios and two native late-PVC/owner-replacement scenarios pass;
all 108 current PVCs and 52 deployment snapshots are preserved. The four focused
branches are pushed but **not installed**. This closes the bound anchored-volume
retirement implementation gap, not initially absent/late-prepare recovery,
durable cleanup, authenticated fencing or coordinated production rollout.

The next [preparation-revocation implementation](AGYN-PREPARATION-REVOCATION.md)
adds integrated native/registry/controller recovery for initially absent,
unbound preparations with persisted anchors. Native and combined process
acceptance pass; late workspace discovery retains the original physical UID.
All four dependent branches are pushed. The existing execution regression passes
all 41 entries; the DNS-compatible source separately passes its 19-entry native
revocation matrix and unfiltered race/vet checks. Installed resources are unchanged.
This updates that narrow source gap, not the broader production gate. It is
**not installed**, and does not settle an accepted A2A request with no registry
workload, replay interrupted execution, authenticate all future writers or fence
a partitioned node. Coordinated deployment and real-agent regressions remain.

The latest [checked-volume acceptance](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance)
now combines real PostgreSQL, registry RPCs, controller process replacement and
native Kubernetes deletion. It does not use the A2A driver or deployed Agents
service, and does not remove the coordinated rollout or infrastructure gates.

The separate [native transport restriction](AGYN-RUNNER-TRANSPORT.md) now closes
the full plaintext control API alongside a Ziti-enabled runner at source level.
Independent and combined race/startup tests pass; real overlay-policy audit,
backend incarnation and deployed acceptance remain open. No deployment changed.

[Backend-bound volume inventory/removal](AGYN-VOLUME-BACKEND.md) now passes
isolated real Kubernetes/PostgreSQL/process acceptance, including wrong-runner
routing and old-runner rejection. Workload-start backend pinning, authenticated
routes, node/late-operation fencing and coordinated A2A rollout remain open.

## Objective

Expose Agyn agents over A2A with an isolated, durable environment per agent/task,
concurrent execution across tasks, serialized execution within a task, and no
running workload between turns. Follow-up messages retain the task's identity,
runtime profile, agent session and workspace. Switching the operator-selected
agent profile must not change the A2A controller or workflow implementation.

## Gates

| Gate | Status | Required evidence |
| --- | --- | --- |
| Unbound preparation revocation | Source and native/process acceptance verified; not installed | [Distinct native proof and two-step registry cleanup](AGYN-PREPARATION-REVOCATION.md) preserve workspace identity without fabricating a Pod binding or replaying execution. Native 15-entry and combined 19-entry fixtures pass; registry full race passes 838 entries with real PostgreSQL. The focused controller passes the complete 41-entry execution regression. Its separate DNS-compatible combination passes 879 ordinary/full race entries with seven gated skips, unfiltered vet/build and the 19-entry revocation matrix; Gateway compatibility passes 363 full race entries. All dependent branches are pushed. Existing-workspace adoption, backup/restore of new metadata, DNS-compatible coordinated rollout, durable credential/receipt cleanup, accepted-request-without-workload recovery, authenticated fencing and hardening remain required. |
| Anchored workspace retirement | Source and combined native/process acceptance verified; not installed | [Four dependent contributions](AGYN-ANCHORED-RETIREMENT.md) persist exact intent and PVC/owner absence without old-API fallback, owner substitution or reopening. Registry ordinary/full race suites pass 752 entries each; native race passes 636 with seven gated skips; controller ordinary/selected race passes 789/788 with six gated skips and the known test-race exclusion. Eight real controller SIGKILL scenarios plus groups/parent pass 11 entries, and native late-child GC/replaced-owner cases pass three entries. All 108 prior claims and 52 deployments are unchanged. Unknown first provision, durable cleanup, authenticated future-write/node fencing and coordinated A2A rollout remain open. |
| Resource anchor controllers | Source and combined process acceptance verified; not installed | [Both controller paths](AGYN-ANCHOR-CONTROLLERS.md) persist native workload/volume ownership before preparation, preserve exact reservation receipts, and require Pod removal plus workload-owner absence before confirmation. Real assembler identity and distinct inbox-thread regressions are fixed. Ordinary/selected race suites pass 761/760 entries, with five gated skips and the documented group-consumer race excluded; 1,920 repeated anchor entries pass. Final combined native/process acceptance passes 41 entries with no failures/skips. DNS-compatible source with separate test-only `fdf60f9` passes 765 ordinary/full race entries without test exclusion; five gated entries skip and the unrelated vet self-assignment remains. Its native subset passes seven entries with no failures/skips. Initially absent/late resources retain admission; anchored-volume retirement, durable cleanup, remaining clients and coordinated real-agent rollout remain open. |
| Resource anchor registry | Source and disposable PostgreSQL acceptance verified; not installed | [Dependent registry/API contribution](AGYN-ANCHOR-REGISTRY.md) adds dual revisions, immutable workload/volume identities, exact reservation receipts and old-writer guards. The initial Read Committed cancellation/replacement race was reproduced and fixed. Initial 618 full race entries and 1,600 repeated focused entries pass; upgrade preserves 28 prepared workloads and 14 bound volume records. Follow-up `e1a3b7f` adds actual inbox-thread validation through additive migration `0024`; 620 ordinary/full race entries pass, preserving prior anchors. Native receipts in registry-only checks and authorization writes are fixtures; combined native checks are separate above. Remaining wire/client migration, initially absent/late-create recovery, checked anchored-volume retirement, durable cleanup and coordinated real-agent rollout remain open. |
| Native resource anchors | Source and isolated native acceptance verified; integration incomplete | [Dependent API/native capability](AGYN-RESOURCE-ANCHORS.md) pins owner UIDs before gated resource creation and serializes Pod selection/activation with revocation on one ConfigMap. Both 610-entry ordinary/full race suites, 1,060 repeated anchor entries and 15 real Kubernetes scenarios plus parent pass. Registry and controller source have dependent evidence above; anchored-volume retirement, delayed holds/credential reconciliation, authenticated authority and coordinated A2A deployment remain required. Nothing is installed. |
| Lost preparation recovery | Source and combined process verification; not installed | [Dependent API/native/controller proposal](AGYN-PREPARED-RECOVERY.md) discovers only atomic-credential, gated, unexecuted Pods after durable removal intent. Full owner/volume validation and existing CAS persist exact bindings before removal. Native 551 race entries, controller 663 ordinary/662 selected race entries and 1,320 repeated recovery entries pass, with the documented gated skips and known broader race/vet limitations. Native SIGKILL and combined process recovery have separate evidence. Initially absent/late creates, durable credential cleanup, all-writer enforcement, backend authentication/fencing and coordinated deployment remain open. |
| Prepared workload activation | Combined process and both local native-agent matrices verified; production gates pending | [Native and registry proposals](AGYN-PREPARED-WORKLOADS.md) persist gated execution and exact Pod/PVC bindings. [Combined acceptance](AGYN-PREPARED-CONTROLLERS.md#combined-execution-acceptance) passes 22 live scenarios plus three parent/group entries with real PostgreSQL, registry/native RPCs, controller-method subprocesses and Kubernetes execution. Sixteen SIGKILLs cover lost activation ACKs and removal boundaries without redispatch. The [DNS-fixed retained stack](AGYN-NATIVE-DNS.md) passes all five core lifecycle scenarios for both Codex and Claude with exact workspace/session/removal evidence. Its controller suite passes 601 ordinary and 600 selected race entries; five opt-in live/process entries skip, and known unrelated unfiltered race/vet failures remain. Unknown/late prepare recovery, durable credential cleanup, zero-volume placement pins, all-writer enforcement, authentication/fencing and production rollout remain open. |
| Backend-bound volume identity | Source, database and isolated combined native acceptance verified; rollout pending | [Four dependent proposals](AGYN-VOLUME-BACKEND.md) persist namespace identity and use the distinct `RemoveVolumeBound` capability. Old-runner fallback, mixed inventory and mismatched absence are rejected. Migration `0021` refuses unidentified checked history without backfill. All 186 independent/409 combined native race tests, 423 registry race tests, 40 repeated controller test entries and 495 selected controller/native race tests pass. The selected suite excludes exactly the known group-consumer race; full vet retains its unrelated self-assignment failure. Actual overlay authorization, workload-start pinning, cloned-cluster identity, late operations, node fencing, all-writer adoption and A2A rollout remain required. |
| Existing behavior | Baseline preserved | Build and all 449 tests including subtests pass on 2026-09-14, with zero failures/skips, on pinned Node 24.21.0 / SQLite 3.53.4. This includes the preserved baseline, volume audits, rollout/backup/proof guards, credential-safe setup/HTTP/SSE/request diagnostics, five native-DNS fixture admission checks, seven replacement-observation cases and terminal-readiness regression coverage. |
| Prepared rollout and registry restore | Offline rehearsal and retained local rollout verified; production operations pending | [Rollout tooling](AGYN-PREPARED-ROLLOUT.md) waits for actual old-writer Pod deletion before migration and retains reviewed or partial deployments. Legacy mode refuses checked/prepared schemas. The installed registry was privately restored and migrated offline with matching fingerprints before the reviewed four-component rollout through `0022`. All 276 Gateway race entries pass; completed-turn live Codex now passes exact prepared binding/absence assertions. [Scoped RBAC](AGYN-RUNNER-RBAC.md) passes 57 probes; network preflight passes 92. Original task PVCs are retained. External-writer fencing, production Helm packaging, the full real-agent matrix and whole-platform backup/restore remain required. |
| Workload namespace RBAC | Independent chart fix and local permission matrix verified | [Focused runner fix](AGYN-RUNNER-RBAC.md) places Role/RoleBinding in the configured workload namespace while binding the platform service account. Exact Namespace GET is separate. Required Secret get/patch and PVC patch are allowed; Secret listing and cross-namespace workload access are denied. The old broad ClusterRoleBinding no longer grants this service account access. Local resources are an explicit operator overlay, not a reconciled Helm release. |
| Prepared startup Secret ownership | Source and native crash/late-write acceptance verified; not installed | [Dependent runner fix](AGYN-PREPARED-SECRETS.md), `856d1b4` / `1f33556`, creates the gated Pod before credentials, attaches exact ownership in each Secret CREATE and commits readiness only after acknowledged setup. All 521 ordinary/521 full race entries pass; the gated native run passes eight scenarios plus parent, including four actual SIGKILL checkpoints and observed late-write GC. The parent reads interrupted bindings as an operator. Automatic unknown-prepare recovery, late Pod/PVC reconciliation, old ownerless credentials, durable external revocation/GC tracking and coordinated rollout remain open. |
| Durable task ownership and execution | Module/process and live restart verified | Transactional submissions, scoped idempotency, FIFO turns, fenced leases and six-process contention pass. Live controller SIGKILL plus pod replacement recovers a pinned execution without redispatch. Remaining failover/storage boundaries need verification. |
| Authenticated protocol boundary | HTTP/SSE tests verified; deployment pending | Unauthorized and cross-owner send/get/list/cancel/events checks, disconnect/reconnect and subscription credential revocation pass. TLS deployment acceptance remains. |
| Native runner transport | Source, loopback RPC and startup verified; live overlay/rollout pending | [Independent transport fix `c5c467e` / `d0ef963`](AGYN-RUNNER-TRANSPORT.md) restricts plaintext TCP to exact unary readiness when Ziti is enabled. Anonymous/forged-metadata control calls, all streams and future registered services are denied; pending/failed enrollment stays restricted. All 152 independent race tests and 400 test entries across ten repeated transport runs pass. Combined checked-runner `28d77ea` passes 386 race tests, including plaintext checked-removal denial. Build/vet pass. Kubernetes fixtures were not enabled; the startup test uses a fake Kubernetes client and loopback Gateway. Standalone plaintext mode, actual Dial/Bind policy audit, per-owner authorization, backend incarnation, revocation and coordinated deployment remain open. |
| Protocol conformance | Blocking/stream lifetime and real agent continuation verified; full audit pending | [Protocol acceptance](A2A-PROTOCOL.md) now also passes on the coordinated removal stack: a 79.403-second blocking duplicate and two approximately 118-second streams across idle compute release and Pod replacement. Store-driven tests cover races, large snapshots, heartbeat/proxy behavior, bounded slow-reader cleanup, error envelopes and eight-reader fan-out. Error/validation conformance, production ingress, crash recovery and sustained load acceptance remain. |
| Reporting MCP and durable events | Live Codex and Claude verified in gated lab | Real progress/artifact/outcome calls, stdio-to-HTTP relay and private execution-scoped terminal delivery pass. Claude parallel acceptance also verifies distinct execution credentials and rejects reporter access to owner APIs. Hardened delivery/deployment remains. |
| Stop outcome check | Both native reminders and required-init failure verified | Native Codex and Claude Stop reminders caused real MCP outcomes. The false cancellation notice on normal release is corrected; two-turn Claude/Codex Pod tests pass. Required-init failure prevents native CLI startup in a real model-free fixture. Both profiles have completed/streaming reminder evidence; Claude interrupted/cancellation/parallel fixtures also pass separately. Reliability and hardened hook enforcement remain open. |
| Durable runtime | Completed, interrupted and concurrent continuation live verified | Same Agyn instance, native Codex session and PVC across changed pod UIDs. After explicit recovery, an unconditional append remains one line and the old inbox request is acknowledged without execution. Parallel follow-up also preserves identity while another task stays active. |
| Recovery and cancellation | Healthy-runner checks pass on the coordinated removal stack | Bounded/network-profile cancellation settled in 3.074s for Codex and 8.568s in the fresh Claude run, after observed Pod deletion; retained PVC checks showed stopped heartbeats and no late-write markers. SIGKILL/pod-loss quarantine and explicit retirement also pass with all original/replacement workload confirmations. Unknown provider identities still cannot resume. Node partitions and late in-flight creates need fencing/reconciliation. |
| Compute release | Additive contract and controlled failed-Pod release live verified | [The replacement contract](AGYN-REMOVAL.md) passes a coordinated rollout: 15 held-Pod snapshots keep A2A release false despite billing end; physical absence and explicit confirmation precede settlement. No native CLI ran, no queued follow-up dispatched, and the PVC survived. Live old-server/TTL checks, production upgrade audit, orphan/late-create exclusion and node fencing remain required. |
| Parallelism | Real same-agent tasks and FIFO verified for both profiles | [Two live Codex tasks](AGYN-PARALLEL.md) and the [fresh Claude scenario](AGYN-PORTABILITY.md#fresh-lifecycle-sweep) ran in separate pods/PVCs/native sessions; an earlier queued follow-up did not block the other task. Follow-up claim occurred after old-pod removal and reused only its own state while the other task kept advancing. Final turns released all instance pods. |
| Agent portability | Both profiles pass the current local lifecycle matrix; production reliability pending | The [DNS-fixed stack](AGYN-NATIVE-DNS.md) passes completed/interrupted recovery, cancellation, parallel/FIFO and blocking/streaming continuation for Codex and Claude without changing A2A controller/workflow code. A credential-free test with actual Claude reproduces dual-resolver interception bypass; focused agent/sandbox/wait fixes and single/unavailable-resolver controls pass. A separate live parallel run records 20 proxied model responses, all HTTP 200, before repeating the complete matrices with the stock proxy. These results address the reproduced routing path, not every historical native error or sustained production reliability. |
| Sandbox and network enforcement | Pod-network, parallel and lifecycle checks verified after local repair; full gate pending | The repeated credential-free preflight passed 92 checks; real concurrent tasks denied cross-pod TCP/UDP, and completion/interruption/cancellation have passing network-profile reruns. See [network evidence](AGYN-NETWORK.md) and [parallel scope](AGYN-PARALLEL.md). Adversarial hardening, cross-task overlay authorization and fail-closed bootstrap remain required. Unconfined is lab-only. |
| Resource containment | Per-container bounds, shared task-count admission and local A2A quota recovery verified; production gate pending | [Typed API, runner enforcement and flavor/MCP mapping](AGYN-RESOURCES.md) pass source tests, kernel probes and the coordinated five-scenario Codex sweep. [Database-wide admission](SERVICE.md#shared-execution-admission) pins the limit and retains unreleased reservations. [Native quota acceptance](AGYN-RESOURCES.md#native-namespace-quota-acceptance) covers effective init/sidecar accounting and competing starts. The [existing-task A2A rejection/recovery scenario](AGYN-RESOURCES.md#a2a-quota-recovery) passes with one persisted inbox receipt, explicit confirmation, no capacity-triggered retry and acknowledgement-only retirement. The separate first-PVC scenario below also passes. Whole-task cost reporting, agent OOM recovery, sizing, protected quota bootstrap and mandatory production profiles remain required. Stock deployments are restored with no permanent workload quota. |
| First-provision cleanup | Deployed first-PVC rejection and explicit recovery verified; production gate pending | [First-provision evidence](AGYN-RESOURCES.md#a2a-first-provision-recovery) includes the failed image-only rollout, missing Secret-read RBAC diagnosis and focused fix `9002f31`. Native quota stages now pass using the chart's service-account permissions, without Secret listing; both focused and combined race suites pass. The real A2A rerun preserves task/instance/volume identity, retires the rejected inbox item without execution and completes two native turns across Pod replacement. All 49 prior PVCs and 16 older Secret identities are unchanged; stock deployments and temporary RBAC are restored. The newer volume-ownership rerun below preserves all 50 prior claims. Named-PVC identity enforcement, crash-orphan reconciliation, late-create/node fencing and post-success Stop/Remove cleanup remain required. |
| Volume ownership | Closed-record, native PVC and combined A2A checks verified; production gate pending | [Runners ownership](AGYN-RESOURCES.md#closed-volume-ownership) passes real PostgreSQL contention and deployed recovery. Independent named-PVC `7d3238a` passes source/native Kubernetes tests; combined `641e2f7` now passes build, full race, credential-rollback/PVC-conflict tests and [deployed first-provision A2A acceptance](AGYN-RESOURCES.md#combined-a2a-acceptance). The rejected request is retired without execution and two native turns retain workspace/session identity. Sandbox open-record validation, safe deletion, authentication, late-create/node fencing and upgrade of all writers remain required. Stock services are restored, not permanently fixed. |
| Volume inventory and orphan retention | Independent and combined native checks verified; production gate pending | [Orchestrator retention `72e1b22` and complete runner inventory `40b35ce`](AGYN-VOLUME-SAFETY.md) prevent stale/scoped-list orphan deletion and reject incomplete/ambiguous inventory. Both fixes and combined `f65a9f6`/`d03831f` pass source and real runner/Kubernetes acceptance. All 60 existing PVC identities/specs/phases are unchanged; fixture namespaces are gone. Registry/Agents clients in this test are fakes, no platform deployment changed, and no new A2A lifecycle sweep ran. Authenticated incarnation-bound deletion, physical confirmation, ownership-aware garbage collection, all-writer rollout and late-create/node fencing remain required. Truly unknown disks are retained, not automatically reclaimed. |
| Checked volume deletion | Combined process acceptance verified; coordinated A2A rollout pending | [Checked removal](AGYN-CHECKED-VOLUMES.md) adds immutable bindings/intents, revision CAS, old-writer guards and physical-absence confirmation. Caller migration `eebf4cf` routes every orchestrator/sandbox volume mutation through checked APIs. [Follow-up `5449301`](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance) now verifies real PostgreSQL/migrations, registry RPCs, controller subprocesses and native Kubernetes deletion for both owner kinds. SIGKILL after begin, native deletion and registry confirmation preserves committed state; old-UID replay cannot delete a replacement. Build and 488 ordinary tests pass; 491 selected race tests pass with both native fixtures enabled and exactly the known group-consumer test excluded. Unfiltered race/vet limitations remain. Agents metadata and authorization writes are stubs; A2A acceptance, backend identity, authorization, all-writer rollout, garbage collection and late-create/node fencing remain required. All 68 existing PVCs, including 60 task claims, and all 41 platform deployments are unchanged; nothing is permanently deployed. |
| Workload admission and volume deletion | Registry contention and combined controller/native races verified; rollout pending | [Dependent Runners guard `f05b479`](AGYN-CHECKED-VOLUMES.md#workload-admission) serializes checked-owner admission with deletion, retains unconfirmed predecessor reservations and protects workload identity/confirmation from old SQL. Build, vet and all 335 registry race tests pass with both real PostgreSQL fixtures enabled. Forty-eight blocked interleavings cover both owner kinds, all isolation settings, rollback and competing starts while another owner progresses. Upgrade refuses contradictory history without rewriting it. [Combined process acceptance](AGYN-CHECKED-VOLUMES.md#combined-process-acceptance) now forces both controller/registry admission-deletion orderings against native PVCs, preserves another owner's progress and verifies process recovery with independent SQL reads. Workloads are unused reservations, not native Pod starts. Coordinated migrations `0017`-`0019`, all-writer audit and A2A rollout remain required; this does not establish late-create/node fencing. |
| Checked-volume upgrade | Pre-rollout audit and local schema upgrade verified; legacy reconciliation pending | [The pre-rollout capture](AGYN-PREPARED-WORKLOADS.md#installed-state) at 14:56:10 UTC found 61 legacy records, 60 matching task PVCs and 125 confirmed workloads before migrations `0018`-`0022`. Its 79 audit tests and 66 findings granted no adoption or deletion authority. The later [retained rollout](AGYN-PREPARED-ROLLOUT.md) installs those migrations and compatible reviewed clients after an offline restore rehearsal; it does not automatically adopt legacy volumes. Explicit reconciliation, all-writer enforcement, authenticated backend identity and the full upgraded-stack A2A matrix remain required. |
| Legacy volume adoption | Registry guards, upgrade and native compatibility verified; coordinator/drain pending | [Dependent Runners `748d283`](AGYN-CHECKED-VOLUMES.md#legacy-adoption-guards) reuses checked bind with a known recorded name, zero unconfirmed predecessors and immutable persistent identity; ordinary reopen cannot opt legacy failures in. Migration `0020` preserves historical rows and serializes adoption with workload admission. All 419 registry race tests pass, including 32 blocked interleavings, both owner kinds and all isolation settings; build/vet/module verification pass. The combined process/native fixture also passes with the new registry. It does not adopt installed data, authenticate the backend, drain writers or fence delayed operations. All 68 existing PVC identities/specs/phases and all 52 deployment identities/generations/images/replica counts/readiness across namespaces are unchanged. Full A2A rollout and explicit legacy reconciliation remain required. |
| Startup reliability | Terminal-readiness and resolver races corrected locally; sustained reliability pending | [The terminal-readiness fix](AGYN-PREPARED-ROLLOUT.md#terminal-readiness-race) waits for published running MAIN inventory before the single terminal attempt. The separate [native DNS correction](AGYN-NATIVE-DNS.md) removes the ordinary fallback resolver from Ziti workloads and readiness checks while preserving upstream forwarding. Both native-agent lifecycle matrices pass on the retained combination. Read-only diagnostics retain restricted metadata, not raw runtime-error storage or authoritative outcomes. Interception startup, earlier unclassified failures and sustained load/failure reliability remain release work. |
| Operations | Coordinated local rollout, restoration, retention and migration verified | 70 subprocess cases cover rollout/restoration and guards, including optional proxy diagnostics. The latest Claude sweep verifies all five stock deployment UIDs/settings/readiness restored, temporary Role/RoleBinding removed, unchanged ClusterRole, zero task Pods/Services/quotas, all 56 prior claim UIDs/specs/phases and 16 older Secret identities unchanged, and 60 retained claims. Independent database/Gateway checks retain six removal confirmations and four paused instances with active persistent/no-TTL workspaces. Temporary provider bindings were deleted; the host credential file is unchanged. Prior failure and PVC-recovery audits remain separate. Production admission/load, draining, readiness, storage backup/restore, active upgrade, retention and disaster recovery remain required. |
| Upstream contribution | Focused branches pushed; no upstream PR submitted | API, Runners, orchestrator, Gateway, SDK and runner branches retain separate review boundaries and licenses; new service/reporting code is AGPL-3.0-only. The new [workload-namespace RBAC fix `92b25e9`](AGYN-RUNNER-RBAC.md) is independently tested and pushed, separate from prepared API changes. Earlier diagnostics, session, resource, ownership, inventory, checked-volume and backend-identity branches retain their evidence in [the contribution guide](CONTRIBUTING-AGYN.md). Checked/prepared contracts require coordinated dependencies and are not published APIs or drop-in images. Acceptance combinations are not bundled upstream proposals. Broader daemon/orchestrator race and vet limitations remain disclosed. |

Eight additional dependent prepared-workload branches cover the
[native lifecycle](AGYN-PREPARED-WORKLOADS.md) and
[registry persistence](AGYN-PREPARED-REGISTRY.md), plus
[both controller paths and read-only inspection](AGYN-PREPARED-CONTROLLERS.md),
and [Gateway wire compatibility](AGYN-PREPARED-ROLLOUT.md#gateway-compatibility),
separate from the focused contributions above. Controller source is
migrated; follow-up `754e935` adds combined real execution/process acceptance on
the same branch. Full prepared-stack A2A acceptance and production enforcement
are required before production rollout.

Native session persistence is required for correct continuation. Bulk session
analytics, auto-improvement pipelines and prompt/tool customization UI are next
steps, not substitutes for the gates above.

## Contribution Boundaries

- `src/service/`: A2A task ownership, execution scheduling and durable events.
- Agyn adapter: translate provider operations; no LLM-specific control logic.
- Reporting MCP: generic progress and outcome contract, separate from chat.
- `agynio/agynd-cli`: generic persistent state location and lifecycle hooks.
- `agynio/architecture`: discuss the contract before declaring a native API.
- API/Gateway changes are separate PRs only where existing APIs cannot meet the
  agreed contract. Runtime images remain binary packaging.

The first storage implementation uses SQLite WAL on a single local/PVC
filesystem, with transactions and fencing across local worker processes. WAL
must not be put on a shared network filesystem. A production storage profile,
backup/restore procedure and failover tests remain release gates; this is not a
claim of multi-node HA.

The service and admission CLI now check for SQLite's
[WAL-reset fix](https://www.sqlite.org/wal.html#walreset) before opening the task
database. Node 24.21.0 / SQLite 3.53.4 passes the full suite; the former host
default Node 22.20.0 / SQLite 3.50.4 is rejected. This is a runtime prerequisite,
not a reproduction of the corruption race or a complete storage reliability
proof. Production runtime packaging, restore and migration acceptance remain.

## References

- [Checked anchored workspace retirement and crash/late-PVC acceptance](AGYN-ANCHORED-RETIREMENT.md)
- [Resource-anchor controllers, combined native acceptance and remaining rollout](AGYN-ANCHOR-CONTROLLERS.md)
- [Native resource anchors and delayed creates](AGYN-RESOURCE-ANCHORS.md)
- [Prepared controller migration, native inspection and remaining combined acceptance](AGYN-PREPARED-CONTROLLERS.md)
- [Backend-bound volume operations, wrong-runner acceptance and upgrade gates](AGYN-VOLUME-BACKEND.md)
- [Native runner transport restriction and remaining authentication gates](AGYN-RUNNER-TRANSPORT.md)
- [Service setup and current limitations](SERVICE.md)
- [Gated live integration and reproduction](AGYN-REPORTING.md)
- [Network enforcement failure, repair and acceptance](AGYN-NETWORK.md)
- [Live parallel tasks and same-task FIFO](AGYN-PARALLEL.md)
- [Compute resource enforcement and remaining profile acceptance](AGYN-RESOURCES.md)
- [Volume inventory, orphan retention and deletion-safety gates](AGYN-VOLUME-SAFETY.md)
- [Checked volume API, registry guards and native deletion acceptance](AGYN-CHECKED-VOLUMES.md)
- [Blocking/streaming protocol acceptance and remaining audit](A2A-PROTOCOL.md)
- [Second-agent portability evidence and remaining integration](AGYN-PORTABILITY.md)
- [Failed-Pod incident and explicit removal confirmation](AGYN-REMOVAL.md)
- [Contribution guide and patch evidence](CONTRIBUTING-AGYN.md)

- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Blocking SendMessage requirements](https://a2a-protocol.org/latest/specification/#322-sendmessageconfiguration)
- [Agyn architecture conventions](https://github.com/agynio/architecture)
- [Agyn daemon development](https://github.com/agynio/agynd-cli)
- [Current lab acceptance](ACCEPTANCE.md)
