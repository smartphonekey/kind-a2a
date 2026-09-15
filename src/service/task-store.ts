// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Role, TaskState, type ListTasksRequest, type ListTasksResponse, type Message, type Task } from "@a2a-js/sdk";
import { contentHash, reportSchema, type OutcomeReport, type TaskEvent } from "./events.js";
import { evaluateStop, type StopDecision } from "../reporting/stop-check.js";
import type { ExecutionStatus } from "../reporting/mcp.js";
import { taskArtifact } from "./artifacts.js";

export type Scope = { tenant: string; subject: string };
export type Phase = "queued" | "provisioning" | "ready" | "dispatching" | "running" | "releasing" | "uncertain" | "settled";
export type Runtime = { instanceId: string; threadId: string; profileId: string };
export type Lease = { executionId: string; workerId: string; generation: number };
export type DispatchReceipt = { requestId: string; workloadId?: string };
export type Execution = {
  id: string; taskId: string; ordinal: number; phase: Phase; message: Message;
  endTask: boolean; workerId: string | null; generation: number; leaseUntil: number;
  requestId: string | null; workloadId: string | null; outcome: OutcomeReport | null; canceled: boolean;
  runtime: Runtime | null; profileId: string; createdAt: number; startedAt: number | null; uncertainReason: string | null;
};
export type Submission = { task: Task; execution: Execution; duplicate: boolean };
export type StoreOptions = { clock?: () => number; maxQueuedPerTask?: number; maxPendingPerOwner?: number };
export type Admission = { maxActive: number | null; reserved: number };

export class TaskStoreError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invalid" | "capacity" | "stale_lease", message: string) {
    super(message);
  }
}

const terminal = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED]);
type Row = Record<string, string | number | null>;

