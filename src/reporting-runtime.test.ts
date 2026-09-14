// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Message } from "@a2a-js/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "smol-toml";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { installRuntime, managedReportingConfig } from "./reporting/runtime.js";
import { DurableTaskStore } from "./service/task-store.js";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";
import { deliverBinding, reportingTargetReady, ReportingDeliveryError } from "./service/agyn-terminal.js";
import type { AgynWorkload } from "./agyn-client.js";

test("Agyn installer does not hide unconfirmed failed/stopped workloads behind billing end", async t => {
  const setup = { executionId: randomUUID(), instanceId: randomUUID(), threadId: randomUUID(), requestId: randomUUID(),
    retiredRequestIds: [], profileId: "test", reporting: { url: "https://reporting.invalid", token: "A".repeat(43) } };
  let workloads: AgynWorkload[] = [];
  let terminalRequests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      const method = request.url?.split("/").at(-1);
      if (method === "GetInstance") response.end(JSON.stringify({ instance: { meta: { id: setup.instanceId }, state: "AGENT_INSTANCE_STATE_ACTIVE" } }));
      else if (method === "ListWorkloadsByAgentInstance") response.end(JSON.stringify({ workloads }));
      else if (method === "CreateTerminalSession") {
        terminalRequests.push(JSON.parse(body).workloadId);
        // Only selection is under test; no remote terminal or credential delivery.
        response.writeHead(503).end("{}");
      } else response.writeHead(404).end("{}");
    });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  for (const scenario of [
    { name: "failed alone", status: "WORKLOAD_STATUS_FAILED", confirmed: false, replacement: false },
    { name: "unconfirmed failed replacement", status: "WORKLOAD_STATUS_FAILED", confirmed: false, replacement: true },
    { name: "unconfirmed stopped replacement", status: "WORKLOAD_STATUS_STOPPED", confirmed: false, replacement: true },
    { name: "confirmed failed predecessor", status: "WORKLOAD_STATUS_FAILED", confirmed: true, replacement: true },
    { name: "confirmed stopped predecessor", status: "WORKLOAD_STATUS_STOPPED", confirmed: true, replacement: true }
  ]) {
    const replacementId = randomUUID();
    workloads = [{ meta: { id: randomUUID() }, agentInstanceId: setup.instanceId, status: scenario.status,
      removedAt: new Date().toISOString(), ...(scenario.confirmed ? { removalConfirmedAt: new Date().toISOString() } : {}) }];
    if (scenario.replacement) workloads.push({ meta: { id: replacementId }, agentInstanceId: setup.instanceId, status: "WORKLOAD_STATUS_RUNNING",
      containers: [{ name: "agent", role: "CONTAINER_ROLE_MAIN", status: "CONTAINER_STATUS_RUNNING" }] });
    terminalRequests = [];
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [new URL("./service/agyn-reporting-installer.js", import.meta.url).pathname], {
      env: { ...process.env, AGYN_GATEWAY_URL: `http://127.0.0.1:${address.port}`, AGYN_TOKEN: "test-gateway",
        AGYN_ORGANIZATION_ID: randomUUID(), AGYN_IDENTITY_ID: randomUUID() }, timeout: 5000, killSignal: "SIGKILL"
    });
    const exited = once(child, "close");
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    child.stdin.end(JSON.stringify(setup));
    const [code, terminationSignal] = await exited;
    assert.equal(terminationSignal, null, `${scenario.name}: installer did not fail promptly`);
    assert.equal(code, 1, scenario.name);
    assert.deepEqual(JSON.parse(output), scenario.confirmed ? {
      reportingSetupFailed: true, stage: "ticket", httpStatus: 503, rpcCode: "unknown"
    } : { reportingSetupFailed: true, stage: "runtime" }, scenario.name);
    assert(!output.includes(setup.reporting.token) && !output.includes("test-gateway"), "failure output exposed credentials");
    assert.equal(errors, "Agyn execution reporting setup failed\n", scenario.name);
    assert.deepEqual(terminalRequests, scenario.confirmed ? [replacementId] : [], scenario.name);
  }
});

