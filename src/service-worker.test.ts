// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { Message, TaskState } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DurableTaskStore, type Execution } from "./service/task-store.js";
import { ExecutionWorker, type RuntimeDriver } from "./service/worker.js";

const scope = { tenant: "org", subject: "alice" };
const input = (taskId = "") => Message.fromJSON({ messageId: randomUUID(), taskId, role: "ROLE_USER", parts: [{ text: "work" }] });
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert(predicate(), "condition did not become true");
}
class Driver implements RuntimeDriver {
  sends: Execution[] = [];
  stops = new Set<string>();
  allowStop = true;
  failDispatch = false;
  interrupted = false;
  releaseErrors = 0;
  provision = async (execution: Execution) => ({ instanceId: `i-${execution.taskId}`, threadId: `t-${execution.taskId}`, profileId: execution.profileId });
  prepare = async () => {};
  dispatch = async (execution: Execution) => { this.sends.push(execution); if (this.failDispatch) throw new Error("lost acknowledgement"); return randomUUID(); };
  observe = async () => this.interrupted ? "interrupted" as const : "running" as const;
  release = async (execution: Execution) => {
    if (this.releaseErrors-- > 0) throw new Error("temporary provider outage");
    if (this.allowStop) this.stops.add(execution.id);
    return { stopped: this.allowStop };
  };
}
function worker(store: DurableTaskStore, driver: RuntimeDriver): ExecutionWorker {
  return new ExecutionWorker(store, driver, { concurrency: 2, leaseMs: 150, pollMs: 5, turnTimeoutMs: 5000 });
}

test("worker: parallel isolated tasks, same-task FIFO, profile changes require no workflow/controller changes", async t => {
  const store = new DurableTaskStore(":memory:"); const driver = new Driver(); const runner = worker(store, driver);
  t.after(async () => { await runner.stop(); store.close(); });
  const first = store.submit(scope, input(), "agent-one");
  const follow = store.submit(scope, input(first.task.id), "agent-one");
  const second = store.submit(scope, input(), "agent-two");
  runner.start(); await until(() => driver.sends.length === 2);
  assert.deepEqual(new Set(driver.sends.map(e => e.profileId)), new Set(["agent-one", "agent-two"]));
  assert.notEqual(store.execution(first.execution.id)?.runtime?.instanceId, store.execution(second.execution.id)?.runtime?.instanceId);
  driver.allowStop = false;
  store.report(store.execution(first.execution.id)!.runtime!.instanceId, first.execution.id,
    { eventId: "done", kind: "outcome", outcome: "turn_done", message: "done" });
  await until(() => store.execution(first.execution.id)?.phase === "releasing");
  assert.equal(store.execution(follow.execution.id)?.phase, "queued");
  assert.equal(store.get(scope, first.task.id).status?.state, TaskState.TASK_STATE_WORKING);
  driver.allowStop = true;
  await until(() => driver.sends.length === 3);
  assert.equal(driver.sends[2].id, follow.execution.id);
  assert.equal(driver.sends[2].runtime?.instanceId, driver.sends.find(e => e.id === first.execution.id)?.runtime?.instanceId);
  assert(driver.stops.has(first.execution.id));
  store.requestCancel(scope, first.task.id);
  assert.throws(() => store.submit(scope, input(first.task.id), "agent-one"));
  await until(() => store.get(scope, first.task.id).status?.state === TaskState.TASK_STATE_CANCELED);
});

test("worker: independent database connections keep the global slot until release is confirmed", async t => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-workers-"));
  const path = join(directory, "tasks.sqlite");
  const store = new DurableTaskStore(path); const other = new DurableTaskStore(path);
  const driver = new Driver(); driver.allowStop = false;
  let releaseAttempts = 0;
  const tracked: RuntimeDriver = { ...driver, release: async execution => { releaseAttempts++; return driver.release(execution); } };
  const one = worker(store, tracked); const two = worker(other, tracked);
  t.after(async () => { await one.stop(); await two.stop(); store.close(); other.close(); rmSync(directory, { recursive: true, force: true }); });
  const tasks = Array.from({ length: 4 }, () => store.submit(scope, input(), "agent"));
  one.start(); two.start();
  await until(() => driver.sends.length === 2);
  const completed = driver.sends[0];
  const neighbor = driver.sends[1];
  store.report(completed.runtime!.instanceId, completed.id, { eventId: "done", kind: "outcome", outcome: "turn_done", message: "done" });
  await until(() => releaseAttempts >= 3);
  assert.equal(driver.sends.length, 2);
  assert.equal(store.execution(completed.id)!.phase, "releasing");
  assert.equal(other.execution(neighbor.id)!.phase, "running");
  assert.deepEqual(other.admission(), { maxActive: 2, reserved: 2 });
  assert.equal(tasks.filter(task => store.execution(task.execution.id)!.phase === "queued").length, 2);
  driver.allowStop = true;
  await until(() => driver.sends.length === 3);
  assert(driver.stops.has(completed.id));
  assert.equal(store.execution(completed.id)!.phase, "settled");
  assert.deepEqual(store.admission(), { maxActive: 2, reserved: 2 });
  assert.equal(store.execution(neighbor.id)!.phase, "running");
  for (const task of tasks) store.requestCancel(scope, task.task.id);
  await until(() => store.admission().reserved === 0);
  assert(tasks.every(task => store.execution(task.execution.id)!.phase === "settled"));
  assert.equal(driver.sends.length, 3);
});

