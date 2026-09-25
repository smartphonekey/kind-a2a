<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Verification And Acceptance

This is the cross-component verification procedure, not a manually maintained
test inventory or a claim that the current checkout has passed a live rollout.
Test cases and their contracts live with code. Open release requirements are
in [PRODUCTION.md](PRODUCTION.md); installed revisions are in
[KUBERNETES.md](KUBERNETES.md#backend-revisions).

## Find Relevant Checks

Start with structural discovery, then inspect the affected components together:

```sh
npm run code:map -- scan --area src/service
npm run code:map -- inspect src/service/worker src/service/task-store
```

The result includes test files and case names derived from imports and syntax.
These are navigation relationships, not coverage guarantees or passing results.
A change to a cross-component contract also requires the relevant integration
suite even when a test imports that component only transitively.

## Local Verification

```sh
nvm use
npm ci
npm --prefix web ci
npm test
npm exec --prefix web -- playwright install chromium
npm run test:web
node --test scripts/k8s-manifests.test.mjs
```

`npm test` builds source, checks living-documentation structure and runs the
application and navigation-tool tests. For documentation/tooling-only iterations,
`npm run docs:check` and `npm run test:code-map` are available separately.

Browser tests use a model-free service fixture. Ordinary source tests do not
silently enable live Kubernetes, PostgreSQL or provider fixtures. Record skipped
gates explicitly; a skipped integration test is not a passing live check.

## Live Release Acceptance

Use the exact reviewed images, API bindings, schema and environment profile.
Live tests require explicit operator authorization and controlled credentials;
navigation tools and repository skills do not grant that authority.

Verify these cross-component boundaries:

- Parallel tasks retain separate instances, workspaces and native sessions;
  same-task messages remain FIFO with no overlapping execution.
- Completed-turn continuation uses replacement compute with the original
  workspace/session and retained file contents.
- Interrupted-turn recovery blocks new work until explicit reconciliation.
  A new read-only turn inspects an already-observed side effect without replay
  of the interrupted action. Session restoration alone is insufficient.
- Reports are durably acknowledged; actual removal precedes settlement and
  subsequent execution. Cancellation is not proved by a pause acknowledgement.
- Browser restoration, streams, artifacts and authorization survive the relevant
  process/reconnect boundary without silently resending accepted work.
- Upgrades and restores preserve ownership and data. A local database/process
  fixture does not stand in for node fencing or full replacement-node recovery.

Record source/image identities, commands, results, failures/skips, preserved
resources and cleanup. Keep provider approvals separate from noninteractive
execution; do not claim an approval workflow without exercising it.

## Recorded Evidence

The [archive](docs/archive/README.md) retains dated results and failed receipts.
The [migration report](docs/archive/2026-09-25/AGYN-WORKSPACE-MIGRATION.md)
covers the in-place backend upgrade and its Codex checks. The
[Claude/transport report](docs/archive/2026-09-25/AGYN-CLAUDE-A2A.md) covers the
separate Claude follow-up and app-only error fix.

Those records keep their original scope. They are not a substitute for testing
new source or image combinations, and their private evidence must not be
committed or exposed through navigation tools.
