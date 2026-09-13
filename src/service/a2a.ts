// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from "node:timers/promises";
import { type AgentCard, type Task, type SendMessageRequest, type GetTaskRequest, type CancelTaskRequest,
  type ListTasksRequest, type StreamResponse, type SubscribeToTaskRequest, TaskState } from "@a2a-js/sdk";
import { type A2ARequestHandler, type ServerCallContext } from "@a2a-js/sdk/server";
import { ContentTypeNotSupportedError, ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError,
  RequestMalformedError, TaskNotCancelableError, TaskNotFoundError, JsonRpcTransportError } from "@a2a-js/sdk/errors";
import { DurableTaskStore, TaskStoreError, taskView, type Scope, type Submission } from "./task-store.js";
import type { Principal } from "./auth.js";
import { reportSchema } from "./events.js";
import { taskArtifact } from "./artifacts.js";

export const PRINCIPAL = "execution.principal";
export const SIGNAL = "execution.signal";
export const CHECK_AUTH = "execution.check_auth";

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
    private readonly defaultProfile: string, private readonly pollMs = 250, private readonly waitMs = 30_000) {}

  async getAgentCard(): Promise<AgentCard> { return this.card; }
  async getAuthenticatedExtendedAgentCard(): Promise<never> { throw new ExtendedAgentCardNotConfiguredError(); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    const scope = this.scope(context, params.tenant);
    const submitted = this.submit(scope, params);
    if (!params.configuration?.returnImmediately) {
      const deadline = Date.now() + this.waitMs;
      while (Date.now() < deadline && !this.signal(context).aborted) {
        await this.checkAuth(context);
        if (["settled", "uncertain"].includes(this.store.execution(submitted.execution.id)!.phase)) break;
        await delay(this.pollMs, undefined, { signal: this.signal(context) }).catch(() => {});
      }
    }
    return mapped(() => taskView(this.store.get(scope, submitted.task.id), params.configuration?.historyLength));
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
    const submitted = this.submit(scope, params);
    yield* this.watch(scope, submitted.task.id, context, submitted.execution.id, params.configuration?.historyLength);
  }

  async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    yield* this.watch(this.scope(context, params.tenant), params.id, context);
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

  private async *watch(scope: Scope, taskId: string, context: ServerCallContext, executionId?: string, historyLength?: number): AsyncGenerator<StreamResponse> {
    const snapshot = mapped(() => this.store.snapshot(scope, taskId));
    let cursor = snapshot.sequence;
    const view = (task: Task) => ({ ...taskView(task, historyLength ?? 0), artifacts: [] });
    yield { payload: { $case: "task", value: view(snapshot.task) } };
    for (const artifact of snapshot.task.artifacts) yield { payload: { $case: "artifactUpdate", value: {
      taskId, contextId: snapshot.task.contextId, artifact, append: false, lastChunk: true, metadata: { eventSequence: cursor }
    } } };
    const deadline = Date.now() + this.waitMs;
    while (!this.signal(context).aborted && Date.now() < deadline) {
      await this.checkAuth(context);
      const events = mapped(() => this.store.events(scope, taskId, cursor, 100));
      for (const event of events) {
        cursor = event.sequence;
        if (event.kind === "task.status") yield { payload: { $case: "statusUpdate", value: {
          taskId, contextId: snapshot.task.contextId, status: event.payload.status as Task["status"],
          metadata: { ...(event.payload.metadata as object), eventSequence: cursor }
        } } };
        if (event.kind === "agent.artifact" && event.executionId) {
          const report = reportSchema.parse(event.payload);
          if (report.kind === "artifact") yield { payload: { $case: "artifactUpdate", value: {
            taskId, contextId: snapshot.task.contextId, artifact: taskArtifact(event.executionId, report),
            append: false, lastChunk: true, metadata: { eventSequence: cursor }
          } } };
        }
        if (event.kind === "execution.settled") yield { payload: { $case: "task", value: view(this.store.get(scope, taskId)) } };
      }
      if (events.length === 100) continue;
      const done = executionId ? ["settled", "uncertain"].includes(this.store.execution(executionId)!.phase)
        : ![TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING].includes(this.store.get(scope, taskId).status!.state);
      if (done) return;
      await delay(this.pollMs, undefined, { signal: this.signal(context) }).catch(() => {});
    }
  }

  private scope(context: ServerCallContext, tenant: string): Scope {
    const principal = context.state.get(PRINCIPAL) as Principal | undefined;
    if (!context.user?.isAuthenticated || !principal || tenant && tenant !== principal.tenant) throw new TaskNotFoundError();
    return principal;
  }
  private signal(context: ServerCallContext): AbortSignal { return context.state.get(SIGNAL) as AbortSignal; }
  private async checkAuth(context: ServerCallContext): Promise<void> {
    const check = context.state.get(CHECK_AUTH) as () => Promise<void>;
    await check();
  }
}
