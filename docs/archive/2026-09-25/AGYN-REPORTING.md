> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Gated Agyn Reporting Integration

This is a tested **trusted-local** integration, not a hardened deployment. It
keeps Agyn responsible for pod/PVC lifecycle and the A2A service responsible for
task ownership, dispatch and durable reports. No upstream PR has been submitted.

**Compatibility correction:** the earlier images and reproduction commands below
do not implement the current removal contract. A later failed Pod proved that
Runners can stamp `removedAt` for metering without deletion. The new service
requires `removalConfirmedAt`; coordinated API/Runners/Gateway/orchestrator
rollout, model-free failed-Pod acceptance and all five native Codex regressions
now pass locally. See [AGYN-REMOVAL.md](AGYN-REMOVAL.md) for current evidence and
images before running another fixture. Stock deployments were restored and are
not compatible with this service. The live preflight now requires reviewed
Runners and Gateway images as well as the previous components.

## Network Acceptance Caveat

The original lifecycle results below did not prove network isolation. Subsequent live
probes found the Agyn VM was not enforcing its installed workload egress policy.
Restarting only VM K3s restored per-pod firewall rules. A new two-turn Codex run
passed with the ingress policy and a narrow, fixture-agent-only host reporting
route. [Parallel tasks and same-task FIFO](AGYN-PARALLEL.md) also pass under this
profile. Completion, interruption and cancellation also have passing network-profile
reruns; an earlier unexplained workload startup failure remains disclosed in
[AGYN-NETWORK.md](AGYN-NETWORK.md). See that report for evidence and
the `AGYN_LIVE_RUNNER_CHART` opt-in command; do not broadly allow host/LAN egress.

## Components Used For Earlier Runs

- `agynd-cli` persistence patch `c933329`, branch `fix/codex-home-persistence`.
- Independent required-init patch `591543b`, branch `feat/required-init-scripts`.
- Independent inbox-guard patch `8b6056c`, branch `feat/durable-inbox-guard`.
- Local integration branch `lab/reporting-integration`, commit `b8db063`, combines
  the patches without combining their upstream review units.
- Orchestrator branches `feat/stop-inactive-instances` (`7a6c8ec`) and
  `fix/confirmed-workload-removal` (`230977d`, then volume-retention fix `e0f57d8`),
  combined only for testing on `lab/a2a-lifecycle-integration` (`cba941a`). Explicit
  `STOP_INACTIVE_INSTANCES=true` bypasses idle delay for paused instances.
  These earlier patches stopped the orchestrator itself from stamping removal
  on failure/stop ACK, but did not account for the separate Runners billing path.
- `ops/Dockerfile.agyn-reporting-init` adds the patched daemon and Node to the
  original init image. The workspace image, Codex image and model are unchanged.
  Node's C++ libraries are private to its wrapper, not injected into Codex.
- An operator-owned environment with a per-instance `/workspace` volume,
  `CODEX_HOME=/workspace/.codex`, `AGYN_INIT_SCRIPTS_REQUIRED=true`, and
  `A2A_REPORTING_RUNTIME_SHA256` matching `dist/reporting/runtime.mjs`.
- `AGYN_INBOX_JOURNAL_DIR=/workspace/.agyn/inbox-journal` and
  `AGYN_INBOX_CONTROL_FILE=/run/agyn-execution/inbox-control.json`. The journal is
  durable per instance; the control file is private and ephemeral per workload.
- `scripts/agyn-execution-gate.cjs` registered as an environment init script,
  executed using `/agyn/bin/node` before the agent CLI starts.

Do not install the gate on the stock daemon and assume it is required. Stock
`agynd-cli` deliberately logs nonzero init exits and continues. Required-init
behavior is opt-in in the contribution patch, retaining existing defaults.

## Startup And Release

1. The service creates an explicit instance, with the task UUID compacted to
   Agyn's 32-character label limit, and an operator/instance thread.
2. It records dispatch intent before sending the message. Agyn wakes the pod only
   when the message reaches the instance's inbox. The send ACK is persisted before
   setup, so an installer failure does not discard a known request identity.
3. The required init script creates a private, ephemeral gate and waits. Re-entry
   in the same container fails; it cannot silently replay the inbox.
4. The installer finds the bound workload and connects through TerminalGateway.
   Its receiver waits at most 30 seconds for an absent init gate; RUNNING alone
   does not establish gate readiness. Unsafe or mismatched gates fail immediately.
   No Kubernetes client or cluster-admin credential is used for delivery.
5. After a verified raw-mode readiness frame, it streams the digest-pinned
   runtime and execution credential on stdin. No token is put in argv or chat.
6. The runtime checks its authenticated execution is still dispatching, installs
   MCP and Stop configuration while preserving Agyn's trace hook, and releases
   the init gate. Timeout, wrong identity, digest mismatch or setup failure does
   not authorize agent startup on the required-init daemon.
7. Reports commit to the service database before ACK. Only workload removal
   evidence permits settlement or a queued follow-up, not an outcome or pause ACK.
   The current contract requires explicit `removalConfirmedAt` from the updated
   Runners/Gateway/orchestrator stack. Billing's `removedAt` is insufficient.
   The replacement patch checks runner inspection and the exact durable ACK,
   and retains unconfirmed failures so replacements cannot skip their cleanup.
   An acknowledged non-canceled outcome lets native Stop finish normally while
   compute is releasing; it must not write a false cancellation notice into the
   resumable conversation. Actual cancellation and unacknowledged release still
   stop, with notices scoped to the execution.
8. The daemon journals intent before invoking any SDK. An ambiguous pending record
   blocks automatic retries. Only this workload's allowed message can execute;
   explicitly retired predecessors are acknowledged without running the agent.
   The service pins the configured workload ID to detect unexpected replacement.

