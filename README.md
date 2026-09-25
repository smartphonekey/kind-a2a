<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# AIRA A2A Lab

An Agyn-backed A2A execution service with an assistant-ui web workspace.
Codex and Claude run isolated tasks on single-node Kubernetes. Each task keeps
its own workspace and native session while compute is removed between turns.

**Status: trusted local lab, not production-ready.** The backend is upgraded
in place through registry schema `0027`. See [production readiness](PRODUCTION.md)
for the remaining release criteria and [acceptance](ACCEPTANCE.md) for what has
actually been tested.

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

- A new task receives a dedicated instance, thread, workspace and native session.
  Different tasks run concurrently; the installed service admits two executions.
- Follow-ups retain the task's immutable profile and run FIFO in the same
  workspace, never concurrently within that task.
- An ordinary completed turn releases compute after confirmed Pod removal.
  A follow-up starts a new Pod attached to the retained workspace/session.
- Terminal tasks are read-only. Further work starts a new task.
- Interrupted turns require explicit reconciliation. Restoring a session does
  not authorize replay of actions that might already have completed.
- Workspaces outlive compute. Retention and deletion are separate operations.

## Documentation

| Document | Purpose |
| --- | --- |
| [Production readiness](PRODUCTION.md) | Current blockers and release acceptance criteria |
| [Kubernetes deployment](KUBERNETES.md) | Installed images, access, upgrades and backup boundaries |
| [Service](SERVICE.md) | Configuration, authentication, admission, reporting and recovery |
| [Web workspace](WEB.md) | Browser setup, task behavior and security boundary |
| [Agyn integration](AGYN.md) | Runtime requirements and ownership boundaries |
| [Acceptance](ACCEPTANCE.md) | Current verification summary and its limits |
| [Contributions](CONTRIBUTING-AGYN.md) | Fork/branch status and upstream review units |
| [Architecture proposal](docs/agyn-a2a-proposal.md) | Contract proposed for discussion with Agyn |
| [Licensing](LICENSING.md) | AGPL scope and third-party terms |

## Develop And Verify

Use the Node version in `.nvmrc`; the service checks the bundled SQLite version.

```sh
nvm use
npm ci
npm --prefix web ci
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
