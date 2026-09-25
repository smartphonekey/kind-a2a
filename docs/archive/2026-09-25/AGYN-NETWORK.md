> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Agyn Network Isolation Acceptance

This is operator-only, credential-free CNI acceptance for the trusted local lab.
It is not a production deployment or a substitute for concurrent real-agent
acceptance. [Separate live parallel acceptance](AGYN-PARALLEL.md) now verifies
concurrent cross-pod denial and same-task continuation. The A2A service itself
does not receive Kubernetes credentials.

The separate [native runner transport fix](AGYN-RUNNER-TRANSPORT.md) closes a
plaintext control API alongside the Ziti listener at the application layer.
Its loopback/process tests pass; it is not deployed and does not replace this
CNI evidence or establish actual overlay-policy enforcement.

## Enforcement Failure Found

On 2026-09-13 the installed `agent-workload-egress` policy selected the probe pods,
but all 96 attempted managed-pod connections to other probe pods succeeded across
six rounds. TCP and UDP both bypassed isolation, over direct Pod IPs and Service
ClusterIPs. Positive controls and loopback challenge-response checks passed.
The failed evidence is `.state/agyn-network-live-9Nec99/evidence.json`.

The Agyn VM had policy chains but no `KUBE-POD-FW` rules. Network policy was not
disabled in its K3s systemd unit, and bridge netfilter was enabled. After verifying
there were no agent workload pods, only the Agyn VM's `k3s` service was restarted.
Per-pod firewall rules appeared and connection rejection resumed. The node and
Agyn platform deployments were healthy afterward. No Docker/Dagger restart,
PVC deletion, policy relaxation, or host firewall change was performed.

The bundled Kube-router v2.2.1 caches node IPs at startup and selects local pods by
`status.hostIP`. Stale node-address state after VM restoration is a plausible
cause, not a proven diagnosis of its in-memory state. A restart is a local repair,
not a durable bootstrap fix. VM bootstrap/recovery must verify actual enforcement
before admitting untrusted work; healthy Pods and policy objects are insufficient.
The earlier real-agent lifecycle acceptance remains valid for lifecycle behavior,
but did not prove network isolation.

## Verified Run

Run `28a93b50` passed on 2026-09-13 from 15:01:16 to 15:02:37 UTC, using K3s
`v1.33.1+k3s1` and containerd `2.0.5-k3s1`. All 92 checks passed, including 16
installed-egress probes, the ingress denial/revocation matrices, positive controls
and DNS. No denial probe unexpectedly succeeded in this run. All three pods,
three Services and two temporary policies were removed; the installed policy's
UID and specification were unchanged. Evidence remains private at
`.state/agyn-network-live-wjwjej/evidence.json`.

Each probe process verified UID 1000, no service-account token, zero effective
capabilities, `NoNewPrivs=1` and `Seccomp=2`. These checks describe the test pods,
not the real agent runtime. The rendered ingress template SHA-256 was
`ed83573cde3f924aa003a742439f4d8a2a93d376f773b9363a69ab2b27acfefa`.

At that checkpoint, the build and all 55 tests passed. Early verifier attempts caught copied API
metadata and the need to correlate Kube-router TCP rejections with a live listener;
they are not counted as successful acceptance runs. Their resources were cleaned.

## Reproduction

The focused chart change is in the `feat/workload-ingress-isolation` branch of
<https://github.com/spk-ai/k8s-runner>, commit `e914f23`. The chart adds opt-in
`workloadIngressNetworkPolicy.enabled=true`, selecting orchestrator-managed pods
with `ingress: []`. The runner binary and RBAC are unchanged. Helm tests cover
default-off behavior, target namespace, selector merging/removal, rejection of
empty or non-string selectors, and preservation of the egress policy tests.

Build the chart dependencies and run its checks in that checkout:

```sh
bash scripts/verify-workload-egress-networkpolicy.sh
```

Then, from this lab, with an idle `agyn-workloads` namespace:

```sh
npm test
env AGYN_LIVE_ACCEPTANCE=trusted-local \
  AGYN_LIVE_RUNNER_CHART=/home/alex/work/agyn-contrib/k8s-runner/charts/k8s-runner \
  AGYN_LIVE_INSPECTOR_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 \
  node dist/live/agyn-network.js
```

`AGYN_KUBECONFIG` defaults to this lab's `.state/agyn-kubeconfig`; it never uses
the ambient kubectl context. The test uses the installed egress policy and renders
the actual proposed ingress template, adding a random run selector so it covers
only the new probe pods. It does not install a namespace-wide policy or alter any
pre-existing resource. This specific pre-deployment test requires ingress to be
open to its control pod initially; it is not an admission controller or a general
audit for arbitrary already-isolated namespaces.

