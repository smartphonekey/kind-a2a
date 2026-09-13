// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ListTasksRequest, Message, Role, TaskState } from "@a2a-js/sdk";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";
import { fileAuthorizer, tokenDigest } from "./service/auth.js";
import { DurableTaskStore } from "./service/task-store.js";

test("service HTTP: auth, tenant isolation, scoped list/replay/cancel, validation and revocation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-http-"));
  const path = join(dir, "credentials.json");
  const tokens = { alice: randomBytes(32).toString("base64url"), bob: randomBytes(32).toString("base64url") };
  const credentials = Object.entries(tokens).map(([subject, token]) => ({
    sha256: tokenDigest(token), subject, tenant: "org", expiresAt: "2099-01-01T00:00:00Z", canReconcile: subject === "alice"
  }));
  await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  const store = new DurableTaskStore(join(dir, "tasks.sqlite"));
  const abort = new AbortController();
  const server = createServer(createServiceApp({ store, card: serviceCard("http://localhost"), profileId: "agent-one",
    authorize: fileAuthorizer(path), signal: abort.signal, pollMs: 5 }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { abort.abort(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = (who?: keyof typeof tokens) => ({ "content-type": "application/json", "A2A-Version": "1.0", ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) });
  const rpc = async (method: string, params: unknown, who: keyof typeof tokens = "alice") => {
    const response = await fetch(`${base}/a2a`, { method: "POST", headers: headers(who), body: JSON.stringify({ jsonrpc: "2.0", id: "request", method, params }) });
    assert.equal(response.status, 200); return await response.json() as any;
  };
  const input = Message.toJSON(Message.fromJSON({ messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "run tests" }] }));
  const send = { message: input, configuration: { returnImmediately: true } };
  const card = await fetch(`${base}/.well-known/agent-card.json`).then(r => r.json()) as any;
  assert.equal(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, "Bearer");
  assert.equal((await fetch(`${base}/a2a`, { method: "POST", headers: headers(), body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/tasks/missing/events`, { headers: headers() })).status, 401);
  const first = await rpc("SendMessage", send);
  assert(first.result?.task?.id, JSON.stringify(first));
  const taskId = first.result.task.id as string;
  assert.equal((await rpc("SendMessage", send)).result.task.id, taskId);
  assert.notEqual((await rpc("SendMessage", send, "bob")).result.task.id, taskId);
  assert.equal((await rpc("GetTask", { id: taskId }, "bob")).error.code, -32001);
  assert.equal((await rpc("CancelTask", { id: taskId }, "bob")).error.code, -32001);
  assert.equal((await rpc("GetTask", { id: taskId, tenant: "different-org" })).error.code, -32001);
  assert.equal((await fetch(`${base}/tasks/${taskId}/events`, { headers: headers("bob") })).status, 404);
  assert.equal((await fetch(`${base}/a2a`, { method: "POST", headers: { ...headers("alice"), origin: "https://untrusted.example" }, body: "{}" })).status, 403);
  const listed = await rpc("ListTasks", {});
  assert.equal(listed.result.tasks.length, 1);
  assert.equal(listed.result.tasks[0].id, taskId);
  assert.equal((await rpc("GetTask", { id: taskId, historyLength: 0 })).result.history?.length ?? 0, 0);
  assert((await rpc("GetTask", { id: taskId, historyLength: -1 })).error);
  const page = await fetch(`${base}/tasks/${taskId}/events`, { headers: headers("alice") }).then(r => r.json()) as any;
  assert(page.events.length > 0);
  const replay = await fetch(`${base}/tasks/${taskId}/events?after=${page.nextCursor}`, { headers: headers("alice") }).then(r => r.json()) as any;
  assert.deepEqual(replay.events, []);
  assert.equal((await fetch(`${base}/tasks/${taskId}/events?after=no`, { headers: headers("alice") })).status, 400);
  assert.equal((await rpc("CancelTask", { id: taskId })).result.status.state, "TASK_STATE_CANCELED");
  await writeFile(path, JSON.stringify(credentials.filter(entry => entry.subject === "bob")), { mode: 0o600 });
  assert.equal((await fetch(`${base}/tasks/${taskId}/events`, { headers: headers("alice") })).status, 401);
});

test("task lists use owner-bound keyset cursors and bounded history; duplicate aliases stay reserved", t => {
  let clock = 1000;
  const store = new DurableTaskStore(":memory:", { clock: () => clock++ }); t.after(() => store.close());
  const scope = { tenant: "org", subject: "alice" };
  const first = Message.fromJSON({ messageId: "message-one", role: "ROLE_USER",
    parts: [{ text: "one" }], metadata: { idempotencyKey: "retry" } });
  const original = store.submit(scope, first, "one");
  store.submit(scope, { ...first, messageId: "message-two" }, "one");
  assert.throws(() => store.submit(scope, { ...first, messageId: "message-two", metadata: { idempotencyKey: "changed" } }, "one"));
  for (let n = 0; n < 4; n++) store.submit(scope, { ...first, messageId: `m-${n}`, metadata: {} }, "one");
  const query = ListTasksRequest.fromJSON({ pageSize: 2 });
  const page = store.list(scope, query);
  assert.equal(page.totalSize, 5); assert.equal(page.tasks.length, 2);
  assert.equal(page.tasks[0].history.length, 0);
  assert(page.nextPageToken);
  assert.throws(() => store.list({ ...scope, subject: "bob" }, { ...query, pageToken: page.nextPageToken }));
  const second = store.list(scope, { ...query, pageToken: page.nextPageToken });
  assert.equal(new Set([...page.tasks, ...second.tasks].map(task => task.id)).size, 4);
  store.requestCancel(scope, original.task.id);
  assert.equal(store.list(scope, { ...query, status: TaskState.TASK_STATE_CANCELED }).totalSize, 1);
  assert.throws(() => store.list(scope, { ...query, pageSize: 101 }));
});
