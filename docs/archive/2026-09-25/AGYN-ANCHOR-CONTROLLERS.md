<!-- SPDX-License-Identifier: AGPL-3.0-only -->
> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).


# Resource Anchor Controllers

Status: source and final combined process acceptance verified on 2026-09-15.
The separate DNS-compatible lab subset also passes. These dependent changes are
not installed. The retained local prepared/DNS stack and registry schema through
`0022` remain unchanged.

## Implemented

Both agent and sandbox controllers now persist native workload/volume ownership
before preparation authority. New starts use only the distinct anchored APIs;
unsupported implementations cannot trigger an old-API fallback. Existing
persisted unanchored workloads keep their old recovery/removal contract, but
legacy workspaces are not implicitly adopted into anchored ownership.

The controller verifies the assembled native owner projection, reserves native
metadata, binds each volume owner and exact reservation receipt, then binds the
complete workload owner set. Preparation/activation and subsequent transitions
preserve both revisions and exact Pod/PVC/owner identities. Replacement workloads
reuse persistent volume anchors and their original reservation receipts.

Known Pod removal must complete before exact workload-anchor revocation and
registry removal confirmation. Pending, unavailable or mismatched revocation
does not free admission. For an unknown preparation, read-only native observation
can recover a verified gated Pod. Failed/absent observations cause a revocation
attempt but retain admission: owner absence alone does not prove child cleanup.

## Integration Bugs

The initial source failures exposed three issues rather than just stale tests:

- The sandbox assembler stores identity in `label.*` properties. Reading only
  explicit labels lost its human owner. The controller now follows native label
  precedence and rejects reserved-label overrides before native reservation.
- An anchored unbound volume must still be its original revision-2 provisioning
  generation. Recovery now rejects a previously bound record disguised as new.
- Registry `thread_id` is a legacy instance alias, while the runtime label is
  the actual inbox thread. The original native/registry test used identical IDs
  and hid this mismatch. The actual canonical inbox thread is now stored in the
  immutable workload anchor without rewriting registry or volume identity.

Registry follow-up `e1a3b7f` adds migration `0024` instead of editing `0023`.
The real PostgreSQL upgrade fixture seeds existing anchors under `0023`,
reproduces rejection of a distinct inbox thread, applies migration twice and
compares every workload/volume/owner-guard field. Malformed threads and changes
to a bound thread remain rejected. A following workload may use a new inbox
thread without changing its persistent instance workspace.

These validations do not authenticate the authority to select a backend, owner
or thread. That remains a separate production requirement.

## Verification

- Controller ordinary suite: **761 passing entries**, five gated live/child
  skips, no failures. Selected full race suite: **760 passing entries**, the
  same five skips, excluding exactly the known
  `TestGroupMembershipConsumerLoopRetriesWithoutBlocking` race.
- Controller build and `go vet -assign=false ./...` pass. Unfiltered vet still
  reports the pre-existing `start_decision.go:186` self-assignment.
- The final focused 20-run anchor race suite passed **1,920 entries**, including
  the cancellation-boundary cases, with no failures/skips.
- Registry ordinary and full race suites: **620 passing entries each**, zero
  failures/skips with both real PostgreSQL gates enabled. Build and vet pass.
- The unchanged A2A service builds and passes **449 tests**, zero skips.
- Final combined controller/registry/native Kubernetes verification passes
  **38 scenarios plus two owner groups and parent (41 entries)**, with no
  failures/skips. The final run uses distinct native/legacy thread IDs and the
  corrected registry migration, rather than relying on the earlier coincident-ID
  fixture's 41-entry pass.
- The DNS-compatible lab combination, including the separate test repair below,
  passes **765 ordinary / 765 full race entries**, with five gated skips and no
  test exclusion. Build and vet excluding `assign` pass. Its real Kubernetes/
  PostgreSQL/process subset passes **four scenarios plus two owner groups and
  parent (seven entries)**, with no failures/skips: parallel durable follow-up
  and lost preparation across replacement of all three application processes,
  for both owner kinds. This is source compatibility, not another live DNS
  interception test or native-agent A2A run.

