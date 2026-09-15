<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Resource Anchor Registry

Status: registry source and isolated PostgreSQL acceptance verified on
2026-09-15. This is a dependent contribution, not a production release.
Nothing is installed: the retained prepared/DNS stack and schema through `0022`
remain unchanged. Both controller paths, native recovery integration and
coordinated rollout remain unfinished.

## Contract

The [native resource-anchor capability](AGYN-RESOURCE-ANCHORS.md) creates
metadata owners before Pod/PVC creation. The registry now retains these exact
identities before granting preparation authority:

1. `CreateAnchoredWorkload` creates an unused reservation with separate
   preparation and resource revisions. It pins the owner to anchored operation.
2. Checked volume records bind their native anchors first. Each also retains an
   immutable receipt identifying the exact workload and both reservation
   revisions that authorized this first binding.
3. `BindWorkloadResourceAnchors` checks the complete persisted volume set and
   binds the workload owner UID. This changes only the resource revision.
4. `UpdateAnchoredWorkload` checks and advances both revisions for lifecycle
   transitions. Native Pod/PVC bindings must retain the previously stored owners.
5. Replacement workloads reuse persistent volume anchors and the original
   receipts. Workload ownership history remains separate from volume lifetime.

Old prepared APIs cannot mutate anchored workloads, and database guards reject
old SQL lifecycle writes. Unsupported registries must fail with Unimplemented;
clients must not fall back. Migration `0023_resource_anchors.sql` adds nullable
identity/receipt columns and an immutable owner-mode pin, without adopting
legacy records or inventing native evidence.

Anchored volume retirement and metadata-history deletion are deliberately
refused until their checked retirement/cleanup contracts exist. This is an
explicit integration limit, not a completed garbage collector.

## Bugs Found And Fixed

The initial real Read Committed overlap test failed for both agent and sandbox
owners. A volume update could read the old reservation, wait for the owner lock,
and then bind after cancellation because another reservation for the same owner
now existed. An owner-only check was insufficient.

The persisted receipt lets the database recheck the exact workload and both
revisions after its owner-row write. The canceled request cannot borrow the new
reservation's authority. Rollback still allows the original request, and
another owner continues while this owner waits. This follows PostgreSQL's
[snapshot rules](https://www.postgresql.org/docs/16/transaction-iso.html) and
[trigger behavior](https://www.postgresql.org/docs/16/trigger-definition.html).

Two source regressions also failed before their fixes: accepting a binding with
a missing persisted volume anchor, and allowing a sandbox PVC's human-owner
label to differ from its anchor. Both now reject those inputs.

## Verification

- API lint and breaking checks against native API `3b25d03` pass.
- Full registry ordinary and race suites: **618 passing entries each**, zero
  failures/skips, with both disposable PostgreSQL fixtures enabled. The ordinary
  suite also passes after regeneration from committed API `6fe4cab`. Build and
  unfiltered vet pass.
- The unchanged A2A service rebuild and all **449 tests** pass, zero skips.
- Focused repeated race suite: **1,600 passing entries** across 20 runs,
  including **240 forced database interleavings**; zero failures/skips.
- Real loopback registry RPCs cover agent and sandbox owners with zero, one and
  two volumes; two turns retain exact volume identities across registry-server
  replacement. Native preparation/activation/removal receipts are synthetic.
- Twelve interleavings per run cover both owners, all three isolation levels,
  commit/rollback, cancellation with a replacement reservation, and progress for
  another owner. The test observes actual PostgreSQL lock blocking.
- The upgrade fixture seeds the real schema through `0022`: **28 prepared
  workloads** across all seven lifecycle phases, with and without volumes, and
  **14 bound volume records**. Two migration applications preserve every prior
  row field and create no anchor authority. Earlier upgrade/rejection fixtures
  continue passing using historical seed SQL.

These are registry/database checks, not combined controller/native Kubernetes
acceptance or provider-agent A2A tests. Agents display metadata and authorization
writes are stubbed. The source regression failures and initial cancellation-race
failures remain separate evidence, not passing runs.

Private evidence: `.state/agyn-anchor-registry-zevefZ/`. PostgreSQL runs in owned,
bounded, loopback-only Docker containers with tmpfs storage and private generated
credentials. Each completed run removes only its own container. The installed
platform database, Kubernetes workloads, PVCs and provider credentials are not
used or modified by these fixtures.

## Contribution And Next Work

| Repository | Branch | Revision / Base |
| --- | --- | --- |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/resource-anchor-registry) | `feat/resource-anchor-registry` | `6fe4cab`, based on native API `3b25d03` |
| [spk-ai/runners](https://github.com/spk-ai/runners/tree/feat/resource-anchor-registry) | `feat/resource-anchor-registry` | `573b497`, based on registry `e7c42f4` |

Existing fork licenses are retained; this service integration report is
AGPL-3.0-only. No upstream PR has been submitted. The registry's
[reproduction guide](https://github.com/spk-ai/runners/blob/573b497/RESOURCE-ANCHORS.md)
describes dependency generation and gated tests.

1. Migrate agent and sandbox controllers and all necessary wire/client paths.
   Persist reservations before native calls, recover lost replies by reading
   exact state, and retain admission for uncertain or late resources.
2. Add combined registry/controller/native process-crash acceptance, including
   initially absent resources and cancellation at each authorization boundary.
3. Implement checked anchored-volume retirement, delayed hold reconciliation,
   durable child/credential cleanup and explicit legacy reconciliation.
4. Coordinate all-writer upgrades while retaining the DNS correction, then rerun
   both complete Codex/Claude A2A matrices before deployment.
5. Close [the other production gates](PRODUCTION.md): authenticated owner/backend
   authority, node/storage fencing, sandbox/network hardening, TLS, backup and
   failover, packaging and sustained reliability.

Durable native sessions already work. Centralized session export/analysis,
auto-improvement, prompt/tool customization and editor takeover remain later
features; this registry milestone does not claim overall production readiness.
