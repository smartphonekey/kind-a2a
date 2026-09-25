<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Agyn Integration

Agyn is the execution backend for the durable A2A service. It supplies instance
and thread management, native Codex/Claude runtimes, workload scheduling,
persistent volumes and provider proxying. This repository supplies task
ownership, A2A protocol state, durable scheduling and execution reporting.

The current installed backend includes reviewed fork changes through registry
schema `0027`. A stock Agyn installation alone does not satisfy this service's
lifecycle contract. Use the [installed inventory](KUBERNETES.md#backend-revisions),
not a generic `agyn local upgrade`, to identify the compatible stack.

## Ownership And Lifecycle

Each new task is bound to a dedicated Agyn instance, thread, workspace and native
session. Different tasks can execute concurrently, while follow-ups for one task
are serialized. Only trusted operator configuration selects agent profiles,
runtime images, executables, volumes and subscription bindings.

Agyn receives one recorded inbox submission for each execution. A required init
gate configures reporting before the CLI starts; a durable inbox journal records
execution intent/completion and prevents ambiguous pending work from being
silently replayed. The service pins the exact workload identity.

An outcome does not prove compute release. The service waits for
`removalConfirmedAt` from the compatible lifecycle stack; `removedAt` is a
metering field and is insufficient. After confirmed release, the next turn can
start a new Pod with the same task instance/thread/PVC/session.

## Runtime Requirements

Operator-managed Codex and Claude profiles need:

- A distinct, retained per-instance workspace and durable native session state.
- The required-init, reporting/Stop and durable-inbox configuration appropriate
  to the selected daemon/runtime.
- A valid Agyn subscription binding, with provider authentication handled by
  the native proxy rather than browser or A2A task credentials.
- Explicit resource bounds, the intended network allowances and access to the
  configured reporting endpoint.
- Compatible Gateway, registry, native runner and orchestrator capabilities.

Codex persistence uses `CODEX_HOME` on the workspace. Claude persistence uses
its durable configuration/session mapping and exact transcript identity.
Profile configuration is immutable for existing tasks; changes require a new
versioned profile rather than repointing an existing binding.

The installer uses authenticated TerminalGateway delivery, not Kubernetes
credentials inside the A2A worker. Its exact contract and remaining trusted-local
assumptions are in [SERVICE.md](SERVICE.md#reporting-setup-contract).

## Run And Operate

For the installed Kubernetes app, follow [KUBERNETES.md](KUBERNETES.md).
For a separately configured host instance, follow [WEB.md](WEB.md) or
[SERVICE.md](SERVICE.md#run-requirements). Neither launcher provisions a fresh
compatible Agyn installation.

Use `AGYN_PROFILE` for the host launcher's existing operator login. Provider
subscription credentials are separate from that login and from owner-scoped
A2A/browser credentials. A secret-manager change does not automatically rotate
the corresponding Agyn subscription.

## Boundaries

- The native Agyn path is not the legacy ACP harness. The controller/workflow is
  profile-neutral, but CLI configuration and persistence require runtime adapters.
- The native integration does not provide the legacy ACP human-approval bridge.
  Do not claim real approval handling from noninteractive execution tests.
- Cancellation waits for workload removal. Work already executed can leave
  effects; interruption requires explicit reconciliation rather than retry.
- Root native runtimes and trusted-local reporting/hook configuration are not
  hardened for hostile repositories. App Pod restrictions do not fix that.
- Native session retention is implemented; centralized export/analytics and
  authenticated editor takeover are separate unfinished features.

See [ACCEPTANCE.md](ACCEPTANCE.md) for tested scope,
[PRODUCTION.md](PRODUCTION.md) for release gates, and
[CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md) for fork and review boundaries.
The old `start:agyn` adapter is preserved in source; its
[archived instructions](docs/archive/2026-09-25/AGYN.md) are not the durable
service's runbook.
