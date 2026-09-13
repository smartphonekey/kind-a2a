<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Agyn Compute Resource Enforcement

Status: source-level integration and credential-free Kubernetes enforcement
passed on 2026-09-13. The stock Agyn deployments and existing live agent profiles
have **not** been upgraded by this test. Resource-bounded real-agent continuation,
parallelism and aggregate admission remain release gates.

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

## Remaining Acceptance

1. Build and deploy combined lab runner/orchestrator images while preserving the
   existing ingress, inactive-instance stop and confirmed-removal patches. The
   prepared `lab/resource-integration` branches combine only these contributions;
   they are not upstream review branches.
2. Restore-safe operator tooling must set explicit supporting bounds, wait for
   the runner's capability report, opt a temporary profile in, then verify all
   actual Agyn containers and cgroups through completion and continuation.
3. Repeat same-agent parallel/FIFO, interruption and cancellation tests using
   that profile. Prior live task tests used the unbounded stock resource path;
   they do not prove sizing or continuation under the new bounds.
4. Add scheduler/admission and whole-task accounting evidence, aggregate
   backpressure/quotas, and appropriate production sizing. Test supporting
   runtime failure and OOM recovery without unsafe side-effect replay.

This work does not close the broader [production gates](PRODUCTION.md), including
adversarial sandbox hardening, fail-closed networking, storage/HA operations,
partitions and unexplained startup failure diagnosis.
