// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Message, TaskState } from "@a2a-js/sdk";
import { AgynClient } from "./agyn-client.js";
import { AgynRuntimeDriver } from "./service/agyn-driver.js";
import { DurableTaskStore, type Runtime } from "./service/task-store.js";
import { ExecutionWorker, type RetirementEvent, type RuntimeDriver } from "./service/worker.js";

const scope = { tenant: "org", subject: "alice" };
const input = (taskId = "") => Message.fromJSON({ messageId: randomUUID(), taskId, role: "ROLE_USER", parts: [{ text: "work" }] });
const runtimeOf = (taskId: string): Runtime => ({ instanceId: `i-${taskId}`, threadId: `t-${taskId}`, profileId: "agent" });

/** Drive one turn to a confirmed stop, optionally reporting an outcome; returns the task and execution. */
function turn(store: DurableTaskStore, outcome?: "task_completed" | "failed" | "turn_done", taskId = "", endTask = false) {
  const message = input(taskId);
  if (endTask) message.metadata = { endTask: true };
  const submitted = store.submit(scope, message, "agent");
  const claimed = store.claim("worker", 60_000, 1)!;
  assert.equal(claimed.execution.id, submitted.execution.id);
  if (!claimed.execution.runtime) store.bind(claimed.lease, runtimeOf(submitted.task.id));
  store.beginDispatch(claimed.lease); store.dispatched(claimed.lease, `request-${submitted.execution.id}`);
  if (outcome) {
    store.report(`i-${submitted.task.id}`, submitted.execution.id, { eventId: "done", kind: "outcome", outcome, message: outcome });
    store.releasing(claimed.lease);
  } else store.markUncertain(claimed.lease, "interrupted");
  store.settle(claimed.lease, { stopped: true });
  return submitted;
}

