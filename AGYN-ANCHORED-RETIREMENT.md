<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Checked Anchored Workspace Retirement

Status: source, real PostgreSQL and combined native/process acceptance verified
on 2026-09-15. Four focused dependent branches are pushed. Nothing from this
milestone is installed; the retained prepared/DNS stack remains at registry
migrations through `0022`. This is not production-readiness completion.

## Contract

Explicit workspace retirement is separate from releasing compute between turns.
Ordinary turn completion retains the PVC, persistent owner and agent session.
Both agent-instance and sandbox retirement paths now use the same checked flow:

1. Persist an anchored removal intent for the complete original bound PVC and
   exclude competing workload admission through the registry's owner guard.
2. Invoke the distinct `RemoveVolumeAnchored` native capability. Validate the
   backend incarnation, exact PVC UID, identity labels and persistent owner UID.
3. Atomically mark the owner as retiring, then delete the original PVC with
   UID/resourceVersion preconditions. Workload holds remain PENDING. Confirm
   PVC absence separately before deleting the exact persistent owner.
4. Persist the exact native PVC-and-owner ABSENT receipt with the original
   intent, binding, owner and reservation. Recovery reads this history; a
   confirmed retirement does not reissue native deletion or execute another turn.

Unsupported servers cannot fall back to older removal APIs. Invalid, pending,
foreign and unavailable replies do not confirm deletion. Additive migration
`0025` rejects old SQL confirmation, erased history, owner substitution and
reopening of retired anchored volumes. It does not rewrite earlier migrations
or backfill absence from billing timestamps.

Unbound first provision still requires explicit reconciliation. An absent owner
does not exclude late child creation. The native handler does not adopt a
different-UID child or directly delete it by a discovered identity. It observes
owner-based cleanup, consistent with Kubernetes
[garbage collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/).
The receipt is current control-plane absence, not authenticated future-write or
storage/node fencing.

## Verification

| Check | Result |
| --- | --- |
| API lint and additive breaking check | Pass against the parent branch |
| Native runner full source race suite | 636 passing entries; seven explicitly gated live/child skips |
| Registry ordinary and full race suites | 752 passing entries each, zero failures/skips; both real PostgreSQL gates enabled |
| Controller ordinary suite | 789 passing entries; six gated live/child skips |
| Controller selected full race suite | 788 passing entries; six gated skips; exactly the previously documented group-consumer test race excluded |
| Combined native/registry/controller race fixture | Eight scenarios plus two owner groups and parent: 11 passing entries, zero failures/skips |
| Native late-PVC collection fixture | Two scenarios plus parent: three passing entries, zero failures/skips |
| Builds and vet | All three Go builds pass; native/registry vet pass; controller vet passes with `-assign=false`, retaining the known unrelated self-assignment limitation |

The combined fixture SIGKILLs a real controller process after persisted intent,
native PENDING, native ABSENT and persisted confirmation, for both owner kinds.
The ABSENT case also replaces the registry and native processes. Independent
SQL reads compare the complete durable receipt and target; Kubernetes reads
confirm both PVC and owner absence. Another isolated owner keeps advancing
its heartbeat and retains its workspace effects during every retirement.

The late-create fixture captures the original actual PVC CREATE, retires its
Pod/PVC and owners, and then commits that old CREATE after retirement. Natural
Kubernetes GC removes the new-UID child without native deletion by discovered
UID. A second scenario replaces the owner with the same name and a new UID:
both GC and the stale retirement request preserve the new owner. This models a
late duplicate write, not a real delayed network connection or node partition.

Registry contention tests force admission-first, retirement-first and rollback
orderings for both owner kinds and all supported transaction isolation settings.
Upgrade tests preserve prior workload/volume/owner-guard fields and do not
invent native absence. Their native responses are fixtures; real GC evidence
comes from the separate native and combined tests.

Agents metadata, authorization writes and sandbox lookup remain stubs in the
combined fixture. Production lifecycle methods and registry/native RPCs are
real; the full controller event loop, A2A service, provider agents and database
crashes are not exercised. No Codex/Claude inference or credential changes were
needed for these tests. The [web acceptance](WEB.md#local-acceptance) remains a
separate real-agent result on the installed older stack.

## Preservation

The final independent snapshot matches all **108 prior PVCs**, **52 deployment
specifications/readiness values**, ten namespaces, 96 ClusterRoles and 76
ClusterRoleBindings. The task namespace has zero Pods. All temporary fixture
namespaces, PostgreSQL containers and application processes were removed; no
installed claim, schema, deployment or credential was changed. No finalizer
stripping, global pruning, Docker restart or downgrade was used. The web service
remains ready at `http://127.0.0.1:8083/ui/`.

Private before/after snapshots and rebuilt fixture binaries are in
`.state/agyn-anchored-retirement-verify-SzWjR0/`. Structured logs and summaries
are in `.state/agyn-anchored-volume-removal-UmYw8G/`, notably
`combined-retirement-process-lifetime`, `native-retirement-late-create-authorized`,
`native-retirement-final-verified`, `registry-retirement-final-race` and
`controller-retirement-final-verified`.

Earlier failures remain failed evidence. They included confusing workload and
volume owner assertions, replacement fixture processes being stopped by an
earlier subtest's cleanup, and the new native test RPC missing from its fixture
allowlist. Those fixture issues were corrected without relaxing lifecycle
assertions or broadening installed permissions. Only the final passing runs
above count as acceptance.

## Contributions

All four use branch `feat/anchored-volume-removal`:

| Repository | Commit | Scope |
| --- | --- | --- |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/anchored-volume-removal) | `bdd3df8` | Additive capability, intent and receipt contract |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/feat/anchored-volume-removal) | `e22fd25` | Exact native retirement, late-child and replacement-owner acceptance |
| [spk-ai/runners](https://github.com/spk-ai/runners/tree/feat/anchored-volume-removal) | `228abf2` | Migration `0025`, durable receipts and admission guards |
| [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/feat/anchored-volume-removal) | `446422f` | Both owner paths and combined crash acceptance |

Each branch includes its own reproduction notes. Fork licenses are unchanged;
this report is AGPL-3.0-only. No upstream PR or BSR publication is claimed.
The focused controller is not a DNS-compatible deployment combination.

## Still Required

Initially absent/late-prepare reconciliation and durable child/credential cleanup
remain the next implementation work. Authenticated backend authority, storage/node
fencing, remaining client migration, a DNS-compatible all-writer rollout and
both real-agent A2A matrices must follow. Hardened sandbox/network profiles,
TLS, backup/restore, release packaging and sustained reliability remain
[production gates](PRODUCTION.md). Native sessions already persist; analytics
and prompt/tool customization do not substitute for those gates.
