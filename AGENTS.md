<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Repository Navigation And Documentation

Run navigation commands from this checkout's root with the Node runtime in
`.nvmrc`, development dependencies installed and Go available for Go navigation.
The trusted Go parser is built offline; scanned repositories are never built or
executed. The repo-tracked
[code-map skill](skills/code-map/SKILL.md) provides the focused workflow.

## Discover Before Reading

1. List repositories before crossing into Agyn contributions. The registry in
   `tooling/code-map/workspace.json` selects active checkouts, not every historical
   integration branch. Git supplies current branch/head identities:

   ```sh
   npm run code:map -- repos
   npm run code:map -- repos --worktrees
   npm run code:map -- scan --repo runners --language go
   ```

   Worktree names come from discovery, not arbitrary paths. Select one explicitly
   with `--repo daemon --worktree agynd-cli`; it never changes the checked-out branch.

2. List components in the default A2A repository, optionally narrowing the area:

   ```sh
   npm run code:map -- scan
   npm run code:map -- scan --area src/service
   ```

   Use `--limit` and `--offset` to page larger lists; add `--include-tests` when
   selecting test components.

3. Choose related IDs from the list and inspect them together:

   ```sh
   npm run code:map -- inspect src/service/worker src/service/task-store
   npm run code:map -- inspect runners::migrations/0027_volume_anchor_migration api::proto/agynio/api/runners/v1/runners
   ```

4. Follow the returned JSDoc/Go/protobuf/SQL comments, imports and test links.
   Detail symbols/test cases also page with `--offset`/`--limit`; follow
   `symbolPage`/`testCasePage.nextOffset` instead of assuming the first page is complete.
   Scan export previews and related-test case previews include totals/truncation flags.
   Narrow with an exact `--symbol NAME` such as `DurableTaskStore.resolveUncertain`,
   then use `--source` for bounded line-numbered excerpts or a targeted file read.
   Test components expose `testCases`; select a literal case name with
   `--test-case NAME --source`. Symbol/case requests omit repeated case inventories.
   IDs are `[repo[@worktree]::]path-without-extension`. Go methods use `Type.Method`;
   repeated SQL targets and overloaded declarations may require a listed line-range
   read. Go tests link by package/import, not symbol coverage. Generated files are
   excluded unless `--include-generated` is requested. The map parses source ASTs
   on demand; it does not store a generated component catalog, execute repository
   source or call a model.
5. List document purposes in the selected checkout, then load relevant IDs together:

   ```sh
   npm run code:map -- docs
   npm run code:map -- doc production deployment
   npm run code:map -- docs --repo daemon
   ```

Use `rg` to locate unknown text or inspect content outside the source map, not
as a replacement for component discovery. Read linked historical evidence only
when the task needs it; the catalog includes the archive index, not archive bodies.
CLI results are JSON; `npm --silent run code:map -- ...` omits npm banners.

For read-only MCP navigation, the server is `npm run code:map:mcp`; use
`node tooling/code-map/mcp.mjs` when stdout must be protocol-only. Tools are
`list_repositories`, `list_components`, `inspect_components`, `list_documents`,
`inspect_documents`. MCP `repository` and `worktree` select discovered checkouts;
component/document IDs support mixed-repository batches.
Apply the same list-then-batch-inspect sequence. No repository source is executed.

## Author At The Owner

- Put module purpose and public behavior/invariants in JSDoc, Go doc or protobuf
  comments beside the owning implementation, with nearby comments for reasoning and tests for
  behavior. Do not copy class/function/API contracts into standalone Markdown.
- Keep standalone docs for prerequisites, cross-component decisions/ownership,
  operating procedures, security/release requirements, verification scope and
  licensing. Keep established root URLs as concise guides or routing pages.
- Maintain [docs/catalog.json](docs/catalog.json) when a meaningful cross-cutting
  document is added, moved or repurposed. Give it a stable ID and discriminating
  purpose. Do not generate a component inventory or index every archive report.
- Use source-adjacent `@see repo::component` for meaningful cross-repository
  relationships; use repo-relative source filenames for local links. Go imports
  and proto `go_package` also derive cross-links. These do not prove that pinned
  dependency versions or deployed images match the inspected worktrees.
  Generator-specific import rewrites are not resolved automatically; use an
  explicit ownership link where the literal module/go_package paths differ.
- Never edit applied SQL migrations merely to improve comments: their exact
  bytes may be pinned by backup/recovery checks. Document their contract next to
  the owning Go code and link the migration. Preserve generated code and original
  contribution heads; keep fork documentation changes independently reviewable.
- Run `npm run docs:check` and `npm run test:code-map`, plus tests for changed
  behavior. Inspect the affected components/documents again to check discovery.
  Use `npm run docs:check:workspace` for the registered multi-repository set;
  ordinary `docs:check` remains usable without optional sibling checkouts.
  Check changed Markdown heading links manually; `docs:check` does not validate
  heading fragments.
  Report which checks actually ran; do not infer live acceptance from local tests.
  No Go build-tag evaluation, SQL body execution or cross-repo dependency-version
  validation is performed by the navigator. Inspect returned provenance before
  treating source relationships as compatibility evidence.
  Static case names exclude computed/helper-generated names; inspect the linked
  test source rather than treating that list as a runtime test inventory.

## Operational Scope

Navigation and documentation work does not authorize service startup against
real providers, deployments, cluster mutations or secret rotation. Use model-free
local checks unless the user separately authorizes operational actions. Keep
operator state, credentials and private evidence out of source and documentation.
