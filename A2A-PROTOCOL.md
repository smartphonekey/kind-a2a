<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# A2A Protocol Acceptance

Scope: the new `src/service/` JSON-RPC 1.0 service using the pinned official
`@a2a-js/sdk@1.1.0`. This does not change the preserved 0.4.0 lab controller or
claim full protocol certification. Tests use real loopback HTTP connections and
the official client, but drive the durable store directly instead of launching
an agent. Kubernetes lifecycle evidence remains in [AGYN-REPORTING.md](AGYN-REPORTING.md).

## Request Lifetime

The A2A 1.0 blocking-send contract waits for terminal or interrupted task state.
Subscriptions start with task state, preserve event order and reject terminal
tasks. Multiple streams must not interfere with each other. References:
[blocking send](https://a2a-protocol.org/v1.0.0/specification/#322-sendmessageconfiguration),
[subscription](https://a2a-protocol.org/v1.0.0/specification/#316-subscribe-to-task),
[event delivery](https://a2a-protocol.org/v1.0.0/specification/#352-streaming-event-delivery).

The implementation now has these properties:

- Blocking `SendMessage` has no success-on-timeout path. Its own execution must
  settle and the current task must be terminal or interrupted before returning.
  A predecessor's interruption cannot complete a queued message, and a settled
  execution cannot return another turn's `WORKING` state.
- Outcomes are not settlement evidence. Completion, failure, input requests and
  uncertain-side-effect recovery wait for the store's confirmed-removal boundary.
  Canceling a queued message also waits for an active predecessor to stop.
- `returnImmediately: true` still provides immediate durable acceptance and has
  no effect on streaming lifetime. Exact message retries remain idempotent.
- Both JSON-RPC stream operations follow task lifetime, including idle
  `INPUT_REQUIRED` and later follow-ups. They close after the terminal status
  event. A client disconnect does not cancel durable work or sibling streams.
  Containers still stop between turns; the subscription is only an HTTP request.
- The interrupted-state streaming choice follows the core task operations; it
  is explicit service behavior, not a claim that all bindings require it. The
  specification's [REST streaming section](https://a2a-protocol.org/v1.0.0/specification/#117-streaming-support)
  also describes closure on interruption. This service advertises JSON-RPC only.
- `SubscribeToTask` rejects terminal tasks with the SDK's
  `UnsupportedOperationError`. Unknown and cross-owner tasks remain not-found.
  An exact `SendStreamingMessage` retry can replay a settled task without opening
  a new execution; a new follow-up cannot reopen it.

## Snapshot And Delivery

The initial task and event cursor come from one SQLite transaction. Subsequent
events are read in ordered batches of 100. Execution settlement no longer inserts
a fresh task-head read into an older event batch, which could previously expose
future state before older status updates.

Initial task JSON has a 1 MiB budget, below the installed SDK parser's 4 MiB SSE
event limit. Small snapshots contain their artifacts. For larger snapshots,
artifacts follow in individually bounded artifact updates. Requested history
is reduced to the newest messages that fit; the persisted history is unchanged.
All snapshot fragments precede events newer than the snapshot cursor.

Snapshot artifact updates carry `metadata.snapshotSequence`, not a fabricated
`eventSequence`. Durable status/artifact updates carry their actual increasing
`metadata.eventSequence`. These are service metadata, not SSE `id` fields.
`Last-Event-ID` replay is not implemented; reconnect starts from current state.
Owner-scoped `/tasks/:taskId/events?after=...` supplies explicit durable replay.

Authorization is rechecked before submission, while waiting and before backlog
updates. Revocation returns HTTP 401 while a blocking response is still pending;
an unavailable authorizer or shutdown returns 503. Once SSE headers have been
sent, these failures close the connection without inventing a terminal task.
Disconnect/abort releases connection admission, not task ownership. The existing
10-second HTTP drain deadline remains; it is not an execution timeout.

## Reproduce

On 2026-09-13, `npm test` passed all 101 tests, including the 10 baseline tests
and 19 new handler/official-client lifetime checks. The focused long-running
client scenario passed in 31.38 seconds; no agent workload was created for it.

```sh
npm test
```

For focused tests after building:

```sh
node --test dist/service-a2a.test.js dist/service-protocol.test.js dist/service-http.test.js dist/service-stream.test.js
```

The protocol test deliberately waits 31.25 real seconds with no task update.
It holds a blocking send, a streaming send and a subscription open together,
then checks artifact delivery and terminal closure using the official client.
The test server uses the entry point's 30-second request-body and 10-second
header timeouts; neither is a response-lifetime limit.

Additional coverage includes:

- Terminal/interrupted results after removal confirmation, both follow-up races,
  cancellation while queued, uncertain side effects, and abort without mutation.
- Three readers crossing two turns and a backlog larger than one event batch,
  with identical ordered updates and no future task snapshots.
- Idle interrupted subscription, sibling disconnect, terminal/missing/hidden
  subscriptions, and exact settled-submission replay.
- Credential revocation during backlog delivery, live blocking revocation,
  authorizer failure, shutdown, admission release and an idempotent retry.
- Stored artifacts whose combined task snapshot exceeds the client's 4 MiB
  limit, with successful bounded replay and distinct snapshot/event metadata.
- Byte-bounded requested history retaining the newest messages without changing
  durable history.

These checks do not create Kubernetes workloads or use model credentials.

## Still Required

- A complete operation/validation/error conformance audit. Terminal follow-up
  rejection and other store conflicts still use service-specific JSON-RPC
  errors; their semantic mappings and detail shapes need review.
- SSE heartbeats, real ingress idle-timeout acceptance, slow-reader/fan-out load
  tests, and an explicit in-stream error contract. A closed connection alone
  is not task completion; clients must inspect the last task status or `GetTask`.
- Native `AUTH_REQUIRED` and `REJECTED` producer paths, second-agent acceptance,
  and live blocking/streaming agent execution beyond these store-driven tests.
- Production TLS, hardening, physical fencing, storage/operations and the other
  independent gates in [PRODUCTION.md](PRODUCTION.md).