## What Is Checked

- Three bounded, nonroot, read-only-rootfs probe pods; no PVCs, host mounts,
  service-account tokens, Agyn credentials or model calls. Runtime checks require
  UID 1000, zero effective capabilities, no-new-privileges and seccomp filtering.
- Fresh TCP/UDP challenge responses bind every positive control to its intended
  listener. Timeouts/rejections cannot pass as allowed traffic. TCP refusal counts
  as denial only with a fresh successful check of that same listener.
- Installed egress denies both managed pods access to each other and the control
  pod, using both Pod IPs and Service IPs. Cluster DNS remains usable.
- The proposed ingress policy denies the otherwise-unrestricted control pod
  access to both managed pods; loopback listeners remain healthy.
- A temporary allow policy reopens only pod A, leaving pod B isolated. Removing
  the exception restores denial; removing the proposed ingress policy restores
  the original positive controls. This explicitly exercises additive policies.
- Cleanup uses exact resource names, run labels and UID deletion preconditions.
  Lost creation responses are reconciled; conflicting creates are not adopted.
  Pre-existing policy UIDs/specifications must remain unchanged. Failed runs keep
  private evidence, and cleanup never deletes PVCs or unrelated resources.

The test records policy convergence instead of assuming it is instantaneous. It
does not establish an absence of startup traffic before enforcement. SIGKILL or
host failure can interrupt cleanup: inspect the private `evidence.json` resource
list and current UIDs before removing only that run's remaining probes, Services
and policies. Probe pods have a ten-minute active deadline, but that does not
automatically delete Services or NetworkPolicies.

## Native Agent Compatibility

The real Codex two-turn acceptance was also rerun with enforced egress and the
proposed ingress policy, narrowed to the newly created fixture agent. A second
temporary policy permitted only that agent's pods to reach the host reporting
endpoint at `192.168.5.2/32` on its selected TCP port (`35811` in this run). It
did not allow the host/LAN generally or modify the installed egress policy.

Task `802ddc02-4414-49f2-a96b-ec89a443146b` passed both resumable A2A turns and the
real stop-hook reminder on 2026-09-13. Pod UIDs changed from
`b040b6e2-535a-46ac-959e-03b22263315f` to
`a8e1fc56-60f7-492d-bd3f-d389deffb04c`, while instance
`b59b64f4-1396-4200-9cbd-0a9b471f9bd6`, native Codex session
`01a09b51-47c7-7540-83fa-caabc20ad291` and PVC
`pv-b59b64f4-139-bbd22494-4ee` stayed the same. The marker `mtzy9okl` was unchanged.
The test checked policy UIDs/specifications and matching labels on both pods.
This demonstrates enrollment, terminal setup, authenticated reporting and session
continuation remain functional; it is not an adversarial runtime sandbox test.

Evidence is `.state/agyn-reporting-live-xM8Sob/evidence.json`. Workload absence was
checked after both turns. Cleanup paused the fixture instance, retained its PVC,
removed both temporary policies only after confirming workloads were gone, and
restored the original orchestrator/daemon deployment settings. The deployment
snapshot is `.state/agyn-lifecycle-deploy-PNa6Y1/before.json`.

After the CNI probe above succeeds, reproduce with the locally built integration
images documented in [AGYN-REPORTING.md](AGYN-REPORTING.md):

```sh
env NODE_EXTRA_CA_CERTS=/home/alex/.agyn/local/certs/agyn-local-ca.pem \
  AGYN_LIVE_ACCEPTANCE=trusted-local \
  AGYN_LIVE_INIT_IMAGE=a2a-agynd-reporting-init:b8db063 \
  AGYN_LIVE_ORCHESTRATOR_IMAGE=a2a-agyn-orchestrator:cba941a \
  AGYN_LIVE_RUNNER_CHART=/home/alex/work/agyn-contrib/k8s-runner/charts/k8s-runner \
  node scripts/agyn-live-lifecycle.mjs completed
```

Setting `AGYN_LIVE_RUNNER_CHART` explicitly enables these fixture-scoped policies.
The controller and workflow code are unchanged. The reporting allowance remains
a trusted-local HTTP fixture, not a production reporting transport. If workload
cleanup cannot be confirmed, the acceptance program retains the policies for
operator reconciliation instead of removing isolation from a possibly live agent.

## Remaining Requirements

