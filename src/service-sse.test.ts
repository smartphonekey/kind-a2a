// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { Message, SubscribeToTaskRequest, TaskState, type StreamResponse } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";
import { DurableTaskStore, type Scope } from "./service/task-store.js";

const scope = { tenant: "org", subject: "alice", canReconcile: false };
const headers = { authorization: "Bearer token", "A2A-Version": "1.0", "content-type": "application/json" };
const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: async (url, init) => {
  const authenticated = new Headers(init?.headers); authenticated.set("authorization", headers.authorization);
  return fetch(url, { ...init, headers: authenticated });
} })] });

async function fixture(t: TestContext, heartbeatMs = 20, maxRequestsPerOwner = 16) {
  const store = new DurableTaskStore(":memory:");
  const abort = new AbortController();
  const submitted = store.submit(scope, Message.fromJSON({ messageId: "one", role: "ROLE_USER", parts: [{ text: "work" }] }), "profile");
  const server = createServer(createServiceApp({ store, card: serviceCard("http://localhost"), profileId: "profile", signal: abort.signal,
    authorize: async value => value === headers.authorization ? scope : undefined,
    pollMs: 5, sse: { heartbeatMs, drainTimeoutMs: 250 }, maxRequestsPerOwner }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const client = await factory.createFromAgentCard(serviceCard(base));
  t.after(async () => { abort.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  return { store, server, base, client, submitted, address };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2500;
  while (!await predicate()) { assert(Date.now() < deadline, "condition did not become true"); await delay(5); }
}

for (const heartbeat of [true, false]) test(`SSE proxy: ${heartbeat ? "heartbeats preserve idle subscription" : "control without timely heartbeats times out"}`, { timeout: 5000 }, async t => {
  const f = await fixture(t, heartbeat ? 20 : 2000);
  let timeouts = 0;
  const chunks: Buffer[] = [];
  const proxy = createServer((incoming, outgoing) => {
    const upstream = request(`${f.base}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, source => {
      outgoing.writeHead(source.statusCode!, source.headers); outgoing.flushHeaders();
      source.setTimeout(200, () => { timeouts++; outgoing.destroy(); source.destroy(); });
      source.on("data", chunk => chunks.push(Buffer.from(chunk)));
      source.on("error", () => outgoing.destroy()); source.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.destroy());
    outgoing.once("close", () => upstream.destroy()); incoming.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  const address = proxy.address(); assert(address && typeof address !== "string");
  const client = await factory.createFromAgentCard(serviceCard(`http://127.0.0.1:${address.port}`));
  const stream = client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: f.submitted.task.id }), { signal: AbortSignal.timeout(3000) });
  const first = await stream.next(); assert(!first.done && first.value.payload?.$case === "task");
  const next = stream.next();
  if (!heartbeat) {
    await assert.rejects(next);
    assert.equal(timeouts, 1);
  } else {
    let done = false; void next.then(() => { done = true; }, () => { done = true; });
    await delay(650);
    assert.equal(timeouts, 0); assert.equal(done, false, "SDK ignores heartbeat comments as task events");
    assert((Buffer.concat(chunks).toString().match(/: keep-alive/g)?.length ?? 0) >= 3);
    f.store.requestCancel(scope, f.submitted.task.id);
    const event = await next; assert(!event.done && event.value.payload?.$case === "statusUpdate");
    assert.equal(event.value.payload.value.status?.state, TaskState.TASK_STATE_CANCELED);
    assert.equal((await stream.next()).done, true);
  }
  assert.equal(f.store.execution(f.submitted.execution.id)?.phase, heartbeat ? "settled" : "queued");
});

test("SSE failure: official client receives a sanitized error envelope without a false task outcome", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const stream = f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: f.submitted.task.id }), { signal: AbortSignal.timeout(3000) });
  assert.equal((await stream.next()).done, false);
  t.mock.method(f.store, "events", () => { throw new Error("private database path and credentials"); });
  await assert.rejects(stream.next(), error => {
    assert(error instanceof Error);
    assert(error.message.includes("Internal service error") && !error.message.includes("private"));
    return true;
  });
  assert.equal(f.store.get(scope, f.submitted.task.id).status?.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(f.store.execution(f.submitted.execution.id)?.phase, "queued");
});

test("SSE slow reader: real socket backpressure closes admission promptly with bounded response buffering", { timeout: 5000 }, async t => {
  const f = await fixture(t, 20, 1);
  let response: ServerResponse | undefined;
  let closed = false; let peakBuffer = 0; let batches = 0;
  f.server.on("request", (req, res) => { if (req.url === "/a2a") { response = res; res.once("close", () => { closed = true; }); } });
  const events = t.mock.method(f.store, "events", (_scope: Scope, taskId: string, cursor = 0, limit = 100) => {
    batches++;
    return Array.from({ length: limit }, (_, n) => ({ sequence: cursor + n + 1, taskId, executionId: null,
      kind: "task.status", at: new Date().toISOString(), payload: { status: { ...f.submitted.task.status,
        state: TaskState.TASK_STATE_WORKING, message: Message.fromJSON({ messageId: String(cursor + n), role: "ROLE_AGENT",
          parts: [{ text: "x".repeat(16_384) }] }) }, metadata: {} } }));
  });
  const socket = createConnection({ host: "127.0.0.1", port: f.address.port });
  socket.on("error", () => {}); socket.pause();
  const sample = setInterval(() => { peakBuffer = Math.max(peakBuffer, response?.writableLength ?? 0); }, 2);
  t.after(() => { clearInterval(sample); socket.destroy(); });
  await once(socket, "connect");
  const body = JSON.stringify({ jsonrpc: "2.0", id: "slow", method: "SubscribeToTask", params: { id: f.submitted.task.id } });
  socket.write(`POST /a2a HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nA2A-Version: 1.0\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  await until(() => Boolean(response?.writableNeedDrain));
  assert.equal((await fetch(`${f.base}/tasks/${f.submitted.task.id}/events`, { headers })).status, 429);
  await until(() => closed);
  assert(peakBuffer > 0 && peakBuffer < 100_000, `unexpected write buffer ${peakBuffer}`);
  assert(batches > 0 && batches < 100, `unbounded event prefetch: ${batches} batches`);
  events.mock.restore();
  assert.equal((await fetch(`${f.base}/tasks/${f.submitted.task.id}/events`, { headers })).status, 200);
  assert.equal(f.store.execution(f.submitted.execution.id)?.phase, "queued");
});

test("SSE fanout: eight HTTP readers receive ordered durable updates; one disconnect does not affect the others", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const claim = f.store.claim("worker", 60_000, 1)!;
  f.store.bind(claim.lease, { instanceId: "instance", threadId: "thread", profileId: "profile" });
  f.store.beginDispatch(claim.lease); f.store.dispatched(claim.lease, "request");
  const aborts = Array.from({ length: 8 }, () => new AbortController());
  t.after(() => { for (const abort of aborts) abort.abort(); });
  const streams = aborts.map(abort => f.client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: f.submitted.task.id }), { signal: abort.signal }));
  for (const stream of streams) assert.equal((await stream.next()).done, false);
  const cut = f.store.snapshot(scope, f.submitted.task.id).sequence;
  aborts[0].abort(); await streams[0].return(undefined);
  const reading = streams.slice(1).map(async stream => {
    const events: StreamResponse[] = [];
    for await (const event of stream) events.push(event);
    return events;
  });
  for (let n = 0; n < 50; n++) f.store.report("instance", claim.execution.id, { eventId: `p-${n}`, kind: "progress", message: `step ${n}` });
  f.store.report("instance", claim.execution.id, { eventId: "done", kind: "outcome", outcome: "task_completed", message: "done" });
  f.store.releasing(claim.lease); f.store.settle(claim.lease, { stopped: true });
  const received = await Promise.all(reading);
  const expected = f.store.events(scope, f.submitted.task.id, cut, 1000).filter(event => event.kind === "task.status").map(event => event.sequence);
  assert.equal(expected.length, 51);
  for (const events of received) {
    assert.deepEqual(events, received[0]);
    assert.deepEqual(events.map(event => event.payload?.value.metadata?.eventSequence), expected);
    const last = events.at(-1)!; assert(last.payload?.$case === "statusUpdate" && last.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED);
  }
});
