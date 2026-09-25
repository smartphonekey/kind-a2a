---
name: code-map
description: Navigate and maintain living documentation in aira-a2a-lab using its AST component map and curated document index. Use when locating code owners, tracing related components or updating this repository's source-adjacent contracts and cross-cutting docs, not for generic repository search or deployment.
---
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# AIRA Code Map

Work from the `aira-a2a-lab` checkout root with its pinned Node runtime and
installed dependencies. Follow [AGENTS.md](../../AGENTS.md) for repository rules.
Resolve a discovery symlink to this repo-tracked skill before following its
relative links.

## Navigate Progressively

List first, choose related IDs, then batch-inspect:

```sh
npm run code:map -- scan --area src/service
npm run code:map -- inspect src/service/worker src/service/task-store
```

Omit `--area` to discover all areas; page with `--limit` and `--offset`. Add
`--include-tests` when selecting test components. IDs are source paths without
extensions. Start with module/public JSDoc, symbols, imports and dependents.
Related tests are direct-import relationships, not coverage or passing results.
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
```

[docs/catalog.json](../../docs/catalog.json) indexes maintained guides. Open only
those relevant to the task; historical evidence is behind the archive index.
AST navigation is derived on demand, with no generated component catalog,
repository-source execution or model calls.

For MCP clients, use `npm run code:map:mcp`, or `node tooling/code-map/mcp.mjs`
for protocol-only stdout. Pair `list_components` with `inspect_components`, and
`list_documents` with `inspect_documents`; inspect selected IDs in batches.
The server is read-only. Use the CLI when MCP is not connected; do not change
global client configuration as part of navigation.

## Author And Check

Put implementation contracts in module/public JSDoc at the owning code and
verify behavior with its tests. Standalone docs retain setup, cross-component
decisions, operations, security/release requirements and evidence limits. Remove
duplicate explanations while retaining root guide URLs. For document changes,
update the catalog's stable ID, path and purpose when needed; do not list archive
bodies or copy AST output into a maintained index.

Run `npm run docs:check` and `npm run test:code-map`, plus affected behavior tests.
Repeat inspection of changed owners and selected docs to verify useful discovery,
not just passing syntax. Check changed heading links manually; `docs:check` does
not validate Markdown fragments. Report skipped checks without claiming new
acceptance.
This workflow does not authorize provider calls, service deployment, cluster
changes or secret rotation.
