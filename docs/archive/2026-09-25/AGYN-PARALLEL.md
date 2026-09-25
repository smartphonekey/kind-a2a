> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Agyn Parallel Task Acceptance

This is real-agent acceptance in the trusted local lab, not a production security
claim. The scenario uses the existing A2A service, scheduler, reporting MCP and
Agyn adapter unchanged. Only the operator test coordinates the barriers.

The scenario passed again on the coordinated removal-confirmation stack at
22:08:13-22:11:10 UTC on 2026-09-13, using agent
`91fd5868-7a48-4d72-8df8-c8eb337d3b5c`. Separate native identities/PVCs,
same-task FIFO, continued neighbor progress, explicit old-workload confirmation,
cross-task reporting 401s and TCP/UDP denial all passed. All three Pods had the
bounded resource profile. Private evidence is
`.state/agyn-reporting-live-czDtiH/{parallel,evidence}.json`; current images and
independent cleanup audits are in [the coordinated regression](AGYN-REMOVAL.md#native-lifecycle-regression).
The detailed run below remains historical evidence, not the current image recipe.

## Verified Behavior

On 2026-09-13, from 15:37:57 to 15:40:38 UTC, two tasks on agent
`047bdc02-7d57-4d6f-9942-ba3a1fec70e7` passed concurrent execution and continuation:

| Identity | Task A | Task B |
| --- | --- | --- |
| A2A task | `7cea4130-474c-4dde-a8c8-bc93c8e65927` | `011ff216-1bd4-47e2-ac70-cf752ea97920` |
| Agyn instance | `e791b03c-8193-4d0f-af62-c0efd32636e5` | `8fdf206b-345e-4989-a404-e8fe604cda2c` |
| PVC | `pv-e791b03c-819-d3f51661-122` | `pv-8fdf206b-345-d3f51661-122` |
| Native Codex session | `01a09b6b-51c2-7550-ae2c-b83d49001444` | `01a09b6b-5c2c-79d0-b918-f19cd948d448` |
| Workspace marker | `a-mtzza77a` | `b-mtzza77a` |

The same operator-selected profile, `codex-gated-live-v1`, served both tasks.
Each had its own thread, instance, PVC, Pod UID and native session. No second
agent profile was used, so this run does not establish agent portability.

The client submitted A1, then A2 on the same task, then B1. Enqueuing A2 first
tests that a blocked follow-up cannot prevent a different task from starting.
Both first turns ran live processes with advancing heartbeats. A2 remained only
`execution.queued`, with no dispatch, reporter or workspace side effects.

After operator release, A1 reported its exact marker artifact and `turn_done`.
The service recorded `runtime.stopped` at sequence 28 (15:39:17.706 UTC), then
claimed A2 at sequence 31 (15:39:18.010 UTC). The test independently checked that
A1's Pod UID was absent and its provider workload had confirmed removal.

A2 used a new pod, changing UID from `3f3d0ec1-44fc-44be-9f44-0d963379d02b` to
`ed66f3a4-4389-4ef3-a261-2729f1cd2766`, while keeping A's instance, thread, PVC,
profile, marker and native session. Session continuity compares identity and
creation time, not the mutable `last_used_at_unix_ms`. Its action log contained
exactly A's first and second turns; B's still contained only B's first turn.
B's heartbeat continued across A's replacement and second turn.

Each final turn reached `INPUT_REQUIRED` with `resourcesReleased: true` and no
instance pods. Exactly two Agyn instances existed for the two tasks, not three
instances for the three turns. The runtime identity and workspace are reused;
the stopped container process is not kept alive between turns. Cleanup then
canceled the test tasks, paused the instances and retained their PVCs.

## Isolation Checks

- The credential-free [network preflight](AGYN-NETWORK.md) passed all 92 checks
  immediately before this acceptance, run `451e3f70`. Its private evidence is
  `.state/agyn-network-live-Bh2OgH/evidence.json`; all probe resources were removed.
- Both live agent pods were selected by the reviewed ingress-denial policy and
  the installed egress policy. Their only additional reporting allowance was
  the exact fixture agent, host IPv4 address and reporting TCP port.
- Cross-pod TCP and UDP were denied in both directions. Every denial had working
  loopback positive controls on both ends; TCP refusal was not counted without
  proving the target listener was alive. The four cross-pod checks passed.
- Reporter credentials differed across tasks and rotated for A2. Supplying B's
  execution ID in A's status URL still returned A's authenticated execution.
  Each reporter received HTTP 401 when trying the owner's cross-task events API.
  Only credential hashes, never raw tokens, are included in the evidence.
- Pods had no host network/PID/IPC namespaces, hostPath volumes or mounted
  Kubernetes service-account tokens. PVC and native-session identities differed.

These checks do not establish adversarial isolation. In particular, the observed
agent and init/sidecar containers had empty `resources` specifications: CPU and
memory requests/limits were absent. The Ziti sidecar added `NET_ADMIN`, and the
agent's pod/container security contexts did not demonstrate a hardened nonroot
profile. Cross-task authorization through the Agyn overlay is not tested here.
An agent able to alter its own hook/control files is still inside the trusted-lab
boundary. Resource containment and runtime hardening remain production gates.

## Reproduction And Evidence

Run `npm test`, then the credential-free preflight documented in
[AGYN-NETWORK.md](AGYN-NETWORK.md). With an idle `agyn-workloads` namespace:

```sh
env NODE_EXTRA_CA_CERTS=/home/alex/.agyn/local/certs/agyn-local-ca.pem \
  AGYN_LIVE_ACCEPTANCE=trusted-local \
  AGYN_LIVE_INIT_IMAGE=a2a-agynd-reporting-init:b8db063 \
  AGYN_LIVE_ORCHESTRATOR_IMAGE=a2a-agyn-orchestrator:cba941a \
  AGYN_LIVE_RUNNER_CHART=/home/alex/work/agyn-contrib/k8s-runner/charts/k8s-runner \
  node scripts/agyn-live-lifecycle.mjs parallel
```

The wrapper refuses this scenario without an explicit reviewed network chart.
It uses the lab kubeconfig, not the ambient context, and restores only the
deployment settings it owns. The scenario creates a private fixture agent using
the existing subscription reference; it does not read/copy subscription secrets
or use paid API inference. It does not add Kubernetes access to the A2A service.

Successful evidence is in `.state/agyn-reporting-live-GAxAyE/parallel.json`.
The companion `evidence.json` records fixture IDs, scoped policies and cleanup;
the detailed parallel snapshots are in `parallel.json`, not the single-task
`snapshots` field. The deployment snapshot is
`.state/agyn-lifecycle-deploy-eMrTsA/before.json`. Both temporary policies were
removed only after all fixture workloads were gone, and the original deployment
was restored. Private evidence, databases and transcripts are not committed.

The first attempt, `.state/agyn-reporting-live-c8vbCN/parallel.json`, passed the
initial concurrency/network checks but failed before releasing A1 because the
operator's reused HTTP connection closed during synchronous probes. It is not
counted as a successful run. The operator now requests fresh local HTTP
connections without retrying possibly accepted submissions. Its cleanup also
removed its pods/policies, retained PVCs and restored the deployment.

All 62 build/module/process tests pass. Five focused parallel tests exercise the
same barrier program in real child processes, including replay, wrong releases,
timeouts, shared identities and invalid FIFO evidence. A barrier never treats
timeout as success, and a release is bound to both marker and turn. Existing
acceptance cases and production service/controller code are preserved.

Remaining release gates are tracked in [PRODUCTION.md](PRODUCTION.md). Restoring
a session is not proof that arbitrary interrupted side effects can be retried.
