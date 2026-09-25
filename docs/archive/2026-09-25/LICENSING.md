> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Licensing Scope

The new execution service, reporting tools and their tests are licensed under
AGPL-3.0-only. Covered files carry an SPDX header. The complete license is in
[LICENSES/AGPL-3.0-only.txt](../../../LICENSES/AGPL-3.0-only.txt).

The new `web/` application code, tests, `WEB.md`, and `scripts/start-web.sh`
and the new Kubernetes packaging, scripts and `KUBERNETES.md` are also
AGPL-3.0-only. Third-party packages and the Agyn organization avatar
at `web/public/agyn.png` retain their own terms; the avatar is not included in
this license grant.

This grant does not relicense the pre-existing lab, third-party dependencies,
generated files or Agyn repositories. Those retain their existing terms.
Contributions in the `agynd-cli` and `agents-orchestrator` forks remain under
their respective repositories' licenses. Contributions to `claude-sdk-go`
retain that repository's MIT license.

The service and reporting documentation added with this implementation is also
AGPL-3.0-only: `SERVICE.md`, `PRODUCTION.md`, `CONTRIBUTING-AGYN.md`,
`docs/agyn-a2a-proposal.md`, `AGYN-REPORTING.md`, `AGYN-NETWORK.md`,
`AGYN-PARALLEL.md`, `AGYN-RESOURCES.md`, `AGYN-PORTABILITY.md`,
`AGYN-REMOVAL.md`, `AGYN-VOLUME-SAFETY.md`, `AGYN-CHECKED-VOLUMES.md`, and
`A2A-PROTOCOL.md`, `AGYN-RUNNER-TRANSPORT.md`, `AGYN-VOLUME-BACKEND.md`, and
`AGYN-PREPARED-WORKLOADS.md`, `AGYN-PREPARED-REGISTRY.md`,
`AGYN-PREPARED-CONTROLLERS.md`, `AGYN-PREPARED-ROLLOUT.md`, and
`AGYN-PREPARED-CLAUDE.md`, `AGYN-NATIVE-DNS.md`, `AGYN-PREPARED-SECRETS.md`, and
`AGYN-PREPARED-RECOVERY.md`, `AGYN-RESOURCE-ANCHORS.md`,
`AGYN-ANCHOR-REGISTRY.md`, `AGYN-ANCHOR-CONTROLLERS.md`. New integration
scripts and the local integration-image Dockerfiles carry the same SPDX header. Third-party code in
the generated runtime bundle retains its dependency licenses.
