// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Message } from "@a2a-js/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "smol-toml";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { managedReportingConfig } from "./reporting/runtime.js";
import { DurableTaskStore } from "./service/task-store.js";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";
import { deliverBinding } from "./service/agyn-terminal.js";

test("managed runtime config preserves tracing and existing tools without exposing credentials", () => {
  const source = '[mcp_servers.existing]\ncommand="existing"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype="command"\ncommand="agynd-trace-hook"\n';
  const configured = managedReportingConfig(source, "/run/agyn-execution", "/usr/bin/node");
  const result = parse(configured) as any;
  assert.equal(result.mcp_servers.existing.command, "existing");
  assert.equal(result.mcp_servers.execution_reporting.required, true);
  assert.equal(result.hooks.Stop.length, 2);
  assert.equal(result.hooks.Stop[0].hooks[0].command, "agynd-trace-hook");
  assert(result.hooks.Stop[1].hooks[0].command.includes(" stop "));
  assert(!configured.includes("token"));
  assert.throws(() => managedReportingConfig(configured, "/run/agyn-execution", "/usr/bin/node"), /already configured/);
  assert.throws(() => managedReportingConfig(source, "/run/directory;command", "/usr/bin/node"), /unsafe/);
});

test("bundled stdio MCP relays to real authenticated HTTP and reloads rotated credentials", async t => {
  const directory = mkdtempSync(join(tmpdir(), "reporting-runtime-"));
  const store = new DurableTaskStore(":memory:");
  const scope = { tenant: "org", subject: "test" };
  const submitted = store.submit(scope, Message.fromJSON({ messageId: "one", role: "ROLE_USER", parts: [{ text: "work" }] }), "agent");
  const lease = store.claim("worker", 10_000, 1)!.lease;
  store.bind(lease, { instanceId: "instance", threadId: "thread", profileId: "agent" }); store.beginDispatch(lease);
  const server = createServer(createServiceApp({ store, card: serviceCard("http://localhost"), profileId: "agent",
    signal: new AbortController().signal, authorize: async () => undefined }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/reporting`;
  const writeBinding = () => writeFileSync(join(directory, "binding.json"), JSON.stringify({ url,
    token: store.issueReportingCredential(submitted.execution.id, 60_000), allowInsecureLocal: true }), { mode: 0o600 });
  writeBinding();
  const client = new Client({ name: "runtime-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [new URL("./reporting/runtime.mjs", import.meta.url).pathname, "mcp", directory], stderr: "pipe" });
  let errors = ""; transport.stderr?.on("data", chunk => { errors += chunk; });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 4);
  const report = { name: "report_progress", arguments: { eventId: "progress", message: "working" } };
  assert.equal((await client.callTool(report)).isError, undefined, errors);
  writeBinding();
  assert.equal(z.object({ duplicate: z.boolean() }).parse((await client.callTool(report)).structuredContent).duplicate, true);
  assert.equal((await client.callTool({ name: "report_outcome", arguments: { eventId: "done", outcome: "turn_done", message: "Done" } })).isError, undefined);
  assert.equal(store.execution(submitted.execution.id)!.outcome?.outcome, "turn_done");
  assert(!errors.includes("Bearer"));
});

test("Agyn terminal delivery waits for verified raw-mode readiness and requires an exact ACK plus successful exit", async t => {
  const http = createServer(); const server = new WebSocketServer({ server: http });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); assert(address && typeof address !== "string");
  t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => http.close(() => r())); });
  const expected = { executionId: "execution", instanceId: "instance", workloadId: "workload", runtimeSha256: "hash" };
  for (const scenario of ["ok", "wrong-instance", "no-ack", "nonzero", "closed"] as const) {
    let credentialSent = false;
    server.once("connection", socket => {
      socket.once("message", (data, binary) => {
        assert.equal(binary, false); assert.equal(JSON.parse(data.toString()).type, "resize");
        socket.send(Buffer.from(JSON.stringify({ ready: true, instanceId: scenario === "wrong-instance" ? "other" : expected.instanceId,
          workloadId: expected.workloadId, runtimeSha256: expected.runtimeSha256 }) + "\n"));
        socket.once("message", data => {
          credentialSent = true; assert.equal(data.toString(), "private-binding\n");
          if (scenario !== "no-ack") socket.send(Buffer.from(JSON.stringify({ executionId: expected.executionId, instanceId: expected.instanceId, reportingConfigured: true }) + "\n"));
          if (scenario === "closed") socket.close();
          else socket.send(JSON.stringify({ type: "exit", reason: "completed", ...(scenario === "nonzero" ? { code: 1 } : {}) }));
        });
      });
    });
    const delivery = deliverBinding({ websocketUrl: `ws://127.0.0.1:${address.port}`, ticket: "one-time" }, expected,
      "private-binding", AbortSignal.timeout(2000), true);
    if (scenario === "ok") await delivery;
    else await assert.rejects(delivery, /delivery failed/);
    assert.equal(credentialSent, scenario !== "wrong-instance");
  }
});
