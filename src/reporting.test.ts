// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";
import { Role, TaskState } from "@a2a-js/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReportingMcp, type ExecutionStatus } from "./reporting/mcp.js";
import { codexStopOutput, evaluateStop } from "./reporting/stop-check.js";
import { DurableTaskStore } from "./service/task-store.js";

test("reporting MCP: real SDK calls are execution-scoped, durable, idempotent and separate from completion", async t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const scope = { tenant: "org", subject: "caller" };
  const submission = store.submit(scope, { messageId: randomUUID(), taskId: "", contextId: "", role: Role.ROLE_USER,
    parts: [{ content: { $case: "text", value: "work" }, filename: "", mediaType: "text/plain", metadata: {} }],
    metadata: {}, referenceTaskIds: [], extensions: [] }, "agent");
  const lease = store.claim("worker", 10_000, 1)!.lease;
  store.bind(lease, { instanceId: "instance", threadId: "thread", profileId: "agent" });
  store.beginDispatch(lease); store.dispatched(lease, "message-1");
  const executionId = submission.execution.id;
  const server = createReportingMcp({
    report: async event => ({ executionId, ...store.report("instance", executionId, event) }),
    status: async () => { const execution = store.execution(executionId)!;
      return { executionId, phase: execution.phase, canceled: execution.canceled, outcome: execution.outcome }; }
  });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["get_execution_status", "report_artifact", "report_outcome", "report_progress"]);
  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema.properties?.taskId, undefined);
    assert.equal(tool.inputSchema.properties?.executionId, undefined);
  }
  const input = { eventId: "progress-1", message: "Testing", percent: 50 };
  const first = await client.callTool({ name: "report_progress", arguments: input });
  const second = await client.callTool({ name: "report_progress", arguments: input });
  assert.equal(first.isError, undefined);
  const receipt = z.object({ sequence: z.number(), duplicate: z.boolean() });
  assert.equal(receipt.parse(second.structuredContent).sequence, receipt.parse(first.structuredContent).sequence);
  assert.equal(receipt.parse(second.structuredContent).duplicate, true);
  const invalid = await client.callTool({ name: "report_progress", arguments: { ...input, taskId: "another-task" } });
  assert.equal(invalid.isError, true);
  assert.equal(store.execution(executionId)?.outcome, null);
  const artifact = await client.callTool({ name: "report_artifact", arguments: { eventId: "artifact-1", artifactId: "test-log", name: "tests.txt", text: "passed" } });
  assert.equal(artifact.isError, undefined);
  const final = await client.callTool({ name: "report_outcome", arguments: { eventId: "outcome-1", outcome: "input_required", message: "Which branch?" } });
  assert.equal(final.isError, undefined);
  assert.equal(store.get(scope, submission.task.id).status?.state, TaskState.TASK_STATE_WORKING, "MCP cannot certify stopped compute");
  const status = await client.callTool({ name: "get_execution_status", arguments: {} });
  assert.equal(z.object({ outcome: z.object({ outcome: z.string() }) }).parse(status.structuredContent).outcome.outcome, "input_required");
  store.releasing(lease); store.settle(lease, { stopped: true });
  assert.equal(store.get(scope, submission.task.id).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
});

test("stop check: bounded reminders, cancellation precedence and native hook output", () => {
  const status: ExecutionStatus = { executionId: "execution-1", phase: "running", canceled: false, outcome: null };
  assert.equal(evaluateStop(status, 0).action, "remind");
  assert.equal(evaluateStop(status, 1).action, "remind");
  assert.equal(evaluateStop(status, 2).action, "stop");
  assert.equal(codexStopOutput(evaluateStop(status, 0)).decision, "block");
  assert.equal(codexStopOutput(evaluateStop(status, 2)).continue, false);
  assert.equal(evaluateStop({ ...status, canceled: true }, 0).action, "stop");
  const done = { ...status, outcome: { eventId: "done", kind: "outcome" as const, outcome: "turn_done" as const, message: "Done" } };
  assert.equal(evaluateStop(done, 0).action, "allow");
  assert.equal(evaluateStop({ ...done, canceled: true }, 0).action, "stop");
  assert.equal(evaluateStop({ ...done, phase: "settled" }, 0).action, "stop");
  assert.deepEqual(codexStopOutput(evaluateStop(done, 0)), {});
});

test("reporting MCP: backend failures cannot masquerade as receipts or disclose credentials", async t => {
  const server = createReportingMcp({ report: async () => { throw new Error("secret-token"); }, status: async () => { throw new Error("secret-token"); } });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  for (const request of [
    { name: "report_outcome", arguments: { eventId: "done", outcome: "turn_done", message: "Done" } },
    { name: "get_execution_status", arguments: {} }
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
  }
});