test("terminal readiness requires a published running main container", () => {
  const workload: AgynWorkload = { meta: { id: "workload" }, status: "WORKLOAD_STATUS_RUNNING" };
  assert.equal(reportingTargetReady(workload), false);
  for (const containers of [[], [{ name: "sidecar", role: "CONTAINER_ROLE_SIDECAR", status: "CONTAINER_STATUS_RUNNING" }],
    [{ name: "agent", role: "CONTAINER_ROLE_MAIN" }], [{ name: "agent", role: "CONTAINER_ROLE_MAIN", status: "CONTAINER_STATUS_WAITING" }]]) {
    assert.equal(reportingTargetReady({ ...workload, containers }), false);
  }
  for (const name of ["main", "agent-instance"]) {
    assert.equal(reportingTargetReady({ ...workload, containers: [{ name, role: "CONTAINER_ROLE_MAIN", status: "CONTAINER_STATUS_RUNNING" }] }), true);
  }
});

test("terminal readiness rejects ambiguous aliases, duplicate names and terminated main containers", () => {
  const main = { name: "agent", role: "CONTAINER_ROLE_MAIN", status: "CONTAINER_STATUS_RUNNING" };
  for (const containers of [[main, { ...main, name: "other" }], [main, { ...main, role: "CONTAINER_ROLE_SIDECAR" }],
    [main, { name: "main", role: "CONTAINER_ROLE_SIDECAR" }], [{ ...main, status: "CONTAINER_STATUS_TERMINATED" }]]) {
    assert.throws(() => reportingTargetReady({ meta: { id: "workload" }, status: "WORKLOAD_STATUS_RUNNING", containers }));
  }
});

test("Agyn installer observes delayed container inventory before its only terminal attempt", async t => {
  const setup = { executionId: randomUUID(), instanceId: randomUUID(), threadId: randomUUID(), requestId: randomUUID(),
    retiredRequestIds: [], profileId: "test", reporting: { url: "https://reporting.invalid", token: "A".repeat(43) } };
  const workloadId = randomUUID();
  let reads = 0, terminalAttempts = 0, readsAtTerminal = 0;
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    const method = request.url?.split("/").at(-1);
    if (method === "GetInstance") response.end(JSON.stringify({ instance: { meta: { id: setup.instanceId }, state: "AGENT_INSTANCE_STATE_ACTIVE" } }));
    else if (method === "ListWorkloadsByAgentInstance") {
      reads++;
      response.end(JSON.stringify({ workloads: [{ meta: { id: workloadId }, agentInstanceId: setup.instanceId, status: "WORKLOAD_STATUS_RUNNING",
        ...(reads > 1 ? { containers: reads === 2 ? [] : [{ name: "agent", role: "CONTAINER_ROLE_MAIN",
          status: reads === 3 ? "CONTAINER_STATUS_WAITING" : "CONTAINER_STATUS_RUNNING" }] } : {}) }] }));
    } else if (method === "CreateTerminalSession") {
      terminalAttempts++; readsAtTerminal = reads;
      response.writeHead(503).end("{}");
    } else response.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const child = spawn(process.execPath, [new URL("./service/agyn-reporting-installer.js", import.meta.url).pathname], {
    env: { ...process.env, AGYN_GATEWAY_URL: `http://127.0.0.1:${address.port}`, AGYN_TOKEN: "test-gateway",
      AGYN_ORGANIZATION_ID: randomUUID(), AGYN_IDENTITY_ID: randomUUID() }, timeout: 8000, killSignal: "SIGKILL"
  });
  const exited = once(child, "close");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  child.stdin.end(JSON.stringify(setup));
  assert.deepEqual(await exited, [1, null]);
  assert.equal(readsAtTerminal, 4); assert.equal(terminalAttempts, 1);
  assert.deepEqual(JSON.parse(output), { reportingSetupFailed: true, stage: "ticket", httpStatus: 503, rpcCode: "unknown" });
});

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