test("retirement: only terminal tasks with settled executions and a bound runtime are retirable, once", () => {
  const store = new DurableTaskStore(":memory:");
  const completed = turn(store, "task_completed").task.id;
  const failed = turn(store, "failed").task.id;
  const waiting = turn(store, "turn_done").task.id;
  const ended = turn(store, "turn_done", "", true).task.id;
  const blocked = turn(store).task.id;
  const canceledBlocked = turn(store).task.id;
  store.requestCancel(scope, canceledBlocked);
  const failedBlocked = turn(store);
  store.resolveUncertain(scope, failedBlocked.execution.id, "fail", "operator gave up");
  const neverStarted = store.submit(scope, input(), "agent").task.id;
  store.requestCancel(scope, neverStarted);
  const canceledWaiting = turn(store, "turn_done").task.id;
  store.requestCancel(scope, canceledWaiting);
  const userFinished = turn(store, "turn_done").task.id;
  store.requestFinish(scope, userFinished);

  assert.equal(store.get(scope, waiting).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(store.get(scope, blocked).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(store.get(scope, neverStarted).status?.state, TaskState.TASK_STATE_CANCELED);
  const retirable = store.retirableRuntimes(100);
  assert.deepEqual(new Set(retirable.map(r => r.taskId)),
    new Set([completed, failed, ended, canceledBlocked, failedBlocked.task.id, canceledWaiting, userFinished]));
  assert.deepEqual(retirable.find(r => r.taskId === completed)?.runtime, runtimeOf(completed));
  assert.equal(retirable.find(r => r.taskId === failed)?.state, TaskState.TASK_STATE_FAILED);

  // A follow-up reuses its own task's runtime, so a waiting task keeps it until it ends.
  turn(store, "task_completed", waiting);
  assert(store.retirableRuntimes(100).some(r => r.taskId === waiting));

  assert.equal(store.recordRetired(completed, `i-${completed}`, true), true);
  assert.equal(store.recordRetired(completed, `i-${completed}`, false), false, "a repeated record is a no-op");
  assert.throws(() => store.recordRetired(failed, "another-instance", true), /does not match/);
  assert(!store.retirableRuntimes(100).some(r => r.taskId === completed));
  const before = store.get(scope, completed);
  assert.equal(before.status?.state, TaskState.TASK_STATE_COMPLETED, "retirement keeps the task and its status");
  assert(before.history.length >= 2);
  assert.deepEqual(store.events(scope, completed).filter(e => e.kind === "runtime.retired").map(e => e.payload),
    [{ instanceId: `i-${completed}`, deleted: true }]);
  assert.throws(() => store.retirableRuntimes(0), /page size/);
  store.close();
});

class Driver implements RuntimeDriver {
  retired: string[] = [];
  failures = 0;
  provision = async () => { throw new Error("unused"); };
  prepare = async () => {};
  dispatch = async () => "request";
  observe = async () => "running" as const;
  release = async () => ({ stopped: true });
  retire = async (taskId: string, runtime: Runtime) => {
    assert.equal(runtime.instanceId, `i-${taskId}`);
    if (this.failures-- > 0) throw new Error("gateway unavailable");
    this.retired.push(taskId);
    return { deleted: true };
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert(predicate(), "condition did not become true");
}

test("retirement: the worker deletes each terminal runtime once, logs it and retries failures", async t => {
  const store = new DurableTaskStore(":memory:"); const driver = new Driver(); driver.failures = 2;
  const completed = turn(store, "task_completed").task.id;
  const waiting = turn(store, "turn_done").task.id;
  const events: RetirementEvent[] = []; const errors: { phase: string; taskId?: string }[] = [];
  const worker = new ExecutionWorker(store, driver, { concurrency: 1, leaseMs: 150, pollMs: 5, turnTimeoutMs: 5000, retireIntervalMs: 5,
    retireTerminalRuntimes: true, onRetired: event => events.push(event), onError: error => errors.push(error) });
  t.after(async () => { await worker.stop(); store.close(); });
  worker.start();
  await until(() => events.length === 1);
  assert.deepEqual(errors.map(e => [e.phase, e.taskId]), [["retiring", completed], ["retiring", completed]]);
  assert.deepEqual(events, [{ taskId: completed, instanceId: `i-${completed}`, profileId: "agent", state: TaskState.TASK_STATE_COMPLETED, deleted: true }]);
  const canceled = turn(store, "turn_done").task.id;
  store.requestCancel(scope, canceled);
  await until(() => events.length === 2);
  await delay(50);
  assert.deepEqual(driver.retired, [completed, canceled], "each runtime is retired once; INPUT_REQUIRED keeps its runtime");
  assert(!driver.retired.includes(waiting));
});

test("retirement: a worker without a retire hook or without opting in keeps every runtime", async t => {
  const store = new DurableTaskStore(":memory:"); const { retire: _unused, ...hookless } = new Driver(); const capable = new Driver();
  turn(store, "task_completed");
  const options = { concurrency: 1, leaseMs: 150, pollMs: 5, turnTimeoutMs: 5000, retireIntervalMs: 5 };
  const workers = [new ExecutionWorker(store, hookless, { ...options, retireTerminalRuntimes: true }), new ExecutionWorker(store, capable, options)];
  t.after(async () => { for (const worker of workers) await worker.stop(); store.close(); });
  for (const worker of workers) worker.start();
  await delay(50);
  assert.equal(store.retirableRuntimes(10).length, 1);
  assert.deepEqual(capable.retired, []);
});

test("Agyn driver: retire deletes only this task's released instance and confirms TERMINATED", async t => {
  const taskId = randomUUID(); const label = taskId.replaceAll("-", "");
  let instance: Record<string, unknown> = { meta: { id: "instance" }, agentId: "agent-class", label, state: "AGENT_INSTANCE_STATE_PAUSED" };
  let workloads: Record<string, unknown>[] = [{ meta: { id: "w" }, status: "WORKLOAD_STATUS_FAILED", removalConfirmedAt: new Date().toISOString() }];
  let deleteState = "AGENT_INSTANCE_STATE_TERMINATED";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const method = request.url!.split("/").at(-1)!; requests.push(method);
      assert.equal(JSON.parse(body).id ?? JSON.parse(body).agentInstanceId, "instance");
      let output: unknown;
      if (method === "GetInstance") output = { instance };
      else if (method === "ListWorkloadsByAgentInstance") output = { workloads };
      else if (method === "DeleteInstance") output = { instance: instance = { ...instance, state: deleteState } };
      else { response.writeHead(404).end(); return; }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(output));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const driver = new AgynRuntimeDriver(new AgynClient(`http://127.0.0.1:${address.port}`, "token", "org", "human"),
    [{ id: "agent", agentId: "agent-class" }], async () => ({ workloadId: "unused" }));
  const runtime: Runtime = { instanceId: "instance", threadId: "thread", profileId: "agent" };
  const signal = new AbortController().signal;

  await assert.rejects(driver.retire(randomUUID(), runtime, signal), /does not belong/, "another task's label");
  instance = { ...instance, agentId: "other-class" };
  await assert.rejects(driver.retire(taskId, runtime, signal), /does not belong/, "another agent class");
  instance = { ...instance, agentId: "agent-class" };
  workloads = [...workloads, { meta: { id: "held" }, status: "WORKLOAD_STATUS_RUNNING" }];
  await assert.rejects(driver.retire(taskId, runtime, signal), /unremoved workload/);
  workloads = workloads.slice(0, 1); deleteState = "AGENT_INSTANCE_STATE_PAUSED";
  await assert.rejects(driver.retire(taskId, runtime, signal), /not confirmed/);
  assert.equal(requests.filter(m => m === "DeleteInstance").length, 1, "rejected checks never delete");
  instance = { ...instance, state: "AGENT_INSTANCE_STATE_PAUSED" }; deleteState = "AGENT_INSTANCE_STATE_TERMINATED";
  assert.deepEqual(await driver.retire(taskId, runtime, signal), { deleted: true });
  assert.deepEqual(await driver.retire(taskId, runtime, signal), { deleted: false }, "a terminated instance is not deleted again");
  assert.equal(requests.filter(m => m === "DeleteInstance").length, 2);
  await assert.rejects(driver.retire(taskId, { ...runtime, profileId: "unknown" }, signal), /profile is unavailable/);
});
