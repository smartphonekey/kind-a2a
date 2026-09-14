<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Prepared Stack Rollout

Status: Gateway compatibility, operator guards, offline database restore and
migration rehearsal are verified. The installed stack has **not** been upgraded.
Full prepared-stack Codex/Claude A2A acceptance and the remaining
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
workload even while a newer turn is active. These additional assertions are
implemented and unit-tested, but have not run with live agents yet.

## Evidence On 2026-09-14

- Build and all **417 service tests** pass on pinned Node 24.21.0. This includes
  29 prepared rollout subprocess cases, 13 offline-backup subprocess cases,
  22 prepared Pod/removal proof cases, and the preserved baseline. Three new
  legacy cases reject prepared schemas before setup, after registry migration
  and before restoration.
- The installed source remains at migration `0017`: 61 legacy volume records,
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
- Installed runner permission probes still return **no** for Secret `get`,
  Secret `patch` and GET of `namespace/agyn-workloads`. Those prerequisites and
  reviewed image builds remain before the controlled rollout.

The rollout guard is a trusted-local operator control, not authenticated
all-writer fencing or proof against node/storage partitions. Unknown/late
preparation recovery, durable credential cleanup, backend placement without
volume pins, legacy reconciliation and full A2A/crash acceptance remain open.
No upstream PR has been opened.
