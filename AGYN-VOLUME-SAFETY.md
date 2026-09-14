# Volume Inventory And Retention Safety

Status: focused source fixes and native Kubernetes acceptance pass, including a
combined lifecycle/resource/ownership stack. These fixes are pushed, but are not
deployed to the stock platform. Safe deletion, production garbage collection
and infrastructure fencing remain release gates.

## Findings

The orchestrator previously compared a scoped active-volume registry snapshot
with a later runner inventory, then removed every unmatched disk. The registry
scan excludes organizations without an agent and terminal volume records. It
also cannot contain records created after that scan. Consequently, a foreign
workspace or a newly provisioned disk could be classified as an orphan and
deleted. Writing the record before creating the disk does not close this
two-snapshot race.

Malformed inventory also affected tracked records. The orchestrator skipped nil
or missing-key items and selected the first duplicate key. That could finalize
an existing disk's record, adopt an ambiguous physical name, or request deletion
of the wrong disk. The native Kubernetes runner additionally hid managed PVCs
whose `volume_key` label was missing, returning a successful partial inventory.

Both failures were reproduced against unchanged upstream production source with
new regression tests before applying the fixes. The original orchestrator
volume tests passed before these new cases were added. The runner's former
positive test explicitly expected missing-key claims to be skipped; it now
checks exclusion of genuinely unmanaged claims instead.

## Focused Contributions

| Repository | Branch / commits | Scope |
| --- | --- | --- |
| [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/fix/retain-untracked-volumes) | `fix/retain-untracked-volumes`: core `79580bb`, native fixture/docs `72e1b22`; base `ae7d0bf` | Retain unmatched disks; validate the complete returned inventory before changing tracked records or requesting deletion. |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/fix/complete-volume-inventory) | `fix/complete-volume-inventory`: `40b35ce`; base `baadc75` | Return `FailedPrecondition`, without partial results, for missing, empty, padded or duplicate managed PVC keys. |

The orchestrator also rejects duplicate physical names, nil responses/items and
blank/padded identities. It does not impose UUID syntax on opaque runner keys.
An invalid inventory blocks only that runner's volume pass; another valid
runner can still progress. Valid provisioning, reuse, TTL and deprovisioning
continue through their existing paths.