The next message repeats startup with a new pod and credential, retaining the
same instance, thread, PVC and native Codex session. Generic reporting code is
outside the agent runtime image; Codex-specific configuration is a small adapter.

## Reproduce The Local Test

The following records the earlier test profile. It is not currently sufficient
for the new driver; complete the coordinated rollout in
[AGYN-REMOVAL.md](AGYN-REMOVAL.md) first. Do not label stock images as reviewed
confirmation images to bypass the new preflight.

Select the [patched Node/SQLite runtime](SERVICE.md#run-requirements) with
`nvm use`, then build and test with `npm ci && npm test`. From the combined daemon
checkout, build the integration binary into the lab's dedicated build context:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -o /home/alex/work/aira-a2a-lab/.state/agyn-init-build/agynd ./cmd/agynd
```

From this checkout:

```sh
docker build -f ops/Dockerfile.agyn-reporting-init \
  -t a2a-agynd-reporting-init:b8db063 .state/agyn-init-build
agyn local load-image a2a-agynd-reporting-init:b8db063
```

From the combined orchestrator checkout, build its integration binary:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -o /home/alex/work/aira-a2a-lab/.state/agyn-orchestrator-build/orchestrator ./cmd/orchestrator
```

Back in the lab checkout, load the images. The inspector uses a real Node runtime,
not the daemon's packaging-only init image:

```sh
docker build -f ops/Dockerfile.agyn-orchestrator \
  -t a2a-agyn-orchestrator:cba941a .state/agyn-orchestrator-build
agyn local load-image a2a-agyn-orchestrator:cba941a
docker pull node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
```

Use an otherwise idle local lab. These daemon/orchestrator settings are
platform-wide, not per agent. The wrapper refuses existing workload pods, saves
only its managed settings, applies resource-version-checked updates and restores
the previous fields in `finally`. External edits are preserved or surfaced as an
explicit conflict, never overwritten. For process/host failure, its private
`.state/agyn-lifecycle-deploy-*/before.json` is the manual recovery record.

```sh
NODE_EXTRA_CA_CERTS="$HOME/.agyn/local/certs/agyn-local-ca.pem" \
  AGYN_LIVE_ACCEPTANCE=trusted-local \
  AGYN_LIVE_INIT_IMAGE=a2a-agynd-reporting-init:b8db063 \
  AGYN_LIVE_ORCHESTRATOR_IMAGE=a2a-agyn-orchestrator:cba941a \
  AGYN_LIVE_INSPECTOR_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 \
  node scripts/agyn-live-lifecycle.mjs cancellation completed interrupted
```

The test verifies that the selected image is deployed, creates separate private
agent/environment fixtures, references the template's existing subscription
without reading its credential, starts the real service and uses real model
turns. Set `AGYN_LIVE_TEMPLATE_ENVIRONMENT` to another native Codex environment as
needed. `AGYN_LIVE_HOST_IP` defaults to this Lima lab's host address `192.168.5.2`.
The test uses explicit HTTP reporting on this trusted local link; production
requires TLS and network policy. It never mounts host Codex authentication.

Pass just `interrupted` to the wrapper for the interrupted-turn fault test. It
kills the controller and deletes only its fixture pod after an unconditional
append, inspects the gated replacement's pending journal and marker, restarts
the controller, and requires quarantine plus removal before explicit recovery.
The follow-up must keep the native session/PVC, acknowledge-only the old request,
and read exactly one marker line. This is not automatic retry of the old turn.

The `cancellation` case starts a 120-second native command with a heartbeat and a
late side effect. Operator inspection verifies it survives SIGTERM before A2A
cancellation. A Kubernetes deletion watch must complete before `runtime.stopped`,
within a 30-second test bound. A separate credential-free, read-only PVC inspector
checks that the heartbeat stopped and the late side effect is absent. It cannot
resume the canceled agent. The inspector Pod alone is deleted; the PVC remains.
All scenarios now independently check that instance Pods are absent on settlement.

Evidence and private task storage are retained in `.state/agyn-reporting-live-*`.
The service is stopped and its instances paused after the test. The wrapper
restores the exact previous images/settings; verify zero workload pods afterward.
Do not unpause gated fixtures under the stock daemon. Test instances/PVCs remain
for inspection; deletion is a separate retention operation.

## Verified And Pending

The successful 2026-09-13 run verified real MCP progress/artifact/outcome calls,
a real native Stop reminder, completed-turn pod replacement, unchanged native
session identity, unchanged PVC and a persisted file. See [ACCEPTANCE.md](ACCEPTANCE.md).
The paired orchestrator regression additionally verifies bounded cancellation
and actual instance Pod absence on settlement, not just removal timestamps.

Required-init exit/cancellation behavior has focused Go tests; a deliberately
failing init script still needs a dedicated live failure test. A separate real
interrupted-turn test now verifies controller/pod loss, a gated replacement,
quarantine, explicit retirement and one unchanged marker line across native
session recovery. Independent parallel tasks in this new service, a second agent,
non-root/read-only runtime boundaries, credential isolation from the agent,
network enforcement, TLS deployment and operational recovery remain gates.

The init image is a local packaging fixture. Its dependencies must be pinned and
reviewed for a release. Neither root-owned files nor a managed hook protects the
lab from an agent that already has root access. The gate is a coordination
mechanism, not a security sandbox.

Confirmed runner absence is not fencing for a partitioned node, an externally
force-deleted Pod or a delayed in-flight create. Historical removal timestamps
require an operator drain/audit. The bounded local cancellation result does not
close those production recovery gates.
