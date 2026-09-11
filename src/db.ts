import { DatabaseSync } from "node:sqlite";
import type { ListTasksRequest, ListTasksResponse, Task } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { CONTROLLER_DB, now, redact } from "./common.js";

export type Workspace = {
  workspaceId: string;
  sandboxName: string;
  pvcName: string;
  threadId: string | null;
  podUid: string | null;
  createdAt: string;
  updatedAt: string;
};

export class Store implements TaskStore {
  readonly db: DatabaseSync;

  constructor(path = CONTROLLER_DB) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY, sandbox_name TEXT NOT NULL, pvc_name TEXT NOT NULL,
        thread_id TEXT, pod_uid TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        idempotency_key TEXT, task_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL
      );
    `);
  }

  async save(task: Task, _context: ServerCallContext): Promise<void> {
    const row = this.db.prepare("SELECT workspace_id, idempotency_key FROM tasks WHERE task_id = ?").get(task.id) as { workspace_id?: string; idempotency_key?: string } | undefined;
    const metadata = (task.metadata ?? {}) as Record<string, unknown>;
    const workspaceId = row?.workspace_id ?? String(metadata.workspaceId ?? "unknown");
    const idempotencyKey = row?.idempotency_key ?? (typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : null);
    this.db.prepare(`INSERT INTO tasks(task_id, context_id, workspace_id, idempotency_key, task_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET task_json=excluded.task_json, updated_at=excluded.updated_at`).run(
      task.id, task.contextId, workspaceId, idempotencyKey, JSON.stringify(redact(task)), now(), now());
  }

  async load(taskId: string, _context: ServerCallContext): Promise<Task | undefined> {
    const row = this.db.prepare("SELECT task_json FROM tasks WHERE task_id = ?").get(taskId) as { task_json?: string } | undefined;
    return row?.task_json ? JSON.parse(row.task_json) as Task : undefined;
  }

  async list(params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
    const limit = Math.min(params.pageSize || 100, 100);
    const rows = this.db.prepare("SELECT task_json FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit) as Array<{ task_json: string }>;
    const tasks = rows.map((row) => JSON.parse(row.task_json) as Task);
    return { tasks, nextPageToken: "", pageSize: tasks.length, totalSize: tasks.length };
  }

  workspace(workspaceId: string): Workspace | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as Record<string, string | null> | undefined;
    return row ? {
      workspaceId: String(row.workspace_id), sandboxName: String(row.sandbox_name), pvcName: String(row.pvc_name),
      threadId: row.thread_id, podUid: row.pod_uid, createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    } : undefined;
  }

  createWorkspace(workspaceId: string, sandboxName: string, pvcName: string): Workspace {
    const timestamp = now();
    this.db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, NULL, NULL, ?, ?)").run(workspaceId, sandboxName, pvcName, timestamp, timestamp);
    return this.workspace(workspaceId)!;
  }

  updateWorkspace(workspaceId: string, fields: Partial<Pick<Workspace, "threadId" | "podUid">>): void {
    const current = this.workspace(workspaceId);
    if (!current) throw new Error(`workspace ${workspaceId} not found`);
    this.db.prepare("UPDATE workspaces SET thread_id = ?, pod_uid = ?, updated_at = ? WHERE workspace_id = ?").run(
      fields.threadId ?? current.threadId, fields.podUid ?? current.podUid, now(), workspaceId);
  }

  bindTask(taskId: string, contextId: string, workspaceId: string, idempotencyKey: string | null, task: Task): void {
    this.db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run(taskId, contextId, workspaceId, idempotencyKey, JSON.stringify(redact(task)), now(), now());
  }

  findDuplicate(workspaceId: string, idempotencyKey: string): Task | undefined {
    const row = this.db.prepare("SELECT task_json FROM tasks WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, idempotencyKey) as { task_json?: string } | undefined;
    return row?.task_json ? JSON.parse(row.task_json) as Task : undefined;
  }

  event(taskId: string, kind: string, payload: unknown): void {
    this.db.prepare("INSERT INTO events(task_id, at, kind, payload_json) VALUES (?, ?, ?, ?)").run(taskId, now(), kind, JSON.stringify(redact(payload)));
  }

  transcript(taskId: string): unknown[] {
    const rows = this.db.prepare("SELECT sequence, at, kind, payload_json FROM events WHERE task_id = ? ORDER BY sequence").all(taskId) as Array<{ sequence: number; at: string; kind: string; payload_json: string }>;
    return rows.map((row) => ({ sequence: row.sequence, at: row.at, kind: row.kind, payload: JSON.parse(row.payload_json) }));
  }
}
