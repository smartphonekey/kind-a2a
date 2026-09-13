// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from "node:timers/promises";
import { type AgentCard, Task, type SendMessageRequest, type GetTaskRequest, type CancelTaskRequest,
  type ListTasksRequest, type StreamResponse, type SubscribeToTaskRequest, TaskState } from "@a2a-js/sdk";
import { type A2ARequestHandler, type ServerCallContext } from "@a2a-js/sdk/server";
import { ContentTypeNotSupportedError, ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError,
  RequestMalformedError, TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError, JsonRpcTransportError } from "@a2a-js/sdk/errors";
import { DurableTaskStore, TaskStoreError, taskView, type Scope, type Submission } from "./task-store.js";
import type { Principal } from "./auth.js";
import { reportSchema } from "./events.js";
import { taskArtifact } from "./artifacts.js";

export const PRINCIPAL = "execution.principal";
export const SIGNAL = "execution.signal";
export const CHECK_AUTH = "execution.check_auth";
const terminal = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED]);
const blockingEnd = new Set([...terminal, TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED]);
const snapshotBytes = 1_048_576;

function streamSnapshot(task: Task, historyLength?: number): { task: Task; remainingArtifacts: Task["artifacts"] } {
  let view = taskView(task, historyLength ?? 0);
  const size = (value: Task) => Buffer.byteLength(JSON.stringify(Task.toJSON(value)));
  if (size(view) <= snapshotBytes) return { task: view, remainingArtifacts: [] };
  // The SDK caps SSE frames at 4 MiB; task history/artifacts can exceed that together.
  const remainingArtifacts = view.artifacts;
  view = { ...view, artifacts: [] };
  let low = 0; let high = view.history.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (size(taskView(view, count)) <= snapshotBytes) low = count; else high = count - 1;
  }
  return { task: taskView(view, low), remainingArtifacts };
}

function mapped<T>(fn: () => T): T {
  try { return fn(); }
  catch (error) {
    if (!(error instanceof TaskStoreError)) throw error;
    if (error.code === "not_found") throw new TaskNotFoundError();
    if (error.code === "invalid") throw new RequestMalformedError({ message: error.message });
    throw new JsonRpcTransportError({ jsonrpc: "2.0", id: null, error: {
      code: error.code === "capacity" ? -32029 : -32010,
      message: error.message, data: { reason: error.code }
    } });
  }
}

export class DurableA2AHandler implements A2ARequestHandler {
  constructor(private readonly store: DurableTaskStore, private readonly card: AgentCard,
    private readonly defaultProfile: string, private readonly pollMs = 250) {}

  async getAgentCard(): Promise<AgentCard> { return this.card; }
  async getAuthenticatedExtendedAgentCard(): Promise<never> { throw new ExtendedAgentCardNotConfiguredError(); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    const scope = this.scope(context, params.tenant);
    await this.checkAuth(context);
    const submitted = this.submit(scope, params);
    for (;;) {
      await this.checkAuth(context);
      const execution = this.store.execution(submitted.execution.id)!;
      const task = mapped(() => this.store.get(scope, submitted.task.id));
      // A predecessor's interruption cannot complete this message; a later turn cannot return WORKING.
      if (params.configuration?.returnImmediately ||
          (["settled", "uncertain"].includes(execution.phase) && blockingEnd.has(task.status!.state))) {
        return mapped(() => taskView(task, params.configuration?.historyLength));
      }
      await delay(this.pollMs, undefined, { signal: this.signal(context) });
    }
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    return mapped(() => taskView(this.store.get(this.scope(context, params.tenant), params.id), params.historyLength));
  }

