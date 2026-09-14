<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Agyn Compute Resource Enforcement

Status: source-level integration, credential-free kernel enforcement and real
resource-bounded Agyn lifecycle acceptance passed on 2026-09-13. The operator
wrapper temporarily deployed the combined images, then restored the stock
deployments. This is not a permanent production upgrade. The service's
[shared task-count admission](SERVICE.md#shared-execution-admission) also passes
local multi-process and delayed-release tests on 2026-09-14. A separate real
runner/Kubernetes quota test now passes, including supporting-container usage,
concurrent admission and release. The coordinated local A2A quota-recovery
scenario also passes with an existing task workspace and native Codex session.
A separate runner fix now passes native first-provision rejection and startup
secret cleanup, including preservation of a partially created PVC. A deployed
[first-PVC rejection and explicit A2A recovery](#a2a-first-provision-recovery)
also passes after fixing the runner's missing Secret-read permission. Stock
images and permissions were restored afterward. Whole-task accounting,
production quota rollout, sizing and adversarial hardening remain
release gates; an execution count is not a CPU/RAM or physical-container budget.
Independent [closed-record](#closed-volume-ownership) and
[named-PVC](#named-pvc-ownership) ownership checks now have separate passing
acceptance. The latter has native Kubernetes evidence, not a deployed A2A rerun.

The resource measurements remain valid, but these historical lifecycle images
do not implement the new [removal-confirmation contract](AGYN-REMOVAL.md).
An unrelated failed-Pod case disproved billing `removedAt` as deletion evidence.
The new service requires coordinated Runners/Gateway/orchestrator updates before
repeating the model tests. The later coordinated five-scenario sweep is recorded
in [the replacement contract](AGYN-REMOVAL.md); the historical image recipe below
must not be used as a current confirmation-capable deployment.

## Problem And Contract

The previously observed agent Pods had no CPU/memory requests or limits on their
main, init or sidecar containers. A runner flavor existed in the catalog, but the
runner API had no typed container resource field and the orchestrator did not
transmit the selected flavor's allocations. Separate Pods and PVCs alone do not
bound CPU or memory consumption.

Three focused contributions implement an opt-in `compute-resources` capability:

| Repository | Commit | Scope |
| --- | --- | --- |
| [API](https://github.com/spk-ai/api/tree/feat/container-resource-limits) | `a760da3` | Additive typed `ContainerSpec.resources` and required capability contract. |
| [Kubernetes runner](https://github.com/spk-ai/k8s-runner/tree/feat/container-resource-limits) | `1e7def5` | Validate before Kubernetes access; enforce main, init, sidecar and injected-container bounds. |
| [Orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/feat/container-resource-limits) | `d732aa9` | Pass the selected flavor's main bounds and explicit MCP bounds, retaining the capability. |

All branches are `feat/container-resource-limits`. No upstream PR is submitted.
The API must be published before normal downstream BSR generation can consume
it; the downstream READMEs describe local source generation for review.

For opted-in requests, all four main fields are required and positive, with
requests no greater than limits. The runner rejects quantities it cannot
represent, sub-millicore CPU and fractional-byte memory. Explicit partial/empty
messages fail; absent supporting messages use complete operator-configured
`SUPPORTING_CONTAINER_RESOURCES`. Defaults cover regular/restartable init,
normal sidecars and Docker containers injected by the runner. There is no
built-in default. The runner advertises the capability only when its supporting
configuration is valid. Resource fields without the required capability fail;
legacy requests with neither remain unchanged.

Bounds are **per container**, not a single task budget. Supporting allocations
are additional to the main flavor. Orchestrator accounting includes the flavor
and explicit MCP requests, but not all runner-owned defaults or Pod overhead.
Task count, CPU/RAM aggregate quotas, storage, PIDs, IO and network controls are
separate concerns. No runtime security profile or host configuration is relaxed
by this change.

## Verification

- API: `buf lint` and `buf breaking --against '.git#branch=main'` pass.
- Runner: ordinary `go test ./...` and full `GOMAXPROCS=4 go test -race ./...` pass.
- Orchestrator: ordinary `go test ./...` and full assembler race tests pass.
  The previously documented unrelated reconciler race is not claimed fixed.
- Unit tests cover malformed bounds, missing capability/configuration, unchanged
  legacy requests, no request mutation, independent default maps, and invalid
  requests making **zero** Kubernetes calls even when PVCs/secrets were requested.
- Assembly tests prove the selected flavor replaces deprecated agent resources
  only for opted-in agents, explicit MCP bounds survive, and partial overrides
  fail without silently becoming defaults.
- Prepared combined branches: runner `4dd12a8`, orchestrator `5edf8a4`, both named
  `lab/resource-integration` and pushed. Both ordinary Go suites and the runner
  ingress/egress Helm verification pass. The combined orchestrator race suite
  passes with the documented unrelated
  `TestGroupMembershipConsumerLoopRetriesWithoutBlocking` excluded; this is not
  an unfiltered race-suite claim. All 62 lab tests still pass.

### Live Kernel Enforcement

The opt-in runner test calls the real RunnerService through a loopback gRPC
server backed by the real Kubernetes client. It creates a private random
namespace with deny-all ingress/egress policy, no PVCs or credentials, and a
digest-pinned Node.js image. It does not register with Agyn's orchestrator or
change the running runner/orchestrator deployments. Every stress process reads
and verifies its own cgroup v2 caps **before** allocation or busy looping;
the memory loop is also finite if enforcement disappears.

Environment: local K3s `v1.33.1+k3s1`, containerd `2.0.5-k3s1`, Linux amd64.
Run ID: `d7ab4862-e3fc-47ae-8f23-744920e7da27`.
Temporary namespace: `runner-resources-x6bz8`.
Test duration: 57.85 seconds; all assertions and cleanup passed.

| Check | Observed evidence |
| --- | --- |
| Main cgroup | `250` millicores and `134217728` memory bytes. |
| CPU enforcement | 5004.035 ms elapsed, 1256.403 ms process CPU, throttled periods increased from 1 to 51. |
| Supporting cgroups | Regular init, restartable init and normal helper each reported `500` millicores and `134217728` memory bytes. |
| Memory exhaustion | After verified bounds, the retained-buffer probe ended with `OOMKilled`, exit `137`. |
| Neighbor isolation | Control Pod UID `daa5d316-b701-4b60-8200-0e963d1a71f9` remained ready with zero restarts; heartbeat advanced after the OOM. |
| Resource release | StopWorkload was followed by independent Pod GETs confirming NotFound for all three Pods. The namespace was also confirmed absent. |

Removed Pod UIDs:

- CPU: `3f8f9efe-7b89-4537-90e8-630e18c3c25b`.
- Memory: `fbd83cf0-593c-4b1b-babc-e235326b9916`.
- Control: `daa5d316-b701-4b60-8200-0e963d1a71f9`.

Reproduction, after local API generation from the focused branches:

```sh
cd /home/alex/work/agyn-contrib/k8s-runner
env GOMAXPROCS=4 \
  RUNNER_LIVE_RESOURCE_TEST=trusted-local \
  RUNNER_LIVE_KUBECONFIG=/home/alex/work/aira-a2a-lab/.state/agyn-kubeconfig \
  RUNNER_LIVE_NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 \
  go test -v ./internal/server -run '^TestLiveComputeResources$' -count=1 -timeout=6m
```

Run only in an explicitly selected trusted local lab. Ordinary tests skip this
fault injection. Cleanup checks ownership and refuses to delete foreign Pods,
PVCs or unexpected secrets. The policy installation here is not an independent
CNI enforcement proof; [network acceptance](AGYN-NETWORK.md) covers that separately.

The observed behavior matches Kubernetes v1.33's documented
[CPU throttling and reactive OOM enforcement](https://v1-33.docs.kubernetes.io/docs/concepts/configuration/manage-resources-containers/#requests-and-limits).
No Pod-level alpha resource feature is needed.

## Native Namespace Quota Acceptance

The independent runner chart branch
[feat/workload-resource-quota](https://github.com/spk-ai/k8s-runner/tree/feat/workload-resource-quota)
at `28d4562` adds an operator-selected namespace budget using Kubernetes
ResourceQuota. It does not change the runner binary, API, A2A controller or
workflow. It is disabled by default; enabling it requires explicit totals for
`requests.cpu`, `requests.memory`, `limits.cpu`, `limits.memory` and `count/pods`.
Rendering rejects an absent, dynamic, duplicate or mismatched runner
`KUBE_NAMESPACE`, incomplete budgets and unsupported scope options. It adds no
implicit container limits. Helm/render, existing network-policy checks, full
runner race tests and `go build ./...` pass on the focused branch.

The lab-only [quota integration branch](https://github.com/spk-ai/k8s-runner/tree/lab/quota-integration)
combines that chart with the existing typed-resource implementation. Test source
`dc67264d9ecd648705950e493ebde01c23fff05e` uses local API
`3c84a6a9e60ccb869aa9ac2a045875a6832f2568`. Ordinary combined runner race tests
pass with both live fixtures disabled. No upstream PR has been submitted.

### Real Runner And Kubernetes Evidence

`TestLiveWorkloadQuota` passed in **35.82 seconds** on 2026-09-14, using local K3s
`v1.33.1+k3s1`. It renders the real chart and calls the real RunnerService through
loopback gRPC backed by Kubernetes. Run ID:
`0025c4dc-7559-47d3-b689-0e0f5519a29e`; temporary namespace `runner-quota-hglt5`,
UID `a2618fab-5780-4f06-8668-3c436644ab0a`.

The pinned image built from `ops/Dockerfile.agyn-quota-probe` defaults to UID
1000. Main, helper, restartable init and regular init each checked their UID and
real cgroup caps before sending bounded heartbeats. No model/backend, provider
credentials, PVCs, service-account token, Pod volumes or stress loops were used.
A deny-all ingress/egress policy was installed in the owned temporary namespace;
this fixture does not independently verify CNI enforcement.

| Check | Observed evidence |
| --- | --- |
| Assembled-Pod usage | Heavy Pod plus neighbor used `550m`/`288Mi` requests, `1750m`/`448Mi` limits and two Pod objects. The heavy Pod includes a helper, restartable init and larger regular init; these are not main-only totals. |
| Real container caps | Main: `250m`/`128Mi`; helper and restartable init: `500m`/`64Mi` each; regular init: `1` CPU/`256Mi`. Each probe reported UID 1000 and the run nonce. |
| Independent CPU/RAM admission | Each of the four resource quota keys independently rejected a candidate with gRPC `PermissionDenied` and the native exceeded-quota reason. Each rejected Pod was confirmed absent. |
| Existing work | Neighbor heartbeat advanced during the quota rejections. |
| Terminal object capacity | A Succeeded Pod released compute quota but retained a `count/pods` slot; another start was rejected until the object was removed. |
| Concurrent admission | Six real gRPC starts competed for one remaining Pod slot: exactly one accepted, five quota rejections, zero rejected Pods present. |
| Release and cleanup | All four admitted Pods were stopped and independently confirmed absent. All five used quota values returned to zero, then namespace removal was confirmed. |

Admitted Pod UIDs were `2d766738-e27b-4692-ad70-70527c9ee3ef` (heavy),
`8c1e3cf2-3be3-4965-9ae8-ffd23e2278db` (neighbor),
`85007129-f022-4cf5-8a4f-1bb3e2d98a03` (completed), and
`9ddbc671-a27a-457a-92e1-1ff26a7ee4a0` (concurrent winner).

The independent post-run audit confirmed all **48** original PVC UIDs, specs and
phases unchanged; all four stock deployment UIDs, generations and specs unchanged
and ready; the original network policy unchanged; and zero workload Pods,
Services or ResourceQuotas in `agyn-workloads`. No PVC was created or deleted.
Private evidence is under `.state/quota-probe-build-ILcTYL/`: `live-bdmvwF/run.json`,
`live-bdmvwF/go-test.log`, `before.json` and `post-audit.json`. None is committed.

### Reproduction And Remaining Boundary

Use the combined runner checkout with local API bindings and Helm dependencies
generated as described in its README. The following digest is the independently
verified, already-loaded local fixture image, not a public registry artifact.
For another cluster, build the tracked Dockerfile using an empty build context,
load it and use its verified digest reference instead.

```sh
cd /home/alex/work/agyn-contrib/k8s-runner-quota-integration
env -u RUNNER_LIVE_RESOURCE_TEST GOMAXPROCS=4 \
  RUNNER_LIVE_QUOTA_TEST=trusted-local \
  RUNNER_LIVE_KUBECONFIG=/home/alex/work/aira-a2a-lab/.state/agyn-kubeconfig \
  RUNNER_LIVE_NODE_IMAGE=docker.io/library/a2a-quota-probe@sha256:d086089ef330d40f93bd673d886b440f72668095e1d9f4a6fdb1a7cd1ee9f4e6 \
  go test -v ./internal/server -run '^TestLiveWorkloadQuota$' -count=1 -timeout=6m
```

This establishes controlled admission of assembled Pods, not a global budget
across all namespaces or a replacement for the service's durable task scheduler.
Kubernetes applies its own effective init/sidecar accounting; no parallel
production resource arithmetic was added. See the native
[quota contract](https://v1-33.docs.kubernetes.io/docs/concepts/policy/resource-quotas/)
and [sidecar accounting](https://v1-33.docs.kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/#resource-sharing-within-containers).

The stock Agyn runner has no permanently installed workload quota. This
PVC-free test does not prove A2A recovery; the separate native scenario below
now covers a rejected follow-up with an existing workspace. The current runner
creates supporting resources before Pod creation; the separate
[first-provision runner fix](#native-first-provision-failures) below now has
controlled acceptance, but coordinated A2A recovery is still required.
The chart does not fix orchestrator whole-task cost reporting,
add typed quota errors/retries, enforce producer bootstrap or mandatory profiles,
or establish agent OOM recovery, tenant fairness, storage/PID/IO bounds or node
partition fencing. UID 1000 in this fixture is not a hardened production agent
security profile. These gates remain open.

## A2A Quota Recovery

On 2026-09-14, source `56fb17940e9234a4c7ab25b643b0452d021cc038` passed a real
native Codex/A2A test on the coordinated removal-confirmation stack. The complete
wrapper run, including deployment/restoration, took **139.508 seconds** from
01:36:11.236Z to 01:38:30.744Z. Credential-free network preflight `ab2818aa` first
passed all 92 checks and confirmed cleanup. Build and all **205 local tests**
pass (186 top-level), including six quota-proof tests and nine new wrapper cases.

The new operator-only scenario uses the existing A2A controller, worker and Agyn
driver unchanged. It installs the real reviewed chart's quota in the otherwise
idle workload namespace, completes one native turn, temporarily changes only
`count/pods` to zero, and submits a follow-up. It then restores the original
budget, requires explicit owner reconciliation and sends a new continuation.
The rejected request is never resent. Only the existing ChatGPT subscription
reference is used; no host provider credentials are copied or paid API fallback
enabled. The bounded resource/network profile remains explicitly `trusted-local`.

| Check | Observed evidence |
| --- | --- |
| Both native turns under quota | Each used one Pod, `550m` CPU/`2112Mi` requested memory, and `2500m` CPU/`2304Mi` memory limits. Both main cgroups and all seven container specs matched the selected allocations. |
| Rejected follow-up | The real runner returned native quota `PermissionDenied`; Gateway retained `WORKLOAD_FAILURE_REASON_START_FAILED` and the exact quota name/Pod-count failure. No Pod or native execution was admitted for that request. |
| Durable acceptance and release | One inbox receipt persisted at 01:37:19.806Z. Explicit workload absence confirmation was 01:37:20.018935Z; A2A `runtime.stopped` was 01:37:21.019Z. Quarantine retained the request and required reconciliation; it did not publish an agent outcome. |
| Capacity restoration alone | During five one-second checks after restoring quota, the instance stayed paused, no Pod appeared and the task event count was unchanged. Another unreconciled follow-up was still rejected. |
| Explicit recovery | Owner reconciliation was recorded at 01:37:26.538Z. The new continuation retained the exact native session and PVC across a new Pod UID; the rejected inbox request became `ack_only`. |
| Side-effect guard | The file still contained exactly `mu0ko5xv`; the rejected request's unconditional `quota-replayed-...` append never appeared. This is not a claim of exactly-once arbitrary external effects. |
| Cleanup and restoration | All compute quota usage returned to zero. The owned quota and network policies were removed with identity checks and observed absence; all four stock deployments were restored and ready. |

Task `df06a3c8-68c0-4b5a-91bd-1b595fd4e93a` retained Agyn instance
`9c408427-d6d9-4d1c-93f0-f4c63573587c`, Codex session
`01a09d8f-6c95-7170-b02d-5cd65ce458c2` and PVC `pv-9c408427-d6d-bd59f7cc-231`
(UID `0ca81475-d78e-4945-a189-343784e45df0`). Native Pod UIDs changed from
`aa630bd3-8616-4503-bd85-fce890f00ff1` to `11d0f887-6392-41b4-8e82-e3a870525a6c`.
Rejected execution `8b535214-7f0c-4eb8-a436-6f9dfafc0421` retained inbox request
`136b6d94-33cc-4b68-a076-017f001d1ae3` and failed workload
`8e3e9d9d-14b5-451b-819f-f9e2e721c4ce`. Native workloads were
`152110bc-eba1-44bf-b21b-414c5fd353d4` and `c64247ec-0f73-4c70-a86a-7fa4dba0c292`.

Independent post-restoration audits verified all **48** prior PVC UIDs/specs/
phases unchanged, **49** total retained PVCs, zero workload Pods/Services/quotas,
and the original network policy unchanged. The new instance is paused; its
volume is still active with a persistent `/workspace` definition and no TTL.
All three removal confirmations and the quota failure reason survived stock
restoration in PostgreSQL. The existing additive migration was not changed.

Reproduce only in the explicitly selected idle trusted local lab, after building
the service and running the network preflight. Use the combined quota chart,
not the earlier resource-only checkout:

```sh
env PATH=/home/alex/.nvm/versions/node/v24.21.0/bin:$PATH \
  NODE_EXTRA_CA_CERTS=/home/alex/.agyn/local/certs/agyn-local-ca.pem \
  AGYN_LIVE_ACCEPTANCE=trusted-local \
  AGYN_KUBECONFIG=/home/alex/work/aira-a2a-lab/.state/agyn-kubeconfig \
  AGYN_LIVE_RUNNERS_IMAGE=a2a-agyn-runners:890f759-api3c84a6a \
  AGYN_LIVE_GATEWAY_IMAGE=a2a-agyn-gateway:6d7d432-api3c84a6a \
  AGYN_LIVE_ORCHESTRATOR_IMAGE=a2a-agyn-orchestrator:d77e7d5-api3c84a6a \
  AGYN_LIVE_INIT_IMAGE=docker.io/library/a2a-agynd-reporting-init@sha256:97dee776b0866e3324da20d3ac511239928dd73971af45e6748b9f9b98f18b70 \
  AGYN_LIVE_RUNNER_IMAGE=a2a-agyn-runner:4dd12a8 \
  AGYN_LIVE_COMPUTE_RESOURCES=true \
  AGYN_LIVE_SUPPORTING_RESOURCES='{"requestsCpu":"50m","requestsMemory":"64Mi","limitsCpu":"500m","limitsMemory":"256Mi"}' \
  AGYN_LIVE_QUOTA_HARD='{"requests.cpu":"1500m","requests.memory":"5Gi","limits.cpu":"6","limits.memory":"5Gi","count/pods":"2"}' \
  AGYN_LIVE_HOST_IP=192.168.5.2 \
  AGYN_LIVE_RUNNER_CHART=/home/alex/work/agyn-contrib/k8s-runner-quota-integration/charts/k8s-runner \
  node scripts/agyn-live-lifecycle.mjs quota-recovery
```

The budget is fixture sizing, not a production recommendation. The wrapper
requires an explicit absolute kubeconfig, bounded/network profile and complete
budget; it refuses pre-existing quotas and retains the integration deployments
if quota cleanup is unconfirmed. Quota changes use resource-version checks;
deletion requires UID/version preconditions. Lost acknowledgements, conflicts,
foreign/replaced resources and unrelated edits have focused tests. The failure
message assertion belongs only to this controlled test; it is not a production
error classifier or retry policy.

Private evidence: `.state/agyn-reporting-live-lknJvL/{evidence,quota}.json`,
`.state/agyn-network-live-c7EnYW/evidence.json`, and
`.state/agyn-quota-acceptance-FAe3DV/{before,run,post-audit,database-audit,gateway-audit}.json`.
The deployment recovery snapshot is `.state/agyn-lifecycle-deploy-EMmfZ1/before.json`.
No private evidence is committed. This proves healthy-runner recovery of an
existing task, not first-provision PVC/secret rejection, quota-controller outage,
node partition fencing, full Claude lifecycle or mandatory production-profile
enforcement. Those and the other production gates remain open.

## Native First-Provision Failures

On 2026-09-14, focused runner commit
[`fcd7cf66d068b38ba65273a837bee7215836e64c`](https://github.com/spk-ai/k8s-runner/commit/fcd7cf66d068b38ba65273a837bee7215836e64c)
passed real Kubernetes startup acceptance in **32.77 seconds** with the race
detector enabled. The complete Go invocation took 35.217 seconds, from
02:18:35.830Z to 02:19:11.047Z. This independent branch is based on upstream
`baadc75`, not the combined resource/quota integration stack. Published API
generation, `go build ./...` and the full `go test -race ./...` suite pass:
**146 tests including subtests**, 101 top-level. Its 12 new focused unit tests
account for 34 of those passes. The live test is skipped by ordinary runs and
passed separately with all seven subcases.

Regression tests first reproduced three defects: PVC provisioning failures left
pull secrets behind; a lost inline-secret create acknowledgement leaked that
secret; and an uncertain Pod-create response deleted credentials even if the Pod
had been accepted. The fix gives startup secrets an attempt identifier, tracks
creation intent and recorded UIDs, and centralizes failure cleanup. It uses a
fresh five-second context, checks Pod absence and secret identity/content,
deletes with UID/resource-version preconditions and observes absence. Durable
PVCs are not part of rollback. Unknown Pod-create outcomes retain credentials;
neither a timeout nor a subsequent NotFound authorizes cleanup or execution retry.

The real test uses loopback RunnerService gRPC against the selected Kubernetes
API, with synthetic credentials, a new owned namespace, a unique absent
StorageClass and a zero-Pod quota throughout. No agent, image pull, production
deployment, provider login, paid API, existing PVC or real workspace content is
involved. Native quota rejection is asserted only in this controlled fixture;
the production cleanup code uses Kubernetes API status reasons, not quota-text
parsing.

| Rejected stage | Temporary secrets after failure | Retained test PVCs |
| --- | --- | --- |
| First pull Secret | 0 | 0 |
| Second pull Secret after the first was created | 0 | 0 |
| First PVC by object-count quota | 0 | 0 |
| First PVC by requested-storage quota | 0 | 0 |
| Second PVC after the first was created | 0 | 1 |
| Inline-file Secret after pull Secret/PVC creation | 0 | 1 |
| Pod after both PVCs and both Secrets were created | 0 | 2 |

All starts returned native `PermissionDenied` with the expected quota key; no
Pod was admitted. A separate, explicitly issued eighth request after raising
PVC capacity reused `pvc-second-0` with UID
`bb1183eb-a53f-4558-a94a-655ea27f3d5a` and unchanged spec, created the second PVC,
then hit the still-zero Pod quota. Its secrets were also removed while both
claims survived. This is a native provisioning continuation, not an A2A inbox
or agent-session recovery test. The fixture then explicitly deleted only its
own unbound test claims and observed zero quota usage.

Namespace `runner-startup-f9dba485-12d`, UID
`3dbfe822-dfe3-4849-81cb-ff2c44824f3d`, was confirmed absent at 02:19:10.002Z.
The independent post-audit verified all **49** prior workspace PVC UIDs/specs/
phases, the original network-policy UID/spec, and all four stock deployment
UIDs/specs/generations unchanged. Their generations remain Runners 14, Gateway
19, runner 28 and orchestrator 50; all four were ready. There were zero workload
Pods, Services or quotas and no retained startup-test namespace. No stock image
was replaced or restored during this test.

The unit-only failure matrix additionally covers caller cancellation, ambiguous
creates, lost create/delete acknowledgements, duplicate-start contention,
foreign/replaced/edited secrets, read failures, deletion denial and a held
finalizer. It verifies conditional deletion, bounded cleanup and diagnostics
without credential payloads. These simulated failures are not claims of live
node-partition or crash recovery.

```sh
cd /home/alex/work/agyn-contrib/k8s-runner-startup
buf generate
go build ./...
go test -race ./... -count=1 -timeout=3m
RUNNER_LIVE_STARTUP_TEST=trusted-local \
  RUNNER_LIVE_KUBECONFIG=/home/alex/work/aira-a2a-lab/.state/agyn-kubeconfig \
  go test -race -v ./internal/server -run '^TestLiveStartupSecretCleanup$' -count=1 -timeout=5m
```

Private evidence is in `.state/agyn-startup-acceptance-gzD71Q/`:
`before.json`, `run.json`, `go-test.jsonl`, `post-audit.json`, `unit-run.json` and
`unit-test.jsonl`. It remains untracked. The focused branch is pushed with the
runner repository's AGPL license unchanged; no upstream PR has been submitted.

### Combined Source Validation

On 2026-09-14, lab-only runner commit
[`74faf0e9d247cffdac58a3b219639328d65a1093`](https://github.com/spk-ai/k8s-runner/commit/74faf0e9d247cffdac58a3b219639328d65a1093)
integrated the focused fix onto quota/resource commit `e6e83e7`. API generation
against local combined API source `3c84a6a`, `go build ./...` and the full
`go test -race ./...` suite pass. Resource validation remains ahead of startup
Secret/PVC writes. The independent branch and its existing license are intact.
This run did not deploy an image or enable the opt-in Kubernetes tests; the live
matrix above is evidence for the focused revision only.

The first coordinated deployment below exposed a prerequisite that this initial
administrator-backed matrix did not exercise: the deployed runner could
create/delete Secrets but could not read them to confirm ownership and removal.
The focused branch now includes the chart permission and tests the native matrix
through a namespace-bound service account using the chart rules. Stock images
are still restored after acceptance; this is not a permanent production upgrade.

## A2A First-Provision Recovery

On 2026-09-14, `provisioning-recovery` passed through the real A2A service,
coordinated Agyn stack, Kubernetes quota controller and native Codex runtime.
The deployment/test/restoration invocation took **152.745s**, 03:17:28.017Z to
03:20:00.762Z. Service source was `1a8b523`; the runner binary was `74faf0e` with
API `3c84a6a`, image `a2a-agyn-runner:74faf0e-api3c84a6a` (OCI index
`sha256:68319e75290b425af1b1a12c2d9239765afe446dbaabed6441b0d9ffb0d28583`).
No A2A controller, workflow, driver or agent runtime change was needed.

The first deployment failed correctly because temporary credential cleanup was
unconfirmed. Runner logs proved `get secrets` was forbidden for
`system:serviceaccount:agyn-platform:k8s-runner`. Three provisioning attempts
left three pull secrets; no Pod or PVC was admitted. The task was quarantined,
not reconciled or replayed. After stock restoration and confirmed fixture pause,
the operator removed only those three secrets using recorded UIDs, resource
versions, workload ownership and exact startup-attempt annotations. All 49
existing workspaces and 16 older secrets remained unchanged. This failed run is
retained as evidence, not presented as a recovery pass.

Focused runner fix [`9002f31`](https://github.com/spk-ai/k8s-runner/commit/9002f31)
adds only `get` to its existing Secret create/delete rule. Image-only upgrade is
insufficient; custom RBAC overrides must also be updated. A regression test first
failed against the old rule. Both focused and combined (`6ab2e20`) full race
suites pass. The revised native matrix passed all seven cases in **19.97s**
using the chart's Role and an impersonated service account; Secret listing was
explicitly denied. Its owned namespace `runner-startup-e089a7a0-c3d` was removed.

For the successful A2A rerun, an operator-owned Role/RoleBinding temporarily
granted only Secret `get` in `agyn-workloads`. Secret listing and reads in
`agyn-platform` remained denied; the existing ClusterRole was never changed.
Both temporary RBAC objects were conditionally deleted and permission restoration
was verified at 03:20:01.513Z. The wrapper now refuses this scenario before any
deployment change if the runner account lacks the required read permission.
Secret inventory requests negotiate metadata-only API responses, reject payload
fallback and sanitize errors.

The quota started with one additional PVC slot above the 49-claim baseline,
then denied that slot while retaining the normal Pod/CPU/memory budget. Exact
native PVC quota rejection produced one retained inbox receipt, no admitted Pod
or new PVC, no leaked secrets, and an explicitly confirmed failed workload.
Restoring the slot did not wake the instance or alter task events during a
five-second observation. Follow-ups were rejected both before and after capacity
returned until the owner explicitly reconciled the execution.

The same task then completed two real turns with MCP progress/artifact/outcome
delivery, including a native Stop reminder. The failed volume record reopened
as active with unchanged identity/ownership. The two Pod UIDs differ; both turns
use the same PVC UID/spec and native session. The rejected inbox item is
`ack_only` in both inspections and its separate append-marker file never exists.
Compute usage returned to zero while PVC usage remained 50.

| Identity | Recorded value |
| --- | --- |
| A2A task | `2489754c-677d-4434-8130-6832a0968092` |
| Agyn instance | `a7a7db46-5d60-4d67-9830-01444709b7f5` |
| Agyn thread | `63802827-227f-4cae-af4b-1ad9d8ebb736` |
| Native Codex session | `01a09dec-71bc-7f12-adb5-6b9e8d96ebb0` |
| Volume record | `1b371790-1870-538e-ba7a-d174bd81b1cf` |
| PVC | `pv-a7a7db46-5d6-9be896ae-728` |
| PVC UID | `6e937c54-8392-4d08-a983-e9d1bba62787` |

Post-restoration audits verified all 49 prior PVC UIDs/specs/phases, all 16 older
Secret identities, the original network policy, and four stock deployment
UIDs/settings/readiness. There are no workload Pods, Services or quotas. All
three workload-removal confirmations and the same active volume record survive
stock restoration in PostgreSQL. Gateway confirms the instance is paused and
its `/workspace` definition is persistent with no TTL.

Reproduction uses the earlier four-component command with this runner image,
the reviewed Secret-read permission installed first, the single scenario
`provisioning-recovery`, and an explicit `persistentvolumeclaims` quota total
exactly one above the current retained-claim count. The recorded budget was 50;
after this run there are 50 claims, so a new run would require 51. Do not delete
retained workspaces to reuse an old fixture budget. Mixed scenarios, an incorrect
PVC count, missing read permission or pre-existing quotas fail preflight.

Build and all **221 service tests** pass (202 top-level). Credential-free network
preflight `6a3db6ee` passed 92 checks and cleaned up. Private evidence:
`.state/agyn-reporting-live-bktx4G/{evidence,quota}.json`,
`.state/agyn-provisioning-recovery-Vh3DIV/{run,before,post-audit,rbac,database-audit,gateway-audit}.json`,
`.state/agyn-startup-rbac-g3QeKX/run.json` and `go-test.jsonl`,
and `.state/agyn-network-live-9vxmTJ/evidence.json`.
The failed fixture is `.state/agyn-reporting-live-qs9jez/`, with independent audit
and explicit cleanup in `.state/agyn-provisioning-acceptance-bd1dJV/`.

This closes the controlled first-PVC rejection/recovery check, not the full
production lifecycle gate. Crash-orphan reconciliation, late-create/node fencing,
post-success Stop/Remove cleanup and named-PVC identity enforcement remain
separate work. Closed-record ownership validation is covered below. A first
allocation has no prior native session to restore; the two successful turns
establish subsequent session continuity. Completed-turn and interrupted-turn
recovery evidence elsewhere must not be conflated with this provisioning case.

## Closed Volume Ownership

Tracing first-provision recovery exposed a separate Runners bug: after a create
collided with a failed/deleted volume ID, the reopen update overwrote its
identity without checking the old owner. Against unchanged upstream `f76154d`,
real PostgreSQL tests reproduced **22 identity-changing writes**, plus a race
in which a different owner won the slot. These were isolated disposable records,
not mutations of the deployed platform's volumes.

The independent Runners branch
[`fix/volume-owner-reopen`](https://github.com/spk-ai/runners/tree/fix/volume-owner-reopen)
at `5638dce` keeps identity out of the update and atomically matches owner kind,
owner ID, organization, runner, volume definition, thread and agent class.
Nullable sandbox thread/class values use null-safe equality. A mismatch returns
the existing `AlreadyExists` error with the entire stored row unchanged. An
already-open row retains the existing conflict behavior.

Legitimate same-owner reopening still clears the previous backing instance and
removal timestamp, restarts metering, retains creation time and accepts the
existing size/status inputs. Canonical/deprecated fields and unspecified owner
kind keep their existing interpretation. No API, migration, A2A controller,
workflow or agent-profile change is required.

- Published BSR generation, `go build ./...` and the full race suite pass:
  **169 tests including subtests, 114 top-level, no skips**.
- The real PostgreSQL fixture contributes 45 passing test entries. Twenty
  repetitions pass with 900 entries and no skips. Its contention test holds a
  row lock until at least four legitimate contenders are blocked in PostgreSQL,
  alongside four different-owner requests; exactly one legitimate reopen wins.
- CI supplies disposable PostgreSQL and runs the race-enabled suite with the
  database test enabled. `actionlint` and `git diff --check` pass locally.
- The separate `lab/volume-owner-integration` branch at `5f66067` combines the
  fix with removal-confirmation commit `890f759`. Generation against API
  `3c84a6a`, the build and **177 race-enabled tests** (117 top-level, no skips)
  pass with both PostgreSQL fixtures enabled.

The fixture uses existing pgx and real repository migrations. It requires
`AGYN_RUNNERS_VOLUME_TEST_DSN` to name the disposable
`runners_volume_acceptance` database on `127.0.0.1`, creates a unique schema,
and drops only that schema. The local PostgreSQL 16.6 container and its test
volume were removed after confirming both acceptance databases had no fixture
schemas left. Private evidence is in `.state/agyn-volume-owner-yd1b26/`:
`before-fix.jsonl`, `after-fix.jsonl`, `repeat.jsonl`, `combined.jsonl`,
`service-tests.log`, and `cleanup.json`. All 221 unchanged A2A service tests also
pass on pinned Node 24.21.0.

### Deployed recovery regression

On 2026-09-14, the unchanged A2A `provisioning-recovery` scenario passed in
**255.850 seconds** with Runners `5f66067`, combined API `3c84a6a`, and the
previously reviewed Gateway/orchestrator/runner/daemon images. The Runners image
is `a2a-agyn-runners:5f66067-api3c84a6a`, OCI index
`sha256:80fada4999ed41b1d88a9d3b28908aad7e92ce7438bc890fa642701a15122854`.
The running Pod's `/app/runners` SHA-256 matched the local build byte-for-byte;
build metadata identifies the clean combined commit. No A2A or workflow change
was made. Credential-free network preflight `9cc99d68` passed 92 checks and
cleaned up before deployment.

The test started with 50 retained claims and a budget of 51, then denied the
initial additional PVC slot. **Three Agyn provisioning attempts** received the
same native PVC quota denial before the single A2A execution was quarantined.
No Pod, agent execution, new PVC or leaked Secret resulted. These infrastructure
retries are distinct from prompt replay; this is not a one-attempt guarantee.
All three failed workloads received explicit removal confirmation.

Capacity restoration alone did not dispatch a new execution. Explicit owner
reconciliation at `03:58:05.205Z` retired request
`cb7ed933-99c2-44b7-9560-c4b06c0c1f1c` without executing it. Two real native Codex
turns then completed with MCP outcomes, including the first-turn Stop reminder.
They used different Pod UIDs, the same PVC UID/spec, the same native session and
the unchanged marker. The rejected request stayed `ack_only`; its unconditional
append file was absent in both Pod inspections.

| Identity | Value |
| --- | --- |
| A2A task | `83d8422d-3f11-47d6-ae4f-c6d5b03b6824` |
| Agyn instance | `785d3928-4313-49fe-be7b-6ace1e2d9dc6` |
| Native Codex session | `01a09e10-e431-7c50-9d81-e376d3d38fc1` |
| Volume record | `beac0725-47ab-575d-816c-c5dd21ec2532` |
| PVC | `pv-785d3928-431-16e22283-af4` |
| PVC UID | `5b295d3d-a5ab-4c3e-98b4-c2f2b319ba9a` |

Post-run audits verified all 50 previous PVC UIDs/specs/phases and all 16 older
Secret identities unchanged, **51 retained claims**, and zero workload Pods,
Services, quotas, Roles or RoleBindings. CPU/memory usage returned to zero.
Stock deployment images, UIDs, settings and readiness were restored; generations
are Runners 20, Gateway 25, k8s-runner 34 and orchestrator 56. The temporary
namespace-scoped Secret-read grant was conditionally deleted and the original
ClusterRole was unchanged. Secret listing and platform-namespace Secret reads
were never granted. A read-only PostgreSQL audit after image restoration
confirmed five retained workload-removal timestamps and the same active volume
identity. Gateway confirmed the instance is paused with a persistent,
no-TTL `/workspace` definition.

Private evidence: `.state/agyn-volume-recovery-gGgV9L/` contains `run.json`,
`before.json`, `post-audit.json`, `rbac.json`, `deployed-binary.json`,
`database-audit.json` and `gateway-audit.json`;
`.state/agyn-reporting-live-OapfDm/{evidence,quota}.json` records the task;
`.state/agyn-volume-image-VnGzee/build.json` identifies the image;
`.state/agyn-network-live-eyeEsN/evidence.json` records the network preflight.
Reproduction uses the existing first-provision recipe with this Runners image,
the reviewed temporary read permission and a current-baseline-plus-one PVC
budget. The next run would need 52, not 51; never remove retained workspaces to
reuse an earlier budget.

This fixes the closed-row create path, not authentication, SQL administrator
writes, physical-PVC ownership or fencing against old workloads. Open-record
reuse callers must still validate identity; the sandbox orchestrator's current
`ensureOpenVolumeRecord` checks only status. Stock runner `ensurePVC` accepts a
matching claim name without checking ownership; the independent fix below is
not yet deployed. All Runners writers must be upgraded before relying on the new check;
an old binary can still execute the previous unconstrained update.
The stock services are restored, so this local acceptance is not a permanent
rollout of the fix. It also does not rerun interrupted-turn side-effect recovery.

## Named PVC Ownership

The independent k8s-runner branch
[`fix/pvc-owner-reuse`](https://github.com/spk-ai/k8s-runner/tree/fix/pvc-owner-reuse)
at `7d3238a`, based on upstream `baadc75`, requires an explicit, nonempty
`VolumeSpec.labels.volume_key` for every named volume. The Agyn orchestrator
already supplies this durable record key. Unkeyed custom clients must migrate;
legacy claims are not automatically relabeled or replaced with empty workspaces.

Reuse matches the existing runner/orchestrator management labels, volume key
and any agent-instance, agent-class, sandbox and sandbox-owner labels. Per-volume
labels cannot override workload identity. Per-start workload/thread IDs are
excluded so legitimate continuation retains the same claim without mutation.
Terminating/lost claims, garbage-collection owner references, incompatible
filesystem/access modes, insufficient requested capacity and explicit storage
class mismatches are rejected. Larger claims and the original cluster-selected
default class are preserved without resizing.

The check applies to an existing claim, a successful creation response, and a
fresh read after a competing create returns `AlreadyExists`. No other API error
authorizes adoption. A native quota denial exposed the need to test this
explicitly: even if a matching claim appears concurrently, a forbidden create
returns `PermissionDenied`, with no extra read or Pod creation.

### Source and native acceptance

- The original code failed 41 regression test entries, including parent tests,
  by accepting conflicting claims and bypassing request validation, or by not
  handling the create race. The initial matrix is retained separately; this is
  not a count of 41 distinct defects.
- Published BSR generation, `go build ./...` and `go test -race ./... -count=1`
  pass: 187 passing entries, 97 top-level tests. The native test is opt-in and
  skipped by that ordinary suite; its separate execution below has no skips.
- At 04:44 UTC on 2026-09-14, the native test passed in 13.85 seconds. It uses
  the chart's actual RBAC rules through an impersonated fixture service account,
  a unique namespace, an absent storage class and a zero-Pod quota. It creates
  no agent, container, credential, backing PV or existing workspace content.
- Same-owner reuse reaches the intended Pod-quota rejection. Cross-task,
  missing-key, omitted-owner and agent-class changes fail before that stage.
  Eight real API `GET/404` responses are held before competing creates: one PVC
  identity wins, four requests for that owner succeed and four foreign owners
  fail. No response or Kubernetes status is synthesized by this test.
- Namespace `runner-pvc-16e42dcc-62c`, UID
  `e3eaaa77-4812-400b-bacf-740e0f4f7790`, was removed with UID/resource-version
  preconditions and observed absent. The competing claim's UID was
  `95309ef1-42de-47ac-b2d1-30d7cfb51ac7`. All 51 prior PVC UIDs/specs/labels/phases
  and the four deployment UIDs/specs/generations were unchanged.

The first native run did not pass: eight concurrent creates exhausted the
fixture's eight-claim quota before name-conflict handling. Its cleanup then
refused controller-injected CA ConfigMaps. The fixture now reserves headroom
for all attempts while keeping Pod admission at zero. Cleanup validates known
Kubernetes/Istio CAs and trust-manager bundle content, metadata and controller
UID; unknown objects or extra data still stop deletion. The original fixture
was separately reconciled with exact namespace/PVC UIDs, certificate-only
content checks and no bound storage before conditional namespace deletion.
Its failure logs have not been replaced by the passing result.

Private evidence: `.state/agyn-pvc-owner-nwrbM7/` contains `before-fix.jsonl`,
the original `native.jsonl` and `native-reconciliation.json`;
`.state/agyn-pvc-owner-vimidP/` contains `unit.jsonl`, the passing `native.jsonl`,
source hashes in `native-run.json`, and matching `native-before.json` /
`native-after.json`. The source hashes were rechecked before commit.

The lab-only `lab/pvc-owner-integration` branch at `641e2f7` combines this patch
with startup credential cleanup, its chart permission, resources and quota.
Local API generation, `go build ./...` and the full Go race suite pass. A new
cross-patch test verifies matching-owner startup, foreign-owner and missing-key
rejection, and partial PVC creation: rejected attempts remove only their own
pull credentials with identity preconditions and never mutate/delete claims.
The independent review branch remains unchanged.

The combined native PVC test also passes all six subcases (seven entries with
the parent), without skips. Private evidence is
`.state/pvc-combined-native-oONnCp/`: source `641e2f7`, native JSONL and independent
before/after snapshots. All 53 prior claims and four deployment identities,
specs and generations were unchanged. Fixture namespace
`runner-pvc-4e24ae82-c02`, UID `16431dc0-9034-4b3a-8aac-e873835450cf`, is confirmed
absent. This is native PVC acceptance, not a combined A2A lifecycle pass.

### Combined A2A acceptance

The unchanged first-provision recovery scenario passes on the combined image
`a2a-agyn-runner:641e2f7-api3c84a6a`, with Runners `5f66067`, Gateway `6d7d432`,
orchestrator `d77e7d5`, API `3c84a6a` and the combined diagnostic/session init
image. This run used the existing Codex subscription reference, not a new
provider credential. A fresh model-free network preflight passed 92 checks.

- Run: 05:54:49-05:59:10 UTC on 2026-09-14, approximately 261 seconds.
- Task: `9f67c2e2-e678-40b7-ae8f-cc2fbf36da48`; retained instance
  `0e51cc03-8c53-429a-bd7b-3c1eb557ed1d` and volume record
  `fd60dd9d-441c-57d2-bc42-ea5c19b95144`.
- Three infrastructure provisioning attempts hit the deliberate first-PVC
  quota rejection before one A2A quarantine. No agent ran for that request;
  startup credential cleanup was confirmed. Capacity restoration did not
  authorize a retry. Explicit reconciliation retired the request `ack_only`.
- Two native Codex turns then passed with a real Stop reminder, MCP outcomes,
  confirmed release and no replay of the rejected request. Changed Pod UIDs
  `47fe46e2-3b74-4d47-b748-003ed733310a` and
  `257001b1-f8a5-4e9e-9d65-1db1a0d9d9ed` retained native session
  `01a09e7e-10d4-7ba3-b30d-f6df484af812` and PVC
  `pv-0e51cc03-8c5-de5998c7-d79` (final UID
  `f87a54e2-2809-4626-8727-dfd2dcd24d28`).
- Independent read-only PostgreSQL checks confirmed all five workload-removal
  timestamps, the same active volume ownership tuple and its physical claim.
  Gateway confirmed the instance paused and its workspace persistent with no TTL.
- All 55 prior claim UIDs/specs/phases and 16 older Secret identities were
  unchanged; 56 claims remain. Stock deployment UIDs/settings/readiness and
  temporary RBAC were restored, with no workload Pods/Services/quotas remaining.

Private evidence is `.state/agyn-pvc-recovery-KnA7dX/` and
`.state/agyn-reporting-live-qxkNiI/`. Build provenance is in
`.state/agyn-pvc-integration-build-BXMgeq/build.json`; image index digest
`sha256:8b9a620053825b922ef1f4c72b777b1803b5b030208223eea57fe21c4d5e87e2`.
The deployed `/app/k8s-runner` independently matched binary SHA-256
`7c202c79098b65474105af0d326c57e9b4d8adb658630b7a69284220c2341ea3` before
the native turns completed. The inspected runtime base was upstream `0.12.0`
at digest `sha256:dadb9ad718533cce73f7918734c8ebe379bc539b786a09b4d3f6861ed535d5fa`.

Both branches are pushed. Stock k8s-runner is restored, not permanently fixed.
This is first-provision/continuation acceptance, not a new interrupted-turn,
parallel or adversarial storage test. Caller
authentication, sandbox open-record checks, UID/ownership-safe volume deletion,
late-create reconciliation and old-writer fencing remain separate requirements.
The claim check cannot stop a privileged writer from replacing storage after
validation; `ReadWriteOnce` is not a single-writer lock. See
[Kubernetes access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes).

## Bounded Agent Profile

This section records the earlier deployed profile, not a currently validated
reproduction recipe. The wrapper now also requires and manages Runners/Gateway
images, with 41 passing subprocess cases and a successful four-component live
startup-failure test/restore. All five native Codex scenarios now also pass on
that coordinated stack, with eleven main/supporting Pod specification checks and
main cgroup proofs. The original 40 PVCs are unchanged and six new task PVCs are
retained. Current images, per-scenario evidence and remaining checks are in
[the rollout requirements](AGYN-REMOVAL.md).

The operator wrapper now optionally deploys both combined images. It snapshots
only managed fields and deployment UIDs, uses resource-version-checked patches,
re-reads between rollout steps, and preserves unrelated edits. It restores the
deployments independently in reverse order, so a conflict in one does not prevent
restoration of the other. Missing capability/configuration, partial deployment,
lost patch acknowledgement, rollout failure and external edits have subprocess
tests. If workload Pods remain at cleanup, it keeps the integration deployments
in place for operator reconciliation instead of downgrading active workloads.

Build the binaries using the corresponding `lab/resource-integration` checkouts
and local API generation described above. The runner build context is
`.state/agyn-runner-build/k8s-runner`; the orchestrator context is
`.state/agyn-orchestrator-build/orchestrator`. Both use `CGO_ENABLED=0 GOOS=linux
GOARCH=amd64 go build -trimpath`, targeting `./cmd/k8s-runner` and
`./cmd/orchestrator` respectively.

From the lab checkout:

```sh
docker build -f ops/Dockerfile.agyn-runner \
  -t a2a-agyn-runner:4dd12a8 .state/agyn-runner-build
docker build -f ops/Dockerfile.agyn-orchestrator \
  -t a2a-agyn-orchestrator:5edf8a4 .state/agyn-orchestrator-build
agyn local load-image a2a-agyn-runner:4dd12a8
agyn local load-image a2a-agyn-orchestrator:5edf8a4
```

Use the previously reviewed daemon/init image `a2a-agynd-reporting-init:b8db063`.
Run the credential-free [network preflight](AGYN-NETWORK.md) before credentialed
acceptance, then use an otherwise idle lab:

```sh
env NODE_EXTRA_CA_CERTS=/home/alex/.agyn/local/certs/agyn-local-ca.pem \
  AGYN_LIVE_ACCEPTANCE=trusted-local \
  AGYN_KUBECONFIG=/home/alex/work/aira-a2a-lab/.state/agyn-kubeconfig \
  AGYN_LIVE_INIT_IMAGE=a2a-agynd-reporting-init:b8db063 \
  AGYN_LIVE_ORCHESTRATOR_IMAGE=a2a-agyn-orchestrator:5edf8a4 \
  AGYN_LIVE_RUNNER_IMAGE=a2a-agyn-runner:4dd12a8 \
  AGYN_LIVE_COMPUTE_RESOURCES=true \
  AGYN_LIVE_SUPPORTING_RESOURCES='{"requestsCpu":"50m","requestsMemory":"64Mi","limitsCpu":"500m","limitsMemory":"256Mi"}' \
  AGYN_LIVE_RUNNER_CHART=/home/alex/work/agyn-contrib/k8s-runner/charts/k8s-runner \
  AGYN_LIVE_INSPECTOR_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 \
  node scripts/agyn-live-lifecycle.mjs completed parallel interrupted cancellation
```

The fixture waits for the selected runner's advertised capability, resolves its
actual flavor through Gateway, and requires the capability on a new temporary
agent. It compares every main/supporting Pod specification to the operator's
bounds and the main process's `cpu.max`/`memory.max` to the flavor. This includes
replacement and parallel Pods; resource mismatches are fatal assertions, not
ignored setup retries. `evidence.json` includes a `resources` section keyed by
observed Pod UID. No A2A controller, worker, workflow or agent prompt changes are
needed to enable this profile. No existing user profile is modified.

These are test sizing values, not production recommendations. The actual main
flavor is `ram-2gb`: 500m CPU/2Gi requests and 2 CPU/2Gi limits. The supporting
allocation is additional, including the restartable Ziti sidecar. The test uses
the existing ChatGPT subscription reference, not copied credentials or paid API
inference. For process/host failure, the private
`.state/agyn-lifecycle-deploy-*/before.json` lists managed fields under
`deployments`; it is the manual recovery record, not proof of restored state.

## Real Agent Acceptance Results

The four scenarios ran in one invocation of the command above. Before credentialed
work, network preflight run `9d342a81` passed all 92 checks and confirmed cleanup:
`.state/agyn-network-live-PT5api/evidence.json`.

All **nine** observed Agyn Pod UIDs had seven bounded container specifications:
the main agent plus `ziti-enroll`, `ziti-sidecar`, `agynd-cli-init`, `agyn-cli-init`,
`agent-runtime` and `ziti-wait`. Every inspected main cgroup reported
`cpu.max=200000 100000` and `memory.max=2147483648`. This establishes actual main
cgroups and all Pod resource specifications; the separate kernel probe establishes
supporting-container cgroup enforcement. We did not read an already exited Agyn
init container's cgroup and do not claim to have done so.

| Scenario | Result | Evidence directory under `.state/` |
| --- | --- | --- |
| Completed turn and follow-up | Passed; new Pod UID, same instance/PVC/native session, real MCP outcome and Stop reminder, physical cleanup. | `agyn-reporting-live-hnVmB3` |
| Same-agent parallel tasks and FIFO | Passed; distinct Pods/PVCs/sessions, queued follow-up reused only A's state while B advanced, four cross-Pod TCP/UDP denials and scoped reporter credentials. | `agyn-reporting-live-X0ylVs` |
| Interrupted turn | Passed; controller SIGKILL and Pod loss, gated replacement, quarantine, explicit retirement, one unchanged append and same native session after recovery. | `agyn-reporting-live-cnkrgq` |
| Hard cancellation | Passed in 6.045s; Pod deletion observed before settlement, retained heartbeat stopped and no late-write marker. | `agyn-reporting-live-OqkS2e` |

Each directory contains private `evidence.json` with its `resources` and network
sections. The parallel directory also contains `parallel.json`. No model retry
was needed for these four runs; their success does not explain the separate
historical startup failure in [the network report](AGYN-NETWORK.md).

Completed task `4ad362f1-6b91-4594-8643-af05227be923` retained instance
`318a780f-3f23-4747-9e74-bf5ff27804c6`, PVC `pv-318a780f-3f2-0971e70d-cff`, and
native session `01a09ba4-19a7-7a83-81bb-b74317383d6b`. Pod UID changed from
`9426d8ff-a5fc-4c65-86a4-f14513dfeafd` to `b577957e-0626-416a-8a16-8e5ac91cc93d`.

Parallel A task `4e86bb19-39a7-4d1e-8a6c-1a7a1dd14239` used instance
`43f37cfd-edc1-431e-967d-99439b3891f6`; B task
`a49c33f9-289f-4b4f-9236-48ce178486e1` used instance
`c5910189-3f32-4a5b-b74a-cfa9772c80a4`. A1's `runtime.stopped` was sequence 28;
A2 was claimed at sequence 31. Their native sessions and PVCs were distinct;
A2 retained A1's mapping across changed Pod UIDs. This ran from 16:41:22 to
16:44:26 UTC without modifying the A2A controller or workflow code.

Interrupted task `e8ba526a-33a6-40a4-9975-412fdecbb57c` retained native session
`01a09ba8-289b-70a1-90a1-202f636b5d33` and exactly one appended marker line.
The old inbox message `aa59e6d1-35d6-46df-a212-01ea2c0f97a5` became `ack_only`
after explicit reconciliation, not automatic replay. All three Pod UIDs,
including the gated replacement, had the expected resource bounds.

Cancellation task `8f4ab284-231a-4032-a513-cab7277fe1a3` had physical Pod deletion
observed at `2026-09-13T16:47:21.633Z`, before `runtime.stopped` at
`16:47:25.915Z`. A read-only PVC inspector found an identical heartbeat on reads
1.5 seconds apart and no late side effect. Cancellation stayed terminal.

Deployment recovery record: `.state/agyn-lifecycle-deploy-VgjyKi/before.json`.
Independent checks after the wrapper exited confirmed both stock images ready
(`k8s-runner:0.12.0`, `agents-orchestrator:0.23.0`), no workload Pods or Services,
and only the pre-existing `agent-workload-egress` policy. The stock runner's
Gateway capability report returned to `["docker"]`, without `compute-resources`.
All five fixture PVCs were independently confirmed Bound and task state was
retained; running the bounded profiles again
requires the reviewed resource-capable images, not the restored stock runner.

All 82 lab tests pass, including 26 deployment-wrapper subprocess cases and two
resource-proof validation tests. The normal agent tasks are tiny fixtures, not
a production sizing benchmark or a proof of isolation against hostile code.

## Remaining Acceptance

Add scheduler/admission and whole-task accounting evidence, aggregate
backpressure/quotas, and appropriate production sizing. Test supporting runtime
failure and real-agent OOM recovery without unsafe side-effect replay. The kernel
OOM probe is not an agent OOM-recovery acceptance test. The selected capability
remains opt-in for compatibility; a production profile must require enforcement,
not silently fall back to the unbounded legacy path.

This work does not close the broader [production gates](PRODUCTION.md), including
adversarial sandbox hardening, fail-closed networking, storage/HA operations,
partitions and unexplained startup failure diagnosis.
