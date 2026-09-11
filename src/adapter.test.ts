import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./db.js";
import { TaskState } from "@a2a-js/sdk";

test("task idempotency storage returns the original persisted task", () => {
  const store = new Store(":memory:");
  const value: any = { id: "task-1", contextId: "ctx-1", status: { state: TaskState.TASK_STATE_COMPLETED }, artifacts: [], history: [], metadata: { workspaceId: "alpha", idempotencyKey: "same" } };
  store.bindTask("task-1", "ctx-1", "alpha", "same", value);
  assert.equal(store.findDuplicate("alpha", "same")?.id, "task-1");
});