The combined fixture compares resource owners and reservation receipts with
independent SQL, checks native ConfigMap UIDs and Pod/PVC owner references, and
adds cancellation before preparation authority plus SIGKILL at anchor-removal
PENDING/ABSENT. Its final configuration uses inbox-thread IDs distinct from the
registry instance alias. Recovery cannot reissue prepare/activate or reserve new
native owners. Workload-owner absence is checked separately from retained volume
ownership.

Agents display metadata, sandbox lookup and authorization writes remain fixtures.
The fixed credential-free Node program is not an A2A client or provider agent.
The database is not crashed. These checks do not prove real-agent rollout, node
fencing, durable external credential revocation or production garbage collection.

Private evidence: `.state/agyn-anchor-controllers-verify-iwzi2R/`. The earlier
source failures remain in `.state/agyn-anchor-controllers-IH3ZaU/`. Failed runs
are retained as failed evidence, not counted as passing acceptance.

The independent before, after-focused-run and final-after-lab snapshots match
all **105 PVCs**, **52 deployments**, ten namespaces, 96 ClusterRoles and 76
ClusterRoleBindings. The installed task namespace has zero Pods and retains
all 97 bound task claims.
No installed schema, deployment, provider credential or workspace is changed.
All fixture processes terminate and their owned temporary resources are removed.

## Separate Test Repair

The previously excluded group-consumer test was reproduced on unchanged upstream
`ae7d0bf`. The race detector reported both the shared fake unsubscribe flag and
unsynchronized restoration of global retry settings. Test-only `fdf60f9` replaces
polling with channel signals and uses the real retry delay without modifying
production behavior. Both upstream ordinary/full race suites pass 257 entries,
with no exclusions/skips, plus 60 repeated cases across one, two and four CPUs.
Unfiltered vet still reports the separate self-assignment; it is not hidden.

The focused ownership branch retains its original selected-suite boundary. Only
the separate lab combination includes the test fix, as `ce2049c`, and has the
unexcluded 765-entry race evidence. This is not a runtime concurrency fix or a
claim that every daemon/repository race gate is closed.

## Contributions

| Repository | Branch | Verified Source / Dependency |
| --- | --- | --- |
| [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/feat/resource-anchor-controllers) | `feat/resource-anchor-controllers` | source `2fddf9c`, evidence `77650be`, based on `c2bb0e5` |
| [spk-ai/runners](https://github.com/spk-ai/runners/tree/feat/resource-anchor-registry) | `feat/resource-anchor-registry` | `e1a3b7f`, following `573b497` |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/resource-anchor-registry) | `feat/resource-anchor-registry` | `6fe4cab` |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/feat/resource-anchors) | `feat/resource-anchors` | `72a1cc8` |
| [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/fix/group-consumer-test-race) | `fix/group-consumer-test-race` | `fdf60f9`, independent test-only fix on upstream `ae7d0bf` |
| [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/lab/resource-anchors-native-dns) | `lab/resource-anchors-native-dns` | source `ce2049c`, evidence `978fad0`; ownership/DNS/test-fix acceptance combination, not an upstream proposal |

Fork licenses remain unchanged. This service report is AGPL-3.0-only. No upstream
PR has been submitted. These focused and lab branches are pushed. The focused
controller branch omits the separately reviewed DNS fix; it must not replace the
installed prepared/DNS stack on its own.

## Still Required

The later [anchored retirement contribution](AGYN-ANCHORED-RETIREMENT.md)
implements and verifies bound PVC-and-owner retirement separately. It is not
installed and does not change this report's historical acceptance scope.

Initially absent/late-create reconciliation, checked anchored-volume retirement,
durable child/credential cleanup and explicit legacy reconciliation remain open.
So do remaining wire/client migration, a DNS-compatible all-writer rollout and
both full Codex/Claude A2A matrices on that combination. Authentication,
node/storage fencing, hardened sandbox/network profiles, TLS, backups/failover,
release packaging and sustained reliability remain [production gates](PRODUCTION.md).

Native sessions already persist. Centralized session export/analysis,
auto-improvement, prompt/tool customization and editor takeover remain subsequent
features, not evidence that the production objective is complete.
