<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# September 24 Upstream Sync

Status: fork synchronization, rebasing and isolated acceptance completed. All
five new contribution branches are pushed; original tested branches are retained.
No revisions were deployed during the sync itself. Independent before/after
checks confirmed the installed resources were preserved.

Subsequent [deployment work](KUBERNETES.md) built and imported the candidate
backend images and rehearsed registry restore/migration, initially without
installing them because existing-workspace coordination was missing. That gap
is now addressed by the [focused workspace migration
contributions](AGYN-WORKSPACE-MIGRATION.md). The four backend services are upgraded
in place through schema `0027`, with 107 existing workspaces retained and adopted
and one unbound failed record quarantined. Codex continuation and interruption
checks pass; Claude is intentionally untested on this upgrade.
The no-deployment and no-provider-renewal statements below describe this sync's
earlier acceptance, not the subsequent app deployment or workspace migration.

## Bases And Branches

The four fork `main` branches and their local equivalents were fast-forwarded,
without force pushes, to the current upstream revisions:

| Repository | Previous main | Synced main | Upstream change |
| --- | --- | --- | --- |
| `spk-ai/api` | `50ef648` | `d524d3a` | App configuration contracts and workload flavor |
| `spk-ai/k8s-runner` | `baadc75` | `3bd3355` | Runner-side flavor sizing |
| `spk-ai/agents-orchestrator` | `ae7d0bf` | `c88b608` | Forward the selected flavor |
| `spk-ai/gateway` | `d2b485a` | `0ee317b` | App configuration routes and generated-client compatibility |

The active contribution stacks are rebased on new branches. Historical branches
are not rewritten, and obsolete integration branches are not promoted:

