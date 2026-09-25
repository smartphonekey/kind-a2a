<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Existing Workspace Migration

Status: the reviewed backend is upgraded **in place** through registry schema
`0027`. All 107 active workspaces were adopted without replacing their PVCs or
files; the one unbound failed historical record remains quarantined. Real Codex
parallel continuation and interrupted-turn recovery both pass. The final backup,
restore checks and preservation audit pass, and both web services are ready.
Claude was intentionally not tested during this upgrade. The September 25
[Claude credential and A2A follow-up](AGYN-CLAUDE-A2A.md) is a separate acceptance
record on the same installed stack.

## Contribution Units

These focused branches extend the preserved September 24 upstream-sync branches:

| Repository | Branch / Commit | Change |
| --- | --- | --- |
| [API](https://github.com/spk-ai/api/tree/feat/volume-anchor-migration) | `0b9feaf` | Revisioned registry migration RPCs and separate adoption provenance |
| [Registry](https://github.com/spk-ai/runners/tree/feat/volume-anchor-migration) | `627a1aa` | Migration `0027`, durable admission block, guarded receipts and quarantine |
| [Controller](https://github.com/spk-ai/agents-orchestrator/tree/feat/volume-anchor-migration) | `fc93b1d` | Operator coordinator, authenticated native transport and adopted follow-up |
| Native runner | `0ed8c5c` | Existing tested adoption implementation, unchanged |
| Gateway | `7d8267d` | Existing source, regenerated against the new API |

All three new contribution branches are pushed. No upstream PR or acceptance by
Agyn is implied. Generated LLM churn is excluded; both generated and tracked
bindings were checked. The A2A controller, workflow, reporting service and web
application require no routing or profile-specific code changes.

The operator image is defined in
[ops/Dockerfile.agyn-volume-migration](ops/Dockerfile.agyn-volume-migration).
It contains only the migration command, not a second A2A stack or controller.
Binary source/API revisions, build information and OCI index/manifest/config
hashes are retained in the private deployment evidence.

## Installed Release

The existing four Deployments retain their UIDs and configuration, apart from
these verified image changes. No parallel candidate stack was deployed.

| Deployment | Installed Image |
| --- | --- |
| `runners` | `docker.io/library/a2a-agyn-migration-runners@sha256:30135da84301c64f0d1ef8005fef54c397fd898dbf4d340a6498df676818d716` |
| `gateway` | `docker.io/library/a2a-agyn-migration-gateway@sha256:6d8f558893437d0820c677f066b8f6d27a8ec4afc03f7c3cccd6f596b6b25372` |
| `agents-orchestrator` | `docker.io/library/a2a-agyn-migration-orchestrator@sha256:2de348ad22ec7af3c641d85971208c0103d5ebd2e2be28bf2d6761cc7b568000` |
| `k8s-runner` | `docker.io/library/a2a-agyn-candidate-runner@sha256:7c921e48156fb470d194880ce0f56536b08c4e6753d5c070e27308e7c072f7e3` |

The native image's historical name does not indicate a separate deployment.
These are locally imported images, not public registry releases. The app image
remains the digest documented in [KUBERNETES.md](KUBERNETES.md).

## Contract

Begin uses the exact complete owner inventory, lifecycle revisions and actual
native observations. It serializes on the registry owner guard and commits a
durable admission block with any legacy-to-checked promotion. Plans and adoption
IDs are immutable. An unbound failed historical generation receives no invented
PVC or binding and stays quarantined.

Reserve persists the native journal/owner receipt. Apply attaches the persistent
owner to the existing PVC, without changing its UID, specification or files; SQL
then records that exact binding and separate `anchor_adoption` provenance.
Finalize requires an independent read of committed SQL before removing the
temporary native hold. A separate native READY observation is persisted before
the whole owner can complete and reopen prepared anchored admission.

Old/raw lifecycle and workload writers are blocked during migration. Metering
updates remain possible. Receipts are append-only CAS transitions; completed
migrations and their source plans cannot be rewritten or cleared. There is no
force-unblock or automatic rollback. Resume the **same plan** after an ambiguous
response. Never fabricate an allocation receipt, delete a workspace or replay an
agent turn to make an upgrade proceed.

The CLI uses the existing private registry transport and authenticated Ziti
runner connection. Its coordinator exposes no agent-execution, PVC-allocation or
storage-deletion API. `-trusted-local-drained` is an acknowledgement, not a drain
implementation: the external operator must establish and verify that condition.
See the controller branch's `VOLUME-ANCHOR-MIGRATION.md` for the command and
reproducible fixture environment.

## Verification

| Check | Result |
| --- | --- |
| API lint / breaking against preserved API | Pass |
| Registry complete race suite with real PostgreSQL | Pass |
| Controller complete race suite and vet | Pass |
| Coordinator checkpoint / lost-reply unit cases | 64 cases, both owner kinds |
| Real Kubernetes/PostgreSQL three-process crash matrix | All 16 cases pass |
| Service regression suite | 521 pass, one opt-in database fixture skipped |
| Desktop/mobile UI | 12 pass |
| Backup source-path refusal tests | 10 pass |
| Populated adoption database restore | Pass, including 12 partial/completed/quarantined histories |
| Installed pre-upgrade database restore/rehearsal | Pass through `0027`, source unchanged |
| Installed workspace archive restore | 108 claims, 1,180,139,520 bytes, comparison and cleanup pass |
| Post-adoption registry and workspace restore | Pass before reopening execution, including all 107 completed migrations and one quarantine |
| Final post-test backup | Registry restore, 109-claim archive/restore comparison, both SQLite databases checked; 1,272,750,080 archive bytes |
| Real Codex completed-turn continuation | Two existing tasks run concurrently in separate new Pods; original PVCs, file markers and native sessions retained |
| Real Codex interrupted-turn recovery | One non-idempotent append retained; uncertain turn blocks follow-up until explicit reconciliation; new read-only turn preserves the same PVC/session |
| Compute release | Zero task Pods after both live Codex checks |
| Claude | Not run during this migration, as requested; [subsequent acceptance](AGYN-CLAUDE-A2A.md) is separate |
| Deployed UI | Restored history and old uncertain-task read-only state checked at 1440, 390 and 320 pixels; no overflow or page errors |

The live crash matrix covers begin, native reserve, SQL reserve, native apply,
SQL apply, native ready, SQL ready and completion for both agent and sandbox
owners. Every case kills and replaces coordinator, registry and native-runner
processes, preserves the original PVC/journal/file identities, and executes two
explicit follow-up probe turns with compute removed between turns. These are
credential-free probes, not model executions or a PostgreSQL/node crash test.

The initial live fixture used binary-GiB expectations against production's
decimal-GB conversion. Adoption itself preserved storage; follow-up correctly
rejected the fixture size. The fixture was corrected to use the production
conversion, cleaned up, rerun individually, then passed the full matrix.
Private preflight also corrected a SQLite row-prototype comparison and an
operator-Pod cleanup resource-version race; neither caused agent replay or
replacement of installed storage.

The interrupted test removed its exact Pod only after observing the append and
an acknowledged progress event. The old request was not resubmitted. Admission
rejected an unreconciled follow-up, then an explicit operator decision retired
that request and allowed a **new read-only turn**. The file still contained one
line in the replacement Pod. This is separate from completed-turn continuation;
it does not establish generally safe automatic retries or recovery from node loss.
The four pre-existing uncertain app executions remain unchanged. No real-provider
approval interaction was exercised by these two upgrade checks.

The host web unit was transient and disappeared when stopped. It was recreated
with the same service configuration and the explicit Node 24/Linuxbrew PATH;
an initial launch without the Agyn CLI directory failed before accepting work.
The Kubernetes port-forward reconnected automatically after app Pod replacement.

The final preservation audit matches all 116 original PVC/PV identities and
specifications, 11 namespaces, 53 Deployment identities, 96 ClusterRoles,
76 ClusterRoleBindings, 25 original Docker containers and original network
policies. Only the four reviewed backend images and the runner's namespaced
ConfigMap permissions changed. One additional PVC belongs to the new interruption
test. All original host/app execution records are unchanged; the app has four
new test turns. No task Pods, task Services, unconfirmed workload removals or
temporary operator/probe Pods remain. The owned PostgreSQL fixture was removed.

## In-Place Procedure

The source contained 108 registry volume records: 107 active workspaces and one
unchecked failed record with no native PVC. There were 116 total cluster claims,
including platform data and the web app's claim. All original resource identities
were audited before and after the isolated fixtures.

1. Verify tested source commits and imported digest-pinned images independently.
2. Stop both web services, gateway, controller, native runner and registry after
   verifying settled/uncertain executions, no task Pods and no unconfirmed removal.
3. Restore-test the registry dump, rehearse the exact additive migrations, and
   archive/restore-compare task workspaces, native sessions and the app data PVC.
4. Install a temporary gateway ingress restriction, add only the runner's required
   namespaced ConfigMap permissions, and start the upgraded registry/gateway/runner.
5. Verify schema-only history preservation. Obtain actual native inventory over
   Ziti, persist immutable plans, then adopt active workspaces and retain quarantine.
6. Independently compare SQL, journals, native inventory, PVC identities/specs and
   original file contents. Restore-test the populated post-adoption backup before
   reopening the controller, gateway ingress and web services.
7. Run Codex parallel continuation and explicit interrupted-turn acceptance.
   Preserve every original uncertain execution without retrying it.

The old rollout wrapper's `0022` ceiling is intentionally unchanged. This is a
separate reviewed procedure, not permission to deploy old clients against `0027`.
The temporary operator Pods have no service-account token, restart policy Never,
restricted container settings, bounded resources and an execution deadline.
Their exact identities are used for cleanup. Original PVCs and finalizers are
never stripped or deleted.

## Backup Scope

[scripts/agyn-prepared-backup.mjs](scripts/agyn-prepared-backup.mjs) accepts the
explicit `volume-adoption-through-0027` contract. Its distinct receipt fingerprints
complete adoption and migration documents as well as the earlier lifecycle
history and guard definitions. Older contracts do not silently accept the schema.

[scripts/agyn-local-workspace-backup.mjs](scripts/agyn-local-workspace-backup.mjs)
is deliberately specific to the trusted local single-node Lima/local-path setup.
It verifies exact bound PVC/PV references and node/path identities, requires
selected writers stopped and claims unmounted, creates a private tar archive,
extracts only into a new private temporary directory, and compares source and
restored files. It retains PVC/PV and native ConfigMap metadata and confirms
temporary-directory cleanup. It never restores over installed storage.

The host task database is backed up separately; the Kubernetes task database is
also checked for SQLite integrity, foreign keys and unchanged execution records.
Archives may contain credentials and private sessions. They remain local,
owner-only and excluded from Git; encrypt them before off-node retention.

These checks are **not complete replacement-node disaster recovery**. Kubernetes
authority UIDs, registry receipts, all Agyn databases/keys, storage and credentials
must be recovered consistently. Recreating a ConfigMap or PVC with the same name
does not restore its original identity. A standalone older database restore is
not permission to run old controllers or infer native fencing.

## Security Boundary

This remains a trusted local execution lab. Runtime root/`Unconfined` behavior
stays explicit in the existing environment profile; this rollout does not silently
change it or claim hostile-repository isolation. Comprehensive network enforcement,
credential containment, encrypted off-node retention and fenced node recovery
remain production gates. Completed-turn continuation and interrupted-turn
side-effect reconciliation are reported separately; session restoration alone
never establishes safe automatic retry.

Private evidence: `.state/agyn-workspace-migration-UnR9M6/`. Do not publish its
archives, credentials, session contents or operator configuration.

The final recovery point is `backup-tCyMir/` plus `workspaces-EhZ3I2/` and the
two `final-*-tasks.sqlite` files under that private directory. It was captured
with the five selected writers and both web services stopped, after live tests.
`final-backup.json`, `final-resumed.json`, `final-preservation.json`,
`codex-continuation.json`, `codex-interrupted.json` and `ui-verified.json` retain
the corresponding checks. This backup set is local only, not an off-node copy.
