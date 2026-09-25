<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Repository Navigation And Documentation

Run navigation commands from this checkout's root with the Node runtime in
`.nvmrc` and dependencies installed. The repo-tracked
[code-map skill](skills/code-map/SKILL.md) provides the focused workflow.

## Discover Before Reading

1. List components, optionally narrowing the area:

   ```sh
   npm run code:map -- scan
   npm run code:map -- scan --area src/service
   ```

   Use `--limit` and `--offset` to page larger lists; add `--include-tests` when
   selecting test components.

2. Choose related IDs from the list and inspect them together:

   ```sh
   npm run code:map -- inspect src/service/worker src/service/task-store
   ```

3. Follow the returned module/public JSDoc, imports, dependents and test links.
   Narrow with an exact `--symbol NAME` such as `DurableTaskStore.resolveUncertain`,
   then use `--source` for bounded line-numbered excerpts or a targeted file read.
   Test components expose `testCases`; select a literal case name with
   `--test-case NAME --source`. Symbol/case requests omit repeated case inventories.
   IDs are repo-relative source paths without extensions. Test links represent
   direct imports, not coverage or passing results. The map parses source ASTs
   on demand; it does not store a generated component catalog, execute repository
   source or call a model.
4. List document purposes, then load only relevant document IDs together:

   ```sh
   npm run code:map -- docs
   npm run code:map -- doc production deployment
   ```

Use `rg` to locate unknown text or inspect content outside the source map, not
as a replacement for component discovery. Read linked historical evidence only
when the task needs it; the catalog includes the archive index, not archive bodies.
CLI results are JSON; `npm --silent run code:map -- ...` omits npm banners.

For read-only MCP navigation, the server is `npm run code:map:mcp`; use
`node tooling/code-map/mcp.mjs` when stdout must be protocol-only. Tools are
`list_components`, `inspect_components`, `list_documents`, `inspect_documents`.
Apply the same list-then-batch-inspect sequence. No repository source is executed.

## Author At The Owner

- Put module purpose and public behavior/invariants in JSDoc beside the owning
  implementation, with nearby comments for non-obvious reasoning and tests for
  behavior. Do not copy class/function/API contracts into standalone Markdown.
- Keep standalone docs for prerequisites, cross-component decisions/ownership,
  operating procedures, security/release requirements, verification scope and
  licensing. Keep established root URLs as concise guides or routing pages.
- Maintain [docs/catalog.json](docs/catalog.json) when a meaningful cross-cutting
  document is added, moved or repurposed. Give it a stable ID and discriminating
  purpose. Do not generate a component inventory or index every archive report.
- Run `npm run docs:check` and `npm run test:code-map`, plus tests for changed
  behavior. Inspect the affected components/documents again to check discovery.
  Check changed Markdown heading links manually; `docs:check` does not validate
  heading fragments.
  Report which checks actually ran; do not infer live acceptance from local tests.

## Operational Scope

Navigation and documentation work does not authorize service startup against
real providers, deployments, cluster mutations or secret rotation. Use model-free
local checks unless the user separately authorizes operational actions. Keep
operator state, credentials and private evidence out of source and documentation.
