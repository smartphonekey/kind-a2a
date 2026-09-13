// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Message } from "@a2a-js/sdk";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";
import { DurableTaskStore } from "./service/task-store.js";

test("A2A stream: disconnect releases admission, reconnect sees durable state, credential revocation closes subscription", async t => {
  const store = new DurableTaskStore(":memory:"); const scope = { tenant: "org", subject: "alice", canReconcile: false };
  const submitted = store.submit(scope, Message.fromJSON({ messageId: "one", role: "ROLE_USER", parts: [{ text: "work" }] }), "original-profile");
  const claim = store.claim("worker", 10000, 1)!;
  store.bind(claim.lease, { instanceId: "instance", threadId: "thread", profileId: "original-profile" });
  store.beginDispatch(claim.lease); store.dispatched(claim.lease, "request");
  store.report("instance", claim.execution.id, { eventId: "artifact", kind: "artifact", artifactId: "progress-file", name: "tests.txt", text: "tests in progress" });
  assert.equal(store.get(scope, submitted.task.id).artifacts.length, 1, "artifacts are visible before the outcome");
  let valid = true;
  const shutdown = new AbortController();
  const server = createServer(createServiceApp({ store, card: serviceCard("http://localhost"), profileId: "changed-default",
    signal: shutdown.signal, authorize: async header => header === "Bearer token" && valid ? scope : undefined,
    pollMs: 5, waitMs: 1000, maxRequestsPerOwner: 1 }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { shutdown.abort(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); });
  const headers = { authorization: "Bearer token", "A2A-Version": "1.0", "content-type": "application/json" };
  const subscribe = () => fetch(`${base}/a2a`, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: "sub", method: "SubscribeToTask", params: { id: submitted.task.id } }) });
  const first = await subscribe(); assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  const reader = first.body!.getReader();
  const initial = await reader.read(); assert(new TextDecoder().decode(initial.value).includes(submitted.task.id));
  let snapshotFrames = new TextDecoder().decode(initial.value);
  while (!snapshotFrames.includes("artifactUpdate")) {
    const frame = await reader.read(); assert(!frame.done); snapshotFrames += new TextDecoder().decode(frame.value);
  }
  assert(snapshotFrames.includes("progress-file"), "snapshot must not lose pre-subscription artifacts");
  assert.equal((await fetch(`${base}/tasks/${submitted.task.id}/events`, { headers })).status, 429);
  await reader.cancel(); await delay(30);
  assert.equal((await fetch(`${base}/tasks/${submitted.task.id}/events`, { headers })).status, 200);
  const second = await subscribe(); const resumed = second.body!.getReader();
  assert.equal((await resumed.read()).done, false);
  valid = false;
  const deadline = Date.now() + 2000;
  let closed = false;
  while (Date.now() < deadline) { if ((await resumed.read()).done) { closed = true; break; } }
  assert(closed);
  assert.equal(store.execution(submitted.execution.id)?.phase, "running", "a client disconnect does not cancel durable work");
  valid = true; await delay(20);
  const follow = await fetch(`${base}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "follow", method: "SendMessage", params: {
    message: { messageId: "follow", role: "ROLE_USER", taskId: submitted.task.id, parts: [{ text: "more work" }] }, configuration: { returnImmediately: true }
  } }) }).then(r => r.json()) as any;
  assert.equal(follow.result?.task?.metadata?.profileId, "original-profile", JSON.stringify(follow));
});
