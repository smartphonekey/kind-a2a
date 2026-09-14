<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Prepared Workload Registry Acceptance

Status: API, registry implementation and disposable PostgreSQL/RPC acceptance
verified on 2026-09-14. This follows the [native prepared-workload stage](AGYN-PREPARED-WORKLOADS.md).
The native runner and registry have been tested separately, not together through
the A2A controller. Both controller migrations and coordinated rollout remain
open. No installed platform service, database or task workspace was changed.

## Implemented

- Separate `CreatePreparedWorkload` and revision-checked `UpdatePreparedWorkload`
  RPCs. Old registries cannot silently ignore new preconditions.
- Durable RESERVED, PREPARING, BOUND, ACTIVATING, ACTIVE, REMOVING and REMOVED
  states. Native bindings and the complete requested registry-volume set are
  immutable; each bound volume must match the active checked registry binding.
- Backend/owner pins and admission guards in migration `0022`. Pins survive
  confirmed workload-history deletion, including owners without volumes. Old
  registry clients cannot admit another legacy workload for an opted-in owner.
- Cancellation before activation authorization wins through CAS. A late prepare
  reply can attach an exact binding while REMOVING only for cleanup, not execution.
  Unknown prepare outcomes retain admission; generic errors cannot prove absence.
- Only a never-authorized RESERVED workload can abort without a native binding.
  Otherwise removal requires an exact-binding ABSENT observation, retained with
  server-time confirmation. Terminal status and billing end remain insufficient.
- Database old-writer guards for binding replacement, skipped transitions,
  identity/pin changes and discarded unconfirmed workload/volume records.

This remains a trusted-controller contract. Registry CAS is not authentication
or node/storage fencing; a native call already authorized before cancellation
may still be in flight. There is no safe automatic replay of uncertain side effects.

## Contribution Boundaries

- [`spk-ai/api`, `feat/prepared-workload-registry`](https://github.com/spk-ai/api/tree/feat/prepared-workload-registry):
  `4f957e5`, based on prepared API `53e0817`.
- [`spk-ai/runners`, `feat/prepared-workload-registry`](https://github.com/spk-ai/runners/tree/feat/prepared-workload-registry):
  `e7c42f4`, based on backend-bound registry `c3b5338`.

Both branches are pushed, retain their original licenses and are dependent
proposals, not published APIs or drop-in images. These are two more branches
beyond the prior 36 focused contributions and two native prepared branches.
No upstream PR was submitted. Baseline `ef0e75d` is unchanged.

## Evidence

- All **538 registry tests including subtests** pass under `-race`, with both
  real disposable PostgreSQL fixtures enabled. No individual test is skipped;
  Go separately reports five packages without tests. Build and vet pass.
- A focused repeat passes **2,320 entries across 20 repetitions**, with no
  failures or skipped tests. This includes the parent fixture in each repetition.
- **48 deliberately blocked transaction interleavings** cover activation versus
  cancellation and prepared versus legacy admission: both orders, commit and
  rollback, agent and sandbox owners, and three transaction isolation levels.
  Independent SQL reads verify final state while another owner makes progress.
- Real loopback registry RPCs and a fresh registry server/connection preserve
  the committed binding across two generations. This is not process-SIGKILL,
  native Pod execution or A2A acceptance. Native observations, authorization
  and Agents display metadata are fixtures.
- Direct SQL attempts exercise the guards independently of the new handlers.
  Repeated upgrade from 0021 preserves historical data and leaves all new fields
  empty/defaulted on legacy rows, with no automatic opt-in or confirmation.
- API lint and breaking checks against `53e0817` pass. Generated dependencies
  remain reproducible from the matching API; they are ignored by the registry repo.
- The A2A service rebuild and **all 323 tests** pass again on Node 24.21.0.

The PostgreSQL 16.6 fixture used the pinned image
`postgres@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef`,
loopback-only publication, bounded compute and temporary storage. Both databases
had zero leftover test schemas before container cleanup. No model credentials,
subscription bindings or installed database access were used.

Private evidence: `.state/agyn-prepared-registry-jBWcRY/`, including
`registry-race.jsonl`, `prepared-repeat.jsonl`, `service-full.tap` and
`verification.json`. Earlier development failures were fixture issues: historical
snapshot comparisons included newly added columns, generated test identities did
not reuse the bound identity, and the fresh server lacked Agents display metadata.
The production checks were not relaxed to accommodate them.

## Next

1. Migrate both agent and sandbox controllers and generated clients. Persist and
   read these states before native prepare/activate/remove; do not use legacy fallback.
2. Add explicit uncertain-prepare observation/reconciliation, late-operation and
   interrupted Secret-ownership recovery. A retained unknown binding is safe
   quarantine, not a complete resource-recovery solution.
3. Test the registry, controllers and native runner together through the complete
   A2A lifecycle, including cancellation and crash/restart windows.
4. Enforce authenticated native routes and all writers, reconcile legacy data,
   coordinate deployment, and close the remaining [production gates](PRODUCTION.md).
