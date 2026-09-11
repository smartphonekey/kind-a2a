import { randomUUID } from "node:crypto";
import express from "express";
import { AgentEvent, DefaultRequestHandler, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { UserBuilder, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { Role, TaskState, type AgentCard, type Artifact, type Message, type Task, type TaskStatus } from "@a2a-js/sdk";
import { agynBackendFromEnvironment } from "./agyn-backend.js";
import { CONTROLLER_DB, id, now } from "./common.js";
import { Store } from "./db.js";
import type { RuntimeBinding } from "./execution-backend.js";
import { profile } from "./profiles.js";

const store = new Store(CONTROLLER_DB);
const backend = agynBackendFromEnvironment();
const selectedProfile = profile(backend.profileId);
if (selectedProfile.harness !== "agyn") throw new Error(`profile ${selectedProfile.id} is not an Agyn profile`);
const inflight = new Map<string, AbortController>();
const cancellations = new Set<string>();

function textMessage(contextId: string, taskId: string, text: string): Message {
  return { messageId: id("msg"), contextId, taskId, role: Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: text }, metadata: {}, filename: "", mediaType: "text/plain" }],
    metadata: {}, extensions: [], referenceTaskIds: [] };
}

function status(contextId: string, taskId: string, state: TaskState, text: string): TaskStatus {
  return { state, message: textMessage(contextId, taskId, text), timestamp: now() };
}

function newTask(contextId: string, taskId: string, state: TaskState, text: string, metadata: Record<string, unknown>): Task {
  return { id: taskId, contextId, status: status(contextId, taskId, state, text), artifacts: [], history: [], metadata };
}

function runtimeForTask(taskId: string): RuntimeBinding | undefined {
  const workspace = store.workspaceForTask(taskId);
  if (!workspace?.threadId) return undefined;
  return { runtimeId: workspace.workspaceId, threadId: workspace.threadId, instanceId: workspace.sandboxName, profileId: workspace.profileId };
}

function responseArtifact(text: string): Artifact {
  return { artifactId: `response:${randomUUID()}`, name: "agent-response.txt", description: "Final response from the Agyn agent turn",
    metadata: {}, extensions: [], parts: [{ content: { $case: "text", value: text }, metadata: {}, filename: "agent-response.txt", mediaType: "text/plain" }] };
}

