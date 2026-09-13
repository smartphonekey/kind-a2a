<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Agyn Compute Resource Enforcement

Status: source-level integration, credential-free kernel enforcement and real
resource-bounded Agyn lifecycle acceptance passed on 2026-09-13. The operator
wrapper temporarily deployed the combined images, then restored the stock
deployments. This is not a permanent production upgrade. Aggregate admission,
whole-task accounting, sizing and adversarial hardening remain release gates.

The resource measurements remain valid, but these historical lifecycle images
do not implement the new [removal-confirmation contract](AGYN-REMOVAL.md).
An unrelated failed-Pod case disproved billing `removedAt` as deletion evidence.
The new service requires coordinated Runners/Gateway/orchestrator updates before
repeating the model tests; the source fixes have not yet had that live rollout.

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

## Bounded Agent Profile

This section records the earlier deployed profile, not a currently validated
reproduction recipe. The old wrapper manages only two deployments; new Runners
and Gateway image management and failure tests must be added as described in
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
