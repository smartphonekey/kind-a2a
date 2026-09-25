<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Agyn Integration

Agyn is the execution backend for the durable A2A service. This page records
ownership and runtime prerequisites across repositories; adapter contracts live
beside the implementation and tests.

A stock Agyn installation alone is not compatible. Use the
[installed inventory](KUBERNETES.md#backend-revisions), not a generic
`agyn local upgrade`, to identify the tested combination. Fork/review boundaries
are in [CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md).

## Ownership And Lifecycle

- This repository owns authenticated A2A task identity, durable scheduling,
  protocol state and execution reporting.
- Agyn owns instances/threads, placement, workload lifecycle, persistent volumes,
  native runtimes and provider proxying.
- Operators own versioned profiles, runtime images, subscription bindings and
  security/resource policy. Task input must not select infrastructure authority.

The architectural goal is isolated durable task state, serialized turns within
a task and released compute between turns. Runtime choice must not require a
different A2A controller. Detailed dispatch, identity and release rules are in
the owning modules:

```sh
npm run code:map -- scan --area src/service
npm run code:map -- inspect src/service/agyn-driver src/service/worker src/service/task-store
```

Open cross-repository decisions remain in the
[architecture proposal](docs/agyn-a2a-proposal.md), not an accepted upstream API.

## Runtime Requirements

Operator-managed Codex and Claude profiles need retained per-instance workspaces
and native session directories, compatible required-init/reporting/inbox-guard
support, valid subscription bindings, explicit resource bounds and the intended
network allowances. Workloads must reach the configured reporting endpoint.
Do not repoint a profile used by existing tasks; introduce a new versioned ID.

CLI configuration and session persistence differ by runtime. Inspect
`src/reporting/agent-config` and `src/service/agyn-reporting-installer` for those
contracts. The worker uses authenticated TerminalGateway delivery, not Kubernetes
credentials; [service setup](SERVICE.md#reporting-setup-contract) describes the
remaining trust requirements.

## Run And Operate

Use [KUBERNETES.md](KUBERNETES.md) for the installed app and
[WEB.md](WEB.md) or [SERVICE.md](SERVICE.md#run-requirements) for a separately
configured host instance. Neither launcher provisions a compatible backend.

`AGYN_PROFILE` selects the host launcher's existing operator login. That login,
provider subscription credentials and owner-scoped A2A/browser credentials are
separate. Secret-manager rotation does not automatically update an Agyn
subscription; synchronization remains an authorized operator responsibility.

## Boundaries

The native integration is not the legacy ACP harness and does not provide its
human-approval bridge. Native session retention is not centralized export,
analytics or authenticated editor takeover. Trusted-local root runtimes and
mutable reporting/hooks are not hardened for hostile repositories; app Pod
restrictions do not close that boundary.

Use [verification and acceptance](ACCEPTANCE.md) for checks and evidence
requirements, and [production readiness](PRODUCTION.md) for release requirements.
The old `start:agyn` adapter remains in source for comparison; historical instructions
are reachable through the [archive index](docs/archive/README.md), not current
deployment or rollback procedures.
