// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { Message } from "@a2a-js/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DurableTaskStore } from "./service/task-store.js";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";

function running(store: DurableTaskStore) {
  const task = store.submit({ tenant: "org", subject: "alice" }, Message.fromJSON({
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "work" }]
  }), "agent");
  const claimed = store.claim(randomUUID(), 10000, 10)!;
  store.bind(claimed.lease, { instanceId: `instance-${task.task.id}`, threadId: `thread-${task.task.id}`, profileId: "agent" });
  store.beginDispatch(claimed.lease); store.dispatched(claimed.lease, "request");
  return { task, claimed, instanceId: `instance-${task.task.id}` };
}

test("reporting HTTP: official MCP client, execution-only credentials, rotation and durable acknowledgements", async t => {
  const store = new DurableTaskStore(":memory:");
  const one = running(store); const two = running(store);
  const token = store.issueReportingCredential(one.task.execution.id, 60_000);
  const abort = new AbortController();
  const server = createServer(createServiceApp({ store, card: serviceCard("http://localhost"), profileId: "agent",
    authorize: async () => undefined, signal: abort.signal }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: "reporter-test", version: "1.0.0" });
  t.after(async () => { await client.close(); abort.abort(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/reporting/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const report = { eventId: "progress", message: "Testing", percent: 50 };
  const ack = z.object({ executionId: z.string(), sequence: z.number(), duplicate: z.boolean() });
  const receipt = await client.callTool({ name: "report_progress", arguments: report });
  assert.equal(ack.parse(receipt.structuredContent).executionId, one.task.execution.id);
  assert.equal(ack.parse(receipt.structuredContent).duplicate, false);
  assert.equal(ack.parse((await client.callTool({ name: "report_progress", arguments: report })).structuredContent).duplicate, true);
  const invalid = await client.callTool({ name: "report_outcome", arguments: { eventId: "done", outcome: "turn_done", message: "done", executionId: two.task.execution.id } });
  assert.equal(invalid.isError, true);
  const done = await client.callTool({ name: "report_outcome", arguments: { eventId: "done", outcome: "turn_done", message: "done" } });
  assert.equal(ack.parse(done.structuredContent).executionId, one.task.execution.id);
  assert.equal(store.execution(two.task.execution.id)?.outcome, null);
  assert.equal(store.execution(one.task.execution.id)?.phase, "running");
  assert.equal((await fetch(`${base}/a2a`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).status, 401);
  const replacement = store.issueReportingCredential(one.task.execution.id, 60_000);
  assert.equal((await fetch(`${base}/reporting/status`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await fetch(`${base}/reporting/status`, { headers: { authorization: `Bearer ${replacement}` } })).status, 200);
  store.releasing(one.claimed.lease);
  const stop = await fetch(`${base}/reporting/stop-check`, { method: "POST",
    headers: { authorization: `Bearer ${replacement}`, "content-type": "application/json" }, body: JSON.stringify({ checkId: "after-outcome" }) });
  assert.equal(stop.status, 200);
  const decision = await stop.json() as { decision: { action: string }; codex: unknown };
  assert.equal(decision.decision.action, "allow", "normal release poisoned the next native turn with a cancellation notice");
  assert.deepEqual(decision.codex, {});
});

test("stop checks: durable bounded reminders, retry identity, cancellation precedence and private expiring credentials", t => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-stop-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite"); let clock = Date.now();
  let store = new DurableTaskStore(path, { clock: () => clock });
  const one = running(store); const token = store.issueReportingCredential(one.task.execution.id, 100);
  const first = store.stopCheck(one.instanceId, one.task.execution.id, "stop-1");
  assert.equal(first.action, "remind");
  assert.deepEqual(store.stopCheck(one.instanceId, one.task.execution.id, "stop-1"), first);
  store.close(); store = new DurableTaskStore(path, { clock: () => clock }); t.after(() => store.close());
  assert.equal(store.authenticateReporter(token)?.executionId, one.task.execution.id);
  assert.equal(store.stopCheck(one.instanceId, one.task.execution.id, "stop-2").action, "remind");
  assert.equal(store.stopCheck(one.instanceId, one.task.execution.id, "stop-3").action, "stop");
  assert.equal(store.execution(one.task.execution.id)?.phase, "releasing");
  assert.equal(store.stopCheck(one.instanceId, one.task.execution.id, "stop-1").action, "stop");
  clock += 101; assert.equal(store.authenticateReporter(token), undefined);
  const two = running(store);
  store.stopCheck(two.instanceId, two.task.execution.id, "stop-1");
  store.requestCancel({ tenant: "org", subject: "alice" }, two.task.task.id);
  assert.equal(store.stopCheck(two.instanceId, two.task.execution.id, "stop-1").action, "stop");
});

test("stop hook executable: real subprocess, bounded reminders, missing credentials and outage stop safely", async t => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-hook-"));
  const store = new DurableTaskStore(":memory:"); const one = running(store);
  const token = store.issueReportingCredential(one.task.execution.id, 60000);
  const server = createServer(createServiceApp({ store, card: serviceCard("http://localhost"), profileId: "agent",
    authorize: async () => undefined, signal: new AbortController().signal }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const configPath = join(directory, "reporting.json");
  writeFileSync(configPath, JSON.stringify({ url: `http://127.0.0.1:${address.port}/reporting`, token, allowInsecureLocal: true }), { mode: 0o600 });
  const hook = (path = configPath, hookInput = { hook_event_name: "Stop", turn_id: "same-native-turn" }) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./reporting/stop-hook.js", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, REPORTING_CONFIG_FILE: path }, stdio: ["pipe", "pipe", "pipe"]
    });
    let output = ""; let errors = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
    child.once("error", reject); child.once("close", code => {
      try { assert.equal(code, 0); assert(!output.includes(token)); assert(!errors.includes(token)); resolve(JSON.parse(output)); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(hookInput));
  });
  assert.equal((await hook()).decision, "block");
  assert.equal((await hook()).decision, "block", "same native turn ID must not make reminders infinite");
  assert.equal((await hook()).continue, false);
  assert.equal(store.execution(one.task.execution.id)?.phase, "releasing");
  assert.equal((await hook(join(directory, "missing.json"))).continue, false);
  writeFileSync(configPath, JSON.stringify({ url: "http://127.0.0.1:1/reporting", token, allowInsecureLocal: true }), { mode: 0o600 });
  assert.equal((await hook()).continue, false);
});
