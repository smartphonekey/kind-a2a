import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./db.js";
import { TaskState } from "@a2a-js/sdk";
import { profiles } from "./profiles.js";

test("task idempotency storage returns the original persisted task", () => {
  const store = new Store(":memory:");
  const value: any = { id: "task-1", contextId: "ctx-1", status: { state: TaskState.TASK_STATE_COMPLETED }, artifacts: [], history: [], metadata: { workspaceId: "alpha", idempotencyKey: "same" } };
  store.bindTask("task-1", "ctx-1", "alpha", "same", value);
  assert.equal(store.findDuplicate("alpha", "same")?.id, "task-1");
});

test("an out-of-band approval can persist a later terminal task state", async () => {
  const store = new Store(":memory:");
  const value: any = { id: "task-approval", contextId: "ctx-1", status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, artifacts: [], history: [], metadata: { workspaceId: "alpha" } };
  store.bindTask("task-approval", "ctx-1", "alpha", "approval", value);
  const complete: any = { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: "now" };
  store.transitionTask("task-approval", complete, { executionId: "turn-1" }, []);
  const persisted = await store.load("task-approval", {} as any);
  assert.equal(persisted?.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(persisted?.metadata?.executionId, "turn-1");
});

test("workspace persists an operator-selected harness profile and opaque session metadata", () => {
  const store = new Store(":memory:");
  const workspace = store.createWorkspace("acp-one", "runner-acp-one", "runner-acp-one-state", profiles["codex-acp-v1"]);
  assert.equal(workspace.profileId, "codex-acp-v1");
  assert.equal(workspace.harnessType, "acp");
  store.updateWorkspace("acp-one", { sessionId: "opaque-session", providerResume: { providerThread: "opaque-provider-value" }, podUid: "pod-1" });
  assert.deepEqual(store.workspace("acp-one"), {
    ...workspace,
    sessionId: "opaque-session",
    providerResume: { providerThread: "opaque-provider-value" },
    podUid: "pod-1",
    updatedAt: store.workspace("acp-one")!.updatedAt
  });
});

test("existing workspace schema migrates to the direct fallback without changing its thread", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "aira-store-"));
  const filename = path.join(directory, "controller.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY, sandbox_name TEXT NOT NULL, pvc_name TEXT NOT NULL,
      thread_id TEXT, pod_uid TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      idempotency_key TEXT, task_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, idempotency_key)
    );
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL,
      kind TEXT NOT NULL, payload_json TEXT NOT NULL
    );`);
  legacy.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, NULL, ?, ?)").run("legacy", "runner-legacy", "runner-legacy-state", "codex-thread", "then", "then");
  legacy.close();
  const migrated = new Store(filename);
  try {
    const workspace = migrated.workspace("legacy")!;
    assert.equal(workspace.profileId, "codex-direct-v1");
    assert.equal(workspace.harnessType, "direct-codex");
    assert.equal(workspace.sessionId, "codex-thread");
    assert.equal(workspace.threadId, "codex-thread");
    const taskColumns = migrated.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    assert(taskColumns.some((column) => column.name === "execution_id"));
    assert(taskColumns.some((column) => column.name === "turn_id"));
  } finally {
    migrated.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