  async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    try { return this.store.requestCancel(this.scope(context, params.tenant), params.id); }
    catch (error) {
      if (error instanceof TaskStoreError && error.code === "conflict") throw new TaskNotCancelableError();
      return mapped(() => { throw error; });
    }
  }

  async listTasks(params: ListTasksRequest, context: ServerCallContext) {
    return mapped(() => this.store.list(this.scope(context, params.tenant), params));
  }

  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    const scope = this.scope(context, params.tenant);
    await this.checkAuth(context);
    const submitted = this.submit(scope, params);
    yield* this.watch(scope, submitted.task.id, context, false, params.configuration?.historyLength);
  }

  async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    yield* this.watch(this.scope(context, params.tenant), params.id, context, true);
  }

  private submit(scope: Scope, params: SendMessageRequest): Submission {
    if (!params.message) throw new RequestMalformedError({ message: "message is required" });
    if (params.configuration?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError();
    const modes = params.configuration?.acceptedOutputModes ?? [];
    if (modes.length && !modes.includes("text/plain")) throw new ContentTypeNotSupportedError();
    mapped(() => taskView({ history: [] } as unknown as Task, params.configuration?.historyLength));
    const selected = params.message.taskId ? mapped(() => this.store.get(scope, params.message!.taskId)).metadata?.profileId : this.defaultProfile;
    return mapped(() => this.store.submit(scope, params.message!, String(selected)));
  }

  private async *watch(scope: Scope, taskId: string, context: ServerCallContext, subscription: boolean, historyLength?: number): AsyncGenerator<StreamResponse> {
    await this.checkAuth(context);
    const snapshot = mapped(() => this.store.snapshot(scope, taskId));
    let cursor = snapshot.sequence;
    if (subscription && terminal.has(snapshot.task.status!.state)) throw new UnsupportedOperationError({ message: "Task is already terminal" });
    const initial = streamSnapshot(snapshot.task, historyLength);
    yield { payload: { $case: "task", value: initial.task } };
    for (const artifact of initial.remainingArtifacts) {
      await this.checkAuth(context);
      yield { payload: { $case: "artifactUpdate", value: {
        taskId, contextId: snapshot.task.contextId, artifact, append: false, lastChunk: true,
        metadata: { snapshotSequence: cursor }
      } } };
    }
    if (terminal.has(snapshot.task.status!.state)) return;
    for (;;) {
      await this.checkAuth(context);
      const events = mapped(() => this.store.events(scope, taskId, cursor, 100));
      for (const event of events) {
        cursor = event.sequence;
        if (event.kind === "task.status") {
          await this.checkAuth(context);
          const status = event.payload.status as NonNullable<Task["status"]>;
          yield { payload: { $case: "statusUpdate", value: {
            taskId, contextId: snapshot.task.contextId, status,
            metadata: { ...(event.payload.metadata as object), eventSequence: cursor }
          } } };
          if (terminal.has(status.state)) return;
        }
        if (event.kind === "agent.artifact" && event.executionId) {
          const report = reportSchema.parse(event.payload);
          if (report.kind === "artifact") {
            await this.checkAuth(context);
            yield { payload: { $case: "artifactUpdate", value: {
              taskId, contextId: snapshot.task.contextId, artifact: taskArtifact(event.executionId, report),
              append: false, lastChunk: true, metadata: { eventSequence: cursor }
            } } };
          }
        }
      }
      if (events.length === 100) continue;
      await delay(this.pollMs, undefined, { signal: this.signal(context) });
    }
  }

  private scope(context: ServerCallContext, tenant: string): Scope {
    const principal = context.state.get(PRINCIPAL) as Principal | undefined;
    if (!context.user?.isAuthenticated || !principal || tenant && tenant !== principal.tenant) throw new TaskNotFoundError();
    return principal;
  }
  private signal(context: ServerCallContext): AbortSignal { return context.state.get(SIGNAL) as AbortSignal; }
  private async checkAuth(context: ServerCallContext): Promise<void> {
    this.signal(context).throwIfAborted();
    const check = context.state.get(CHECK_AUTH) as () => Promise<void>;
    await check();
    this.signal(context).throwIfAborted();
  }
}
