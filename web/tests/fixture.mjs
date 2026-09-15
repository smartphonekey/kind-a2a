// SPDX-License-Identifier: AGPL-3.0-only
// Model-free browser acceptance only. Never loads Agyn or provider credentials.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createServiceApp } from "../../dist/service/http.js";
import { DurableTaskStore } from "../../dist/service/task-store.js";
import { ExecutionWorker } from "../../dist/service/worker.js";
import { serviceCard } from "../../dist/service/card.js";

const scope = {
  tenant: "browser-test",
  subject: "browser-test",
  canReconcile: false,
};
const token = "browser_fixture_access_token_not_for_real_use";
const store = new DurableTaskStore(":memory:"),
  stopping = new AbortController(),
  calls = [];
const driver = {
  provision: async (execution) => ({
    instanceId: `instance-${execution.taskId}`,
    threadId: `thread-${execution.taskId}`,
    profileId: execution.profileId,
  }),
  prepare: async () => {},
  dispatch: async (execution) => {
    calls.push({
      taskId: execution.taskId,
      profile: execution.profileId,
      executionId: execution.id,
      messageId: execution.message.messageId,
      instanceId: execution.runtime.instanceId,
      time: Date.now(),
    });
    store.report(execution.runtime.instanceId, execution.id, {
      eventId: "progress",
      kind: "progress",
      message: "Inspecting the workspace",
    });
    return randomUUID();
  },
  observe: async (execution) => {
    const text = execution.message.parts
      .map((p) => p.content?.value ?? "")
      .join(" ");
    if (text.includes("uncertain")) return "interrupted";
    const call = calls.find((c) => c.executionId === execution.id);
    if (text.includes("hold") || Date.now() - call.time < 700) return "running";
    store.report(execution.runtime.instanceId, execution.id, {
      eventId: "artifact",
      kind: "artifact",
      artifactId: "result",
      name: "result.txt",
      text: `Result: ${text}`,
    });
    store.report(execution.runtime.instanceId, execution.id, {
      eventId: "outcome",
      kind: "outcome",
      outcome: text.includes("finish") ? "task_completed" : "turn_done",
      message: `Reply from ${execution.profileId}: ${text}`,
    });
    return "running";
  },
  release: async () => ({ stopped: true }),
};
const worker = new ExecutionWorker(store, driver, {
  concurrency: 2,
  leaseMs: 5000,
  pollMs: 25,
  turnTimeoutMs: 120_000,
});
const app = createServiceApp({
  store,
  card: serviceCard("http://127.0.0.1:8094"),
  profileId: "codex",
  pollMs: 25,
  authorize: async (authorization) =>
    authorization === `Bearer ${token}` ? scope : undefined,
  signal: stopping.signal,
  browser: {
    origin: "http://127.0.0.1:8094",
    assetsPath: new URL("../dist/", import.meta.url).pathname,
    profiles: [
      { id: "codex", name: "Codex fixture" },
      { id: "claude", name: "Claude fixture" },
    ],
  },
});
const server = createServer((request, response) => {
  if (request.url === "/__fixture/calls" && request.method === "GET") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(calls));
  } else app(request, response);
});
server.listen(8094, "127.0.0.1", () => worker.start());
async function stop() {
  if (stopping.signal.aborted) return;
  stopping.abort();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await worker.stop();
  store.close();
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
