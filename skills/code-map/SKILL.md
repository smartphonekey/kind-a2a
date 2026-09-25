---
name: code-map
description: Navigate aira-a2a-lab and its registered Agyn worktrees through component and document discovery, then batch inspection. Use when locating owners, tracing contracts or maintaining source-adjacent documentation, not for deployment or generic filesystem search.
---
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# AIRA Code Map

Work from the `aira-a2a-lab` checkout with its pinned Node runtime and development
dependencies. Follow [AGENTS.md](../../AGENTS.md) and the selected fork's local
instructions. Resolve an installed skill symlink before following relative links.
Go navigation also needs the [local parser prerequisites](../../tooling/code-map/go-parser/README.md).

## Discover, Select, Inspect

Start with repository discovery when the task crosses into a fork. Choose the
intended checkout from the returned provenance; do not assume every local branch
is part of the installed stack. Then scan components and batch-inspect related IDs:

```sh
npm run code:map -- repos --worktrees
npm run code:map -- scan --repo runners --area internal/server
npm run code:map -- inspect runners::internal/server/volume_anchor_migration orchestrator::internal/volumemigration/coordinator
```

Follow pagination/truncation metadata before assuming a list is complete. Narrow
to the relevant symbol or test case and its source, then follow related owners.
Treat static relationships as leads, not coverage or compatibility guarantees.
Use targeted reads for ambiguous or computed cases, and `rg` for unmapped content.

Discover documents by purpose before reading selected IDs:

```sh
npm run code:map -- docs --repo daemon
npm run code:map -- doc daemon::operations
```

Use `npm run code:map -- --help` for current CLI arguments and the connected
server's tool schemas for MCP arguments. Apply the same discovery-then-inspection
workflow in either interface. Use the CLI if MCP is not connected; navigation
does not require changing global client configuration.

For an MCP client that needs a server command, run
`node tooling/code-map/mcp.mjs --root /path/to/aira-a2a-lab` with that checkout's
Node runtime. Keep protocol stdout free of package-manager banners.

## Maintain

Apply the source-first rules in [AGENTS.md](../../AGENTS.md). Keep useful contracts
at their owners and non-code decisions in the appropriate existing guide; do not
create another component catalog, API reference or chronological change report.
After edits, repeat discovery and selected inspection to check that a new reader
can find the relevant owner. Follow [acceptance guidance](../../ACCEPTANCE.md) for
checks, and report the scope actually verified.
