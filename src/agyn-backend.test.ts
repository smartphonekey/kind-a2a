import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AgynBackend } from "./agyn-backend.js";
import { AgynClient } from "./agyn-client.js";

test("Agyn backend creates one instance per task and resumes the same instance", async (t) => {
  let state = "AGENT_INSTANCE_STATE_ACTIVE";
  let threadCreates = 0;
  let sends = 0;
  const messages: Array<Record<string, string>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body || "{}") as Record<string, string>;
      const method = request.url?.split("/").pop();
      let output: unknown;
      if (method === "CreateThread") {
        threadCreates += 1;
        output = { thread: { id: "thread-1", participants: [{ id: "human-1" }, { id: "instance-1" }] } };
      } else if (method === "SendMessage") {
        sends += 1;
        const id = `request-${sends}`;
        messages.push({ id, threadId: input.threadId, senderId: "human-1", body: input.body, createdAt: new Date().toISOString() });
        messages.push({ id: `response-${sends}`, threadId: input.threadId, senderId: "instance-1", body: `answer-${sends}`, createdAt: new Date().toISOString() });
        output = { message: messages.at(-2) };
      } else if (method === "GetMessages") output = { messages: [...messages].reverse() };
      else if (method === "GetInstance") output = { instance: { meta: { id: "instance-1" }, state, handle: "@codex#one" } };
      else if (method === "PauseInstance") { state = "AGENT_INSTANCE_STATE_PAUSED"; output = { instance: { meta: { id: "instance-1" }, state, handle: "@codex#one" } }; }
      else if (method === "ResumeInstance") { state = "AGENT_INSTANCE_STATE_ACTIVE"; output = { instance: { meta: { id: "instance-1" }, state, handle: "@codex#one" } }; }
      else { response.writeHead(404); response.end(); return; }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(output));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const backend = new AgynBackend(new AgynClient(`http://127.0.0.1:${address.port}`, "token", "org-1", "human-1"),
    { profileId: "codex-agyn-v1", agentHandle: "@codex", responseTimeoutMs: 1000, pollIntervalMs: 1 });

  let bound: { threadId: string; instanceId: string } | undefined;
  const first = await backend.start("task-1", "first", undefined, (runtime) => {
    assert.equal(sends, 0, "runtime binding must be durable before the first prompt is sent");
    bound = runtime;
  });
  assert.deepEqual(bound, { runtimeId: "task-1", threadId: "thread-1", instanceId: "instance-1", profileId: "codex-agyn-v1" });
  assert.equal(first.instanceId, "instance-1");
  assert.equal(first.response, "answer-1");
  await backend.release(first);
  assert.equal(state, "AGENT_INSTANCE_STATE_PAUSED");

  const second = await backend.continue(first, "second");
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(second.response, "answer-2");
  assert.equal(threadCreates, 1);
  assert.equal(sends, 2);

  const abort = new AbortController();
  abort.abort(new Error("cancel before prompt"));
  await assert.rejects(backend.start("task-2", "never sent", abort.signal), /cancel before prompt/);
  assert.equal(threadCreates, 2);
  assert.equal(sends, 2);
  assert.equal(state, "AGENT_INSTANCE_STATE_PAUSED");
});
