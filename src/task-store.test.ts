// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { Role, TaskState, type Message } from "@a2a-js/sdk";
import { DurableTaskStore, TaskStoreError, type Lease, type Scope } from "./service/task-store.js";

const alice: Scope = { tenant: "org-1", subject: "alice" };
const bob: Scope = { tenant: "org-1", subject: "bob" };
const otherOrg: Scope = { tenant: "org-2", subject: "alice" };
const profile = "codex-agyn-v1";
function message(text = "run tests", taskId = "", key: string = randomUUID(), messageId: string = randomUUID()): Message {
  return { messageId, taskId, contextId: "", role: Role.ROLE_USER, referenceTaskIds: [], extensions: [],
    parts: [{ content: { $case: "text", value: text }, filename: "", mediaType: "text/plain", metadata: {} }],
    metadata: { idempotencyKey: key } };
}
const hasCode = (code: TaskStoreError["code"]) => (error: unknown) => error instanceof TaskStoreError && error.code === code;
function running(store: DurableTaskStore, lease: Lease, instanceId: string = randomUUID()): void {
  const execution = store.execution(lease.executionId)!;
  if (!execution.runtime) store.bind(lease, { instanceId, threadId: randomUUID(), profileId: profile });
  store.beginDispatch(lease);
  store.dispatched(lease, randomUUID());
}
function finish(store: DurableTaskStore, lease: Lease, outcome: "turn_done" | "task_completed" | "input_required" | "failed" = "turn_done"): void {
  const execution = store.execution(lease.executionId)!;
  store.report(execution.runtime!.instanceId, execution.id, { eventId: randomUUID(), kind: "outcome", outcome, message: "Finished" });
  store.releasing(lease);
  store.settle(lease, { stopped: true });
}

test("durable store: idempotency is owner-scoped, content checked, and transactional", t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const input = message("one", "", "retry-key");
  const first = store.submit(alice, input, profile);
  const again = store.submit(alice, { ...input, messageId: randomUUID() }, profile);
  assert.equal(first.task.id, again.task.id);
  assert.equal(first.execution.id, again.execution.id);
  assert.equal(again.duplicate, true);
  assert.throws(() => store.submit(alice, message("different", "", "retry-key"), profile), hasCode("conflict"));
  assert.notEqual(store.submit(bob, input, profile).task.id, first.task.id);
  assert.notEqual(store.submit(otherOrg, input, profile).task.id, first.task.id);
  assert.throws(() => store.get(bob, first.task.id), hasCode("not_found"));
  assert.throws(() => store.events(otherOrg, first.task.id), hasCode("not_found"));
  assert.throws(() => store.requestCancel(bob, first.task.id), hasCode("not_found"));
  assert.throws(() => store.submit(bob, message("continue", first.task.id), profile), hasCode("not_found"));
  assert.throws(() => store.submit(alice, { ...message(), referenceTaskIds: [store.submit(bob, message(), profile).task.id] }, profile), hasCode("not_found"));
});

test("durable store: concurrent tasks claim separately and same-task turns stay FIFO", t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const a = store.submit(alice, message("alpha"), profile);
  const follow = store.submit(alice, message("alpha again", a.task.id), profile);
  const b = store.submit(alice, message("beta"), profile);
  const one = store.claim("worker-1", 10_000, 2)!;
  const two = store.claim("worker-2", 10_000, 2)!;
  assert.deepEqual(new Set([one.execution.taskId, two.execution.taskId]), new Set([a.task.id, b.task.id]));
  assert.equal(store.claim("worker-3", 10_000, 2), undefined);
  const alpha = one.execution.taskId === a.task.id ? one : two;
  running(store, alpha.lease, "alpha-instance");
  finish(store, alpha.lease);
  const next = store.claim("worker-3", 10_000, 2)!;
  assert.equal(next.execution.id, follow.execution.id);
  assert.equal(next.execution.phase, "ready");
  assert.equal(next.execution.runtime?.instanceId, "alpha-instance");
  assert.equal(next.execution.ordinal, 2);
  assert.throws(() => store.submit(alice, message("change", a.task.id), "different-agent"), hasCode("conflict"));
  assert.throws(() => store.submit(alice, { ...message("context", a.task.id), contextId: "foreign" }, profile), hasCode("invalid"));
});

