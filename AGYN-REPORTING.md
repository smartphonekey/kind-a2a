# Gated Agyn Reporting Integration

This is a tested **trusted-local** integration, not a hardened deployment. It
keeps Agyn responsible for pod/PVC lifecycle and the A2A service responsible for
task ownership, dispatch and durable reports. No upstream PR has been submitted.

## Required Components

- `agynd-cli` persistence patch `c933329`, branch `fix/codex-home-persistence`.
- Independent required-init patch `591543b`, branch `feat/required-init-scripts`.
- Local integration branch `lab/reporting-integration`, commit `9e24c78`, combines
  the patches without combining their upstream review units.
- `ops/Dockerfile.agyn-reporting-init` adds the patched daemon and Node to the
  original init image. The workspace image, Codex image and model are unchanged.
  Node's C++ libraries are private to its wrapper, not injected into Codex.
- An operator-owned environment with a per-instance `/workspace` volume,
  `CODEX_HOME=/workspace/.codex`, `AGYN_INIT_SCRIPTS_REQUIRED=true`, and
  `A2A_REPORTING_RUNTIME_SHA256` matching `dist/reporting/runtime.mjs`.
- `scripts/agyn-execution-gate.cjs` registered as an environment init script,
  executed using `/agyn/bin/node` before the agent CLI starts.

Do not install the gate on the stock daemon and assume it is required. Stock
`agynd-cli` deliberately logs nonzero init exits and continues. Required-init
behavior is opt-in in the contribution patch, retaining existing defaults.

## Startup And Release

1. The service creates an explicit instance, with the task UUID compacted to
   Agyn's 32-character label limit, and an operator/instance thread.
2. It records dispatch intent before sending the message. Agyn wakes the pod only
   when the message reaches the instance's inbox.
3. The required init script creates a private, ephemeral gate and waits. Re-entry
   in the same container fails; it cannot silently replay the inbox.
4. The installer finds the bound workload and connects through TerminalGateway.
   No Kubernetes client or cluster-admin credential is used for delivery.
5. After a verified raw-mode readiness frame, it streams the digest-pinned
   runtime and execution credential on stdin. No token is put in argv or chat.
6. The runtime checks its authenticated execution is still dispatching, installs
   MCP and Stop configuration while preserving Agyn's trace hook, and releases
   the init gate. Timeout, wrong identity, digest mismatch or setup failure does
   not authorize agent startup on the required-init daemon.
7. Reports commit to the service database before ACK. Only workload removal
   evidence permits settlement or a queued follow-up, not an outcome or pause ACK.

The next message repeats startup with a new pod and credential, retaining the
same instance, thread, PVC and native Codex session. Generic reporting code is
outside the agent runtime image; Codex-specific configuration is a small adapter.

## Reproduce The Local Test

Build and test the service with `npm ci && npm test`. From the combined daemon
checkout, build the integration binary into the lab's dedicated build context:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -o /home/alex/work/aira-a2a-lab/.state/agyn-init-build/agynd ./cmd/agynd
```

From this checkout:

```sh
docker build -f ops/Dockerfile.agyn-reporting-init \
  -t a2a-agynd-reporting-init:9e24c78 .state/agyn-init-build
agyn local load-image a2a-agynd-reporting-init:9e24c78
```

Use an otherwise idle local lab. Record the orchestrator's existing
`AGYND_CLI_INIT_IMAGE` value before changing it. This setting is platform-wide,
not per agent. Temporarily select the integration image, wait for rollout, and
run the opt-in acceptance:

```sh
kubectl --kubeconfig .state/agyn-kubeconfig -n agyn-platform \
  set env deployment/agents-orchestrator AGYND_CLI_INIT_IMAGE=a2a-agynd-reporting-init:9e24c78
kubectl --kubeconfig .state/agyn-kubeconfig -n agyn-platform \
  rollout status deployment/agents-orchestrator --timeout=90s
NODE_EXTRA_CA_CERTS="$HOME/.agyn/local/certs/agyn-local-ca.pem" \
  AGYN_LIVE_ACCEPTANCE=trusted-local \
  AGYN_LIVE_INIT_IMAGE=a2a-agynd-reporting-init:9e24c78 \
  node dist/live/agyn-reporting.js
```

The test verifies that the selected image is deployed, creates separate private
agent/environment fixtures, references the template's existing subscription
without reading its credential, starts the real service and uses real model
turns. Set `AGYN_LIVE_TEMPLATE_ENVIRONMENT` to another native Codex environment as
needed. `AGYN_LIVE_HOST_IP` defaults to this Lima lab's host address `192.168.5.2`.
The test uses explicit HTTP reporting on this trusted local link; production
requires TLS and network policy. It never mounts host Codex authentication.

Evidence and private task storage are retained in `.state/agyn-reporting-live-*`.
The service is stopped and its instances paused after the test. Verify zero
workload pods and restore the exact previously recorded daemon image afterward.
Do not unpause gated fixtures under the stock daemon. Test instances/PVCs remain
for inspection; deletion is a separate retention operation.

## Verified And Pending

The successful 2026-09-13 run verified real MCP progress/artifact/outcome calls,
a real native Stop reminder, completed-turn pod replacement, unchanged native
session identity, unchanged PVC and a persisted file. See [ACCEPTANCE.md](ACCEPTANCE.md).

Required-init exit/cancellation behavior has focused Go tests; a deliberately
failing init script still needs a dedicated live failure test. Interrupted-turn
side effects, independent parallel tasks in this new service, a second agent,
non-root/read-only runtime boundaries, credential isolation from the agent,
network enforcement, TLS deployment and operational recovery remain gates.

The init image is a local packaging fixture. Its dependencies must be pinned and
reviewed for a release. Neither root-owned files nor a managed hook protects the
lab from an agent that already has root access. The gate is a coordination
mechanism, not a security sandbox.
