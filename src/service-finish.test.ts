// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Message, TaskState } from "@a2a-js/sdk";
import { DurableTaskStore, TaskStoreError, type Lease } from "./service/task-store.js";

const owner = { tenant: "org", subject: "alice" };
const input = (taskId = "") => Message.fromJSON({ messageId: randomUUID(), taskId,
  role: "ROLE_USER", parts: [{ text: "work" }] });
const conflict = (error: unknown) => error instanceof TaskStoreError && error.code === "conflict";
function start(store: DurableTaskStore): Lease {
  const { lease, execution } = store.claim("worker", 60_000, 1)!;
  if (!execution.runtime) store.bind(lease, { instanceId: "instance", threadId: "thread", profileId: "agent" });
  store.beginDispatch(lease); store.dispatched(lease, randomUUID());
  return lease;
}
function report(store: DurableTaskStore, lease: Lease, outcome: "turn_done" | "input_required" | "failed" = "turn_done") {
  store.report("instance", lease.executionId, { eventId: "done", kind: "outcome", outcome, message: outcome });
  store.releasing(lease);
}

test("finish: idle completion is owner-scoped, idempotent and retirable without another turn", t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const { task, execution } = store.submit(owner, input(), "agent");
  const lease = start(store); report(store, lease); store.settle(lease, { stopped: true });
  assert.throws(() => store.requestFinish({ ...owner, subject: "bob" }, task.id),
    (error: unknown) => error instanceof TaskStoreError && error.code === "not_found");
  const completed = store.requestFinish(owner, task.id);
  assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.metadata?.completedBy, "user");
  assert.equal(completed.metadata?.reusable, false);
  assert.equal(completed.metadata?.resourcesReleased, true);
  assert.deepEqual(store.requestFinish(owner, task.id), completed);
  assert.equal(store.events(owner, task.id).filter(e => e.kind === "task.finish_requested").length, 1);
  assert.equal(store.retirableRuntimes(10)[0].taskId, task.id);
  assert.equal(store.execution(execution.id)?.phase, "settled");
  assert.equal(store.claim("next", 60_000, 1), undefined);
  assert.throws(() => store.submit(owner, input(task.id), "agent"), conflict);
  assert(completed.history.length >= 2);
});

test("finish: active work completes naturally and cannot settle before confirmed removal", t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const { task, execution } = store.submit(owner, input(), "agent"); const lease = start(store);
  const pending = store.requestFinish(owner, task.id);
  assert.equal(pending.status?.state, TaskState.TASK_STATE_WORKING);
  assert.equal(pending.metadata?.completionRequested, true);
  assert.equal(store.execution(execution.id)?.endTask, true);
  assert.equal(store.execution(execution.id)?.canceled, false);
  assert.equal(store.admission().reserved, 1);
  assert.deepEqual(store.requestFinish(owner, task.id), pending);
  assert.throws(() => store.submit(owner, input(task.id), "agent"), conflict);
  store.report("instance", execution.id, { eventId: "artifact", kind: "artifact",
    artifactId: "result", name: "result", text: "retained result" });
  report(store, lease);
  assert.throws(() => store.settle(lease, { stopped: false }), conflict);
  assert.equal(store.retirableRuntimes(10).length, 0);
  store.settle(lease, { stopped: true });
  const completed = store.get(owner, task.id);
  assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.metadata?.completionRequested, false);
  assert.equal(completed.metadata?.completedBy, "user");
  assert.equal(completed.artifacts.length, 1);
  assert.equal(store.admission().reserved, 0);
});

test("finish: accepted queued turns are preserved; input-required does not invent success", t => {
  const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
  const first = store.submit(owner, input(), "agent");
  const second = store.submit(owner, input(first.task.id), "agent");
  const lease = start(store);
  store.requestFinish(owner, first.task.id);
  assert.equal(store.execution(first.execution.id)?.endTask, false);
  assert.equal(store.execution(second.execution.id)?.endTask, true);
  report(store, lease); store.settle(lease, { stopped: true });
  assert.equal(store.get(owner, first.task.id).metadata?.completionRequested, true);
  const next = start(store); assert.equal(next.executionId, second.execution.id);
  report(store, next, "input_required"); store.settle(next, { stopped: true });
  const waiting = store.get(owner, first.task.id);
  assert.equal(waiting.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(waiting.metadata?.completionRequested, false);
  assert.equal(waiting.metadata?.completedBy, undefined);
  assert.equal(store.retirableRuntimes(10).length, 0);
  assert.equal(store.requestFinish(owner, first.task.id).status?.state, TaskState.TASK_STATE_COMPLETED);
});

test("finish: cancellation, failure and uncertainty are not relabeled as successful completion", t => {
  for (const kind of ["cancel", "failed", "uncertain"] as const) {
    const store = new DurableTaskStore(":memory:"); t.after(() => store.close());
    const { task } = store.submit(owner, input(), "agent"); const lease = start(store);
    store.requestFinish(owner, task.id);
    if (kind === "cancel") {
      store.requestCancel(owner, task.id); store.releasing(lease);
    } else if (kind === "failed") report(store, lease, "failed");
    else {
      store.markUncertain(lease, "interrupted before outcome");
      assert.throws(() => store.requestFinish(owner, task.id), conflict);
    }
    store.settle(lease, { stopped: true });
    const result = store.get(owner, task.id);
    assert.equal(result.status?.state, kind === "cancel" ? TaskState.TASK_STATE_CANCELED
      : kind === "failed" ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.equal(result.metadata?.completionRequested, false);
    assert.equal(result.metadata?.completedBy, undefined);
    assert.throws(() => store.requestFinish(owner, task.id), conflict);
  }
});

test("finish: pending finish survives restart and requires no extra dispatch", t => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-finish-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "tasks.sqlite");
  let store = new DurableTaskStore(path);
  const { task, execution } = store.submit(owner, input(), "agent"); const lease = start(store);
  store.requestFinish(owner, task.id); store.close();
  store = new DurableTaskStore(path); t.after(() => store.close());
  assert.equal(store.get(owner, task.id).metadata?.completionRequested, true);
  assert.equal(store.execution(execution.id)?.endTask, true);
  report(store, lease); store.settle(lease, { stopped: true });
  assert.equal(store.get(owner, task.id).status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(store.claim("next", 60_000, 1), undefined);
});
