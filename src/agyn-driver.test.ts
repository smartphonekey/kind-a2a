// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Message } from "@a2a-js/sdk";
import { AgynClient } from "./agyn-client.js";
import { AgynRuntimeDriver } from "./service/agyn-driver.js";
import { DurableTaskStore } from "./service/task-store.js";

test("Agyn driver: identity reconciliation, setup before send, and removal evidence beyond pause/status", async t => {
  const requests: string[] = [];
  let instance: Record<string, unknown> | undefined;
  let thread: Record<string, unknown> | undefined;
  let removed = false;
  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body); const method = request.url!.split("/").at(-1)!; requests.push(method);
      let output: unknown;
      if (method === "ListInstances") output = { instances: instance ? [instance] : [] };
      else if (method === "CreateInstance") output = { instance: instance = { meta: { id: "instance" }, agentId: input.agentId, label: input.label, state: "AGENT_INSTANCE_STATE_ACTIVE" } };
      else if (method === "GetThreads") output = { threads: thread ? [thread] : [] };
      else if (method === "CreateThread") output = { thread: thread = { id: "thread", participants: input.participants.map((p: { participantId: string }) => ({ id: p.participantId })) } };
      else if (method === "GetInstance") output = { instance };
      else if (method === "PauseInstance") output = { instance: instance = { ...instance, state: "AGENT_INSTANCE_STATE_PAUSED" } };
      else if (method === "ResumeInstance") output = { instance: instance = { ...instance, state: "AGENT_INSTANCE_STATE_ACTIVE" } };
      else if (method === "SendMessage") output = { message: { id: "request", threadId: input.threadId, body: input.body } };
      else if (method === "ListWorkloadsByAgentInstance") output = { workloads: [{ meta: { id: "workload" }, status: "WORKLOAD_STATUS_STOPPED", ...(removed ? { removedAt: new Date().toISOString() } : {}) }] };
      else { response.writeHead(404).end(); return; }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(output));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const store = new DurableTaskStore(":memory:");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); });
  const client = new AgynClient(`http://127.0.0.1:${address.port}`, "token", "org", "human");
  const driver = new AgynRuntimeDriver(client, [{ id: "agent", agentId: "agent-class" }], async () => { requests.push("SetupReporting"); });
  const submitted = store.submit({ tenant: "org", subject: "alice" }, Message.fromJSON({ messageId: "one", role: "ROLE_USER", parts: [{ text: "work" }] }), "agent");
  const claim = store.claim("worker", 10000, 1)!;
  const signal = new AbortController().signal;
  await assert.rejects(driver.provision(claim.execution, true, signal), /acknowledgement/);
  assert.equal(requests.includes("CreateInstance"), false);
  const binding = await driver.provision(claim.execution, false, signal);
  store.bind(claim.lease, binding);
  assert.deepEqual(await driver.provision(claim.execution, true, signal), binding);
  assert.equal(requests.filter(method => method === "CreateInstance").length, 1);
  assert.equal(requests.filter(method => method === "CreateThread").length, 1);
  await driver.prepare(store.execution(submitted.execution.id)!, signal);
  const dispatch = store.beginDispatch(claim.lease);
  assert.equal(await driver.dispatch(dispatch, signal), "request");
  assert(requests.indexOf("SetupReporting") < requests.indexOf("SendMessage"));
  assert.deepEqual(await driver.release(dispatch, signal), { stopped: false });
  removed = true;
  assert.deepEqual(await driver.release(dispatch, signal), { stopped: true });
  await driver.prepare(dispatch, signal);
  assert(requests.includes("ResumeInstance"));
});
