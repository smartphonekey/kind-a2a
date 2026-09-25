---
name: code-map
description: Navigate and maintain living documentation across aira-a2a-lab and its registered Agyn contribution worktrees using TypeScript/Go/protobuf/SQL structure and curated document catalogs. Use for locating owners, tracing contracts and updating source-adjacent documentation, not generic filesystem search or deployment.
---
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# AIRA Code Map

Work from the `aira-a2a-lab` checkout root with its pinned Node runtime and
installed development dependencies, and Go for Go source navigation. Follow
[AGENTS.md](../../AGENTS.md) and the selected repository's instructions.
Resolve a discovery symlink to this repo-tracked skill before following its
relative links.

## Navigate Progressively

Discover repositories before crossing into forks. Only selected checkouts are
scanned; historical worktrees require explicit selection:

```sh
npm run code:map -- repos
npm run code:map -- repos --worktrees
npm run code:map -- scan --repo runners --language go
```

`tooling/code-map/workspace.json` is checkout configuration, not a generated
component catalog. Missing sibling clones are reported as unavailable, not an
empty successful scan. `--worktree NAME` selects a Git-discovered checkout without
switching branches. Inspect the returned branch/head/dirty provenance.

List first, choose related IDs, then batch-inspect:

```sh
npm run code:map -- scan --area src/service
npm run code:map -- inspect src/service/worker src/service/task-store
npm run code:map -- inspect runners::migrations/0027_volume_anchor_migration api::proto/agynio/api/runners/v1/runners
```

Omit `--area` to discover all areas; page with `--limit` and `--offset`. Add
`--include-tests` when selecting test components. IDs are source paths without
extensions, optionally qualified as `repo[@worktree]::path`. Start with source
comments, symbols, imports and related components. Test links are static imports
or same-Go-package relationships, not coverage or passing results. Generated
output is opt-in via `--include-generated`. Go build tags are not evaluated.
Detail symbols and test cases also page with `--offset`/`--limit`; follow returned
`symbolPage`/`testCasePage.nextOffset`. Export and related-test previews expose
totals/truncation; do not mistake those previews for the complete declaration list.
For detail, use an exact symbol name and optional bounded source excerpts:

```sh
npm run code:map -- inspect src/service/task-store --symbol DurableTaskStore.resolveUncertain --source
```

For test components, inspect the returned `testCases` and select a literal name
with `--test-case NAME --source` (MCP: `testCase`). Select a symbol or a test case,
not both. Focused requests omit repeated case inventories. Duplicate case names
require a targeted read of the listed line ranges.

Then read relevant implementation/test ranges. Use `rg` for unknown text or
content outside the map; do not begin with a repository-wide dump. CLI output is
JSON; `npm --silent run code:map -- ...` suppresses npm banners.

Select cross-cutting docs by purpose before loading their bodies:

```sh
npm run code:map -- docs
npm run code:map -- doc production deployment
npm run code:map -- docs --repo daemon
```

[docs/catalog.json](../../docs/catalog.json) and each fork's catalog index maintained guides. Open only
those relevant to the task; historical evidence is behind the archive index.
AST navigation is derived on demand, with no generated component catalog or model
calls. The trusted Go helper is compiled offline into a private local cache;
scanned source, package builds, generators and SQL are never executed.

For MCP clients, use `npm run code:map:mcp`, or `node tooling/code-map/mcp.mjs`
for protocol-only stdout. Start with `list_repositories`; use MCP `repository`
and `worktree` selectors. Pair `list_components` with `inspect_components`, and
`list_documents` with `inspect_documents`; inspect selected IDs in batches.
The server is read-only. Use the CLI when MCP is not connected; do not change
global client configuration as part of navigation.

## Author And Check

Put implementation contracts in JSDoc, Go doc or protobuf comments at the owning code and
verify behavior with its tests. Standalone docs retain setup, cross-component
decisions, operations, security/release requirements and evidence limits. Remove
duplicate explanations while retaining root guide URLs. For document changes,
update the catalog's stable ID, path and purpose when needed; do not list archive
bodies or copy AST output into a maintained index.

Link cross-repository ownership with source-adjacent `@see repo::component` and
local sources with repo-relative filenames. Go imports and protobuf `go_package`
derive additional links, not version compatibility claims. Do not edit applied
SQL migrations or generated bindings for documentation; migration hashes may be
pinned. Generator-specific import rewrites need explicit ownership links when
literal module/go_package paths differ. Computed and helper-generated test names
are not enumerated; inspect the test source for those cases.
Put explanations next to their callers. Keep original contribution heads
and independently reviewable fork changes.

Run `npm run docs:check` and `npm run test:code-map`, plus affected behavior tests.
Use `npm run docs:check:workspace` to check all registered repositories and cross-links;
the ordinary check does not require sibling clones. Verify comment-only patches
with language-aware comparisons and migration byte checks, not only test results.
Repeat inspection of changed owners and selected docs to verify useful discovery,
not just passing syntax. Check changed heading links manually; `docs:check` does
not validate Markdown fragments. Report skipped checks without claiming new
acceptance.
This workflow does not authorize provider calls, service deployment, cluster
changes or secret rotation.
