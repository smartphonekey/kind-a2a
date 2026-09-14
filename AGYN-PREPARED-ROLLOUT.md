<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Prepared Stack Rollout

Status: the reviewed prepared Agyn stack is now deployed and retained locally,
with registry migrations through `0022`. All five Codex lifecycle scenarios pass
on the final readiness-corrected service, with exact Pod/PVC/removal evidence.
A captured terminal-readiness race is corrected; earlier startup failures remain
unclassified. Prepared-stack Claude acceptance, sustained reliability and remaining
[production gates](PRODUCTION.md) are still required.

## Why The Rollout Changed

The previous acceptance wrapper upgraded Runners and later restored the original
images. That is unsafe for checked/prepared state: persistent owner/backend pins
survive workload-history cleanup, and old clients do not implement the new
execution contract. An empty workload namespace does not authorize downgrading
those clients or discarding retained workspaces.

Legacy wrapper mode now checks the installed schema before changes, after the
registry rollout, and before restoration. Any migration newer than `0017`
refuses that path. It never treats billing end, zero Pods or history GC as a
rollback permit.

Prepared mode is explicit and retains the reviewed stack, including on failure.
It stops the old orchestrator before migrating the registry, verifies that its
Pods are absent, and starts it again only after every reviewed dependency is
installed. A partial upgrade or lost acknowledgement leaves the recorded state
for reconciliation; it does not restart old writers or restore old images.

Deployment rollout completion at zero replicas does not prove that terminating
Pods are gone. The wrapper now waits up to 80 seconds for deletion and then
independently rechecks the Deployment UID, zero desired replicas and empty Pod
selector. A timeout, false deletion acknowledgement or concurrent identity/scale
change prevents migration. Four new subprocess regression cases cover this.

## Gateway Compatibility