test("durable store: restart reclaims existing dispatch without authorizing a resend; old lease is fenced", t => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "tasks.sqlite");
  let now = 1_000;
  const original = new DurableTaskStore(path, { clock: () => now });
  const task = original.submit(alice, message(), profile);
  const first = original.claim("first", 100, 2)!;
  original.bind(first.lease, { instanceId: "instance", threadId: "thread", profileId: profile });
  original.beginDispatch(first.lease);
  original.close();
  const restarted = new DurableTaskStore(path, { clock: () => now }); t.after(() => restarted.close());
  assert.equal(restarted.claim("second", 100, 2), undefined);
  now += 101;
  const takeover = restarted.claim("second", 100, 2)!;
  assert.equal(takeover.execution.id, task.execution.id);
  assert.equal(takeover.execution.phase, "dispatching");
  assert.equal(takeover.recovered, true);
  assert.throws(() => restarted.beginDispatch(takeover.lease), hasCode("conflict"));
  assert.throws(() => restarted.dispatched(first.lease, "late"), hasCode("stale_lease"));
  assert.throws(() => restarted.heartbeat(first.lease, 100), hasCode("stale_lease"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("durable store: progress is not an outcome; durable ACK and exact duplicate are stable after restart", t => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-events-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "tasks.sqlite");
  const store = new DurableTaskStore(path);
  const task = store.submit(alice, message(), profile);
  const claim = store.claim("worker", 10_000, 1)!; running(store, claim.lease, "instance");
  const progress = { eventId: "progress-1", kind: "progress", message: "Testing", percent: 60 };
  const ack = store.report("instance", task.execution.id, progress);
  assert.throws(() => store.releasing(claim.lease), hasCode("conflict"));
  assert.throws(() => store.report("other-instance", task.execution.id, progress), hasCode("not_found"));
  assert.throws(() => store.report("instance", task.execution.id, { ...progress, message: "Changed" }), hasCode("conflict"));
  const outcome = { eventId: "outcome-1", kind: "outcome", outcome: "input_required", message: "Which repository?" };
  store.report("instance", task.execution.id, outcome);
  assert.throws(() => store.report("instance", task.execution.id, { ...progress, eventId: "late" }), hasCode("conflict"));
  store.releasing(claim.lease);
  assert.throws(() => store.settle(claim.lease, { stopped: false }), hasCode("conflict"));
  assert.equal(store.get(alice, task.task.id).status?.state, TaskState.TASK_STATE_WORKING);
  store.settle(claim.lease, { stopped: true }); store.close();
  const restored = new DurableTaskStore(path); t.after(() => restored.close());
  assert.deepEqual(restored.report("instance", task.execution.id, progress), { ...ack, duplicate: true });
  assert.equal(restored.get(alice, task.task.id).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  const events = restored.events(alice, task.task.id);
  assert.equal(events.filter(event => event.kind === "agent.progress").length, 1);
  assert.deepEqual(restored.events(alice, task.task.id, ack.sequence), events.filter(event => event.sequence > ack.sequence));
  const continued = restored.submit(alice, message("repo", task.task.id), profile);
  const next = restored.claim("next", 10_000, 1)!;
  assert.equal(next.execution.id, continued.execution.id); running(restored, next.lease);
  assert.throws(() => restored.report("instance", task.execution.id, { ...outcome, eventId: "old-execution" }), hasCode("conflict"));
  assert.equal(restored.execution(continued.execution.id)?.outcome, null);
});

test("durable store: cancellation wins over a reported outcome and waits for compute release", t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const first = store.submit(alice, message(), profile);
  const queued = store.submit(alice, message("next", first.task.id), profile);
  const claim = store.claim("worker", 10_000, 2)!; running(store, claim.lease, "instance");
  store.report("instance", first.execution.id, { eventId: "result", kind: "outcome", outcome: "task_completed", message: "Done" });
  assert.equal(store.requestCancel(alice, first.task.id).status?.state, TaskState.TASK_STATE_WORKING);
  assert.equal(store.execution(queued.execution.id)?.canceled, true);
  store.releasing(claim.lease); store.settle(claim.lease, { stopped: true });
  assert.equal(store.get(alice, first.task.id).status?.state, TaskState.TASK_STATE_CANCELED);
  assert.throws(() => store.submit(alice, message("resume", first.task.id), profile), hasCode("conflict"));
  assert.equal(store.claim("other", 10_000, 2), undefined);
});

