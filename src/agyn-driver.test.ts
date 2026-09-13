// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Message } from "@a2a-js/sdk";
import { AgynClient } from "./agyn-client.js";
import { AgynRuntimeDriver } from "./service/agyn-driver.js";
import { DurableTaskStore } from "./service/task-store.js";

test("Agyn driver: identity reconciliation, inbox wake before gated setup, and removal evidence beyond pause/status", async t => {
  const requests: string[] = [];
  let instance: Record<string, unknown> | undefined;
  let thread: Record<string, unknown> | undefined;
  let removed = false;
  let workloadId = "workload";
  let workloadStatus = "WORKLOAD_STATUS_RUNNING";
  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body); const method = request.url!.split("/").at(-1)!; requests.push(method);
      let output: unknown;
      if (method === "ListInstances") output = { instances: instance ? [instance] : [] };
      else if (method === "CreateInstance") output = { instance: instance = { meta: { id: "instance" }, agentId: input.agentId, label: input.label, state: "AGENT_INSTANCE_STATE_ACTIVE" } };
      else if (method === "GetThreads") {
        assert.equal(input.participantId, "human");
        output = { threads: [...(thread ? [thread] : []), { id: "unrelated-thread", participants: [{ id: "human" }, { id: "other-instance" }] }] };
      }
      else if (method === "CreateThread") output = { thread: thread = { id: "thread", participants: input.participants.map((p: { participantId: string }) => ({ id: p.participantId })) } };
      else if (method === "GetInstance") output = { instance };
      else if (method === "PauseInstance") output = { instance: instance = { ...instance, state: "AGENT_INSTANCE_STATE_PAUSED" } };
      else if (method === "ResumeInstance") output = { instance: instance = { ...instance, state: "AGENT_INSTANCE_STATE_ACTIVE" } };
      else if (method === "SendMessage") output = { message: { id: "request", threadId: input.threadId, body: input.body } };
      else if (method === "ListWorkloadsByAgentInstance") output = { workloads: [{ meta: { id: workloadId }, agentInstanceId: "instance", status: workloadStatus, ...(removed ? { removedAt: new Date().toISOString() } : {}) }] };
      else { response.writeHead(404).end(); return; }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(output));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const store = new DurableTaskStore(":memory:");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); });
  const client = new AgynClient(`http://127.0.0.1:${address.port}`, "token", "org", "human");
  const driver = new AgynRuntimeDriver(client, [{ id: "agent", agentId: "agent-class" }], async execution => {
    assert.equal(execution.requestId, "request");
    assert.equal(store.execution(execution.id)?.requestId, "request", "persist send ACK before setup can fail");
    requests.push("SetupReporting"); return { workloadId };
  });
  const submitted = store.submit({ tenant: "org", subject: "alice" }, Message.fromJSON({ messageId: "one", role: "ROLE_USER", parts: [{ text: "work" }] }), "agent");
  const claim = store.claim("worker", 10000, 1)!;
  const signal = new AbortController().signal;
  await assert.rejects(driver.provision(claim.execution, true, signal), /acknowledgement/);
  assert.equal(requests.includes("CreateInstance"), false);
  const binding = await driver.provision(claim.execution, false, signal);
  assert.equal(instance!.label, submitted.task.id.replaceAll("-", ""));
  assert.match(String(instance!.label), /^[a-z0-9_-]{1,32}$/);
  store.bind(claim.lease, binding);
  assert.deepEqual(await driver.provision(claim.execution, true, signal), binding);
  assert.equal(requests.filter(method => method === "CreateInstance").length, 1);
  assert.equal(requests.filter(method => method === "CreateThread").length, 1);
  await driver.prepare(store.execution(submitted.execution.id)!, signal);
  assert(!requests.includes("SetupReporting"));
  const dispatch = store.beginDispatch(claim.lease);
  assert.equal(await driver.dispatch(dispatch, signal, receipt => store.recordDispatchReceipt(claim.lease, receipt)), "request");
  assert(requests.indexOf("SendMessage") < requests.indexOf("SetupReporting"));
  const bound = store.execution(dispatch.id)!;
  assert.equal(bound.workloadId, "workload");
  assert.equal(await driver.observe(bound, signal), "running");
  workloadId = "replacement";
  assert.equal(await driver.observe(bound, signal), "interrupted", "replacement must not continue an old execution");
  workloadId = "workload"; workloadStatus = "WORKLOAD_STATUS_STOPPED";
  assert.equal(await driver.observe(bound, signal), "interrupted");
  assert.deepEqual(await driver.release(dispatch, signal), { stopped: false });
  removed = true;
  assert.equal(await driver.observe(bound, signal), "interrupted");
  assert.deepEqual(await driver.release(dispatch, signal), { stopped: true });
  await driver.prepare(dispatch, signal);
  assert(requests.includes("ResumeInstance"));
});
