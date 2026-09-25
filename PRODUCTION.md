<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Production Readiness

**Not production-ready.** This is the current release checklist for the Agyn-backed
A2A service. Recorded verification is summarized in [ACCEPTANCE.md](ACCEPTANCE.md);
installed revisions and operating instructions are in [KUBERNETES.md](KUBERNETES.md).
Historical milestones are in the [archive](docs/archive/README.md), not this checklist.

## First Deployment Target

Single-node self-hosted Kubernetes with tested backup and restore. Multi-node HA
is not required for this first release. Task isolation, durable workspaces,
parallel work across tasks, serialized same-task turns and compute release
between turns remain mandatory.

The application and its agent runtimes have different security boundaries.
Restricted settings on the A2A app Pod do not make the native agent Pods safe
for untrusted repositories.

## Baseline In Place

Baseline results are historical evidence in the
[September 25 readiness snapshot](docs/archive/2026-09-25/PRODUCTION.md),
[acceptance record](docs/archive/2026-09-25/ACCEPTANCE.md) and
[deployment record](docs/archive/2026-09-25/KUBERNETES.md).
Their original failures, corrections and verification limits still apply.
Neither those results nor the presence of an implementation closes the gates below.

## Release Gates

### 1. Sandbox And Resource Isolation

- [ ] Harden native agent Pods and protect runtime-managed hooks/journals from
  agent modification. No production `Unconfined` workaround.
- [ ] Verify fail-closed bootstrap, cross-task network/overlay authorization,
  credential isolation and egress restrictions against adversarial workloads.
  Cover node/host-network, IPv6 and public destinations, not only Pod-to-Pod probes.
  Test effective additive policies and treat same-Pod isolation and overlay
  authorization as separate boundaries; a deny rule alone is not proof of either.
- [ ] Make bounded resource profiles and protected workload quotas mandatory.
  Test OOM, storage/PID/IO exhaustion, fairness and sustained capacity pressure.
  Account for the whole task, including supporting runtimes, and size production
  profiles from representative workloads. Exercise supporting-runtime failure and
  real-agent OOM recovery without replay; a kernel OOM probe does not establish this.
- [ ] Verify execution credentials cannot cross task/owner boundaries during
  replacement, cancellation or cleanup.

Acceptance: an untrusted task cannot access another task's state, platform
control credentials or forbidden endpoints, or exhaust unbounded shared resources.
Repeat allow/deny controls after restart and upgrade, not just policy creation.

### 2. Infrastructure Fencing And Recovery

- [ ] Authenticate and authorize all lifecycle writers and native control routes;
  verify backend incarnation and actual overlay Dial/Bind policies.
- [ ] Fence partitioned or replaced nodes and stale writers. Reconcile delayed
  create/delete requests without activating or deleting replacement resources.
- [ ] Close remaining unknown-provider/preparation paths, including accepted
  requests with no authoritative workload binding and delayed credential cleanup.
- [ ] Verify physical removal, owner-aware storage retirement and durable cleanup
  without relying on billing timestamps or a single incomplete inventory.

Acceptance: control-plane/process/node failures cannot cause automatic replay,
overlapping same-task execution, premature release or deletion of retained state.
Pod absence on a healthy node is not partition fencing. Uncertain side effects
remain quarantined until an explicit, auditable decision.

### 3. Replacement-Node Backup And Restore

- [ ] Produce encrypted off-node backups with a defined recoverable boundary,
  retention policy and all required Kubernetes/backend identities.
- [ ] Include all required Agyn databases and credentials, A2A state/events,
  workspace contents and native sessions, not just registry SQL or app SQLite.
- [ ] Restore on a clean replacement node, verify integrity and measure recovery
  point/time. Fence the old node and isolate the restored stack first.
- [ ] Hold admission closed until uncertain work is reconciled. Work queued at
  backup time may also have executed after the snapshot.

Acceptance: a complete replacement-node drill resumes an explicitly authorized
new turn with the correct workspace/session and no blind retry of old actions.
Existing local restore tests and same-node PVC retention do not meet this gate.

### 4. Transport And Credential Operations

- [ ] Deploy and verify HTTPS/ingress for remote browser, A2A and reporting traffic,
  preserving origin checks, SSE streaming, timeouts and backpressure.
- [ ] Test provider/execution/browser credential expiry, revocation and rotation,
  including secret-manager-to-Agyn synchronization.
- [ ] Replace broad operator credentials with least-privilege user/service access.
  Separate reconciliation authority from ordinary task submission.

Acceptance: credentials remain out of prompts, logs, artifacts and persisted
workspace state; revoked clients lose access during open streams as well as on
new requests. The current one-time Claude credential sync is not rotation automation.

### 5. Reproducible Deployment And Operations

- [ ] Package a pinned, compatible multi-repository release with reviewed image
  digests, generated API bindings, dependencies and schema requirements.
- [ ] Test draining, readiness, graceful shutdown and guarded in-place upgrades.
  Rollback must respect schema and inbox compatibility, not restore old images
  against a newer database.
- [ ] Define monitoring/alerts, failed-start recovery, retention/deletion and
  orphan/credential cleanup procedures with durable audit evidence.
- [ ] Validate the single-node storage/runtime profile. SQLite WAL requires
  working local filesystem locks and a supported patched SQLite build.

Acceptance: an operator can deploy, rotate credentials, upgrade, restore and
retire data from the documented release without private workstation assumptions.
The installed backend uses contribution branches, not just fork `main`.

### 6. Release Validation

- [ ] Run the complete Codex and Claude lifecycle matrix against the exact release:
  completed/interrupted continuation, parallel/FIFO, cancellation and streaming.
- [ ] Complete protocol/error conformance and sustained load/failure tests through
  the production ingress, including reconnects and slow consumers.
- [ ] Exercise real approval handling before claiming a supported human-approval
  workflow; it is not provided by the current native Agyn integration.
- [ ] Record reproducible commands, digests, failed/skipped checks and cleanup;
  distinguish model-free fixtures from real-provider and node-failure tests.

Acceptance: no gate is inferred from a test on a different image combination or
from restoring a transcript. Preserve failed receipts instead of relabeling them.

## Separate Follow-Up Features

Centralized native-session export/analytics, auto-improvement pipelines,
prompt/tool customization and remote editor takeover are not implemented.
They are separate product work, not substitutes for the release gates.
Editor access must preserve coordinator ownership and explicit human takeover/return.
Upstream contribution review is tracked in [CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md);
maintainer acceptance is not a substitute for production verification.