| Repository | New branch | New head | Preserved tested head |
| --- | --- | --- | --- |
| API | `sync/2026-09-24-volume-adoption` | [`c21440b`](https://github.com/spk-ai/api/commit/c21440bbd571d439c7c8aa316600d0d06392ccbf) | `66fd206` |
| Native runner | `sync/2026-09-24-volume-adoption` | [`0ed8c5c`](https://github.com/spk-ai/k8s-runner/commit/0ed8c5cfafe85a0f5df01bf7c2ccf5bb6547db20) | `6335223` |
| Orchestrator | `sync/2026-09-24-revocation` | [`5e5a4fe`](https://github.com/spk-ai/agents-orchestrator/commit/5e5a4feb2dbb118455b10123b995e4e5c0ddd668) | `0c414b8` |
| Orchestrator DNS combination | `sync/2026-09-24-revocation-native-dns` | [`039f262`](https://github.com/spk-ai/agents-orchestrator/commit/039f2621a5d4f8e137ab240a2be769996653c046) | `e5d7a53` |
| Gateway | `sync/2026-09-24-resource-lifecycle` | [`7d8267d`](https://github.com/spk-ai/gateway/commit/7d8267d321897120324d59f6d3bb1aa0dcffefdd) | `af4dc71` |

Registry `302b7c8` is unchanged; its matching-API tests run in a separate worktree.
Upstream `runners`, `agynd-cli`, `claude-sdk-go` and `llm-proxy` have no new main
commits relative to our bases and are not needlessly rebased. Independent earlier
fix branches remain separate review units. No upstream PR, BSR publication,
production image or rollout is implied.

Remote refs are independently checked against local heads: each fork `main`
equals its upstream revision, each new branch contains that revision, and all
five original tested branch heads remain unchanged locally and remotely.

## Compatibility Work

The API replay required one README conflict resolution, retaining both removal
confirmation and resource-limit documentation. Breaking checks pass against both
current upstream and the previous tested API checkout. The only protobuf
differences from `66fd206` are the two upstream API changes; lifecycle field
numbers and contracts are retained. Range-diffs are saved in private evidence.

The native mechanical rebase built a duplicate `containerResources` function.
The corrected implementation separates the RPC conversion from catalog
conversion and reuses existing strict Kubernetes-quantity validation. Flavor
resolution now happens before any Kubernetes mutation, so invalid flavor input
cannot allocate storage or enter credential cleanup after a partial start.

Explicit `compute-resources` bounds take precedence over flavor defaults.
Missing ordinary-sidecar resources use flavor defaults, then the configured
supporting bounds cover remaining init, restartable-init and injected containers.
The capability still requires complete explicit main bounds; malformed explicit
resources cannot be hidden by a valid flavor. Valid flavor-only requests retain
upstream sizing behavior, including unsized init containers, and are not silently
opted into the stricter capability. Catalog quantities now receive the same
positive, complete, representable-value validation as explicit bounds. Resource
allocation is per container, not an aggregate
task budget. Quotas and sandbox/network hardening remain separate requirements.

The complete combined API includes our four native adoption methods. The
orchestrator's test client now explicitly returns Unimplemented for them instead
of failing to compile or inventing adoption success. Runtime orchestration is
unchanged apart from upstream flavor forwarding; this does not implement the
registry adoption coordinator. Generated files and unrelated existing worktree
changes are excluded from the contribution commits.

## Verification

| Check | Result |
| --- | --- |
| API lint / breaking checks | Pass against current upstream and previous tested API |
| Native complete race suite | 874 entries pass; eight gated live/helper skips |
| Registry with real disposable PostgreSQL | 838 full race entries pass; no failures/skips |
| Focused controller | 875 ordinary / 874 selected race entries pass; seven gated skips; existing group-consumer race excluded only from selected run |
| DNS-compatible controller | 879 unfiltered race entries pass; seven gated skips |
| Gateway | 363 full race entries pass; no failures/skips |
| Native cgroup enforcement | Both explicit-only and flavor-plus-explicit fixtures pass |
| Native adoption | All 16 scenarios plus parent pass, including SIGKILL and owner-GC retention |
| Native namespace quota | Pass with UID-1000 fixture; concurrent admission and release verified |
| Runner chart CI script / RBAC | Rendering checks and all 33 chart race entries pass |
| Controller preparation revocation | All 19 entries pass; no failures/skips |
| Controller execution/crash regression | All 41 entries pass; no failures/skips |
| A2A service | Build and 505 tests pass; one opt-in PostgreSQL backup fixture skipped |
| A2A desktop/mobile UI | All eight Playwright transport/lifecycle cases pass |

The new sizing tests cover precedence, both Docker implementations, request
immutability, invalid catalog quantities before mutation, and prepared Pod gates.
Native cgroup fixtures independently observe CPU throttling and OOMKilled/137,
bounded ordinary/init/restartable containers, and a neighboring workload making
progress. Their namespaces and Pods are confirmed removed.

The controller fixture separates two recovery scopes:

- Between-turn continuation checks physical compute release, a different Pod on
  the same exact PVC, retained prior effects, parallel owner isolation and held
  same-owner admission.
- Interrupted control-plane operations use real SIGKILL at lost preparation,
  activation-acknowledgement, binding and removal checkpoints. Recovery must not
  redispatch preparation/activation or repeat the fixture's workspace append;
  an unexecuted gated preparation must be retired before admitting follow-up.

Those are distinct from interrupted native-agent/A2A turns. The fixture uses a
model-free program and stubs Agents metadata and authorization writes. It does
not prove safe automatic retry of arbitrary external effects, native-thread
restoration, provider approvals or behavior of the full deployed event loop.
The combined revocation/execution run completed in 2,117 seconds with all 60
entries passing. These counts include subtests and parents, not 60 independent
end-to-end agent scenarios.

The native/registry/Gateway and DNS-compatible controller builds and unfiltered
vet checks pass. The focused controller retains the known unrelated vet no-op
and group-consumer test race; the DNS combination includes their independent
fixes. Both current generated LLM bindings and the repository's tracked bindings
are checked separately so generated churn need not be committed.

Private evidence is `.state/agyn-upstream-sync-dKwMIj/`. Failed intermediate
builds, including the duplicate native helper and missing adoption test-client
methods, remain recorded; they are not counted as passing acceptance.
The first quota invocation mistakenly used plain Node instead of the fixture's
required UID-1000 image and timed out before probe startup. Its namespace was
removed. Rerunning the unchanged test with the documented, independently
verified local quota image passed in 34.62 seconds; all quota usage returned to
zero and namespace removal was confirmed. The failed invocation remains in the
evidence rather than being counted as a source regression or passing test.

The chart CI script exposed an existing fixture conflict: its ingress-only
namespace-fallback case cleared the namespace while enabling scoped RBAC, which
correctly rejects that configuration. Commit `0ed8c5c` disables RBAC only for
that isolated rendering case; chart defaults, permissions and the explicit
empty-namespace rejection test are unchanged. The full chart script and chart
race tests pass after this test-only correction. Runtime/native fixture source
remains `8f32c7d`.

## Reproduction

Use the new worktrees under `/home/alex/work/agyn-contrib/`. The consumers depend
on the complete rebased API `c21440b`, not just upstream's published schema.
For the native runner, generate the selected packages from that API checkout:

```sh
cd /home/alex/work/agyn-contrib/api-upstream-20260924
buf lint
buf breaking . --against '.git#ref=upstream/main'
buf breaking . --against ../api-volume-anchor-adoption
buf generate . --template ../runner-upstream-20260924/buf.gen.yaml \
  --output ../runner-upstream-20260924 --include-imports \
  --path proto/agynio/api/runner/v1 --path proto/agynio/api/runners/v1 \
  --path proto/agynio/api/gateway/v1
cd ../runner-upstream-20260924
GOMAXPROCS=4 go test -race ./... -count=1
bash scripts/verify-workload-egress-networkpolicy.sh
```

Registry, controller and Gateway clients were generated from the same API
checkout using each consumer's `buf.gen.yaml`, outputting into its new worktree
with `--include-imports` and without path filtering. Ordinary Go suites leave
live fixtures explicitly gated; those skips are not live acceptance. Tests used
Go 1.27.1 and Node 24.21.0 with `GOMAXPROCS=4` for Go runs.

Native cgroup/adoption and combined controller fixtures use digest-pinned
`node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.
The quota fixture instead requires the verified, already-loaded local
`docker.io/library/a2a-quota-probe@sha256:d086089ef330d40f93bd673d886b440f72668095e1d9f4a6fdb1a7cd1ee9f4e6`;
see its [build and reproduction instructions](AGYN-RESOURCES.md#reproduction-and-remaining-boundary).
PostgreSQL fixtures use
`postgres@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef`.
The combined controller fixture rebuilds the real registry/native binaries from
the tabled revisions and uses both
`TestLivePreparedExecutionStack` and `TestLivePreparationRevocationStack` on the
DNS-compatible branch, with `-race -count=1 -timeout=55m` and explicit
trusted-local gates. Its [fixture instructions](https://github.com/spk-ai/agents-orchestrator/blob/039f2621a5d4f8e137ab240a2be769996653c046/testdata/runner-prepared-fixture/README.md)
describe the bounded resources and process replacement behavior. Private test
logs and before/after state snapshots are never part of the contribution.

## Installed Resource Preservation

An independent read-only comparison after every fixture completed matches the
pre-test snapshot exactly, not merely its resource counts:

| Resource | Preserved count | Compared fields |
| --- | --- | --- |
| Namespaces | 10 | Names and UIDs |
| PVCs / PVs | 108 each | Names, UIDs, specs and phases |
| Deployments | 52 | Names, UIDs, complete spec hashes, desired/ready replicas |
| ClusterRoles | 96 | Names, UIDs and rules |
| ClusterRoleBindings | 76 | Names, UIDs, role references and subjects |
| Docker containers | 25 | Exact original container IDs |

All owned fixture namespaces and disposable database containers are absent.
There are zero task Pods, and `http://127.0.0.1:8083/readyz` returns
`{"ready":true}`. Existing primary orchestrator generated-file edits were left
untouched; all rebasing and generation took place in separate new worktrees.
No provider credential was read or renewed and no real agent task was submitted.

## Deployment Boundary

The installed stack remains on its reviewed earlier images and registry schema
`0022`. Tests use model-free isolated fixtures, real registry/native RPCs and
controlled A2A backends; they do not establish new-stack Codex/Claude approval or
native-session acceptance. Real-agent tests on these revisions require the still
unfinished coordinated adoption/rollout, not replacement of live images by tags.

Single-node production, full replacement-node backup/restore, adoption
coordination, authentication/fencing and the other [production gates](PRODUCTION.md)
remain open. Passing a rebase regression is not production readiness.