The latest credential-free preflight also passed all 92 checks, run `1176b203`,
with cleanup confirmed in `.state/agyn-network-live-ZL3S0I/evidence.json`.
The following coordinated Codex sweep passed completed, interrupted,
cancellation, parallel/FIFO and streaming with the same enforced policy profile.
Cross-Pod TCP/UDP denial had passing local listener controls. All fixture policies
were removed after workload absence; only the original egress policy remains.
See [the current evidence and images](AGYN-REMOVAL.md#native-lifecycle-regression).

The probes demonstrate pod-network enforcement, not sandboxing of the real Agyn
runtime. Real parallel A2A tasks now pass the separate acceptance linked above.
The three lifecycle cases also have passing reruns under this profile, detailed
below. Still required: cross-task overlay and credential denial; nonprivileged
agents and mandatory production resource enforcement; node/host-network and IPv6
coverage; public-destination restrictions; and fail-closed startup/recovery.

The installed egress policy excludes the private host callback range. The narrow
test allowance above establishes local compatibility only. A production reporting
service needs authenticated overlay/TLS delivery and an explicit deployment
policy. Do not disable enforcement or broadly allow the host/LAN to recover the
old test behavior.

Kubernetes NetworkPolicy does not isolate containers within one pod, block
incoming node/loopback traffic, or authorize services inside OpenZiti. Another
policy can add ingress allowances despite an empty ingress rule set. These are
separate release gates, not exceptions hidden in a production profile.

## Lifecycle Reruns

The unchanged completed, interrupted and cancellation scenarios were rerun with
`AGYN_LIVE_RUNNER_CHART` set, using the same reviewed daemon/orchestrator images
and the existing subscription. All three have passing individual evidence on
2026-09-13; this is not a claim that every attempt passed:

| Scenario | A2A task | Private evidence |
| --- | --- | --- |
| Completed two-turn continuation and Stop reminder | `faf4d023-78a7-43c7-a7e2-352b9cd7a2be` | `.state/agyn-reporting-live-qrzdCZ/evidence.json` |
| Interrupted controller/pod recovery and explicit retirement | `3b147cf2-984f-428c-9954-9dbe0c884a14` | `.state/agyn-reporting-live-unotRI/evidence.json` |
| Active-command cancellation and retained-volume inspection | `37b3cdcd-08fb-431b-99d6-f36b6cb8b2b0` | `.state/agyn-reporting-live-ad88lx/evidence.json` |

The completed case retained its native session and PVC across new Pod UIDs and
released both turns. The interrupted case preserved the non-idempotent append as
exactly one line in the unauthorized replacement and after explicit recovery.
It resumed native session `01a09b72-8ea6-75a3-b9f5-0c7e15ddb175` on PVC
`pv-191cce58-704-21c65dac-c2a`; the old inbox message became `ack_only`. This does
not authorize automatic retry of arbitrary interrupted effects.

Cancellation settled in 6.551 seconds. Pod deletion was observed at
15:49:21.569 UTC, before `runtime.stopped` at 15:49:26.545 UTC. The command had
survived the test's SIGTERM. Two read-only PVC samples 1.5 seconds apart showed
the same stopped heartbeat and no late-write marker. No instance pods remained.
This is healthy-node evidence, not fencing for a partitioned or force-deleted pod.

The first combined sweep passed completion but its interrupted fixture
`c27fe347-81ee-4846-99bb-ceb9955621d9` failed during setup, before fault injection.
Agyn marked workload `4690be1d-780f-4e40-99c7-95d97f1f6090` failed about 12 seconds
after dispatch; Gateway exposed no failure reason and Kubernetes recorded no
warning event for that pod. Its accepted request was quarantined, not replayed,
and the workload was removed. Evidence is
`.state/agyn-reporting-live-fKDsXc/evidence.json`. The underlying startup cause is
unresolved; later fresh fixtures passing does not fix or explain it.

All four fixture instances were paused and their PVCs retained. Temporary
policies and the cancellation inspector pod were removed. Both wrapper
invocations restored the original deployment; their snapshots are
`.state/agyn-lifecycle-deploy-U9d7bx/before.json` and
`.state/agyn-lifecycle-deploy-sJBjOr/before.json`. No test service or workload pod
was left running. Reproduction uses the same wrapper with arguments
`completed interrupted cancellation`; also set the digest-pinned
`AGYN_LIVE_INSPECTOR_IMAGE` from the credential-free probe command above.
## Sources

- [Kubernetes NetworkPolicy semantics](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [K3s network policy controller](https://docs.k3s.io/networking/networking-services#network-policy-controller)
- [Bundled controller initialization](https://github.com/k3s-io/kube-router/blob/v2.2.1/pkg/controllers/netpol/network_policy_controller.go)
- [Bundled local-pod selection](https://github.com/k3s-io/kube-router/blob/v2.2.1/pkg/controllers/netpol/pod.go)
