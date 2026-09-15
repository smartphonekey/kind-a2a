<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Existing Workspace Anchor Adoption

Status: the dependent native/API implementation passes source and isolated
Kubernetes acceptance on 2026-09-15. Both focused branches are pushed, but
**nothing is installed and no existing workspace has been migrated**. The
registry admission gate, adoption persistence and migration coordinator remain
required before rollout. This is not production or disaster-recovery acceptance.

## Contributions

| Repository | Branch | Revision | Scope |
| --- | --- | --- | --- |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/volume-anchor-adoption) | `feat/volume-anchor-adoption` | [`66fd206`](https://github.com/spk-ai/api/commit/66fd206cf20b0ccea3e0a01b1f0c7ae60a0cbf75) | Four additive native RPCs and a distinct existing-volume adoption receipt; based on `23d3073`. |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/feat/volume-anchor-adoption) | `feat/volume-anchor-adoption` | [`6335223`](https://github.com/spk-ai/k8s-runner/commit/633522327e961e0f18e9bc7ea82b71792d52727d) | Native adoption, incomplete-reuse guards, unit/process/native tests; based on `3260fb4`, using the matching API checkout. |

Remote branch heads match those revisions. Existing upstream licenses are
unchanged. No upstream PR, published BSR contract or release image is claimed.
The separate A2A controller and workflow code are unchanged.

## Native Contract

The source must already be a checked, unanchored volume with a complete backend,
PVC name/UID and exact ownership labels. The caller must first durably block the
entire owner and drain all old writers. Native Pod inventory is an additional
check, not authority to admit work or proof of node fencing.

1. `ReserveVolumeAnchorAdoption` requires Bound storage and a complete, versioned
   namespace Pod inventory with no references to that claim. Terminal, deleting
   and unmanaged Pods count. It creates only an adopting owner and an immutable
   journal, retaining the original PVC identity and a hash of its native spec.
   The owner pins the exact journal UID before acknowledging the receipt.
2. `ApplyVolumeAnchorAdoption` validates the complete receipt and rechecks drain.
   A PVC UID/resource-version patch attaches the exact owner, journal/state
   annotations and an operation-specific adoption hold. The claim is not yet
   reusable. Its spec and unrelated metadata are unchanged.
3. The caller persists the applied original-PVC binding under the admission
   block before `FinalizeVolumeAnchorAdoption`. Finalization activates the owner,
   rechecks storage/drain and atomically marks the PVC ready while removing only
   that operation's hold. An active owner with an applied/held PVC remains blocked.
4. `ObserveVolumeAnchorAdoption` is read-only and distinguishes `RESERVED`,
   `APPLIED` and `READY`. Persist independently observed readiness before releasing
   admission. Missing, replaced, deleting or mismatched evidence fails closed.

Original checked identity, adoption receipt and resulting binding must remain
separate from first-provisioning `VolumeAnchorReservation` history. This proposal
does not fabricate an allocation reservation for existing data. No adoption RPC
creates/deletes a PVC or Pod, supplies credentials, resizes storage or replays an
agent turn. Lost replies and CAS conflicts do not authorize replacement identities.

The owner journal pin specifically prevents retry from recreating a missing
acknowledged journal under a new UID. Partial finalization remains recoverable
from its exact receipt. Pending, partial-ready and foreign-hold states fail
ordinary workload reuse; successful readiness permits the existing anchored
workload path to use the same storage.

If the owner disappears after attachment, Kubernetes can request dependent PVC
deletion. The adoption hold retains the original claim and backing volume while
native recovery refuses the missing owner. This is retention for reconciliation,
not automatic recovery of a terminating claim.
[Kubernetes finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/),
[owner garbage collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/).

## Verification

API lint and breaking checks against `23d3073` pass. Native ordinary and
unfiltered race runs each pass **838 test entries**, with zero failures and
seven gated live/helper skips. Unfiltered vet, build, formatting and diff checks
pass. Fake-API tests evaluate actual JSON Patch UID/revision conditions and
cover malformed/altered receipts, unavailable or incomplete inventory, old Pod
references, missing/replaced native objects, all six lost write replies and CAS
conflicts without retargeting. Both owner kinds also exercise the existing
prepare/activate/remove lifecycle using adopted storage.

The final real Kubernetes matrix passes **16 scenarios plus parent**, with no
failures/skips, through loopback native gRPC and chart-scoped service-account
permissions. Each owner kind, agent and sandbox, runs normal adoption, six actual
SIGKILL boundaries and owner-GC retention. The six process boundaries are:

- Owner create committed, reply lost.
- Journal create committed, reply lost.
- Owner journal pin committed, reply lost.
- PVC ownership/hold patch committed, reply lost.
- Owner activation committed, reply lost.
- PVC readiness/hold removal committed, reply lost.

The parent verifies the child is alive at each committed-write barrier, sends
SIGKILL, and verifies its exit signal. Recovery preserves the original owner,
journal where already created, and PVC identities. Every successful adoption is
followed by a distinct resource-bounded, network-denied Node Pod reading the
original file; confirmed compute removal retains the same PVC UID/spec. These
are model-free native tests, not the combined registry/controller or real-agent
A2A matrix. Completed storage migration does not establish safe retry of an
interrupted executed turn.

Both owner-GC cases verify the original PVC/PV survives dependent deletion with
the exact adoption hold after built-in PVC protection clears. Only afterward
does the fixture explicitly dispose of its own new claim by removing its sole
verified adoption hold. No pre-existing finalizer is removed. Normal cleanup
validates owned journals/resources and confirms namespace and temporary RBAC
absence.

The initial run failed the two owner-create crash assertions: a typed Kubernetes
GET can return an empty object alongside NotFound, which the assertion treated
as an existing journal. The corrected assertion tests the GET error before
comparing UIDs. Cleanup correctly retained that initial fixture rather than
accepting its unfinished owner state. A separate exact-identity audit confirmed
no Pods/Secrets/workload holds and deleted only that newly created namespace,
its 14 remaining claims/PVs and temporary RBAC, without finalizer edits. The
failed attempt remains recorded; it is not counted as passing acceptance.

Private evidence is `.state/agyn-volume-anchor-adoption-Z1iJui/`, including
`native-final-default.summary.json`, `native-final-race.summary.json`,
`native-live-corrected.summary.json` and the failed first run. The final live run
finished at 12:10:06 UTC. Independent `before.json`/`after.json` observations match
all **108 PVCs, 108 PVs, 52 deployments**, ten namespaces, 96 ClusterRoles, 76
ClusterRoleBindings and 25 existing Docker container IDs. No task Pods or owned
fixtures remain. The A2A web readiness endpoint still returns ready. No provider
credential was read/renewed and no agent request was submitted or replayed.

## Remaining Release Work

- Add a durable owner-wide registry admission block, distinct immutable adoption
  documents, SQL guards and registry RPCs. Admission must stay blocked throughout
  all partial/lost-reply states, across every client and both owner paths.
- Implement the audited drain/adoption coordinator and its real PostgreSQL,
  controller-crash and native acceptance. The 61 unchecked legacy records need
  explicit checked adoption first; they cannot use this new native API directly.
- Extend the versioned [anchored backup contract](AGYN-ANCHORED-BACKUP.md) beyond
  `0026` when the new registry schema exists; the installed rollout ceiling
  remains `0022`. Native journals and owner metadata also need retention/backup.
- Coordinate reviewed, authenticated writers and the DNS-compatible deployment;
  rerun both real-agent A2A matrices. Accepted requests without a registry
  workload, credential cleanup, node/late-writer fencing and hardening remain open.
- Deliver the selected [single-node self-hosted Kubernetes target](PRODUCTION.md#first-deployment-target)
  with encrypted off-node backups and a tested clean replacement-node restore
  of the complete stack, not just registry SQL. Fence the old node and keep
  restored work closed to admission until uncertain side effects are reconciled.

The native milestone closes one implementation gap. It does not change the
installed trusted-local boundary or replace the remaining production gates.