test("durable store: ambiguous execution releases compute but cannot resume before explicit reconciliation", t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const first = store.submit(alice, message(), profile);
  const queued = store.submit(alice, message("queued", first.task.id), profile);
  const claim = store.claim("worker", 10_000, 1)!; running(store, claim.lease);
  store.markUncertain(claim.lease, "dispatch acknowledgement lost");
  assert.equal(store.execution(first.execution.id)?.phase, "releasing");
  assert.throws(() => store.resolveUncertain(alice, first.execution.id, "continue", "reviewed"), hasCode("conflict"));
  store.settle(claim.lease, { stopped: true });
  assert.equal(store.get(alice, first.task.id).metadata?.resourcesReleased, true);
  assert.equal(store.get(alice, first.task.id).metadata?.recoveryRequired, true);
  assert.equal(store.execution(queued.execution.id)?.phase, "settled");
  assert.throws(() => store.submit(alice, message("retry", first.task.id), profile), hasCode("conflict"));
  assert.throws(() => store.resolveUncertain(bob, first.execution.id, "continue", "reviewed"), hasCode("not_found"));
  assert.equal(store.claim("worker", 10_000, 1), undefined);
  store.resolveUncertain(alice, first.execution.id, "continue", "Inspected workspace; side effects already completed");
  const next = store.submit(alice, message("continue without repeating", first.task.id), profile);
  assert.equal(store.claim("worker", 10_000, 1)?.execution.id, next.execution.id);
});

test("durable store: artifacts survive continuation and terminal states do not resurrect", t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const first = store.submit(alice, message(), profile);
  const claim = store.claim("worker", 10_000, 1)!; running(store, claim.lease, "instance");
  store.report("instance", first.execution.id, { kind: "artifact", eventId: "a", artifactId: "tests", name: "tests.txt", text: "3 passed" });
  finish(store, claim.lease);
  store.submit(alice, message("finish", first.task.id), profile);
  const last = store.claim("worker", 10_000, 1)!; running(store, last.lease); finish(store, last.lease, "task_completed");
  const task = store.get(alice, first.task.id);
  assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.history.length, 4);
  assert.throws(() => store.submit(alice, message("more", first.task.id), profile), hasCode("conflict"));
  assert.throws(() => store.settle(claim.lease, { stopped: true }), hasCode("stale_lease"));
});

test("durable store: limits and schema validation fail before mutating tasks", t => {
  const store = new DurableTaskStore(":memory:", { maxQueuedPerTask: 1, maxPendingPerOwner: 2 }); t.after(() => store.close());
  const first = store.submit(alice, message(), profile);
  assert.throws(() => store.submit(alice, message("more", first.task.id), profile), hasCode("capacity"));
  store.submit(alice, message(), profile);
  assert.throws(() => store.submit(alice, message(), profile), hasCode("capacity"));
  assert.equal(store.submit(bob, message(), profile).duplicate, false);
  assert.throws(() => store.submit(bob, message(""), profile), hasCode("invalid"));
  const claim = store.claim("worker", 10_000, 3)!; running(store, claim.lease, "instance");
  assert.throws(() => store.report("instance", claim.execution.id, { eventId: "a", kind: "progress", message: "bad", percent: 101 }));
  assert.throws(() => store.report("instance", claim.execution.id, { eventId: "a", kind: "progress", message: "bad", taskId: "foreign" }));
});

test("durable store: independent processes contend on one SQLite file without duplicate task or lease", async t => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-concurrent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "tasks.sqlite");
  const store = new DurableTaskStore(path); t.after(() => store.close());
  const moduleUrl = new URL("./service/task-store.js", import.meta.url).href;
  const input = message("concurrent", "", "shared-key");
  const results = await Promise.all(Array.from({ length: 6 }, (_, n) => new Promise<{ taskId: string; claimed: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const data=JSON.parse(process.argv[1]);
      const {DurableTaskStore}=await import(data.moduleUrl);
      const store=new DurableTaskStore(data.path);
      const task=store.submit(data.scope,data.input,data.profile);
      const claim=store.claim('worker-'+data.n,10000,2);
      store.close();console.log(JSON.stringify({taskId:task.task.id,claimed:!!claim}));
      `, JSON.stringify({ moduleUrl, path, scope: alice, input, profile, n })], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) { reject(new Error(errors)); return; }
      try { resolve(JSON.parse(output) as { taskId: string; claimed: boolean }); } catch (error) { reject(error); }
    });
  })));
  assert.equal(new Set(results.map(result => result.taskId)).size, 1);
  assert.equal(results.filter(result => result.claimed).length, 1);
  assert.equal(store.get(alice, results[0].taskId).history.length, 1);
});
