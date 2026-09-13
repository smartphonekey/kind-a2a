// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { SendMessageConfiguration, SendMessageRequest, SubscribeToTaskRequest, TaskState, Task, type StreamResponse } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";
import { DurableTaskStore, TaskStoreError } from "./service/task-store.js";

const scope = { tenant: "org", subject: "alice", canReconcile: false };
const headers = { authorization: "Bearer token", "A2A-Version": "1.0", "content-type": "application/json" };
const input = SendMessageRequest.fromJSON({ message: { messageId: "message", role: "ROLE_USER", parts: [{ text: "work" }] } });

async function fixture(t: TestContext, maxRequestsPerOwner = 16) {
  const store = new DurableTaskStore(":memory:");
  const shutdown = new AbortController();
  let auth: "valid" | "revoked" | "unavailable" = "valid";
  const card = serviceCard("http://localhost");
  const server = createServer(createServiceApp({ store, card, profileId: "profile", signal: shutdown.signal, pollMs: 5, maxRequestsPerOwner,
    authorize: async header => {
      if (auth === "unavailable") throw new Error("private authentication backend details");
      return header === headers.authorization && auth === "valid" ? scope : undefined;
    } }));
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  card.supportedInterfaces[0].url = `${base}/a2a`;
  t.after(async () => {
    shutdown.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  });
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: async (url, init) => {
    const authenticated = new Headers(init?.headers); authenticated.set("authorization", headers.authorization);
    return fetch(url, { ...init, headers: authenticated });
  } })] });
  const client = await factory.createFromUrl(base);
  const send = (signal?: AbortSignal) => fetch(`${base}/a2a`, { method: "POST", headers, signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: "blocking", method: "SendMessage", params: SendMessageRequest.toJSON(input) }) });
  return { store, shutdown, base, client, send, setAuth: (value: typeof auth) => { auth = value; } };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!await predicate()) { assert(Date.now() < deadline, "condition did not become true"); await delay(10); }
}
function track<T>(promise: Promise<T>) {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return { promise, get done() { return done; } };
}

test("official A2A client: blocking send and both streams remain live past 30 seconds, then deliver completion", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const options = { signal: AbortSignal.timeout(50_000) };
  const accepted = await f.client.sendMessage({ ...input, configuration: SendMessageConfiguration.fromJSON({ returnImmediately: true }) }, options);
  assert("id" in accepted);
  const taskId = accepted.id;
  const streams = [
    f.client.sendMessageStream({ ...input, configuration: SendMessageConfiguration.fromJSON({ returnImmediately: true }) }, options),
    f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: taskId }), options)
  ];
  for (const stream of streams) {
    const event = await stream.next(); assert(!event.done && event.value.payload?.$case === "task");
    assert.equal(event.value.payload.value.id, taskId);
  }
  const claim = f.store.claim("worker", 60_000, 1)!;
  f.store.bind(claim.lease, { instanceId: "instance", threadId: "thread", profileId: "profile" });
  f.store.beginDispatch(claim.lease); f.store.dispatched(claim.lease, "request");
  for (const stream of streams) {
    const event = await stream.next(); assert(!event.done && event.value.payload?.$case === "statusUpdate");
    assert.equal(event.value.payload.value.status?.state, TaskState.TASK_STATE_WORKING);
  }
  const blocking = track(f.client.sendMessage(input, options));
  const waiting = streams.map(stream => track(stream.next()));
  await delay(31_250);
  assert.equal(blocking.done, false, "blocking send must not silently return WORKING at 30 seconds");
  for (const next of waiting) assert.equal(next.done, false, "live stream must not silently end at 30 seconds");
  assert.equal(f.store.execution(claim.execution.id)?.phase, "running");
  f.store.report("instance", claim.execution.id, { eventId: "artifact", kind: "artifact", artifactId: "result", name: "result.txt", text: "done" });
  f.store.report("instance", claim.execution.id, { eventId: "outcome", kind: "outcome", outcome: "task_completed", message: "done" });
  f.store.releasing(claim.lease); f.store.settle(claim.lease, { stopped: true });
  const completed = await blocking.promise; assert("id" in completed);
  assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts.length, 1);
  const received: StreamResponse[][] = [];
  for (let i = 0; i < streams.length; i++) {
    const first = await waiting[i].promise;
    assert(!first.done && first.value.payload?.$case === "artifactUpdate");
    const events = [first.value];
    for await (const event of streams[i]) events.push(event);
    assert.equal(events.length, 2);
    const last = events.at(-1)!;
    assert(last.payload?.$case === "statusUpdate" && last.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED);
    received.push(events);
  }
  assert.deepEqual(received[0], received[1]);
  await assert.rejects(f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: taskId }), options).next(), UnsupportedOperationError);
  await assert.rejects(f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: "missing" }), options).next(), TaskNotFoundError);
});