Retaining unknown disks deliberately changes the upstream architecture's
[automatic orphan-deletion policy](https://github.com/agynio/architecture/blob/main/architecture/agents-orchestrator.md#volume-reconciliation).
Truly orphaned disks are also retained and reported in logs. Operators must
account for that storage until ownership- and generation-checked garbage
collection is available. A second lookup followed by a name-only delete would
still race creation/reopening, so it is not an adequate substitute.

Neither change adds A2A, MCP, prompts, model selection, API fields or database
migrations to Agyn. Existing repository licenses remain intact. The branches
are pushed; no upstream PR has been opened. The large optional native fixture
is a separate commit from the orchestrator's production fix and unit tests.

## Verification

Evidence directory: `.state/agyn-volume-retention-ryjZXQ/`, 2026-09-14. Source
checks used Go 1.27.1 and generated APIs from reviewed local API `3c84a6a`.
Runner generation needs `--include-imports` for the tracing dependency; the
first attempt without imports failed to compile and is not a passing build.
Generated API output is excluded from the contributions.

Counts below include subtests, not only top-level test functions.

| Scope | Result |
| --- | --- |
| Independent orchestrator | Build; all 326 ordinary tests pass, with the live test gated off. Scoped race: 325 pass, excluding the known upstream group-consumer test. |
| Independent runner | Build; all 124 race tests pass with no skips/exclusions. |
| Combined orchestrator `f65a9f6` on `d77e7d5` | Build; 363 scoped race tests pass, with the same explicit exclusion and the live test gated off. |
| Combined runner `d03831f` on `641e2f7` | Build; 303 race tests pass. Four existing opt-in quota/resource/PVC/startup live tests are gated off, not claimed as rerun here. |
| Native retention | Paired independent and combined tests both pass under the race detector, with real runner RPCs and real Kubernetes PVCs. |
| A2A service | Build and all 244 tests pass on pinned Node 24.21.0; no skips. No controller/workflow code changed. |

The unfiltered orchestrator race suite was also run and fails in the unchanged
`TestGroupMembershipConsumerLoopRetriesWithoutBlocking` fake-subscription race.
It is not claimed to pass. The scoped command explicitly excludes that test:

```bash
go test -race ./... -skip '^TestGroupMembershipConsumerLoopRetriesWithoutBlocking$' -count=1
```

Native fixture details:

- An initial, narrower pass used the existing named-PVC runner `7d3238a` and did
  not yet test a missing label. Evidence: `native-live.jsonl`.
- Paired independent pass: 07:53:54-07:54:16 UTC, namespace
  `orchestrator-volumes-77d6b5a6-853`, UID
  `8fb96a43-f0e2-47f5-85a4-9231136149cc`. Evidence:
  `paired-native-live.jsonl`.
- Combined pass: 08:00:17-08:00:40 UTC, namespace
  `orchestrator-volumes-f8fb4004-98d`, UID
  `df8a6d40-4701-407a-ad40-bda40f86e937`. Evidence:
  `combined-native-live.jsonl`.

Each full native run verified foreign-organization, terminal-record, unknown
and newly registered claims retained their UIDs/specs/labels. A second scan
activated the newly registered disk. Duplicate/empty keys blocked tracked
deletion. Removing the tracked claim's key did not close its record. After
repairing only the test labels, the real `RemoveVolume` deleted exactly the
tracked deprovisioning claim; the next inventory finalized its record after
physical absence, while the other five claims remained unchanged.

This uses the real runner's `ListVolumes` and `RemoveVolume` over loopback gRPC.
The registry and Agents services are deterministic fakes to control the scan
race; this is not deployed PostgreSQL/Gateway or full A2A lifecycle acceptance.
The fixture exposes only these two RPCs, impersonates a PVC-only namespace
service account, and refuses cross-namespace PVC and Secret-list access. Its
additional deletion guard permits only this fixture's empty claims. That test
guard is not part of the runner's production deletion implementation.

The six 1 MiB claims in each disposable namespace name an absent storage class;
they allocate no backing disks. Quota forbids Pods. Cleanup rejects unexpected
objects/backing storage and checks namespace/resource ownership, including
controller-injected certificate-only ConfigMaps, before namespace deletion
with UID/resource-version preconditions. All three namespaces were confirmed
absent. The helper processes exited; no model, agent, provider credential or
production workspace was used. The README in the orchestrator branch contains
the reproducible fixture build/run commands.

The 08:02:57 UTC audit (`final-audit.json`) confirms all 60 existing task PVCs
retain the same UID, spec and phase; there are no task Pods, Services or quotas,
and no fixture namespaces remain. All five stock deployments are ready at
their original image versions. No deployment or production database was
modified. Native fixture binary SHA-256 values are recorded in the same audit.

## Remaining Gates

- Authenticated deletion intent bound to the task owner and the expected
  backend incarnation. `RemoveVolume` remains name-based; this patch does not
  add UID/resource-version preconditions to production deletion.
- Coordinate creation, reopening and deletion across all writers. Prevent a
  delayed create or stale retry from resurrecting/deleting another incarnation.
- Physical volume-removal confirmation, including finalizers/mounts, generic
  sandbox cleanup and `RemoveWorkload(remove_volumes=true)` paths.
- Node-partition fencing, storage-level single-writer guarantees and authoritative
  orphan reconciliation. Retaining unknown disks prevents this deletion path;
  it does not reclaim genuinely orphaned storage or resolve its ownership.
- Coordinated image rollout, old-writer compatibility audit, live database and
  full A2A lifecycle acceptance on the new combined stack. Source integration
  and native RPC fixtures are not a permanent platform upgrade.
- The other [production gates](PRODUCTION.md), including native Claude 401
  diagnosis, hardened credentials/hooks/networking, protocol conformance,
  storage recovery, load/failover and operations.
