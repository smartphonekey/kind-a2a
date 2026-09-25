<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Repository Navigation And Documentation

Use the Node runtime in [.nvmrc](.nvmrc), installed development dependencies and
the [Go parser prerequisites](tooling/code-map/go-parser/README.md) when needed.

## Discover Before Reading

Follow the [code-map skill](skills/code-map/SKILL.md): discover repositories and
components, select related IDs, then batch-inspect their source and tests. Select
documents by purpose before reading their bodies. Inspect checkout provenance
before crossing into a contribution worktree.

Use `rg` for unknown text or content outside the map, not as a substitute for
structural discovery. Read historical evidence only when the task needs it.
The skill owns the workflow; CLI help and MCP schemas own their argument syntax.

## Author At The Owner

- Before adding prose, read the implementation and adjacent tests. Delete
  descriptions already evident there. Add a source comment only for a useful
  contract, rationale, ownership rule or nonobvious constraint; do not narrate
  code or copy a document into a comment block.
- Keep Markdown for information code cannot establish: external prerequisites,
  operator decisions, cross-project design rationale, security assumptions,
  unimplemented requirements, licensing and the scope of historical evidence.
  Link to source instead of maintaining API, field, default or test inventories.
- Keep one authority for each fact. Link to an existing guide or executable
  procedure rather than repeating it. Preserve established guide URLs and
  linked headings when trimming content.
- Maintain [docs/catalog.json](docs/catalog.json) when a document's purpose or
  location changes. It is a discovery index, not a second component inventory.
- Link genuine cross-repository owners with source-adjacent `@see` references.
  A navigation link is not evidence of compatible dependency versions or a
  passing test; verify the exact revisions needed for the change.
- Do not edit applied SQL migrations, generated bindings, license grants or
  archived receipts to improve prose. Migration bytes can be recovery inputs.
  Put missing rationale beside the caller; preserve original contribution heads.

## Operational Scope

Use [ACCEPTANCE.md](ACCEPTANCE.md) for verification. For comment-only work, also
check code-token/directive equivalence, unchanged migration bytes and affected
Markdown links. Report actual results and skipped or failed checks.

Navigation and documentation work does not authorize deployments, provider
calls, cluster changes or secret rotation. Keep credentials and private evidence
out of source, comments and navigation catalogs.
