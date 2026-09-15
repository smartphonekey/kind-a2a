<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Anchored Registry Backup

Status: explicit offline backup/restore support for resource lifecycle schemas
through `0026`. Installed access remains read-only. The actual installed `0022`
registry has passed a dump/restore and four-migration rehearsal in a disposable
database. All 516 service test entries pass with the populated-history PostgreSQL
fixture enabled, with no failures/skips. Final preservation verification matches
the installed baseline. This evidence was collected on 2026-09-15.

This removes the previous backup projection gap; it is not a coordinated
deployment, whole-platform disaster recovery or authority to adopt a workspace.
The existing rollout path still rejects schemas newer than `0022` and rejects
the new receipt kind. The newer controller/runner/registry images are not installed.

## Contract

The existing command has a separate, explicit mode:

```sh
AGYN_PREPARED_BACKUP_CONTRACT=resource-anchors-through-0026 \
  node scripts/agyn-prepared-backup.mjs
```

Use the private output directory, fresh audited PostgreSQL Pod/Namespace/runner
identities, absolute kubeconfig, reviewed migration directory and pinned image
required by [prepared backup](AGYN-PREPARED-ROLLOUT.md#backup-and-rehearsal).
Omitting the new setting preserves `prepared-through-0022` behavior. Unknown
contracts, missing/gapped migrations and unreviewed later schemas are refused.
The anchored mode requires an existing prepared schema, not a pre-`0022` source.

One repeatable-read, read-only transaction captures the existing lifecycle
projection plus a third record containing:

- Complete workload resource documents, including both revisions, owner anchors,
  preparation revocation and separate cleanup observation.
- Complete volume anchors, original allocation reservations and anchored
  retirement observations, associated with their original registry IDs.
- Durable owner anchor requirements, including owners without current workloads.
- Column types/nullability/default hashes, constraint and trigger definitions,
  trigger enablement, and public function definitions/identity arguments.

New JSON documents are hashed whole with SHA-256 inside PostgreSQL. Nested
revision strings never pass through JavaScript numeric conversion. Metadata
changes cannot disappear simply because the old prepared fields stayed equal.
Fingerprints establish equality, not correctness of arbitrary database code or
authentication of a remote database. Existing prepared fingerprints are retained.

The snapshot uses a fixed search path and PostgreSQL's own definition functions.
Pretty constraint deparsing normalizes redundant parentheses introduced by
reparsing `BETWEEN` as boolean comparisons during restore. Function/constraint
substitutions still change the fingerprint. This is a same-version PostgreSQL
16.6 rehearsal, not a cross-version compatibility guarantee. PostgreSQL documents
these outputs as reconstructed definitions, not original source SQL.
[Definition functions](https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-CATALOG-TABLE).

The custom-format archive is restored only into a newly owned, labeled,
network-disabled container, with no published port or host bind mount and bounded
CPU/memory/PIDs. Pending workloads may be backed up without pretending they are
removed; the rehearsal never resumes them. The actual dump remains sensitive,
even though JSON evidence excludes credentials, runtime containers and raw errors.
Only trusted source databases are supported: restoring an archive can execute
source-controlled database code. [PostgreSQL restore warning](https://www.postgresql.org/docs/16/app-pgrestore.html).

## Receipt

`anchored-upgrade-restored-backup`, version 1, identifies the snapshot contract,
source scope/fingerprint, restored fingerprint, archive hash, image digest,
applied migration hashes and final rehearsal fingerprint. The private
`rehearsal-state.jsonl` is re-parsed and checked against both the receipt and
original lifecycle; boolean success fields alone are insufficient.

The checker requires private, owned regular files, rejects symlinked evidence,
requires every missing reviewed migration exactly once, and checks unchanged
workload, volume and owner-pin history. No receipt is issued until exact offline
container removal and a final fresh source check succeed. Source drift after
cleanup invalidates both backup modes. A failed or lost acknowledgement does not
authorize installed writes, an old-image rollback, or automatic task replay.

## Verification

The new unit and subprocess cases cover unknown contracts, future/gapped schemas,
missing evidence, pending histories, altered documents/functions, disabled guards,
lost create acknowledgements, failed restore/migration, wrong cleanup identity,
archive/receipt changes, symlinks and source drift through final cleanup.

The opt-in real PostgreSQL fixture creates ten valid histories through enabled
database guards: both agent-instance and sandbox owners, each with an unused
reservation, pending revocation, confirmed absence, mixed found/absent workspaces,
and retired storage. It restores four still-pending workloads, twelve volumes,
eight revocation proofs, six cleanup observations and two volume-retirement
observations. Original identities and the captured lifecycle-schema fingerprint
match. Other registry tables are not included in that fingerprint projection.

Restored guards reject proof erasure. Eight explicit corruption probes alter
only fields missing from the older projection; that older projection stays
exactly equal while the new fingerprint changes. A same-name weakened function
and constraint are also detected. Corruption bypasses are confined to newly
created offline fixture databases, with guards re-enabled before observation;
no installed or agent database is used. The fixture passes 11 test entries
(ten histories plus parent), with no failures/skips.

```sh
npm run build
AGYN_ANCHORED_BACKUP_TEST=trusted-local \
AGYN_ANCHORED_TEST_POSTGRES_IMAGE=postgres@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef \
AGYN_ANCHORED_TEST_MIGRATIONS=/absolute/reviewed/runners/migrations \
  node --test dist/anchored-upgrade-live.test.js
```

The installed-source rehearsal preserves 191 workload histories (66 prepared),
101 volume records (40 checked) and durable owner pins. All four migrations run
only on the restored copy, and that copy is confirmed removed. Private evidence
is `.state/agyn-anchored-backup-Vsav8B/backup-51F9pT/`; its receipt was independently
verified with `verifyAnchoredBackup`.

The complete service run is recorded in private `all-tests.junit.xml` under
that evidence root. Independent `before.json`/`after.json` snapshots match all
108 PVC identities/specifications/phases, 52 deployment identities/specifications/
readiness values, ten namespace identities, 96 ClusterRoles, 76 bindings and 25
pre-existing Docker container IDs. No task Pods or owned offline databases remain.
A final fresh database observation still matches the restore receipt at schema
`0022`, and the web service remains ready. No provider credentials were read or
renewed and no agent request was replayed in this milestone.

The first rehearsal (`backup-nurHvW`) failed because non-pretty constraint
deparsing changed a redundant-parenthesis representation; its data fingerprints
matched and its owned database was removed. It remains a failed attempt. The
initial populated fixture also failed when its intentional corruption probe left
guards disabled during observation; the collector correctly refused it. The
corrected fixture restores guard enablement before checking document sensitivity.

## Remaining Work

Existing-workspace adoption, all-writer coordination and the upgraded real-agent
A2A matrix remain required before deployment. New ownership/retention protocols
must extend this explicit versioned backup contract and rerun the rehearsal.
This does not back up PVC contents, A2A SQLite state, other Agyn databases,
roles/grants or external identities. Encrypted off-machine backups, recovery-point
objectives, complete restore/failover drills, supported patched dependencies and
the other [production gates](PRODUCTION.md) remain open.
