<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Durable Execution Service

This is the operator guide for the durable A2A service, not the preserved
lightweight lab adapters. See [Kubernetes deployment](KUBERNETES.md) for the
installed stack, [Agyn integration](AGYN.md) for backend prerequisites and
[production readiness](PRODUCTION.md) for release gates. Stock Agyn alone is
not a compatible backend. Browser access is optional; see [WEB.md](WEB.md).

## Run Requirements

Use the Node runtime in `.nvmrc` and a local/PVC filesystem with working SQLite
WAL locks, not a network-shared filesystem. Do not bypass the SQLite startup
guard or reuse the old lab database: legacy tasks require an explicit ownership
migration. This is not a multi-node HA service.

```sh
nvm use
npm ci
npm run build
```

Prepare an operator-owned JSON file following the startup schema in
[main.ts](src/service/main.ts). Keep service state and credentials outside Git.
Use private absolute paths for the database and credentials, and the built
`dist/service/agyn-reporting-installer.js` as the reporting setup executable.
Select existing compatible Agyn profiles and a reporting URL reachable from
their workloads. Version profile IDs when changing a profile; do not repoint
bindings used by existing tasks.

Provision a compatible Agyn identity and supply the private connection environment
required by [main.ts](src/service/main.ts). Supply `NODE_EXTRA_CA_CERTS` when a
local CA is required; do not disable TLS verification. Then start the configured
host service:

```sh
A2A_SERVICE_CONFIG_FILE=/absolute/private/service.json npm run start:service
```

## Shared Execution Admission

Changing the shared execution ceiling is a drained maintenance operation, not a
way to clear stuck work. Never delete/recreate the database to reset capacity.
Use the [admission CLI](src/service/admission-cli.ts) against the existing database:

1. Stop upstream submissions. Let accepted work settle, or cancel it and wait
   for confirmed workload removal. Inspect ambiguous provider state; SIGTERM
   alone does not drain remote workloads.
2. Stop every worker sharing the database. With the pinned Node runtime and a
   current build, inspect the existing database:

   ```sh
   node dist/service/admission-cli.js --db /absolute/private/service/tasks.sqlite
   ```

3. With `reserved: 0`, compare the old limit and set the new one atomically:

   ```sh
   node dist/service/admission-cli.js --db /absolute/private/service/tasks.sqlite --expect 2 --max-active 4
   ```

4. Set `concurrency: 4` in every worker configuration, restart, and retain the
   command result in the deployment audit. A rejected change requires
   investigation, not a force/reset workaround.

Other databases and workloads created directly in Agyn are outside this budget.
Resource isolation and sustained-load validation remain production gates.

## Client Authentication

Provision owner-scoped A2A credentials using the format maintained in
[auth.ts](src/service/auth.ts). Keep the credentials file mode `0600`; generate
tokens from at least 32 cryptographically random bytes and store only their
SHA-256 digests in that file. Keep plaintext tokens in a secret manager or
private client file. An authorized operator rotates/revokes credentials by
atomically replacing the file. Reconciliation permission is administrative,
not an ordinary task-submission privilege.

Use trusted TLS ingress for non-loopback A2A, browser and reporting traffic.
Do not substitute provider or Agyn credentials for A2A access tokens. Client
contracts are in the [HTTP routes](src/service/http.ts) and
[A2A handler](src/service/a2a.ts); browser access has a separate
[security boundary](WEB.md#browser-boundary).

## Reporting Setup Contract

The trusted-local TerminalGateway installer is not a proposed public Agyn API.
Runtime profiles must include compatible required-init and inbox-guard support;
stock init scripts that log failures and continue are not a startup safety gate.
Runtime-managed configuration and journals need protection from agent writes
before a hostile-code deployment can be considered safe.

For the executable contract, follow the [installer](src/service/agyn-reporting-installer.ts)
to its [terminal delivery](src/service/agyn-terminal.ts) and
[runtime configuration](src/reporting/agent-config.ts) owners.

## Recovery And Operations

- Inspect side effects and provider identity before reconciling an interrupted
  execution. A restored session, accepted pause or reported outcome does not
  prove workload removal or authorize replay. Do not fabricate bindings or
  removal evidence for failed/unbound records.
- Use an explicitly authorized reconciliation credential and record the reason
  for the decision. Follow the [reconciliation route](src/service/http.ts),
  [store eligibility](src/service/task-store.ts) and [provider reconciliation](src/service/agyn-driver.ts).
  Missing request identity may require failure and provider-side
  investigation rather than continuation.
- Drain old workers before coordinated service/daemon upgrades. Never roll back
  the daemon alone under an inbox-guard profile. Audit older workloads before
  trusting lifecycle evidence; partitions, forced deletion and late creates
  require infrastructure fencing, not just process restart.
- Preserve durable databases, workspace/session state and private configuration.
  Use the [deployment backup and restore scope](KUBERNETES.md#backup-and-restore-scope)
  before planning recovery. Retention/deletion is separate from compute release.

Use [verification and acceptance](ACCEPTANCE.md) to select checks and record their
scope. Local results do not prove exactly-once external effects, complete
disaster recovery or production safety.
