// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { SendMessageConfiguration, SendMessageRequest, SubscribeToTaskRequest, TaskState, type StreamResponse, Task } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { DurableA2AHandler, CHECK_AUTH, PRINCIPAL, SIGNAL } from "./service/a2a.js";
import { serviceCard } from "./service/card.js";
import { DurableTaskStore, type Lease } from "./service/task-store.js";

const scope = { tenant: "org", subject: "alice", canReconcile: false };
const profile = "agent-one";
function message(taskId = "") {
  return SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), taskId,
    role: "ROLE_USER", parts: [{ text: "work" }] } });
}
function fixture(t: TestContext) {
  const store = new DurableTaskStore(":memory:");
  const abort = new AbortController();
  t.after(() => { abort.abort(); store.close(); });
  const context = new ServerCallContext({ user: { isAuthenticated: true, userName: scope.subject }, tenant: scope.tenant,
    state: new Map<string, unknown>([[PRINCIPAL, scope], [SIGNAL, abort.signal], [CHECK_AUTH, async () => {}]]) });
  const handler = new DurableA2AHandler(store, serviceCard("http://localhost"), profile, 5);
  const input = message();
  const submitted = store.submit(scope, input.message!, profile);
  const run = () => {
    const claim = store.claim("worker", 60_000, 1)!;
    assert(claim);
    if (!claim.execution.runtime) store.bind(claim.lease, { instanceId: "instance", threadId: "thread", profileId: profile });
    store.beginDispatch(claim.lease); store.dispatched(claim.lease, randomUUID());
    return claim.lease;
  };
  const outcome = (lease: Lease, value: "turn_done" | "task_completed" | "input_required" | "failed") => {
    store.report("instance", lease.executionId, { eventId: randomUUID(), kind: "outcome", outcome: value, message: value });
    store.releasing(lease);
  };
  const subscribe = () => handler.resubscribe(SubscribeToTaskRequest.fromJSON({ id: submitted.task.id }), context);
  return { store, abort, handler, context, input, submitted, run, outcome, subscribe };
}
async function pending(promise: Promise<unknown>) {
  let finished = false;
  void promise.then(() => { finished = true; }, () => { finished = true; });
  await delay(30);
  assert.equal(finished, false, "request must remain pending");
}
function initial(event: IteratorResult<StreamResponse>): Task {
  assert(!event.done && event.value.payload?.$case === "task");
  return event.value.payload.value;
}

for (const [outcome, expected] of [
  ["task_completed", TaskState.TASK_STATE_COMPLETED], ["failed", TaskState.TASK_STATE_FAILED],
  ["input_required", TaskState.TASK_STATE_INPUT_REQUIRED], ["turn_done", TaskState.TASK_STATE_INPUT_REQUIRED]
] as const) test(`blocking A2A: ${outcome} waits for resource release and includes durable artifacts`, { timeout: 5000 }, async t => {
  const f = fixture(t); const lease = f.run();
  f.store.report("instance", lease.executionId, { eventId: "artifact", kind: "artifact", artifactId: "file", name: "result.txt", text: "result" });
  const result = f.handler.sendMessage(f.input, f.context);
  f.outcome(lease, outcome);
  await pending(result);
  f.store.settle(lease, { stopped: true });
  const task = await result;
  assert.equal(task.status?.state, expected);
  assert.equal(task.metadata?.resourcesReleased, true);
  assert.deepEqual(task.artifacts, f.store.get(scope, f.submitted.task.id).artifacts);
  assert.equal(task.history.length, 2);
});

