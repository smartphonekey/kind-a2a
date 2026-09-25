<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# AIRA A2A Lab

An Agyn-backed A2A execution service with an assistant-ui web workspace.

**Status: trusted local lab, not production-ready.** See
[production readiness](PRODUCTION.md) for release criteria,
[deployment](KUBERNETES.md) for the installed revisions and
[verification and acceptance](ACCEPTANCE.md) for procedures and evidence limits.

## Use The Installed App

Use [Kubernetes access](KUBERNETES.md#access) for the installed app. A
[host installation](WEB.md) is separate, not a second replica of that service.

## Architecture

Cross-project responsibilities and open maintainer decisions are in the
[proposal](docs/agyn-a2a-proposal.md). Operational trust and compatibility
requirements are in [Agyn integration](AGYN.md).

## Task Lifecycle

Read the source-adjacent contracts and tests using the
[code-map workflow](skills/code-map/SKILL.md). Follow [AGENTS.md](AGENTS.md) when
changing code or documentation; do not maintain a second lifecycle description here.

## Documentation

[docs/catalog.json](docs/catalog.json) indexes the maintained guides by purpose.
Use it to select operating, contribution or licensing guidance before reading it.

## Develop And Verify

Use the Node version in [.nvmrc](.nvmrc):

```sh
nvm use
npm ci
npm --prefix web ci
```

Follow [ACCEPTANCE.md](ACCEPTANCE.md) for verification and
[Go parser setup](tooling/code-map/go-parser/README.md) for native tooling prerequisites.

For a separately configured host installation, follow [WEB.md](WEB.md).

## Source And Release Status

See [contribution status](CONTRIBUTING-AGYN.md#repository-status) for review branches
and the [deployment inventory](KUBERNETES.md#backend-revisions) for the tested stack.
Checking out only `main` in every repository will not reproduce that installation.

The earlier kind/ACP and lightweight Agyn adapters remain in source for
comparison. They are not the current durable service and their commands are
not deployment or rollback instructions for it.

Milestone reports, failed attempts and legacy instructions are retained in the
[documentation archive](docs/archive/README.md), outside the current runbooks.
