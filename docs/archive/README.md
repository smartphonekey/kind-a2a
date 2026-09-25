<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Documentation Archive

These are evidence records, not current operating instructions. The
`2026-09-25/` snapshot preserves all 40 Markdown documents from application
commit `53eae79` before the current-documentation cleanup. That date is the
snapshot date, not the date of every test described inside it.

Historical outcomes, failed attempts, original test scope and licensing are
retained. Links to archived documents stay within the snapshot; code links point
back to the repository. Old root-level report URLs remain as navigation pointers.
Do not infer current deployment status from an archived "installed", "pending"
or "passed" statement, or run an old fixture against active workspaces.

For current information use [production readiness](../../PRODUCTION.md),
[deployment](../../KUBERNETES.md), [acceptance](../../ACCEPTANCE.md) and
[contribution status](../../CONTRIBUTING-AGYN.md).

## Deployment Evidence

- [Workspace migration and in-place upgrade](2026-09-25/AGYN-WORKSPACE-MIGRATION.md)
- [Claude authentication, recovery and REST error fix](2026-09-25/AGYN-CLAUDE-A2A.md)
- [Fork synchronization and rebased branches](2026-09-25/AGYN-UPSTREAM-SYNC.md)
- [Original Kubernetes app deployment](2026-09-25/KUBERNETES.md)
- [Original web UI acceptance](2026-09-25/WEB.md)

## Execution And Reporting

- [A2A protocol acceptance](2026-09-25/A2A-PROTOCOL.md)
- [Gated reporting and inbox integration](2026-09-25/AGYN-REPORTING.md)
- [Removal confirmation](2026-09-25/AGYN-REMOVAL.md)
- [Network enforcement](2026-09-25/AGYN-NETWORK.md)
- [Parallel tasks and FIFO](2026-09-25/AGYN-PARALLEL.md)
- [Resource bounds, quotas and first-provision recovery](2026-09-25/AGYN-RESOURCES.md)
- [Claude portability and session persistence](2026-09-25/AGYN-PORTABILITY.md)
- [Native DNS reproduction and lifecycle matrices](2026-09-25/AGYN-NATIVE-DNS.md)
- [Runner workload RBAC](2026-09-25/AGYN-RUNNER-RBAC.md)
- [Runner control transport](2026-09-25/AGYN-RUNNER-TRANSPORT.md)

## Workspace Lifecycle

- [Volume inventory and retention](2026-09-25/AGYN-VOLUME-SAFETY.md)
- [Checked volume operations and admission](2026-09-25/AGYN-CHECKED-VOLUMES.md)
- [Backend-bound volume identity](2026-09-25/AGYN-VOLUME-BACKEND.md)
- [Native resource anchors](2026-09-25/AGYN-RESOURCE-ANCHORS.md)
- [Anchor registry persistence](2026-09-25/AGYN-ANCHOR-REGISTRY.md)
- [Anchor controller integration](2026-09-25/AGYN-ANCHOR-CONTROLLERS.md)
- [Anchored workspace retirement](2026-09-25/AGYN-ANCHORED-RETIREMENT.md)
- [Preparation revocation](2026-09-25/AGYN-PREPARATION-REVOCATION.md)
- [Anchored registry backup](2026-09-25/AGYN-ANCHORED-BACKUP.md)
- [Native existing-workspace adoption](2026-09-25/AGYN-VOLUME-ANCHOR-ADOPTION.md)

## Prepared Workloads

- [Native preparation and activation](2026-09-25/AGYN-PREPARED-WORKLOADS.md)
- [Prepared registry state](2026-09-25/AGYN-PREPARED-REGISTRY.md)
- [Prepared controllers and process-crash acceptance](2026-09-25/AGYN-PREPARED-CONTROLLERS.md)
- [Prepared rollout and restore rehearsal](2026-09-25/AGYN-PREPARED-ROLLOUT.md)
- [Prepared-stack Claude acceptance](2026-09-25/AGYN-PREPARED-CLAUDE.md)
- [Prepared Secret ownership](2026-09-25/AGYN-PREPARED-SECRETS.md)
- [Lost preparation recovery](2026-09-25/AGYN-PREPARED-RECOVERY.md)

## Superseded Guides

- [README and legacy kind/ACP instructions](2026-09-25/README.md)
- [Legacy Agyn adapter instructions](2026-09-25/AGYN.md)
- [Full acceptance chronology](2026-09-25/ACCEPTANCE.md)
- [Production-readiness chronology](2026-09-25/PRODUCTION.md)
- [Service guide before cleanup](2026-09-25/SERVICE.md)
- [Full contribution catalog and branch evidence](2026-09-25/CONTRIBUTING-AGYN.md)
- [Architecture proposal before cleanup](2026-09-25/docs/agyn-a2a-proposal.md)
- [Licensing scope before cleanup](2026-09-25/LICENSING.md)

## Maintenance

Keep implementation contracts with code; top-level guides retain operator
decisions, installed inventory and open release criteria. Put dated investigations
and superseded acceptance sequences
in the archive, preserving failures and test limitations. Update the current
acceptance summary only when the corresponding verification has actually run.
Archive moves do not change a document's license or publish private evidence.