The dependent Gateway branch is
[`test/prepared-workload-forwarding`, `127e007`](https://github.com/spk-ai/gateway/tree/test/prepared-workload-forwarding),
based on `6d7d432`, generated against API `24b73ca`. It changes tests and build
instructions, not production handlers or public mutation APIs.

All **276 Gateway race-test entries** pass without exclusions or skips; build
and vet pass. The new test has 70 real Connect HTTP/gRPC round trips, with 93
entries including parent cases. Both owner kinds retain lifecycle fields,
complete Pod/PVC/backend identities, removal observations and exact 64-bit
revision strings. Legacy/unbound records acquire no invented evidence.
Backend responses and resolved authentication are fixtures, not a live registry
or an authorization deployment proof.

## Backup And Rehearsal

`scripts/agyn-prepared-backup.mjs` takes a private custom-format dump of the
installed `runners` database. Installed access is read-only. It restores into
a newly created, digest-pinned PostgreSQL container with no network, no published
ports, bounded CPU/memory/PIDs and temporary data storage. Loopback TCP readiness
excludes the image's temporary Unix-socket-only initialization server.

One read-only MVCC transaction captures migrations, lifecycle fingerprints,
database guards and durable owner-pin counts. Pod/namespace UUIDs and the
PostgreSQL container incarnation are checked around each source observation.
No runtime containers, failure text or credentials enter these JSON projections.
The dump itself is sensitive and stays in a private directory with mode `0600`.

The restored lifecycle must match the source. Migrations `0018` through `0022`
then run **only on the offline copy**, with checked constraints/triggers and
unchanged projected volume/workload history. Exact labeled-container cleanup
and a final source check precede issuance of `receipt.json`. A failed restore,
migration, source comparison or cleanup produces no usable receipt. Raw
subprocess output is not logged.

Required environment:

- `AGYN_LIVE_ACCEPTANCE=trusted-local` and absolute `AGYN_KUBECONFIG`.
- Private, owned `AGYN_AUDIT_OUTPUT_DIR`.
- `AGYN_AUDIT_POSTGRES_POD`, `AGYN_AUDIT_POSTGRES_UID`,
  `AGYN_AUDIT_POSTGRES_USER`, `AGYN_AUDIT_RUNNER_ID`, and
  `AGYN_AUDIT_NAMESPACE_UID`, from a fresh installed-state review.
- Digest-pinned `AGYN_PREPARED_POSTGRES_IMAGE`, already available to Docker.
- Absolute `AGYN_PREPARED_REGISTRY_MIGRATIONS`, pointing at the reviewed Runners
  migration directory. The receipt records each applied SQL file's hash.

With those values set and the pinned Node runtime selected:

```sh
npm run build
node scripts/agyn-prepared-backup.mjs
```

The operator wrapper verifies private ownership, the archive hash, matching
source scope/fingerprint, restored fingerprint, migration rehearsal and cleanup
before making deployment changes. A lifecycle change invalidates the receipt.

This is a registry restore/rehearsal, **not** whole-platform disaster recovery.
It does not back up task PVC contents, the A2A SQLite database, other Agyn
databases, database roles/grants or external identities. Do not restore this dump
over the installed database after newer work has been admitted. Coordinated
recovery of all durable state still needs its own verified protocol.

## Prepared Acceptance

Use `scripts/agyn-live-lifecycle.mjs` with the usual bounded/network fixture
configuration, plus:

- `AGYN_LIVE_PREPARED_WORKLOADS=true`.
- `AGYN_LIVE_PREPARED_RETAIN=true`, acknowledging that original deployments
  will not be restored automatically.
- Absolute `AGYN_LIVE_PREPARED_BACKUP_FILE`, identifying the verified receipt.
- The same explicit audit scope as the receipt.
- Digest-pinned orchestrator, Runners, Gateway, native runner and daemon-init
  images. Optional proxy diagnostics must also be digest-pinned.

The reviewed runner must target `agyn-workloads` with Ziti enabled. Its service
account needs Secret `get`/`patch` and GET of the exact workload Namespace,
in addition to its existing workload permissions. The native chart already
defines these permissions; image replacement alone does not install them.
Preflight checks happen before any deployment mutation. This local wrapper
supports the reviewed single-replica installation, not arbitrary HA topologies.

The wrapper records private before/retained evidence, uses resource-version and
deployment-identity checks, preserves unrelated settings, and refuses external
scale or managed-setting conflicts. Partial upgrades remain stopped until an
operator reviews and completes the coordinated state. There is no force-rollback
or automatic legacy-volume adoption option.

Prepared live acceptance checks the schema before reading model credentials.
The same completed/interrupted/cancellation/parallel/streaming workflows now
capture activated Pod identity, its exact PVC incarnations and ownership holds.
Gateway removal responses must preserve those bindings, the complete registry
volume set, a decimal-string revision, REMOVED phase, explicit timestamp and
an exact-binding ABSENT observation. Parallel follow-up checks the retired
workload even while a newer turn is active. The completed-turn case now passes
with live Codex; broader prepared-stack acceptance remains required.

## Pre-Rollout Evidence On 2026-09-14

- Build and all **417 service tests** pass on pinned Node 24.21.0. This includes
  29 prepared rollout subprocess cases, 13 offline-backup subprocess cases,
  22 prepared Pod/removal proof cases, and the preserved baseline. Three new
  legacy cases reject prepared schemas before setup, after registry migration
  and before restoration.
- That installed-source snapshot was at migration `0017`: 61 legacy volume records,
  125 confirmed workloads, zero checked/prepared records and no owner-pin table.
- Offline restore and all five migrations pass against that actual installed
  data. Source/restored fingerprints match; projected volume/workload lifecycle
  data and prepared-pin counts stay unchanged through migration.
- Successful private receipts include `backup-WfEtXq` and the subsequent
  TCP-readiness run `backup-qG3JI0` under
  `.state/agyn-prepared-rollout-ugufJQ/`. Every created database is confirmed
  absent. No installed database, deployment, RBAC, PVC or quota was modified.
- The first rehearsal failed during restore before adequate diagnostics were
  recorded; its database was removed. The exact initial cause remains unknown.
  Inspection of the pinned image identified a readiness race against its
  temporary server; the tool now requires loopback TCP and has sanitized
  failure/cleanup tests. Later success does not retroactively classify that
  first failure.
- Runner permission probes then returned **no** for Secret `get`, Secret `patch`
  and GET of `namespace/agyn-workloads`. The later scoped installation is
  documented in [runner RBAC](AGYN-RUNNER-RBAC.md).

## Installed Prepared Stack

Private build/operator evidence is in `.state/agyn-prepared-live-QuUwHe/`.
The four binaries were built against API `24b73ca` with credential-free,
binary-only Docker contexts and pinned deployed base images. `build.json`
records binary hashes, Go build metadata, source revisions and OCI digests.
Each digest alias was independently registered and checked in the VM image
store; importing a tag alone did not create those aliases.

| Component | Binary source | Retained image digest |
| --- | --- | --- |
| Runners | `e7c42f4` | `sha256:bb1cc8def75b9d93813774e5e645967d9d6e038c502cd98339f5d881f9b55766` |
| Gateway | `127e007` | `sha256:229039b849779a85d84d93287c302f14133e5237b51df213d0475bcd7eec3c3b` |
| Orchestrator | `754e935` | `sha256:877f5bf9760fc1c84b2c0ce5636f9c00e990f2db26ef0bc21633c55d72edcf2b` |
| Native runner | `1a5a7b6` | `sha256:e9c1995ddf482e8cf587ae6c5d6a12e3cbd1337f7e9759d46bafbb749210144d` |

The native chart includes the additional RBAC-only commit `73c3a20`; it does
not change the built runner binary. Daemon init remains the previously verified
`7ed299f` image with digest `97dee776b0866e3324da20d3ac511239928dd73971af45e6748b9f9b98f18b70`.
The scoped runner permission matrix passes 57 checks. Fresh credential-free
network preflight `agyn-network-live-Yz5cYl` passes all 92 probes and cleanup.
Backup `backup-spmsWd` restores the actual pre-upgrade registry and rehearses
all five migrations offline; its disposable database is confirmed absent.

The first rollout, `agyn-lifecycle-deploy-4dflan`, stopped before migration
because an old orchestrator Pod was still terminating. The operator proved
that all images, managed settings and registry lifecycle data were unchanged,
then restored only that pre-migration orchestrator to retry the corrected
deletion wait. This is not a rollback procedure for prepared state.

The next rollout, `agyn-lifecycle-deploy-imwOVu`, installed all four reviewed
images, verified migrations/guards and resumed the new orchestrator. Its first
agent subprocess failed before task creation because the operator PATH omitted
the Homebrew Agyn CLI. The reviewed stack was retained, not downgraded. Later
fixtures run directly against that installed stack with the pinned Node binary
prepended to the existing PATH.

## Completed-Turn Acceptance

Real Codex `0.147.0` / `gpt-5.5` passes two turns in
`.state/agyn-reporting-live-4wBQQK/evidence.json`, task
`00a0d49d-c5a6-4927-bec3-a68422a76460`. The Pod UIDs differ while instance
`6789b404-5ca0-4efe-8a63-11658dbbd8b3`, native session
`01a0a180-eb42-7623-8656-d94802773ace`, PVC UID
`f4bfc2a2-85a3-4d2c-b4e3-fa6978414454` and file contents remain unchanged.
The Stop reminder elicited a real MCP outcome. Both prepared records reached
REMOVED at revision `7`, with complete identical volume bindings and explicit
exact-binding ABSENT observations. Per-container bounds and main cgroups passed.

A fresh repeat on the final readiness-corrected service also passes:
`.state/agyn-reporting-live-K3U8bS/evidence.json`, task
`297dc5c5-ecb3-49dc-a8a6-21d38135958d`. Instance
`b47718e4-7d33-401f-bb13-350664eeec7a`, native session
`01a0a1ab-c3c1-7c23-85a0-1ffc2bf87ff5` and PVC UID
`e372339b-5b48-4923-8972-e370178f0e94` persist across different Pod UIDs.
Both turns release compute with exact prepared removal proofs. This repeat
completes the five-scenario Codex sweep after the service-side correction.

Earlier fresh tasks in `agyn-reporting-live-YB0PsL` and
`agyn-reporting-live-4ofnlz` failed during reporting setup and were quarantined,
then canceled by fixture cleanup with their workspaces retained. The latter
captured cancellation during daemon initialization, which can be a cleanup
consequence rather than the original fault. The successful later task does not
explain those failures. No uncertain task was automatically redispatched.

Diagnostics now retain enumerated daemon stages/error codes and restricted
reporting-installer failure stage/HTTP/RPC metadata. Terminal failures distinguish
handshake, protocol, transport, remote exit and timeout, with booleans for
receiver readiness, attempted payload delivery and receipt acknowledgement.
Arbitrary child output, credentials, prompts and raw error bodies are excluded.
Diagnostic reports do not acknowledge execution, authorize retries or
constitute task outcomes.

## Interrupted-Turn Investigation

Fixture `agyn-reporting-live-7J43OJ` failed before fault injection. The installer
diagnostic identifies terminal delivery, after ticket creation, but predates
the more specific terminal-phase diagnostics. It does not establish whether
credentials were sent or acknowledged. Cleanup quarantined the execution,
removed compute and retained its workspace; no automatic redispatch occurred.

The next fixture, `agyn-reporting-live-xhCNez`, reached a real side effect and
persisted a pending inbox journal before controller SIGKILL and Pod deletion.
Its first failure message, "Agyn did not recreate the unacked workload", was
too broad: the independent observer recorded replacement Pod UID
`210d2b24-0990-4220-93e7-ce1fd6788284`, still initializing at test cleanup.
Read-only registry inspection confirms both original and replacement records
reached REMOVED with exact UID bindings and independent removal timestamps.
The original was confirmed absent at `20:08:22.275810Z`; the replacement record
was created at `20:08:37.316622Z`. This fixture did not complete recovery or
prove that the interrupted side effect was not replayed.

The installed orchestrator has `POLL_INTERVAL=5s` and no override for
`WORKLOAD_RECONCILE_INTERVAL`, whose reviewed source defaults to 60 seconds.
The first confirmed-failure retry backoff is another 10 seconds, before
container initialization. The old 60-attempt inspection loop did not cover
that sequence and conflated missing Pods with not-yet-inspectable containers.
The replacement observer now has an explicit 180-second monotonic deadline,
records appearance and inspection latency, and rejects overlapping Pods,
predecessor reuse, changed replacement incarnations and mismatched inspections.
It performs reads only. All existing journal, side-effect, credential-gating,
quarantine, explicit-reconciliation and prepared-removal assertions remain.
Seven deterministic cases cover the observer, including late initialization,
missing/uninspectable Pods and probe time charged to the deadline.

The corrected observer reached the gated replacement in fixture
`agyn-reporting-live-YiPkRj` after 68.418 seconds, with the first Pod observation
at 49.843 seconds. Its single-line append, pending journal and absent execution
authorization were verified. Controller restart quarantined the interrupted
execution, confirmed removal of both Pods, rejected an unreconciled follow-up
and accepted explicit acknowledgement-only retirement. The subsequent turn
failed during reporting setup, so the complete interrupted scenario did not
pass in this fixture.

## Terminal Readiness Race

The failed follow-up in `agyn-reporting-live-YiPkRj` captured terminal exit code
1 before receiver readiness, with no attempted payload or acknowledgement.
An independent bounded read of TerminalProxy logs at `20:20:48.187578692Z`
identifies `container main not found`. Only that fixed classification and its
timestamp are retained, in `terminal-readiness-incident.json`; no raw proxy logs
or arbitrary error bodies are stored.

The installed [TerminalProxy v0.7.0](https://github.com/agynio/terminal-proxy/blob/v0.7.0/internal/proxy/server.go)
resolves the main alias from registry container inventory before opening runner
exec. The reviewed runner reporter can publish RUNNING from Pod readiness
without publishing containers, while the orchestrator fills that inventory on
its independent reconciliation interval. Treating RUNNING alone as terminal
readiness therefore races the first container observation. This explains the
captured follow-up failure; it does not retroactively classify older failures.

Reporting setup now waits for one published, running MAIN container before its
first terminal-ticket request. Duplicate main roles/names, a conflicting literal
`main` alias and a terminated main container fail closed. The existing setup
deadline remains bounded, and ticket/credential delivery is never retried.
The real installer subprocess regression observes missing, empty and waiting
container inventory before making exactly one ticket request. No TerminalProxy,
runner or orchestrator image was changed for this service-side correction.

The current build and all **437 service tests** pass on Node 24.21.0 with no
failures or skips. The complete live interrupted rerun below now passes with
this correction. Earlier failures without the same proxy observation remain
unclassified; this is not yet sustained startup-reliability acceptance.

## Interrupted-Turn Acceptance

Real Codex passes the complete interrupted scenario in
`.state/agyn-reporting-live-igtx0m/evidence.json`, task
`9166663c-26a9-413f-b7d8-55df296401a8`. This differs from completed-turn recovery:
the A2A controller is killed with SIGKILL and its Pod deleted after an
unconditional append and a persisted pending inbox journal, before any outcome.

- Instance `52a0947b-b05c-4117-8b14-3fe650334b68`, native session
  `01a0a19d-1e46-73c0-b8ae-a4b7d9306263` and the exact workspace binding persist
  across original, gated replacement and reconciled-follow-up Pod UIDs.
- The original Pod is `2290eb2b-3df6-4689-b718-a0637f7cd544`; the gated
  replacement is `b439125e-c6bd-489f-8842-8b38280d8c67`, inspected after 66.261
  seconds. Its append is still exactly one line, journal unchanged, and
  execution authorization absent.
- Controller restart quarantines the execution with `automaticRetry=false`,
  `uncertainSideEffects=true` and `recoveryRequired=true`. Both workloads have
  exact removal confirmations before release. An unreconciled follow-up is
  rejected; explicit operator reconciliation retires the old request.
- Follow-up Pod `ad4679d4-259e-4a3c-ab46-30ce22fa3d95` preserves the session and
  workspace, records the old request as `ack_only`, and publishes the unchanged
  one-line artifact. Its real MCP outcome completes the turn and releases
  compute, leaving the task reusable without uncertain side effects.
- All three prepared workload records finish at REMOVED revision `7`, with
  matching exact-binding ABSENT observations. Per-container resource bounds,
  main cgroups and the fixture's network policy assertions pass.

The fixture exits successfully and removes task compute while retaining its
workspace. This proves explicit recovery in this healthy local Kubernetes
environment, not safe automatic retry or node/storage-partition fencing.

## Cancellation Acceptance

Fixture `.state/agyn-reporting-live-2u2BgQ/evidence.json`, task
`7ffadf6e-18fb-4439-9730-f9956d413b43`, passes real Codex cancellation on the
same retained stack and readiness-corrected service. The fixture first verifies
that its child process survives SIGTERM, then submits A2A CancelTask.

Cancellation settles in 3.540 seconds. Physical Pod deletion is independently
observed before `runtime.stopped`; prepared workload
`ce57869e-9b7f-40b3-8b63-2ed3895e8953` has exact-binding removal confirmation.
The retained PVC UID is `a5c6bcc8-ba72-43be-a03d-916bd6f675bc`. Two isolated
post-deletion inspections show unchanged heartbeat/marker state, observed
SIGTERM and no late side-effect file. Follow-up to the canceled task is rejected.
Compute is removed and the workspace retained. Node-partition and late-operation
fencing are not covered by this healthy-cluster fixture.

## Parallel And Streaming Acceptance

Parallel fixture `.state/agyn-reporting-live-wHVfNo/parallel.json` passes on the
readiness-corrected service. Two tasks for agent
`b8a0f5da-b990-427a-b019-655d745843ff` have different instances, Pods, PVCs and
native sessions. Both barrier heartbeats advance, while the earlier same-task
follow-up stays queued. After its predecessor's confirmed removal, that
follow-up changes only its Pod UID and retains its instance/session/workspace;
the other task continues advancing. All three turns settle and release compute.

Four directional TCP/UDP cross-task probes are denied with working positive
controls. Three execution-scoped reporter checks return their own execution
state, reject owner-API access and use different credentials. The predecessor's
prepared removal proof is checked even while a newer workload for that instance
exists. These selected controls do not establish complete overlay authorization.

Streaming fixture `.state/agyn-reporting-live-5LutTW/evidence.json`, task
`babde256-268b-4160-943e-9a3f703425d3`, also passes. A duplicate blocking
SendMessage waits 87.302 seconds for the first outcome instead of returning a
working task. Two official-SDK event streams each deliver nine observations
over approximately 167.586 seconds, remain open through a 2.001-second idle
subscription window and Pod replacement, and close after final completion.
Both turns have real MCP artifacts/outcomes, the first has a native Stop
reminder, and both retain exact prepared Pod/PVC/removal evidence. This is local
protocol acceptance, not production ingress, sustained load or failover testing.

## Final Retained Verification

This section records the Codex snapshot. The later
[prepared-stack Claude report](AGYN-PREPARED-CLAUDE.md) verifies four Claude
scenarios, records three failed parallel attempts and revalidates the same
retained services, with 83 task claims and zero task Pods/unconfirmed removals
after cleanup. It does not supersede the Codex passes or close production gates.

All five Codex scenarios pass on the readiness-corrected service and the same
retained image set; all fixture processes have exited and cleanup is complete.

| Scenario | Private evidence directory |
| --- | --- |
| Completed continuation | `agyn-reporting-live-K3U8bS` |
| Explicit interrupted recovery | `agyn-reporting-live-igtx0m` |
| Cancellation | `agyn-reporting-live-2u2BgQ` |
| Parallel tasks and FIFO | `agyn-reporting-live-wHVfNo` |
| Blocking and streaming continuation | `agyn-reporting-live-5LutTW` |

The independent read-only check in `retained-verification.json` revalidates the
four original Deployment UIDs, reviewed image digests and readiness; exact
created RBAC object identities/rules; the empty superseded broad binding; and
all 57 effective permission probes. All original 60 task PVC UIDs/specs/phases
are unchanged. There are 72 retained task claims and zero task Pods.
The registry contains 146 workload records, including 21 prepared records and
zero unconfirmed removals, with 72 durable owner pins and schema guards through
`0022`. This snapshot does not authorize deleting retained data or restoring
older clients. The pre-upgrade backup receipt is historical and is not valid
for another rollout after these new lifecycle records.

The host Claude Max CLI also passed a separate, tool-free authentication smoke
test and refreshed its login. No Claude subscription was installed for these
Codex fixtures. Prepared-stack Claude acceptance, earlier unclassified failures,
sustained startup/load testing and the remaining production gates are still open.

The rollout guard is a trusted-local operator control, not authenticated
all-writer fencing or proof against node/storage partitions. Unknown/late
preparation recovery, durable credential cleanup, backend placement without
volume pins, legacy reconciliation and full A2A/crash acceptance remain open.
No upstream PR has been opened.