for (const reason of ["revoked", "unavailable", "shutdown"] as const) test(`blocking HTTP: ${reason} fails the wait without a success result or task cancellation`, { timeout: 5000 }, async t => {
  const f = await fixture(t, 1);
  const submitted = f.store.submit(scope, input.message!, "profile");
  const response = f.send(AbortSignal.timeout(4000));
  await until(async () => (await fetch(`${f.base}/tasks/${submitted.task.id}/events`, { headers })).status === 429);
  if (reason === "shutdown") f.shutdown.abort(); else f.setAuth(reason);
  const result = await response;
  assert.equal(result.status, reason === "revoked" ? 401 : 503);
  if (reason === "revoked") assert.equal(result.headers.get("www-authenticate"), "Bearer");
  const text = await result.text();
  assert(!text.includes("result") && !text.includes("private authentication backend details"));
  assert.equal(f.store.execution(submitted.execution.id)?.phase, "queued");
  assert.equal(f.store.get(scope, submitted.task.id).status?.state, TaskState.TASK_STATE_SUBMITTED);
});

test("blocking HTTP: disconnect releases admission; retry resumes the same accepted execution", { timeout: 5000 }, async t => {
  const f = await fixture(t, 1);
  const submitted = f.store.submit(scope, input.message!, "profile");
  const abort = new AbortController();
  const response = f.send(abort.signal);
  await until(async () => (await fetch(`${f.base}/tasks/${submitted.task.id}/events`, { headers })).status === 429);
  abort.abort(); await assert.rejects(response, { name: "AbortError" });
  await until(async () => (await fetch(`${f.base}/tasks/${submitted.task.id}/events`, { headers })).status === 200);
  const retry = await f.client.sendMessage({ ...input, configuration: SendMessageConfiguration.fromJSON({ returnImmediately: true }) });
  assert("id" in retry); assert.equal(retry.id, submitted.task.id);
  assert.equal(f.store.events(scope, submitted.task.id).filter(event => event.kind === "execution.queued").length, 1);
  assert.equal(f.store.execution(submitted.execution.id)?.phase, "queued");
});

test("official A2A client: near-capacity artifacts replay in bounded frames without fake event sequence numbers", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const submitted = f.store.submit(scope, input.message!, "profile");
  const claim = f.store.claim("worker", 60_000, 1)!;
  f.store.bind(claim.lease, { instanceId: "instance", threadId: "thread", profileId: "profile" });
  f.store.beginDispatch(claim.lease); f.store.dispatched(claim.lease, "request");
  let bytes = 0;
  for (let n = 0; ; n++) {
    const report = { kind: "artifact", eventId: String(n), artifactId: String(n), name: "a".repeat(256),
      text: "x".repeat(Math.max(0, Math.min(65_536, 4_194_304 - bytes - 450))) };
    try { f.store.report("instance", claim.execution.id, report); bytes += Buffer.byteLength(JSON.stringify(report)); }
    catch (error) { assert(error instanceof TaskStoreError && error.code === "capacity"); break; }
  }
  const snapshot = f.store.snapshot(scope, submitted.task.id);
  assert(Buffer.byteLength(JSON.stringify(Task.toJSON(snapshot.task))) > 4_194_304, "fixture exceeds the SDK default frame limit");
  const stream = f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: submitted.task.id }), { signal: AbortSignal.timeout(8000) });
  const first = await stream.next(); assert(!first.done && first.value.payload?.$case === "task");
  assert.equal(first.value.payload.value.artifacts.length, 0);
  const artifacts = [];
  for (let n = 0; n < snapshot.task.artifacts.length; n++) {
    const event = await stream.next(); assert(!event.done && event.value.payload?.$case === "artifactUpdate");
    assert.equal(event.value.payload.value.metadata?.eventSequence, undefined);
    assert.equal(event.value.payload.value.metadata?.snapshotSequence, snapshot.sequence);
    artifacts.push(event.value.payload.value.artifact);
  }
  assert.deepEqual(artifacts, snapshot.task.artifacts);
  f.store.requestCancel(scope, submitted.task.id); f.store.releasing(claim.lease); f.store.settle(claim.lease, { stopped: true });
  const states = [];
  for await (const event of stream) {
    assert(event.payload?.$case === "statusUpdate");
    assert(Number(event.payload.value.metadata?.eventSequence) > snapshot.sequence);
    states.push(event.payload.value.status?.state);
  }
  assert.deepEqual(states, [TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_CANCELED]);
});