export class DurableTaskStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly maxQueuedPerTask: number;
  private readonly maxPendingPerOwner: number;

  constructor(path: string, options: StoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxQueuedPerTask = options.maxQueuedPerTask ?? 32;
    this.maxPendingPerOwner = options.maxPendingPerOwner ?? 256;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
        throw new Error("task database must be a regular file");
      }
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS execution_tasks (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL,
        context_id TEXT NOT NULL, profile_id TEXT NOT NULL, task_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_tasks_owner ON execution_tasks(tenant, subject, id);
      CREATE TABLE IF NOT EXISTS runtime_bindings (
        task_id TEXT PRIMARY KEY REFERENCES execution_tasks(id),
        instance_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_executions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES execution_tasks(id),
        ordinal INTEGER NOT NULL, phase TEXT NOT NULL, message_json TEXT NOT NULL,
        end_task INTEGER NOT NULL, worker_id TEXT, generation INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, request_id TEXT, outcome_json TEXT,
        canceled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, uncertain_reason TEXT,
        UNIQUE(task_id, ordinal)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS task_one_active_execution ON task_executions(task_id)
        WHERE phase NOT IN ('queued', 'settled');
      CREATE TABLE IF NOT EXISTS execution_workloads (
        execution_id TEXT PRIMARY KEY REFERENCES task_executions(id), workload_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS task_submissions (
        tenant TEXT NOT NULL, subject TEXT NOT NULL, key_scope TEXT NOT NULL,
        key TEXT NOT NULL, content_hash TEXT NOT NULL,
        execution_id TEXT NOT NULL REFERENCES task_executions(id),
        PRIMARY KEY(tenant, subject, key_scope, key)
      );
      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES execution_tasks(id),
        execution_id TEXT REFERENCES task_executions(id), at INTEGER NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, event_id TEXT, content_hash TEXT,
        UNIQUE(execution_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS task_events_replay ON task_events(task_id, sequence);
      CREATE TABLE IF NOT EXISTS reporting_credentials (
        digest TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE REFERENCES task_executions(id), expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stop_checks (
        execution_id TEXT NOT NULL REFERENCES task_executions(id), check_id TEXT NOT NULL,
        decision_json TEXT NOT NULL, PRIMARY KEY(execution_id,check_id)
      );
      CREATE TABLE IF NOT EXISTS execution_admission (
        id INTEGER PRIMARY KEY CHECK(id=1), max_active INTEGER NOT NULL CHECK(max_active>0)
      );
      CREATE TRIGGER IF NOT EXISTS execution_admission_capacity
        BEFORE UPDATE OF phase ON task_executions
        WHEN OLD.phase='queued' AND NEW.phase NOT IN ('queued','settled','uncertain')
          AND (SELECT count(*) FROM task_executions WHERE phase NOT IN ('queued','settled','uncertain'))
            >= (SELECT max_active FROM execution_admission WHERE id=1)
        BEGIN SELECT RAISE(ABORT, 'execution admission capacity exceeded'); END;
    `);
  }

  close(): void { this.db.close(); }

  submit(scope: Scope, message: Message, profileId: string): Submission {
    this.validateScope(scope);
    if (!message.messageId || message.messageId.length > 128 || message.role !== Role.ROLE_USER) {
      throw new TaskStoreError("invalid", "a user message with a bounded messageId is required");
    }
    if (!message.parts.length || message.parts.some(part => part.content?.$case !== "text") ||
        !message.parts.some(part => typeof part.content?.value === "string" && part.content.value.trim()) ||
        Buffer.byteLength(JSON.stringify(message)) > 131_072) {
      throw new TaskStoreError("invalid", "only bounded text messages are supported");
    }
    if (!profileId || profileId.length > 128 || [message.taskId, message.contextId].some(v => v.length > 128)) {
      throw new TaskStoreError("invalid", "invalid task, context or profile identifier");
    }
    const key = message.metadata?.idempotencyKey ?? message.messageId;
    if (typeof key !== "string" || !key || key.length > 128) throw new TaskStoreError("invalid", "invalid idempotencyKey");
    if (message.metadata?.endTask !== undefined && typeof message.metadata.endTask !== "boolean") {
      throw new TaskStoreError("invalid", "endTask must be a boolean");
    }
    const hash = contentHash({ ...message, messageId: undefined });
    const keyScope = message.taskId || "new";
    return this.transaction(() => {
      // A caller's message ID is unique even when it changes its retry key.
      const lookups = [[keyScope, `key:${key}`], ["message", message.messageId]];
      let duplicate: Row | undefined;
      for (const [namespace, value] of lookups) {
        const found = this.db.prepare(`SELECT content_hash, execution_id FROM task_submissions
          WHERE tenant=? AND subject=? AND key_scope=? AND key=?`).get(scope.tenant, scope.subject, namespace, value) as Row | undefined;
        if (found) {
          if (found.content_hash !== hash || (duplicate && duplicate.execution_id !== found.execution_id)) {
            throw new TaskStoreError("conflict", "submission identity was already used for different content");
          }
          duplicate = found;
        }
      }
      if (duplicate) {
        const execution = this.execution(String(duplicate.execution_id))!;
        for (const [namespace, value] of lookups) this.db.prepare("INSERT OR IGNORE INTO task_submissions VALUES(?,?,?,?,?,?)")
          .run(scope.tenant, scope.subject, namespace, value, hash, execution.id);
        return { task: this.get(scope, execution.taskId), execution, duplicate: true };
      }
      const existing = message.taskId ? this.get(scope, message.taskId) : undefined;
      if (existing && terminal.has(existing.status!.state)) throw new TaskStoreError("conflict", "terminal tasks cannot resume");
      if (existing?.metadata?.cancellationRequested || existing?.metadata?.recoveryRequired) {
        throw new TaskStoreError("conflict", "task is canceling or requires explicit recovery");
      }
      if (existing && message.contextId && message.contextId !== existing.contextId) {
        throw new TaskStoreError("invalid", "contextId does not belong to this task");
      }
      if (existing && existing.metadata?.profileId !== profileId) throw new TaskStoreError("conflict", "a task's profile is immutable");
      if (existing && (existing.history.length >= 200 || Buffer.byteLength(JSON.stringify(existing)) + Buffer.byteLength(JSON.stringify(message)) > 4_194_304)) {
        throw new TaskStoreError("capacity", "task history limit reached");
      }
      for (const reference of message.referenceTaskIds) this.get(scope, reference);
      const pending = this.db.prepare(`SELECT count(*) AS n FROM task_executions e JOIN execution_tasks t ON t.id=e.task_id
        WHERE t.tenant=? AND t.subject=? AND e.phase!='settled'`).get(scope.tenant, scope.subject) as Row;
      if (Number(pending.n) >= this.maxPendingPerOwner) throw new TaskStoreError("capacity", "owner admission limit reached");
      if (existing) {
        const rows = this.db.prepare("SELECT phase, end_task FROM task_executions WHERE task_id=? AND phase!='settled'").all(existing.id) as Row[];
        if (rows.length >= this.maxQueuedPerTask) throw new TaskStoreError("capacity", "task queue is full");
        if (rows.some(row => row.phase === "uncertain" || row.end_task === 1)) {
          throw new TaskStoreError("conflict", "task is closing or requires explicit recovery");
        }
      }
      const timestamp = this.clock();
      const taskId = existing?.id ?? randomUUID();
      const contextId = existing?.contextId ?? (message.contextId || randomUUID());
      const normalized: Message = { ...message, taskId, contextId };
      const title = message.parts.flatMap(part => part.content?.$case === "text" ? [part.content.value] : []).join(" ").slice(0, 120);
      const task: Task = existing ?? { id: taskId, contextId, history: [], artifacts: [], metadata: { profileId, title },
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date(timestamp).toISOString(), message: undefined } };
      task.history = [...task.history, normalized];
      if (!existing) {
        this.db.prepare(`INSERT INTO execution_tasks VALUES(?,?,?,?,?,?,?,?)`).run(taskId, scope.tenant, scope.subject,
          contextId, profileId, JSON.stringify(task), timestamp, timestamp);
      } else this.saveTask(task);
      const ordinalRow = this.db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM task_executions WHERE task_id=?").get(taskId) as Row;
      const executionId = randomUUID();
      this.db.prepare(`INSERT INTO task_executions(id,task_id,ordinal,phase,message_json,end_task,created_at)
        VALUES(?,?,?,'queued',?,?,?)`).run(executionId, taskId, Number(ordinalRow.n), JSON.stringify(normalized), message.metadata?.endTask === true ? 1 : 0, timestamp);
      for (const [namespace, value] of lookups) this.db.prepare("INSERT INTO task_submissions VALUES(?,?,?,?,?,?)")
        .run(scope.tenant, scope.subject, namespace, value, hash, executionId);
      this.append(taskId, executionId, "execution.queued", { messageId: normalized.messageId, ordinal: Number(ordinalRow.n) });
      if (existing && !this.db.prepare("SELECT 1 FROM task_executions WHERE task_id=? AND phase NOT IN ('queued','settled')").get(taskId)) {
        this.setStatus(taskId, TaskState.TASK_STATE_SUBMITTED, "Continuation queued", {});
      }
      return { task: this.get(scope, taskId), execution: this.execution(executionId)!, duplicate: false };
    });
  }

  get(scope: Scope, taskId: string): Task {
    this.validateScope(scope);
    const row = this.db.prepare("SELECT task_json FROM execution_tasks WHERE id=? AND tenant=? AND subject=?")
      .get(taskId, scope.tenant, scope.subject) as Row | undefined;
    if (!row) throw new TaskStoreError("not_found", "task not found");
    return JSON.parse(String(row.task_json)) as Task;
  }

  execution(id: string): Execution | undefined {
    const row = this.db.prepare(`SELECT e.*, t.profile_id, r.instance_id, r.thread_id, w.workload_id,
      (SELECT at FROM task_events WHERE execution_id=e.id AND kind='execution.dispatching' LIMIT 1) AS started_at FROM task_executions e
      JOIN execution_tasks t ON t.id=e.task_id LEFT JOIN runtime_bindings r ON r.task_id=e.task_id
      LEFT JOIN execution_workloads w ON w.execution_id=e.id WHERE e.id=?`).get(id) as Row | undefined;
    return row ? {
      id: String(row.id), taskId: String(row.task_id), ordinal: Number(row.ordinal), phase: row.phase as Phase,
      message: JSON.parse(String(row.message_json)) as Message, endTask: row.end_task === 1,
      workerId: row.worker_id as string | null, generation: Number(row.generation), leaseUntil: Number(row.lease_until),
      requestId: row.request_id as string | null, outcome: row.outcome_json ? JSON.parse(String(row.outcome_json)) as OutcomeReport : null,
      workloadId: row.workload_id as string | null,
      canceled: row.canceled === 1, profileId: String(row.profile_id), createdAt: Number(row.created_at),
      startedAt: row.started_at === null ? null : Number(row.started_at),
      uncertainReason: row.uncertain_reason as string | null,
      runtime: row.instance_id ? { instanceId: String(row.instance_id), threadId: String(row.thread_id), profileId: String(row.profile_id) } : null
    } : undefined;
  }

  list(scope: Scope, params: ListTasksRequest): ListTasksResponse {
    this.validateScope(scope);
    const pageSize = params.pageSize ?? 50;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
        (params.statusTimestampAfter && !Number.isFinite(Date.parse(params.statusTimestampAfter)))) {
      throw new TaskStoreError("invalid", "invalid task list filter");
    }
    const filter = contentHash({ scope, contextId: params.contextId, status: params.status,
      after: params.statusTimestampAfter ?? null });
    let cursor = { created: Number.MAX_SAFE_INTEGER, id: "", ceiling: this.clock(), filter };
    if (params.pageToken) {
      try {
        if (params.pageToken.length > 1024) throw new Error();
        const decoded = JSON.parse(Buffer.from(params.pageToken, "base64url").toString()) as typeof cursor;
        if (!Number.isSafeInteger(decoded.created) || !Number.isSafeInteger(decoded.ceiling) ||
            typeof decoded.id !== "string" || decoded.id.length > 128 || decoded.filter !== filter) throw new Error();
        cursor = decoded;
      } catch { throw new TaskStoreError("invalid", "invalid task list cursor"); }
    }
    const where = `tenant=? AND subject=? AND created_at<=? AND (?='' OR context_id=?)
      AND (?=0 OR json_extract(task_json,'$.status.state')=?)
      AND (? IS NULL OR json_extract(task_json,'$.status.timestamp')>=?)`;
    const after = params.statusTimestampAfter ? new Date(params.statusTimestampAfter).toISOString() : null;
    const bindings = [scope.tenant, scope.subject, cursor.ceiling, params.contextId, params.contextId, params.status, params.status, after, after];
    const count = this.db.prepare(`SELECT count(*) AS n FROM execution_tasks WHERE ${where}`).get(...bindings) as Row;
    const rows = this.db.prepare(`SELECT task_json,created_at,id FROM execution_tasks WHERE ${where}
      AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...bindings, cursor.created, cursor.created, cursor.id, pageSize + 1) as Row[];
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return { tasks: page.map(row => {
      const task = taskView(JSON.parse(String(row.task_json)) as Task, params.historyLength ?? 0);
      if (!params.includeArtifacts) task.artifacts = [];
      return task;
    }), totalSize: Number(count.n), pageSize,
    nextPageToken: rows.length > pageSize && last ? Buffer.from(JSON.stringify({
      created: Number(last.created_at), id: String(last.id), ceiling: cursor.ceiling, filter
    })).toString("base64url") : "" };
  }

  snapshot(scope: Scope, taskId: string): { task: Task; sequence: number } {
    return this.transaction(() => {
      const task = this.get(scope, taskId);
      const row = this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM task_events WHERE task_id=?").get(taskId) as Row;
      return { task, sequence: Number(row.n) };
    });
  }

  configureAdmission(maxActive: number): void {
    this.validateAdmissionLimit(maxActive);
    this.transaction(() => this.assertAdmissionLimit(maxActive));
  }

  admission(): Admission {
    const row = this.db.prepare(`SELECT
      (SELECT max_active FROM execution_admission WHERE id=1) AS max_active,
      (SELECT count(*) FROM task_executions WHERE phase NOT IN ('queued','settled','uncertain')) AS reserved`).get() as Row;
    return { maxActive: row.max_active === null ? null : Number(row.max_active), reserved: Number(row.reserved) };
  }

  changeAdmissionLimit(expected: number, maxActive: number): Admission {
    this.validateAdmissionLimit(expected);
    this.validateAdmissionLimit(maxActive);
    return this.transaction(() => {
      const current = this.admission();
      if (current.maxActive !== expected) throw new TaskStoreError("conflict", "stored admission limit does not match the expected limit");
      if (current.reserved !== 0) throw new TaskStoreError("conflict", "compute reservations must drain before changing the admission limit");
      this.db.prepare("UPDATE execution_admission SET max_active=? WHERE id=1").run(maxActive);
      return { maxActive, reserved: 0 };
    });
  }

  claim(workerId: string, leaseMs: number, maxActive: number): { execution: Execution; lease: Lease; recovered: boolean } | undefined {
    if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new TaskStoreError("invalid", "invalid worker lease or concurrency limit");
    }
    return this.transaction(() => {
      // Check on every claim so already-open workers cannot bypass an operator change.
      this.assertAdmissionLimit(maxActive);
      const now = this.clock();
      let row = this.db.prepare(`SELECT id FROM task_executions WHERE phase NOT IN ('queued','settled','uncertain')
        AND lease_until<=? ORDER BY created_at,ordinal LIMIT 1`).get(now) as Row | undefined;
      const recovered = Boolean(row);
      if (!row) {
        if (this.admission().reserved >= maxActive) return undefined;
        row = this.db.prepare(`SELECT e.id FROM task_executions e WHERE e.phase='queued' AND NOT EXISTS
          (SELECT 1 FROM task_executions p WHERE p.task_id=e.task_id AND p.ordinal<e.ordinal AND p.phase!='settled')
          ORDER BY e.created_at,e.ordinal,e.id LIMIT 1`).get() as Row | undefined;
      }
      if (!row) return undefined;
      const id = String(row.id);
      this.db.prepare(`UPDATE task_executions SET worker_id=?,generation=generation+1,lease_until=?,
        phase=CASE WHEN phase='queued' THEN CASE WHEN EXISTS(SELECT 1 FROM runtime_bindings WHERE task_id=task_executions.task_id)
          THEN 'ready' ELSE 'provisioning' END ELSE phase END WHERE id=?`).run(workerId, now + leaseMs, id);
      const execution = this.execution(id)!;
      const lease: Lease = { executionId: id, workerId, generation: execution.generation };
      this.append(execution.taskId, id, recovered ? "execution.recovered" : "execution.claimed", { generation: lease.generation, phase: execution.phase });
      this.setStatus(execution.taskId, TaskState.TASK_STATE_WORKING, "Execution acquired", { executionId: id, resourcesReleased: false });
      return { execution, lease, recovered };
    });
  }

  heartbeat(lease: Lease, leaseMs: number): void {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TaskStoreError("invalid", "invalid lease duration");
    this.transaction(() => {
      this.assertLease(lease);
      this.db.prepare("UPDATE task_executions SET lease_until=? WHERE id=?").run(this.clock() + leaseMs, lease.executionId);
    });
  }

  bind(lease: Lease, runtime: Runtime): void {
    this.transaction(() => {
      const execution = this.assertLease(lease);
      if (execution.phase !== "provisioning" || runtime.profileId !== execution.profileId || !runtime.instanceId || !runtime.threadId) {
        throw new TaskStoreError("conflict", "runtime cannot be bound to this execution");
      }
      this.db.prepare("INSERT INTO runtime_bindings VALUES(?,?,?,?)").run(execution.taskId, runtime.instanceId, runtime.threadId, runtime.profileId);
      this.db.prepare("UPDATE task_executions SET phase='ready' WHERE id=?").run(execution.id);
      this.append(execution.taskId, execution.id, "runtime.bound", runtime);
    });
  }

  beginDispatch(lease: Lease): Execution {
    return this.transaction(() => {
      const execution = this.assertLease(lease);
      if (execution.phase !== "ready" || execution.canceled) throw new TaskStoreError("conflict", "execution cannot dispatch");
      this.db.prepare("UPDATE task_executions SET phase='dispatching' WHERE id=?").run(execution.id);
      this.append(execution.taskId, execution.id, "execution.dispatching", {});
      return this.execution(execution.id)!;
    });
  }

  recordDispatchReceipt(lease: Lease, receipt: DispatchReceipt): void {
    this.transaction(() => {
      const execution = this.assertLease(lease);
      if (!["dispatching", "releasing"].includes(execution.phase) || !receipt.requestId || receipt.requestId.length > 256 ||
          receipt.workloadId !== undefined && (!receipt.workloadId || receipt.workloadId.length > 256)) {
        throw new TaskStoreError("conflict", "unexpected provider receipt");
      }
      if (execution.requestId && execution.requestId !== receipt.requestId ||
          execution.workloadId && receipt.workloadId && execution.workloadId !== receipt.workloadId) {
        throw new TaskStoreError("conflict", "provider receipt cannot change its binding");
      }
      if (execution.requestId === receipt.requestId && (!receipt.workloadId || execution.workloadId === receipt.workloadId)) return;
      this.db.prepare("UPDATE task_executions SET request_id=? WHERE id=?").run(receipt.requestId, execution.id);
      if (receipt.workloadId && !execution.workloadId) this.db.prepare("INSERT INTO execution_workloads VALUES(?,?)").run(execution.id, receipt.workloadId);
      this.append(execution.taskId, execution.id, "execution.provider_receipt", receipt);
    });
  }

  retiredRequestIds(executionId: string): string[] {
    const execution = this.execution(executionId);
    if (!execution) throw new TaskStoreError("not_found", "execution not found");
    // Settled predecessors have physical removal evidence. An ambiguous one can
    // only settle through explicit reconciliation; never retire pending work.
    const rows = this.db.prepare(`SELECT request_id FROM task_executions WHERE task_id=? AND ordinal<?
      AND phase='settled' AND request_id IS NOT NULL ORDER BY ordinal`).all(execution.taskId, execution.ordinal) as Row[];
    return rows.map(row => String(row.request_id));
  }

  dispatched(lease: Lease, requestId: string): void {
    this.transaction(() => {
      const execution = this.assertLease(lease);
      if (execution.phase !== "dispatching" || !requestId || execution.requestId && execution.requestId !== requestId) {
        throw new TaskStoreError("conflict", "unexpected dispatch acknowledgement");
      }
      this.db.prepare("UPDATE task_executions SET phase='running',request_id=? WHERE id=?").run(requestId, execution.id);
      this.append(execution.taskId, execution.id, "execution.dispatched", { requestId });
    });
  }

  report(instanceId: string, executionId: string, input: unknown): { sequence: number; duplicate: boolean } {
    const report = reportSchema.parse(input);
    const hash = contentHash(report);
    return this.transaction(() => {
      const execution = this.execution(executionId);
      if (!execution?.runtime || execution.runtime.instanceId !== instanceId) throw new TaskStoreError("not_found", "execution not found");
      const existing = this.db.prepare("SELECT sequence,content_hash FROM task_events WHERE execution_id=? AND event_id=?")
        .get(executionId, report.eventId) as Row | undefined;
      if (existing) {
        if (existing.content_hash !== hash) throw new TaskStoreError("conflict", "eventId already has different content");
        return { sequence: Number(existing.sequence), duplicate: true };
      }
      const count = this.db.prepare("SELECT count(*) AS n FROM task_events WHERE execution_id=? AND event_id IS NOT NULL").get(executionId) as Row;
      if (Number(count.n) >= 1024 && report.kind !== "outcome") throw new TaskStoreError("capacity", "execution event limit reached");
      const size = this.db.prepare("SELECT COALESCE(sum(length(CAST(payload_json AS BLOB))),0) AS n FROM task_events WHERE task_id=? AND event_id IS NOT NULL")
        .get(execution.taskId) as Row;
      if (Number(size.n) + Buffer.byteLength(JSON.stringify(report)) > 4_194_304 && report.kind !== "outcome") {
        throw new TaskStoreError("capacity", "task reporting byte limit reached");
      }
      if (!["dispatching", "running"].includes(execution.phase) || execution.canceled || execution.outcome) {
        throw new TaskStoreError("conflict", "execution no longer accepts events");
      }
      if (report.kind === "artifact" && this.db.prepare(`SELECT 1 FROM task_events WHERE execution_id=?
          AND kind='agent.artifact' AND json_extract(payload_json,'$.artifactId')=?`).get(executionId, report.artifactId)) {
        throw new TaskStoreError("conflict", "artifactId already exists for this execution");
      }
      if (report.kind === "outcome") this.db.prepare("UPDATE task_executions SET outcome_json=? WHERE id=?")
        .run(JSON.stringify(report), executionId);
      const sequence = this.append(execution.taskId, executionId, `agent.${report.kind}`, report, report.eventId, hash);
      if (report.kind === "artifact") {
        const row = this.db.prepare("SELECT task_json FROM execution_tasks WHERE id=?").get(execution.taskId) as Row;
        const task = JSON.parse(String(row.task_json)) as Task;
        task.artifacts.push(taskArtifact(executionId, report));
        this.saveTask(task);
      }
      if (report.kind === "progress") this.setStatus(execution.taskId, TaskState.TASK_STATE_WORKING, report.message, { executionId });
      return { sequence, duplicate: false };
    });
  }

  issueReportingCredential(executionId: string, ttlMs: number): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) throw new TaskStoreError("invalid", "invalid credential lifetime");
    return this.transaction(() => {
      const execution = this.execution(executionId);
      if (!execution?.runtime || !["ready", "dispatching", "running"].includes(execution.phase) || execution.canceled) {
        throw new TaskStoreError("conflict", "execution cannot receive a reporting credential");
      }
      const token = randomBytes(32).toString("base64url");
      this.db.prepare("DELETE FROM reporting_credentials WHERE execution_id=?").run(executionId);
      this.db.prepare("INSERT INTO reporting_credentials VALUES(?,?,?)")
        .run(createHash("sha256").update(token).digest("hex"), executionId, this.clock() + ttlMs);
      this.append(execution.taskId, executionId, "reporting.credential_issued", { expiresAt: this.clock() + ttlMs });
      return token;
    });
  }

  authenticateReporter(token: string): { executionId: string; instanceId: string } | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.db.prepare(`SELECT c.execution_id,r.instance_id FROM reporting_credentials c
      JOIN task_executions e ON e.id=c.execution_id JOIN runtime_bindings r ON r.task_id=e.task_id
      WHERE c.digest=? AND c.expires_at>?`).get(createHash("sha256").update(token).digest("hex"), this.clock()) as Row | undefined;
    return row ? { executionId: String(row.execution_id), instanceId: String(row.instance_id) } : undefined;
  }

  reportingStatus(instanceId: string, executionId: string): ExecutionStatus {
    const execution = this.execution(executionId);
    if (execution?.runtime?.instanceId !== instanceId) throw new TaskStoreError("not_found", "execution not found");
    return { executionId, phase: execution.phase, canceled: execution.canceled, outcome: execution.outcome };
  }

  stopCheck(instanceId: string, executionId: string, checkId: string): StopDecision {
    if (!checkId || checkId.length > 128) throw new TaskStoreError("invalid", "bounded stop check ID required");
    return this.transaction(() => {
      const status = this.reportingStatus(instanceId, executionId);
      // An acknowledgement or cancellation supersedes an old reminder when a hook retries.
      const current = evaluateStop(status, 0);
      if (current.action !== "remind") return current;
      const previous = this.db.prepare("SELECT decision_json FROM stop_checks WHERE execution_id=? AND check_id=?").get(executionId, checkId) as Row | undefined;
      if (previous) return JSON.parse(String(previous.decision_json)) as StopDecision;
      const count = this.db.prepare("SELECT count(*) AS n FROM stop_checks WHERE execution_id=?").get(executionId) as Row;
      const decision = evaluateStop(status, Number(count.n));
      if (Number(count.n) < 3) {
        this.db.prepare("INSERT INTO stop_checks VALUES(?,?,?)").run(executionId, checkId, JSON.stringify(decision));
        this.append(this.execution(executionId)!.taskId, executionId, "execution.stop_check", { checkId, ...decision });
      }
      if (decision.action === "stop") {
        this.db.prepare("UPDATE task_executions SET phase='releasing',uncertain_reason=? WHERE id=?")
          .run("Agent stopped without a durable outcome after bounded reminders", executionId);
        this.setStatus(this.execution(executionId)!.taskId, TaskState.TASK_STATE_WORKING,
          "Outcome reporting exhausted; stopping runtime for reconciliation", { executionId, recoveryRequired: true, automaticRetry: false });
      }
      return decision;
    });
  }

  requestCancel(scope: Scope, taskId: string): Task {
    return this.transaction(() => {
      const task = this.get(scope, taskId);
      if (task.status?.state === TaskState.TASK_STATE_CANCELED) return task;
      if (terminal.has(task.status!.state)) throw new TaskStoreError("conflict", "terminal task cannot be canceled");
      this.db.prepare("UPDATE task_executions SET canceled=1 WHERE task_id=? AND phase!='settled'").run(taskId);
      this.db.prepare("UPDATE task_executions SET phase='settled' WHERE task_id=? AND phase IN ('queued','uncertain')").run(taskId);
      this.append(taskId, null, "task.cancel_requested", {});
      const active = this.db.prepare("SELECT id FROM task_executions WHERE task_id=? AND phase!='settled'").get(taskId);
      this.setStatus(taskId, active ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_CANCELED,
        active ? "Cancellation requested; waiting for runtime termination" : "Task canceled", { cancellationRequested: true });
      return this.get(scope, taskId);
    });
  }

  releasing(lease: Lease): void {
    this.transaction(() => {
      const execution = this.assertLease(lease);
      if (!execution.outcome && !execution.canceled && !execution.uncertainReason) throw new TaskStoreError("conflict", "an acknowledged outcome is required");
      this.db.prepare("UPDATE task_executions SET phase='releasing' WHERE id=?").run(execution.id);
      this.append(execution.taskId, execution.id, "runtime.release_requested", {});
    });
  }

  settle(lease: Lease, evidence: { stopped: boolean }): void {
    this.transaction(() => {
      const execution = this.assertLease(lease);
      if (execution.phase !== "releasing" || !evidence.stopped) throw new TaskStoreError("conflict", "runtime termination must be confirmed");
      this.db.prepare("UPDATE task_executions SET phase=?,worker_id=NULL,lease_until=0 WHERE id=?")
        .run(execution.uncertainReason && !execution.canceled ? "uncertain" : "settled", execution.id);
      const outcome = execution.outcome;
      const state = execution.canceled ? TaskState.TASK_STATE_CANCELED : execution.uncertainReason ? TaskState.TASK_STATE_INPUT_REQUIRED
        : outcome?.outcome === "failed" ? TaskState.TASK_STATE_FAILED
        : outcome?.outcome === "task_completed" || (outcome?.outcome === "turn_done" && execution.endTask) ? TaskState.TASK_STATE_COMPLETED
        : TaskState.TASK_STATE_INPUT_REQUIRED;
      if (terminal.has(state) || execution.uncertainReason) {
        this.db.prepare("UPDATE task_executions SET phase='settled',canceled=1 WHERE task_id=? AND phase='queued'").run(execution.taskId);
      }
      this.append(execution.taskId, execution.id, "runtime.stopped", { instanceId: execution.runtime?.instanceId ?? null });
      const row = this.db.prepare("SELECT task_json FROM execution_tasks WHERE id=?").get(execution.taskId) as Row;
      const task = JSON.parse(String(row.task_json)) as Task;
      if (outcome) task.history.push({ messageId: `outcome:${execution.id}`, taskId: task.id, contextId: task.contextId,
        role: Role.ROLE_AGENT, parts: [{ content: { $case: "text", value: outcome.message }, filename: "", mediaType: "text/plain", metadata: {} }],
        metadata: { executionId: execution.id }, referenceTaskIds: [], extensions: [] });
      this.saveTask(task);
      this.setStatus(execution.taskId, state, execution.canceled ? "Task canceled; runtime stopped"
        : execution.uncertainReason ? "Runtime stopped; operator reconciliation required" : outcome!.message,
        { executionId: execution.id, resourcesReleased: true, reusable: !terminal.has(state) && !execution.uncertainReason,
          uncertainSideEffects: Boolean(execution.uncertainReason || execution.canceled), recoveryRequired: Boolean(execution.uncertainReason && !execution.canceled) });
      this.append(execution.taskId, execution.id, "execution.settled", { state });
    });
  }

  markUncertain(lease: Lease, reason: string): void {
    this.transaction(() => {
      const execution = this.assertLease(lease);
      if (execution.outcome || execution.canceled) {
        this.db.prepare("UPDATE task_executions SET phase='releasing' WHERE id=?").run(execution.id);
        this.append(execution.taskId, execution.id, "runtime.release_requested", { acknowledgedWhileObserving: true });
        return;
      }
      this.db.prepare("UPDATE task_executions SET phase='releasing',uncertain_reason=? WHERE id=?").run(reason, execution.id);
      this.append(execution.taskId, execution.id, "execution.uncertain", { reason });
      this.setStatus(execution.taskId, TaskState.TASK_STATE_WORKING, "Execution uncertain; stopping runtime before reconciliation", {
        executionId: execution.id, uncertainSideEffects: true, automaticRetry: false, recoveryRequired: true
      });
    });
  }

  resolveUncertain(scope: Scope, executionId: string, resolution: "continue" | "fail", reason: string): Task {
    if (!["continue", "fail"].includes(resolution) || !reason.trim() || reason.length > 4096) {
      throw new TaskStoreError("invalid", "reconciliation decision and explanation are required");
    }
    return this.transaction(() => {
      const execution = this.execution(executionId);
      if (!execution) throw new TaskStoreError("not_found", "execution not found");
      this.get(scope, execution.taskId);
      if (execution.phase !== "uncertain") throw new TaskStoreError("conflict", "execution is not stopped awaiting reconciliation");
      if (resolution === "continue" && execution.startedAt !== null && !execution.requestId) {
        throw new TaskStoreError("conflict", "provider request identity is unknown; continuing could replay an untracked inbox item");
      }
      this.db.prepare("UPDATE task_executions SET phase='settled' WHERE id=?").run(executionId);
      this.append(execution.taskId, executionId, "execution.reconciled", { resolution, reason, actor: scope.subject });
      this.setStatus(execution.taskId, resolution === "fail" ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_INPUT_REQUIRED,
        "Operator reconciled the interrupted execution", { executionId, recoveryRequired: false, automaticRetry: false, reusable: resolution === "continue" });
      return this.get(scope, execution.taskId);
    });
  }

  events(scope: Scope, taskId: string, after = 0, limit = 100): TaskEvent[] {
    this.get(scope, taskId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TaskStoreError("invalid", "invalid event cursor or page size");
    }
    const rows = this.db.prepare("SELECT * FROM task_events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(taskId, after, limit) as Row[];
    return rows.map(row => ({ sequence: Number(row.sequence), taskId, executionId: row.execution_id as string | null,
      at: new Date(Number(row.at)).toISOString(), kind: String(row.kind), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown> }));
  }

  private assertLease(lease: Lease): Execution {
    const execution = this.execution(lease.executionId);
    if (!execution || execution.workerId !== lease.workerId || execution.generation !== lease.generation ||
      execution.leaseUntil <= this.clock() || ["queued", "settled", "uncertain"].includes(execution.phase)) {
      throw new TaskStoreError("stale_lease", "execution lease expired or was superseded");
    }
    return execution;
  }

  private saveTask(task: Task): void {
    this.db.prepare("UPDATE execution_tasks SET task_json=?,updated_at=? WHERE id=?").run(JSON.stringify(task), this.clock(), task.id);
  }

  private setStatus(taskId: string, state: TaskState, text: string, metadata: Record<string, unknown>): void {
    const row = this.db.prepare("SELECT task_json FROM execution_tasks WHERE id=?").get(taskId) as Row;
    const task = JSON.parse(String(row.task_json)) as Task;
    task.status = { state, timestamp: new Date(this.clock()).toISOString(), message: {
      messageId: randomUUID(), taskId, contextId: task.contextId, role: Role.ROLE_AGENT,
      parts: [{ content: { $case: "text", value: text }, filename: "", mediaType: "text/plain", metadata: {} }],
      metadata: {}, referenceTaskIds: [], extensions: []
    } };
    task.metadata = { ...task.metadata, ...metadata };
    this.saveTask(task);
    this.append(taskId, typeof metadata.executionId === "string" ? metadata.executionId : null, "task.status", { status: task.status, metadata });
  }

  private append(taskId: string, executionId: string | null, kind: string, payload: Record<string, unknown>, eventId: string | null = null, hash: string | null = null): number {
    return Number(this.db.prepare("INSERT INTO task_events(task_id,execution_id,at,kind,payload_json,event_id,content_hash) VALUES(?,?,?,?,?,?,?)")
      .run(taskId, executionId, this.clock(), kind, JSON.stringify(payload), eventId, hash).lastInsertRowid);
  }

  private validateScope(scope: Scope): void {
    if (!scope.subject || scope.subject.length > 256 || scope.tenant.length > 256) throw new TaskStoreError("invalid", "authenticated scope required");
  }

  private validateAdmissionLimit(maxActive: number): void {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new TaskStoreError("invalid", "admission limit must be a positive integer");
  }

  private assertAdmissionLimit(maxActive: number): void {
    this.db.prepare("INSERT INTO execution_admission(id,max_active) VALUES(1,?) ON CONFLICT(id) DO NOTHING").run(maxActive);
    const row = this.db.prepare("SELECT max_active FROM execution_admission WHERE id=1").get() as Row;
    if (Number(row.max_active) !== maxActive) throw new TaskStoreError("conflict", "worker concurrency differs from the stored admission limit");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

export function taskView(task: Task, historyLength?: number): Task {
  if (historyLength !== undefined && (!Number.isSafeInteger(historyLength) || historyLength < 0)) {
    throw new TaskStoreError("invalid", "invalid historyLength");
  }
  return { ...task, history: historyLength === undefined ? task.history : historyLength === 0 ? [] : task.history.slice(-historyLength) };
}
