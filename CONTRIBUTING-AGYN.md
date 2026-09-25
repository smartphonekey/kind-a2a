<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Contributing This Work To Agyn

Keep contributions independently reviewable. Maintainers should not have to
adopt the entire A2A lab to review a persistence, lifecycle or SDK fix.
The [architecture proposal](docs/agyn-a2a-proposal.md) is a discussion draft,
not accepted Agyn architecture.

## Repository Status

The standalone A2A service, reporting tools, web UI and deployment documentation
are on [smartphonekey/kind-a2a main](https://github.com/smartphonekey/kind-a2a).
The Agyn contributions are pushed to forks but remain outside those forks'
`main` branches. No upstream PRs have been submitted by this project.

Fork `main` branches are used as upstream-tracking bases. Do not merge every
historical integration branch: many are alternatives, older bases or temporary
acceptance combinations. The currently installed backend uses:

| Repository | Contribution branch | Revision |
| --- | --- | --- |
| [spk-ai/api](https://github.com/spk-ai/api/tree/feat/volume-anchor-migration) | `feat/volume-anchor-migration` | `0b9feaf` |
| [spk-ai/runners](https://github.com/spk-ai/runners/tree/feat/volume-anchor-migration) | `feat/volume-anchor-migration` | `627a1aa` |
| [spk-ai/agents-orchestrator](https://github.com/spk-ai/agents-orchestrator/tree/feat/volume-anchor-migration) | `feat/volume-anchor-migration` | `fc93b1d` |
| [spk-ai/k8s-runner](https://github.com/spk-ai/k8s-runner/tree/sync/2026-09-24-volume-adoption) | `sync/2026-09-24-volume-adoption` | `0ed8c5c` |
| [spk-ai/gateway](https://github.com/spk-ai/gateway/tree/sync/2026-09-24-resource-lifecycle) | `sync/2026-09-24-resource-lifecycle` | `7d8267d` |

Exact installed image digests are in [KUBERNETES.md](KUBERNETES.md#backend-revisions).
A production release still needs a complete reproducible multi-repository
manifest. Pushed, installed, merged and accepted upstream are distinct states.

Source-adjacent documentation is maintained separately on `docs/living-contracts`
branches in these forks, the daemon and the focused Claude session SDK. The SDK's
combined session/diagnostic view uses `docs/living-diagnostics-contracts`. Original
contribution and installed-image heads are preserved. These are documentation-only
follow-ups, not new deployed binaries or upstream acceptance.

From the A2A checkout, use `npm run code:map -- repos` to discover selected
repositories and their actual Git heads, then scan and inspect returned IDs.
`repos --worktrees` includes alternative local branches for explicit selection;
the default SDK view follows the daemon's session/diagnostics combination.
The navigator and its parser dependencies stay in this repository. Forks retain
their own licenses, native comments/tests and small Markdown catalogs; using their
code does not require adopting this tooling.

## Review Units

| Area | Proposed home | Boundary |
| --- | --- | --- |
| Execution/reporting contract | `agynio/architecture` | Agree identity, durable ACKs, outcomes, removal evidence and recovery semantics |
| A2A connector | Focused repository agreed with maintainers | Official SDK, task ownership, scheduling and typed Agyn provider adapter |
| Reporting MCP | API/Gateway or a focused service, by agreement | Authenticated execution-scoped reports; commit before ACK; no model-selected task identity |
| Persistence and Stop policy | `agynio/agynd-cli` | Runtime-neutral lifecycle policy, with small CLI-specific config/hook adapters |
| Claude session selection | `agynio/claude-sdk-go` | Forward explicit session/resume options; no A2A state machine or retry policy |
| Workload/volume lifecycle | API, registry, native runner and orchestrator | Separate dependent contracts, migrations and per-repository tests |
| Wire forwarding | Gateway | Generated compatibility and exact RPC/JSON contract checks |
| Session export | Separate proposal | Credential-safe artifacts, access, retention and deletion before analytics |

Runtime images package binaries. They should not contain the A2A controller,
workflow policy or session-analysis pipeline.

## Small Independent Starting Points

| Repository | Branch / revision | Change |
| --- | --- | --- |
| `spk-ai/agynd-cli` | `fix/codex-home-persistence` / `c933329` | Honor `CODEX_HOME` for configuration, auth placeholders and session mappings; preserve unset defaults |
| `spk-ai/agynd-cli` | `feat/required-init-scripts` / `591543b` | Opt-in fail-closed initialization; no A2A/MCP policy |
| `spk-ai/agynd-cli` | `feat/durable-inbox-guard` / `8b6056c` | Intent before SDK execution, completion before ACK, explicit retirement of pending requests |
| `spk-ai/agynd-cli` | `fix/shell-title-worker-lifetime` / `2aac6e7` | Stop/join the title refresher without stopping persistent tmux shells |
| `spk-ai/agynd-cli` | `fix/claude-error-results` / `1b1dd62` | Fail on nil/error results before publishing or acknowledging the inbox |
| `spk-ai/claude-sdk-go` | `feat/session-resumption` / `0cdc814` | Explicit new-session/resume options and pre-spawn validation |

Claude daemon `feat/claude-session-persistence` (`f29925c`) is a separate,
dependent review unit: durable session mapping, exact transcript resume,
ownership locking and fail-closed state checks. It pins the SDK session change.

These are review candidates, not the full runnable release. The Codex fix belongs
around daemon state handling, not a bundle of A2A changes to
`agyn-runtime-codex`. Independent fixes, diagnostics, dependency graphs and test
commands are preserved in the
[archived contribution catalog](docs/archive/2026-09-25/CONTRIBUTING-AGYN.md).

## Submission Workflow

1. Agree the architecture/repository boundary with maintainers.
2. Pick one focused branch, inspect its current upstream base and declare any
   dependent API, migration or SDK change.
3. Preserve the tested integration heads. Rebase on a new branch when updating
   a contribution stack; do not rewrite shared acceptance evidence.
4. Run that repository's ordinary/race/build checks and relevant failure tests.
   State all skips, exclusions, known unrelated failures and fixture limitations.
5. For dependent lifecycle changes, test the combined revisions with real
   storage/process/native fixtures before claiming end-to-end behavior.
6. Open a focused PR with the problem, compatibility/default behavior, dependency
   order and reproducible evidence. Separate implementation from test-only fixes
   and temporary diagnostic/packaging combinations.
7. Rerun the A2A acceptance matrix on the exact accepted release combination before
   changing installed images or claiming production readiness.

Do not infer exactly-once side effects from a thread restore, database lease or
inbox journal. Separate completed-turn continuation from interrupted recovery.
Exclude credentials, transcripts, database snapshots, kubeconfigs, private
evidence and unrelated generated-file churn.

## Licensing And Local Checks

New service/reporting/UI code and current service documentation are AGPL-3.0-only.
Fork contributions keep their repository licenses; `claude-sdk-go` remains MIT.
See [LICENSING.md](LICENSING.md).

For this repository, use `nvm use`, `npm ci`, `npm test` and the
[web checks](WEB.md#tests). These tests do not replace live Agyn acceptance.
Production gates remain in [PRODUCTION.md](PRODUCTION.md), independently of
whether a change has been submitted or accepted upstream.
