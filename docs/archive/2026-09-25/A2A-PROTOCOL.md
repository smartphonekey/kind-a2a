<!-- SPDX-License-Identifier: AGPL-3.0-only -->
> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# A2A Protocol Acceptance

Scope: the new `src/service/` JSON-RPC 1.0 service using the pinned official
`@a2a-js/sdk@1.1.0`. This does not change the preserved 0.4.0 lab controller or
claim full protocol certification. Automated transport tests use real loopback
HTTP and the official client with a store-driven producer. The opt-in `streaming`
scenario additionally runs a real Agyn agent; it is not part of `npm test`.
Related lifecycle evidence remains in [AGYN-REPORTING.md](AGYN-REPORTING.md).

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
  specification's [REST streaming section](https://a2a-protocol.org/v1.0.0/specification/#117-streaming)
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

The initial task and overflow artifact updates carry `metadata.snapshotSequence`,
not a fabricated `eventSequence`. Durable status/artifact updates carry their actual increasing
`metadata.eventSequence`. These are service metadata, not SSE `id` fields.
`Last-Event-ID` replay is not implemented; reconnect starts from current state.
Owner-scoped `/tasks/:taskId/events?after=...` supplies explicit durable replay.

Authorization is rechecked before submission, while waiting and before backlog
updates. Revocation returns HTTP 401 while a blocking response is still pending;
an unavailable authorizer or shutdown returns 503. Once SSE headers have been
sent, these failures close the connection without inventing a terminal task.
Disconnect/abort releases connection admission, not task ownership.

## Connection Reliability

