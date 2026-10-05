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
required by [main.ts](src/service/main.ts) and its [gateway credential](src/service/agyn-gateway-auth.ts). Supply `NODE_EXTRA_CA_CERTS` when a
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

## Profile Endpoints And Limits

Each configured profile is also served at `/agents/<profile>/a2a`, with its own
agent card under that prefix; `/a2a` keeps the default profile. An endpoint
selects the profile of new tasks only. Owner credentials are not limited to
profiles yet: any valid credential may use every profile endpoint.

A profile may override the turn deadline and the reporting setup deadline in
the [startup schema](src/service/main.ts). Size the setup deadline for a cold
image pull on the target node. Compute admission remains one shared ceiling
across all profiles; per-profile admission is not implemented, so a profile that
must run one task at a time needs `concurrency: 1` or its own service database.

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

## Durable Admission Drain

Before an upgrade, close admission using the local operator CLI. Inspect the
current generation and supply it with a reason; stale decisions cannot reopen a
newer drain. Keep reasons free of credentials and private task content.

```sh
node dist/service/admission-cli.js --db /absolute/private/service/tasks.sqlite --control
node dist/service/admission-cli.js --db /absolute/private/service/tasks.sqlite --admission closed --expect-generation 0 --reason "Approved maintenance"
```

A drain persists across process restarts. Existing reservations continue toward
release, including recovery after lease expiry; queued work cannot start, and
new submissions are rejected while exact retries remain idempotent. Reporting,
cancellation and reads remain available. `/admissionz` returns 503 while drained;
`/readyz` stays healthy so Kubernetes does not disconnect the shared reporting
listener. Do not use the admission probe as shared Pod readiness. Inspect the
existing admission command until reservations reach
zero before stopping workers. A failed or uncertain provider must still be
reconciled; closing admission does not establish remote-workload fencing.

After the operator verifies the upgrade and retained work, inspect the current
generation again and explicitly reopen with `--admission open`, that generation,
and a new reason. Never script an unconditional reopen in startup. Local audit
rows are not tamper-proof against an operator with database write access.

This is not a restore barrier: restored queued turns may already have executed
after backup, and reserved work may still exist on the old node. Isolate the
restored stack and fence/reconcile it before any worker starts, under the full
[production recovery gate](PRODUCTION.md#3-replacement-node-backup-and-restore).

## Offline Snapshot Rehearsal

For a trusted, private A2A database, the [snapshot CLI](src/service/snapshot-cli.ts)
creates a WAL-consistent snapshot in a fresh private directory and verifies
SQLite integrity. The source is opened read-only; this does not coordinate a
recoverable boundary with Agyn databases or task workspaces.

```sh
node dist/service/snapshot-cli.js --db /absolute/private/service/tasks.sqlite --output-root /absolute/private/rehearsals
```

The finished copy is permanently quarantined against service/worker startup and
new or recovered claims. It is deliberately unsuitable for direct deployment:
queued turns may have executed after the snapshot. Ordinary admission reopening
cannot clear the quarantine. There is no supported automatic release command.
A failed/interrupted run preserves incomplete output; do not select hidden
pending files or treat missing receipts as success. Keep the directory private,
encrypt off-node copies under an approved backup policy, and retain failures.

This rehearses SQLite consistency and replay prevention only. Full recovery still
requires the [whole-stack scope](KUBERNETES.md#backup-and-restore-scope), old-owner
fencing, reconciled provider state, credentials and an authorized continuation.
Do not remove the hold with ad hoc SQL to make a restore start.

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
  before planning recovery. Retention/deletion is separate from compute release:
  the worker [retires](src/service/worker.ts) a terminal task's Agyn instance, and
  with it the workspace, only after every execution settled. Task history and
  artifacts stay in the database; waiting and recovery-blocked tasks keep theirs.

Use [verification and acceptance](ACCEPTANCE.md) to select checks and record their
scope. Local results do not prove exactly-once external effects, complete
disaster recovery or production safety.