test("blocking A2A: predecessor interruption cannot finish a queued message; settled execution cannot return WORKING", { timeout: 5000 }, async t => {
  const f = fixture(t); const first = f.run();
  const follow = message(f.submitted.task.id);
  const second = f.store.submit(scope, follow.message!, profile);
  const following = f.handler.sendMessage(follow, f.context);
  await pending(following);
  f.outcome(first, "turn_done"); f.store.settle(first, { stopped: true });
  assert.equal(f.store.get(scope, f.submitted.task.id).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(f.store.execution(second.execution.id)?.phase, "queued");
  await pending(following);
  const next = f.run();
  const original = f.handler.sendMessage(f.input, f.context);
  await pending(original);
  f.outcome(next, "task_completed"); f.store.settle(next, { stopped: true });
  assert.equal((await following).status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal((await original).status?.state, TaskState.TASK_STATE_COMPLETED);
});

test("blocking A2A: canceling a queued message waits for the active runtime to stop", { timeout: 5000 }, async t => {
  const f = fixture(t); const lease = f.run();
  const follow = message(f.submitted.task.id);
  const queued = f.store.submit(scope, follow.message!, profile);
  const result = f.handler.sendMessage(follow, f.context);
  f.store.requestCancel(scope, f.submitted.task.id);
  assert.equal(f.store.execution(queued.execution.id)?.phase, "settled");
  await pending(result);
  f.store.releasing(lease); f.store.settle(lease, { stopped: true });
  assert.equal((await result).status?.state, TaskState.TASK_STATE_CANCELED);
});

test("blocking A2A: uncertainty returns INPUT_REQUIRED only after confirmed removal", { timeout: 5000 }, async t => {
  const f = fixture(t); const lease = f.run();
  const result = f.handler.sendMessage(f.input, f.context);
  f.store.markUncertain(lease, "connection lost during side effect");
  await pending(result);
  f.store.settle(lease, { stopped: true });
  const task = await result;
  assert.equal(task.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(task.metadata?.recoveryRequired, true);
  assert.equal(task.metadata?.automaticRetry, false);
});

test("blocking A2A: abort rejects without canceling work; an already aborted call submits nothing", { timeout: 5000 }, async t => {
  const f = fixture(t); f.run();
  const result = f.handler.sendMessage(f.input, f.context);
  await pending(result);
  f.abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(f.store.execution(f.submitted.execution.id)?.phase, "running");
  const before = f.store.snapshot(scope, f.submitted.task.id);
  await assert.rejects(f.handler.sendMessage(message(f.submitted.task.id), f.context), { name: "AbortError" });
  await assert.rejects(f.handler.sendMessageStream(message(f.submitted.task.id), f.context).next(), { name: "AbortError" });
  assert.deepEqual(f.store.snapshot(scope, f.submitted.task.id), before);
});

test("streaming A2A: atomic snapshot contains earlier artifacts; broadcasts span turns in durable order across batches", { timeout: 5000 }, async t => {
  const f = fixture(t); const lease = f.run();
  f.store.report("instance", lease.executionId, { eventId: "before", kind: "artifact", artifactId: "before", name: "before.txt", text: "before" });
  const streams = [f.subscribe(), f.subscribe(), f.handler.sendMessageStream(f.input, f.context)];
  const cut = f.store.snapshot(scope, f.submitted.task.id).sequence;
  for (const stream of streams) {
    const task = initial(await stream.next());
    assert.deepEqual(task.artifacts, f.store.get(scope, task.id).artifacts);
    assert.equal(task.history.length, 0);
  }
  // Both turns finish before readers drain: no snapshot of the future may overtake queued events.
  for (let n = 0; n < 65; n++) f.store.report("instance", lease.executionId, {
    eventId: `progress-${n}`, kind: "progress", message: `step ${n}`
  });
  f.outcome(lease, "turn_done"); f.store.settle(lease, { stopped: true });
  const follow = message(f.submitted.task.id); f.store.submit(scope, follow.message!, profile);
  const next = f.run();
  f.store.report("instance", next.executionId, { eventId: "after", kind: "artifact", artifactId: "after", name: "after.txt", text: "after" });
  f.outcome(next, "task_completed"); f.store.settle(next, { stopped: true });
  const expected = f.store.events(scope, f.submitted.task.id, cut, 1000)
    .filter(event => event.kind === "task.status" || event.kind === "agent.artifact");
  assert(f.store.events(scope, f.submitted.task.id, cut, 1000).length > 100);
  const received: StreamResponse[][] = [];
  for (const stream of streams) {
    const events: StreamResponse[] = [];
    for await (const event of stream) events.push(event);
    assert(events.every(event => event.payload?.$case !== "task"));
    assert.deepEqual(events.map(event => event.payload!.value.metadata?.eventSequence), expected.map(event => event.sequence));
    assert(events.some(event => event.payload?.$case === "statusUpdate" && event.payload.value.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED));
    const last = events.at(-1)!;
    assert(last.payload?.$case === "statusUpdate" && last.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED);
    received.push(events);
  }
  assert.deepEqual(received[0], received[1]); assert.deepEqual(received[1], received[2]);
});

test("streaming A2A: idle interrupted tasks stay subscribed; disconnect leaves sibling stream and task intact", { timeout: 5000 }, async t => {
  const f = fixture(t); const lease = f.run();
  f.outcome(lease, "input_required"); f.store.settle(lease, { stopped: true });
  const first = f.subscribe(); const second = f.subscribe();
  assert.equal(initial(await first.next()).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  await second.next(); await first.return(undefined);
  const waiting = second.next(); await pending(waiting);
  assert.equal(f.store.get(scope, f.submitted.task.id).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  f.store.requestCancel(scope, f.submitted.task.id);
  const event = await waiting;
  assert(!event.done && event.value.payload?.$case === "statusUpdate");
  assert.equal(event.value.payload.value.status?.state, TaskState.TASK_STATE_CANCELED);
  assert.equal((await second.next()).done, true);
});

test("streaming A2A: terminal subscription is unsupported, hidden tasks stay not-found, exact send retry stays idempotent", { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.store.requestCancel(scope, f.submitted.task.id);
  await assert.rejects(f.subscribe().next(), UnsupportedOperationError);
  f.context.state.set(PRINCIPAL, { ...scope, subject: "bob" });
  await assert.rejects(f.subscribe().next(), TaskNotFoundError);
  f.context.state.set(PRINCIPAL, scope);
  await assert.rejects(f.handler.resubscribe(SubscribeToTaskRequest.fromJSON({ id: "missing" }), f.context).next(), TaskNotFoundError);
  const retry = f.handler.sendMessageStream(f.input, f.context);
  assert.equal(initial(await retry.next()).status?.state, TaskState.TASK_STATE_CANCELED);
  assert.equal((await retry.next()).done, true);
  assert.equal(f.store.execution(f.submitted.execution.id)?.ordinal, 1);
});

test("streaming A2A: history limit applies to initial snapshot and auth is rechecked during backlog delivery", { timeout: 5000 }, async t => {
  const f = fixture(t); const lease = f.run();
  const stream = f.handler.sendMessageStream({ ...f.input, configuration: SendMessageConfiguration.fromJSON({ historyLength: 1 }) }, f.context);
  assert.equal(initial(await stream.next()).history.length, 1);
  for (let n = 0; n < 2; n++) f.store.report("instance", lease.executionId, { eventId: `p${n}`, kind: "progress", message: `p${n}` });
  assert.equal((await stream.next()).done, false);
  f.context.state.set(CHECK_AUTH, async () => { throw new Error("revoked"); });
  await assert.rejects(stream.next(), /revoked/);
  assert.equal(f.store.execution(lease.executionId)?.phase, "running");
  await assert.rejects(f.subscribe().next(), /revoked/);
});

test("streaming A2A: requested history is byte-bounded, keeps newest messages, and never mutates stored history", { timeout: 5000 }, async t => {
  const f = fixture(t);
  for (let n = 0; n < 20; n++) {
    const follow = message(f.submitted.task.id);
    follow.message!.parts[0].content = { $case: "text", value: "x".repeat(65_536) };
    f.store.submit(scope, follow.message!, profile);
  }
  const before = f.store.get(scope, f.submitted.task.id);
  assert(Buffer.byteLength(JSON.stringify(Task.toJSON(before))) > 1_048_576);
  const stream = f.handler.sendMessageStream({ ...f.input, configuration: SendMessageConfiguration.fromJSON({ historyLength: 100 }) }, f.context);
  const task = initial(await stream.next());
  assert(task.history.length > 0 && task.history.length < before.history.length);
  assert(Buffer.byteLength(JSON.stringify(Task.toJSON(task))) <= 1_048_576);
  assert.deepEqual(task.history, before.history.slice(-task.history.length));
  assert.deepEqual(f.store.get(scope, f.submitted.task.id).history, before.history);
  await stream.return(undefined);
});