Idle streams send an SSE comment after 15 seconds without a write. The official
client ignores these comments; they are not task progress or execution activity.
This uses the [HTML standard's keepalive pattern](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes).

The writer has one pending write and no heartbeat queue. While a heartbeat waits
for a drain, the next event waits behind it; no subsequent source event is pulled.
The source's existing 100-row read batch is still an additional memory bound.
Following [Node's write/backpressure contract](https://nodejs.org/api/http.html#responsewritechunk-encoding-callback),
the writer stops on a false `write()` result and gives the connection 10 seconds
to drain. Expiry destroys the socket, including buffered bytes, so a stalled
reader cannot retain its admission slot indefinitely. Timers and listeners are
removed on completion, disconnect or failure. This deadline is not a task timeout.

An event-source failure after headers sends the official SDK's SSE error format
with the original JSON-RPC request ID. Internal details are replaced by a generic
message. This is a transport failure, not a generated task outcome. Before
streaming starts, normal JSON-RPC errors are retained. Revocation and broken
writes terminate the connection without sending additional task data.

## Reproduce

On 2026-09-13, `npm test` passed all 114 tests, including the 10 baseline tests.
The store-driven long-running client scenario passed in 31.42 seconds; no agent
workload was created for that test.

```sh
npm test
```

For focused tests after building:

```sh
node --test dist/service-a2a.test.js dist/service-protocol.test.js dist/service-http.test.js dist/service-stream.test.js
node --test dist/service-sse.test.js dist/sse-writer.test.js dist/a2a-stream-proof.test.js
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
- A loopback HTTP proxy with a real idle timeout. Timely heartbeat comments keep
  the subscription alive; the delayed-heartbeat control times out. This is not
  acceptance of a production ingress or TLS deployment.
- A non-reading TCP client against a saturated test event source. Sampled
  response buffering stays below 100,000 bytes, the drain deadline destroys the
  connection, and a subsequent owner request can reclaim its admission slot.
- Eight real HTTP subscribers: one disconnects while the other seven receive
  the same 51 durable status updates in order and close on completion.
- SDK error-envelope handling, writer backpressure/timer cleanup and a live
  stream verifier that rejects missing, reordered, altered or foreign events.

These checks do not create Kubernetes workloads or use model credentials.

## Real Agent Acceptance

The `streaming` scenario passed on 2026-09-13, using the official client and the
actual service entry point, worker, Agyn driver and Codex reporting tools. Network
preflight run `3cdf7446` first passed 92 checks and cleaned its probes:
`.state/agyn-network-live-D3N2ff/evidence.json`.

The test sends the first message through `SendStreamingMessage`, opens a second
`SubscribeToTask` stream, and submits an exact blocking retry of the first message.
The first turn requests a 35-second tool wait and exercises the native stop-hook
reminder. Both streams remain open at `INPUT_REQUIRED`, with an additional
two-second observation after confirmed compute release. A nonblocking follow-up
sets `endTask: true`, reuses only the original workspace/session, and completes
the task in a replacement Pod. The streams close at `COMPLETED`.

| Evidence | Result |
| --- | --- |
| Task | `53baf4ef-a247-4d71-8998-90bc6f8a8240` |
| Blocking retry | Returned `INPUT_REQUIRED` after 79.326 seconds, with artifacts and released-resource metadata. |
| Streaming send | Open for 109.951 seconds, 17:40:59.623 through 17:42:49.574 UTC. |
| Subscription | Open for 109.947 seconds; same atomic snapshot cursor and ordered updates. |
| Delivered state | Each stream received one task snapshot and eight updates, including both artifacts and the interrupted-to-working-to-completed transitions. |
| Durable identity | Exactly two queued executions; the blocking duplicate did not create a third. |
| Agyn instance | `747a12c8-25a8-4b8d-b33f-ecfaa69bd14a` |
| Native Codex session | `01a09bdb-ed8f-7ff2-b147-0e1951088d91`, unchanged between turns. |
| PVC | `pv-747a12c8-25a-6c385794-b48`, unchanged and retained Bound. |
| Pod replacement | `038c4230-1d0b-4a67-8a97-e9771d4931f5` to `d00beaa9-14a1-4c76-9f22-c9828fe9ef53`. |
| Compute bounds | Both Pods' main cgroups: 2 CPU and 2 GiB; all seven main/supporting container specifications matched the selected profile. |
| Cleanup | Both workloads STOPPED/removed; independent Pod checks found no remaining workload Pods or Services. Temporary policies were removed. |

Private evidence: `.state/agyn-reporting-live-Y3TMjp/evidence.json`, including
observed SDK events, the blocking receipt, durable task events, native session
snapshots and resource/network observations. The checker compares each stream's
suffix against the durable log, not just a final task or an agent assertion.

Deployment restoration was independently compared with
`.state/agyn-lifecycle-deploy-FUrvJF/before.json`: original deployment UIDs,
images, managed environment fields and readiness matched. The stock runner's
capabilities returned to `["docker"]`. This is a temporary trusted-local test,
not a permanent production upgrade or an adversarial sandbox acceptance.

The coordinated removal-confirmation stack passed the same scenario again on
2026-09-13, task `9e3c17ec-0bf5-4126-8d7c-9d4a5bfc5abf`. The blocking duplicate
returned after 79.403 seconds; the two streams stayed open for 118.315/118.312
seconds, including 2.001 seconds subscribed with released compute between turns.
Both delivered one snapshot and eight updates matching the durable suffix, then
closed at COMPLETED. The native session/PVC remained unchanged across different
Pod UIDs, and both workload records include explicit removal confirmation.
Evidence: `.state/agyn-reporting-live-lKkffR/evidence.json`. This is still
completed-turn recovery, not streaming through a controller crash.

Reproduce after the network and retention preflights using the current
resource/network/image environment in [AGYN-REMOVAL.md](AGYN-REMOVAL.md#native-lifecycle-regression):

```sh
node scripts/agyn-live-lifecycle.mjs streaming
```

The scenario uses only a newly created private fixture and the existing ChatGPT
subscription reference. It does not read/copy model credentials, delete PVCs,
change an existing user agent profile or enable paid API inference.

## Still Required

- A complete operation/validation/error conformance audit. Terminal follow-up
  rejection and other store conflicts still use service-specific JSON-RPC
  errors; their semantic mappings and detail shapes need review.
- Production ingress idle-timeout/TLS acceptance and sustained multi-owner load
  tests beyond the bounded local fan-out check. A closed connection alone is not
  task completion; clients must inspect the last task status or `GetTask`.
- Native `AUTH_REQUIRED` and `REJECTED` producer paths, second-agent acceptance,
  and streaming across a controller crash or an interrupted tool side effect.
  The live streaming run above covers completed-turn recovery, not those faults.
- Production TLS, hardening, physical fencing, storage/operations and the other
  independent gates in [PRODUCTION.md](PRODUCTION.md).