test("runtime installation requires an exact inbox control binding and a still-dispatching execution", async t => {
  const directory = mkdtempSync(join(tmpdir(), "reporting-install-"));
  const store = new DurableTaskStore(":memory:");
  const scope = { tenant: "org", subject: "test" };
  const submitted = store.submit(scope, Message.fromJSON({ messageId: "one", role: "ROLE_USER", parts: [{ text: "work" }] }), "agent");
  const lease = store.claim("worker", 10_000, 1)!.lease;
  const instanceId = randomUUID();
  store.bind(lease, { instanceId, threadId: randomUUID(), profileId: "agent" }); store.beginDispatch(lease);
  const server = createServer(createServiceApp({ store, card: serviceCard("http://localhost"), profileId: "agent",
    signal: new AbortController().signal, authorize: async () => undefined }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const environment = { AGENT_INSTANCE_ID: instanceId, AGYN_INBOX_JOURNAL_DIR: "/workspace/.agyn/inbox-journal",
    AGYN_INBOX_CONTROL_FILE: join(directory, "inbox-control.json") };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, "binding.json"), JSON.stringify({ url: `http://127.0.0.1:${address.port}/reporting`,
    token: store.issueReportingCredential(submitted.execution.id, 60_000), allowInsecureLocal: true }), { mode: 0o600 });
  writeFileSync(join(directory, "expected.json"), JSON.stringify({ executionId: submitted.execution.id, instanceId }), { mode: 0o600 });
  const configFile = join(directory, "config.toml");
  writeFileSync(configFile, 'model="test"\n');
  await assert.rejects(installRuntime(directory, configFile));
  assert(!existsSync(join(directory, "configured.json")));
  const control = { version: 1, instance_id: instanceId, allowed_message_id: randomUUID(), ack_only_message_ids: [randomUUID()] };
  writeFileSync(environment.AGYN_INBOX_CONTROL_FILE, JSON.stringify({ ...control, ack_only_message_ids: [control.allowed_message_id] }), { mode: 0o600 });
  await assert.rejects(installRuntime(directory, configFile), /replay guard/);
  assert.equal(readFileSync(configFile, "utf8"), 'model="test"\n');
  writeFileSync(environment.AGYN_INBOX_CONTROL_FILE, JSON.stringify(control));
  delete process.env.AGYN_INBOX_JOURNAL_DIR;
  await assert.rejects(installRuntime(directory, configFile), /replay guard/);
  process.env.AGYN_INBOX_JOURNAL_DIR = environment.AGYN_INBOX_JOURNAL_DIR;
  await installRuntime(directory, configFile);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "configured.json"), "utf8")), { executionId: submitted.execution.id, instanceId, reportingConfigured: true });
  store.dispatched(lease, control.allowed_message_id);
  await assert.rejects(installRuntime(directory, configFile), /not eligible/);
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
    else await assert.rejects(delivery, error => {
      assert(error instanceof ReportingDeliveryError);
      assert.equal(error.diagnostic.deliveryReason, scenario === "wrong-instance" ? "protocol" : scenario === "closed" ? "closed" : "remote_exit");
      assert.equal(error.diagnostic.receiverReady, scenario !== "wrong-instance");
      assert.equal(error.diagnostic.payloadAttempted, scenario !== "wrong-instance");
      assert.equal(error.diagnostic.acknowledged, scenario === "closed" || scenario === "nonzero");
      assert(!JSON.stringify(error.diagnostic).includes("private-binding"));
      return true;
    });
    assert.equal(credentialSent, scenario !== "wrong-instance");
  }
});

