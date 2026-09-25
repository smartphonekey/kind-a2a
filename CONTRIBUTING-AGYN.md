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
acceptance combinations. Keep the installed revision/image inventory in
[KUBERNETES.md](KUBERNETES.md#backend-revisions), not a second table here.
A production release still needs a complete reproducible multi-repository
manifest. Pushed, installed, merged and accepted upstream are distinct states.

Source-adjacent documentation is maintained separately on `docs/living-contracts`
branches in these forks, the daemon and the focused Claude session SDK. The SDK's
combined session/diagnostic view uses `docs/living-diagnostics-contracts`. Original
contribution and installed-image heads are preserved. These are documentation-only
follow-ups, not new deployed binaries or upstream acceptance.

Use the [code-map workflow](skills/code-map/SKILL.md) to select contribution worktrees.
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
| Native agent definitions | `agynio/terraform-provider-agyn` | Native `model_name`, environment-owned images and legacy compatibility; no A2A controller |
| Workload/volume lifecycle | API, registry, native runner and orchestrator | Separate dependent contracts, migrations and per-repository tests |
| Wire forwarding | Gateway | Generated compatibility and exact RPC/JSON contract checks |
| Session export | Separate proposal | Credential-safe artifacts, access, retention and deletion before analytics |

Runtime images package binaries. They should not contain the A2A controller,
workflow policy or session-analysis pipeline.

## Small Independent Starting Points

| Repository | Branch / revision | Review focus |
| --- | --- | --- |
| `spk-ai/agynd-cli` | `fix/codex-home-persistence` / `c933329` | Native state routing |
| `spk-ai/agynd-cli` | `feat/required-init-scripts` / `591543b` | Initialization policy, separate from A2A/MCP |
| `spk-ai/agynd-cli` | `feat/durable-inbox-guard` / `8b6056c` | Interrupted execution safety |
| `spk-ai/agynd-cli` | `fix/shell-title-worker-lifetime` / `2aac6e7` | Shell worker ownership |
| `spk-ai/agynd-cli` | `fix/claude-error-results` / `1b1dd62` | SDK error handling |
| `spk-ai/claude-sdk-go` | `feat/session-resumption` / `0cdc814` | Native session selection |
| `spk-ai/terraform-provider-agyn` | `feat/native-agent-model` / `bada84c` | Native model create/update/import, with loopback Terraform regression tests |

Claude daemon `feat/claude-session-persistence` (`f29925c`) is a dependent review
unit; review the SDK session change first. Keep these ownership decisions separate
from the source-adjacent contracts on the selected branch.

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

Use [ACCEPTANCE.md](ACCEPTANCE.md) for this repository's verification procedure.
Production gates remain in [PRODUCTION.md](PRODUCTION.md), independently of
whether a change has been submitted or accepted upstream.