test("worker: lost dispatch acknowledgement is quarantined after stopping, never automatically resent", async t => {
  const store = new DurableTaskStore(":memory:"); const driver = new Driver(); driver.failDispatch = true;
  const first = store.submit(scope, input(), "agent-one");
  const runner = worker(store, driver); const replacement = worker(store, driver);
  t.after(async () => { await runner.stop(); await replacement.stop(); store.close(); });
  runner.start(); await until(() => store.execution(first.execution.id)?.phase === "uncertain");
  await runner.stop(); replacement.start(); await delay(30);
  assert.equal(driver.sends.length, 1);
  assert(driver.stops.has(first.execution.id));
  assert.equal(store.get(scope, first.task.id).metadata?.automaticRetry, false);
  assert.equal(store.get(scope, first.task.id).metadata?.recoveryRequired, true);
});

test("worker: lease recovery after durable outcome retries release but never reruns work", async t => {
  const store = new DurableTaskStore(":memory:"); const driver = new Driver(); driver.allowStop = false; driver.releaseErrors = 2;
  const first = store.submit(scope, input(), "agent-one");
  const claimed = store.claim("dead-worker", 10, 2)!;
  store.bind(claimed.lease, { instanceId: "instance", threadId: "thread", profileId: "agent-one" });
  store.beginDispatch(claimed.lease); store.dispatched(claimed.lease, "request");
  store.report("instance", first.execution.id, { eventId: "done", kind: "outcome", outcome: "task_completed", message: "finished" });
  await delay(15);
  const runner = worker(store, driver); t.after(async () => { await runner.stop(); store.close(); });
  runner.start(); await until(() => driver.releaseErrors < 0);
  assert.equal(store.execution(first.execution.id)?.phase, "releasing");
  assert.equal(driver.sends.length, 0);
  driver.allowStop = true;
  await until(() => store.execution(first.execution.id)?.phase === "settled");
  assert.equal(store.get(scope, first.task.id).status?.state, TaskState.TASK_STATE_COMPLETED);
});

test("worker: acknowledged send survives installer failure and requires explicit retirement before reuse", async t => {
  const store = new DurableTaskStore(":memory:"); const base = new Driver();
  let sends = 0;
  const driver: RuntimeDriver = { ...base, dispatch: async (_execution, _signal, accepted) => {
    sends++;
    accepted({ requestId: "accepted-before-install" });
    throw new Error("installer failed after send acknowledged");
  } };
  const first = store.submit(scope, input(), "agent-one");
  const runner = worker(store, driver);
  t.after(async () => { await runner.stop(); store.close(); });
  runner.start(); await until(() => store.execution(first.execution.id)?.phase === "uncertain");
  assert.equal(store.execution(first.execution.id)?.requestId, "accepted-before-install");
  assert.equal(sends, 1);
  assert(base.stops.has(first.execution.id));
  store.resolveUncertain(scope, first.execution.id, "continue", "Gated setup never released agent; retire queued request");
  await runner.stop();
  const next = store.submit(scope, input(first.task.id), "agent-one");
  assert.deepEqual(store.retiredRequestIds(next.execution.id), ["accepted-before-install"]);
});

test("worker: recovery during dispatch never calls dispatch again; shutdown leaves a recoverable lease", async t => {
  const store = new DurableTaskStore(":memory:"); const driver = new Driver(); driver.allowStop = false;
  const first = store.submit(scope, input(), "agent-one");
  const claimed = store.claim("dead-worker", 10, 2)!;
  store.bind(claimed.lease, { instanceId: "instance", threadId: "thread", profileId: "agent-one" });
  store.beginDispatch(claimed.lease); await delay(15);
  const runner = worker(store, driver); t.after(async () => { await runner.stop(); store.close(); });
  runner.start(); await until(() => store.execution(first.execution.id)?.phase === "releasing");
  await runner.stop();
  assert.equal(driver.sends.length, 0);
  assert.equal(store.get(scope, first.task.id).metadata?.resourcesReleased, false);
  assert(store.execution(first.execution.id)?.workerId);
});

test("worker: outcome committed during a failing provider observation wins over stale uncertainty", async t => {
  const store = new DurableTaskStore(":memory:"); const driver = new Driver();
  const first = store.submit(scope, input(), "agent-one");
  const observing: RuntimeDriver = { ...driver, observe: async execution => {
    store.report(execution.runtime!.instanceId, execution.id, { eventId: "done", kind: "outcome", outcome: "task_completed", message: "done" });
    throw new Error("provider observation failed after report committed");
  } };
  const runner = worker(store, observing); t.after(async () => { await runner.stop(); store.close(); });
  runner.start(); await until(() => store.execution(first.execution.id)?.phase === "settled");
  assert.equal(store.get(scope, first.task.id).status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(store.execution(first.execution.id)?.uncertainReason, null);
});