test("Agyn terminal handshake diagnostics never retain response bodies or tickets", async t => {
  const server = createServer((_req, res) => { res.writeHead(403); res.end("private-response"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await assert.rejects(deliverBinding({ websocketUrl: `ws://127.0.0.1:${address.port}`, ticket: "private-ticket" },
    { executionId: "execution", instanceId: "instance", workloadId: "workload", runtimeSha256: "hash" },
    "private-binding", AbortSignal.timeout(2000), true), error => {
    assert(error instanceof ReportingDeliveryError);
    assert.deepEqual(error.diagnostic, { deliveryReason: "handshake", receiverReady: false, payloadAttempted: false, acknowledged: false, httpStatus: 403 });
    return true;
  });
});

test("Claude installation validates both files before mutation and acknowledges only complete scoped setup", async t => {
  const directory = mkdtempSync(join(tmpdir(), "claude-reporting-install-"));
  const store = new DurableTaskStore(":memory:");
  const submitted = store.submit({ tenant: "org", subject: "test" }, Message.fromJSON({ messageId: "claude-one", role: "ROLE_USER", parts: [{ text: "work" }] }), "claude");
  const lease = store.claim("worker", 10_000, 1)!.lease;
  const instanceId = randomUUID();
  store.bind(lease, { instanceId, threadId: randomUUID(), profileId: "claude" }); store.beginDispatch(lease);
  const server = createServer(createServiceApp({ store, card: serviceCard("http://localhost"), profileId: "claude",
    signal: new AbortController().signal, authorize: async () => undefined }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const environment = { AGENT_INSTANCE_ID: instanceId, AGYN_INBOX_JOURNAL_DIR: "/workspace/.agyn/inbox-journal",
    AGYN_INBOX_CONTROL_FILE: join(directory, "inbox-control.json") };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, "binding.json"), JSON.stringify({ url: `http://127.0.0.1:${address.port}/reporting`,
    token: store.issueReportingCredential(submitted.execution.id, 60_000), allowInsecureLocal: true }), { mode: 0o600 });
  writeFileSync(join(directory, "expected.json"), JSON.stringify({ executionId: submitted.execution.id, instanceId }), { mode: 0o600 });
  writeFileSync(environment.AGYN_INBOX_CONTROL_FILE, JSON.stringify({ version: 1, instance_id: instanceId,
    allowed_message_id: randomUUID(), ack_only_message_ids: [] }), { mode: 0o600 });
  const target = { agent: "claude" as const, settingsFile: join(directory, "settings.json"), mcpFile: join(directory, ".claude.json") };
  const settings = '{"permissions":{"defaultMode":"default"}}';
  writeFileSync(target.settingsFile, settings);
  writeFileSync(target.mcpFile, "not json");
  await assert.rejects(installRuntime(directory, target));
  assert.equal(readFileSync(target.settingsFile, "utf8"), settings);
  assert(!existsSync(join(directory, "configured.json")));
  const link = join(directory, "symlink.json"); symlinkSync(target.mcpFile, link);
  await assert.rejects(installRuntime(directory, { ...target, mcpFile: link }), /invalid managed config/);
  await assert.rejects(installRuntime(directory, { ...target, mcpFile: target.settingsFile }), /distinct/);
  writeFileSync(target.mcpFile, '{"hasCompletedOnboarding":true}');
  const stale = `${target.mcpFile}.execution.tmp`;
  writeFileSync(stale, "prior incomplete write");
  await assert.rejects(installRuntime(directory, target), { code: "EEXIST" });
  assert(!existsSync(join(directory, "configured.json")), "partial setup must not acknowledge readiness");
  assert.equal(readFileSync(stale, "utf8"), "prior incomplete write", "setup must not overwrite a prior temporary file");
  assert.equal(readFileSync(target.mcpFile, "utf8"), '{"hasCompletedOnboarding":true}');
  rmSync(stale);
  await installRuntime(directory, target);
  assert.equal(lstatSync(target.mcpFile).mode & 0o777, 0o600);
  assert.equal(lstatSync(target.settingsFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(target.mcpFile, "utf8")).mcpServers.execution_reporting.type, "stdio");
  assert.deepEqual(JSON.parse(readFileSync(target.settingsFile, "utf8")).permissions, { defaultMode: "default" });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "configured.json"), "utf8")), {
    executionId: submitted.execution.id, instanceId, reportingConfigured: true
  });
});
