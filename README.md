<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# AIRA A2A Lab

An Agyn-backed A2A execution service with an assistant-ui web workspace.
Codex and Claude run isolated tasks on single-node Kubernetes. Each task keeps
its own workspace and native session while compute is removed between turns.

**Status: trusted local lab, not production-ready.** See
[production readiness](PRODUCTION.md) for release criteria,
[deployment](KUBERNETES.md) for the installed revisions and
[verification and acceptance](ACCEPTANCE.md) for procedures and evidence limits,
not a manually maintained test inventory or passing-results claim.

## Use The Installed App

Open **http://127.0.0.1:8084/ui/**. Use the owner-scoped A2A access token described
in [Kubernetes access](KUBERNETES.md#access), not a provider credential.

The host app at `http://127.0.0.1:8083/ui/` is a separate installation with its
own database and browser credentials. Do not treat it as a second replica of
the Kubernetes service.

## Architecture

```text
assistant-ui browser / A2A client
  -> execution service: ownership, task state, FIFO queue, durable events
  -> Agyn adapter: persistent task-to-instance/thread mapping
  -> Agyn lifecycle services and native runner
  -> task-specific Pod + persistent workspace + Codex/Claude session

Agent reporting MCP -> execution service -> A2A events / browser
```

The service uses the official A2A and MCP SDKs. Agyn owns workload placement,
Pod/PVC lifecycle and the native runtimes. Selecting Codex or Claude does not
require changing the A2A controller or workflow.

## Task Lifecycle

Implementation contracts live beside their owning code and tests. Start with a
component list, select related components, then inspect them together:

```sh
npm run code:map -- scan --area src/service
npm run code:map -- inspect src/service/worker src/service/task-store
```

Inspect an exact symbol with `--symbol NAME`, or add `--source` for bounded,
line-numbered implementation excerpts. The map derives imports, exports, test
links and module/public JSDoc from source ASTs on demand; there is no generated
component catalog to refresh. Test links are static import/package relationships, not
coverage or passing results. Follow [AGENTS.md](AGENTS.md) and the repository
[code-map skill](skills/code-map/SKILL.md) for navigation and authoring.

Agyn contribution checkouts are also navigable. Start with `npm run code:map -- repos`,
then `npm run code:map -- scan --repo runners`. Go, protobuf and SQL use structured
parsers; select returned `repo::component` IDs together to follow cross-repository
contracts. `repos --worktrees` exposes other local checkouts for explicit selection.
The registry is `tooling/code-map/workspace.json`; it uses sibling checkout paths,
not a generated component inventory. Missing clones remain explicitly unavailable.
Go navigation needs a local Go toolchain; the helper builds offline and never
builds or executes the scanned packages. SQL migrations are read, never applied.

## Documentation

Standalone docs cover setup, cross-component decisions, operations and release
requirements. They do not maintain a second copy of class, function or API
contracts. List their purposes before loading selected documents:

```sh
npm run code:map -- docs
npm run code:map -- doc production deployment
```

[docs/catalog.json](docs/catalog.json) is the curated navigation index. Common
entry points are [service operations](SERVICE.md), [web setup](WEB.md),
[Agyn ownership](AGYN.md), [contributions](CONTRIBUTING-AGYN.md),
[architecture questions](docs/agyn-a2a-proposal.md) and [licensing](LICENSING.md).
The archive is indexed once; historical report bodies are not loaded by default.

## Develop And Verify

Use the Node version in `.nvmrc`; the service checks the bundled SQLite version.

```sh
nvm use
npm ci
npm --prefix web ci
npm run docs:check
npm run test:code-map
npm test
npm run build:web
npm exec --prefix web -- playwright install chromium
npm run test:web
```

For a configured host installation, run `npm run start:web` as described in
[WEB.md](WEB.md). The launcher requires an operator-owned service configuration,
existing compatible Agyn profiles and valid subscription bindings. It does not
provision a new backend.

## Source And Release Status

Application code and current documentation are maintained on this repository's
`main`. Agyn changes are on pushed contribution branches, not merged into the
forks' `main` branches or submitted as upstream PRs by this project.
The [deployment inventory](KUBERNETES.md#backend-revisions) pins the tested stack;
checking out only `main` in every repository will not reproduce it.

The earlier kind/ACP and lightweight Agyn adapters remain in source for
comparison. They are not the current durable service and their commands are
not deployment or rollback instructions for it.

Milestone reports, failed attempts and legacy instructions are retained in the
[documentation archive](docs/archive/README.md), outside the current runbooks.