const executor: AgentExecutor = {
  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const message = context.userMessage;
    const prompt = message.parts.find((part) => part.content?.$case === "text")?.content?.value;
    if (!prompt) throw new Error("A2A message requires a text part");
    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : message.messageId;

    if (!context.task) {
      const duplicate = store.findDuplicateSubmission(idempotencyKey);
      if (duplicate) { bus.publish(AgentEvent.task(duplicate)); bus.finished(); return; }
      const submitted = newTask(context.contextId, context.taskId, TaskState.TASK_STATE_SUBMITTED,
        "A2A task persisted; creating an isolated Agyn thread and agent instance",
        { idempotencyKey, runtimeId: context.taskId, isolationScope: "a2a-task", backend: "agyn", profileId: backend.profileId });
      store.bindTask(context.taskId, context.contextId, context.taskId, idempotencyKey, submitted);
      bus.publish(AgentEvent.task(submitted));
    } else {
      const copies = (context.task.history ?? []).filter((item) => item.messageId === message.messageId).length;
      if (copies > 1) { bus.publish(AgentEvent.task(context.task)); bus.finished(); return; }
      store.transitionTask(context.taskId, status(context.contextId, context.taskId, TaskState.TASK_STATE_SUBMITTED,
        "A2A continuation persisted; resuming the task's Agyn instance"));
      const submitted = await store.load(context.taskId, context.context);
      if (submitted) bus.publish(AgentEvent.task(submitted));
    }

    const executionId = randomUUID();
    store.setTaskExecution(context.taskId, executionId);
    const working = status(context.contextId, context.taskId, TaskState.TASK_STATE_WORKING, "Agyn is processing the agent turn");
    store.transitionTask(context.taskId, working, { executionId });
    store.event(context.taskId, "a2a/status", { status: working, executionId });
    bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: working, metadata: { executionId } }));

    const abort = new AbortController();
    inflight.set(context.taskId, abort);
    let runtime = runtimeForTask(context.taskId);
    try {
      const result = runtime
        ? await backend.continue(runtime, prompt, abort.signal)
        : await backend.start(context.taskId, prompt, abort.signal, async (binding) => {
            runtime = binding;
            store.createWorkspace(context.taskId, binding.instanceId, "task-workspace", selectedProfile);
            store.updateWorkspace(context.taskId, { threadId: binding.threadId, sessionId: binding.threadId,
              providerResume: { instanceId: binding.instanceId } });
          });
      runtime = result;
      if (!store.workspace(context.taskId)) {
        store.createWorkspace(context.taskId, result.instanceId, "task-workspace", selectedProfile);
      }
      store.updateWorkspace(context.taskId, { threadId: result.threadId, sessionId: result.threadId,
        providerResume: { instanceId: result.instanceId, requestMessageId: result.requestMessageId, responseMessageId: result.responseMessageId } });
      store.event(context.taskId, "agyn/turn", result);

      await backend.release(result);
      const artifact = responseArtifact(result.response);
      bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId, artifact, append: false, lastChunk: true, metadata: {} }));
      const endTask = metadata.endTask === true;
      const finalState = endTask ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_INPUT_REQUIRED;
      const finalStatus = status(context.contextId, context.taskId, finalState,
        endTask ? "Agent turn completed; Agyn compute release requested" : "Agent turn completed and compute release requested; send another message to resume this task");
      const finalMetadata = { executionId, threadId: result.threadId, instanceId: result.instanceId,
        resourcesReleaseRequested: true, reusable: !endTask, profileId: backend.profileId };
      store.transitionTask(context.taskId, finalStatus, finalMetadata, [artifact]);
      store.event(context.taskId, "a2a/status", { status: finalStatus, metadata: finalMetadata });
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: finalStatus, metadata: finalMetadata }));
    } catch (error) {
      let releaseRequested = false;
      if (runtime) {
        try {
          await backend.release(runtime);
          releaseRequested = true;
        } catch (releaseError) {
          store.event(context.taskId, "agyn/release-error", { error: String(releaseError) });
        }
      }
      if (cancellations.has(context.taskId)) {
        const canceled = status(context.contextId, context.taskId, TaskState.TASK_STATE_CANCELED,
          "Agyn pause requested; in-flight side effects may still complete");
        store.transitionTask(context.taskId, canceled, { executionId, cancellationRequested: true,
          resourcesReleaseRequested: releaseRequested, uncertainSideEffects: true, automaticRetry: false });
        bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: canceled, metadata: {} }));
      } else {
        const failed = status(context.contextId, context.taskId, TaskState.TASK_STATE_FAILED, `Agyn turn failed: ${String(error)}`);
        store.transitionTask(context.taskId, failed, { executionId, resourcesReleaseRequested: releaseRequested,
          uncertainSideEffects: true, automaticRetry: false });
        store.event(context.taskId, "a2a/status", { status: failed, error: String(error) });
        bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: failed, metadata: { uncertainSideEffects: true } }));
      }
    } finally {
      inflight.delete(context.taskId);
      cancellations.delete(context.taskId);
      bus.finished();
    }
  },

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const existing = await store.load(taskId, {} as never);
    if (!existing) throw new Error(`unknown task ${taskId}`);
    cancellations.add(taskId);
    inflight.get(taskId)?.abort(new Error("A2A cancellation requested"));
    const runtime = runtimeForTask(taskId);
    if (runtime) await backend.cancel(runtime);
    const canceled = status(existing.contextId, taskId, TaskState.TASK_STATE_CANCELED,
      "Agyn pause requested; in-flight side effects may still complete");
    store.transitionTask(taskId, canceled, { cancellationRequested: true, resourcesReleaseRequested: true,
      uncertainSideEffects: true, automaticRetry: false });
    bus.publish(AgentEvent.statusUpdate({ taskId, contextId: existing.contextId, status: canceled, metadata: {} }));
    bus.finished();
  }
};

const port = Number(process.env.AIRA_PORT ?? "8082");
const publicUrl = process.env.AIRA_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const card: AgentCard = {
  name: "AIRA Agyn A2A Adapter", description: "A2A tasks mapped one-to-one onto isolated Agyn agent instances", version: "0.4.0",
  provider: { organization: "AIRA local lab", url: "https://a2a-protocol.org/" },
  supportedInterfaces: [{ url: `${publicUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
  capabilities: { streaming: true, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [],
  defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], signatures: [],
  skills: [{ id: "agyn-isolated-task", name: "Agyn isolated task", description: "Runs one persistent Agyn instance per A2A task and releases compute between turns.",
    tags: ["coding", "agyn", "kubernetes", "isolation"], examples: ["Implement a function and tests"], inputModes: ["text/plain"], outputModes: ["text/plain"], securityRequirements: [] }]
};

const handler = new DefaultRequestHandler(card, store, executor);
const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/.well-known/agent-card.json", (_request, response) => response.json(card));
app.get("/healthz", (_request, response) => response.json({ ok: true, backend: "agyn", profileId: backend.profileId }));
app.get("/transcripts/:taskId", (request, response) => response.json({ taskId: request.params.taskId, events: store.transcript(request.params.taskId) }));
app.get("/tasks/:taskId/runtime", async (request, response) => {
  const runtime = runtimeForTask(request.params.taskId);
  if (!runtime) { response.sendStatus(404); return; }
  try { response.json(await backend.inspect(runtime)); }
  catch (error) { response.status(502).json({ error: String(error) }); }
});
app.use("/a2a", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
const host = process.env.AIRA_HOST ?? "127.0.0.1";
app.listen(port, host, () => console.log(`AIRA Agyn A2A adapter listening on ${host}:${port} with profile ${backend.profileId}`));
