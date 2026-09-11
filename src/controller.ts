import { randomUUID } from "node:crypto";
import express from "express";
import * as k8s from "@kubernetes/client-node";
import { AgentEvent, DefaultRequestHandler, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { UserBuilder, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { Role, TaskState, type AgentCard, type Artifact, type Message, type Task, type TaskStatus } from "@a2a-js/sdk";
import { CONTROLLER_DB, LAB_NAMESPACE, MAX_ACTIVE_SANDBOXES, dnsName, id, now } from "./common.js";
import { Store, type Workspace } from "./db.js";
import { profile } from "./profiles.js";

const store = new Store(CONTROLLER_DB);
const kubeConfig = new k8s.KubeConfig();
kubeConfig.loadFromCluster();
const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
const custom = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
const inflight = new Map<string, AbortController>();
const cancellations = new Set<string>();
const defaultProfile = profile(process.env.AIRA_DEFAULT_PROFILE ?? "codex-acp-v1");
const slotReservations = new Set<string>();
let admissionLock = Promise.resolve();

function textMessage(contextId: string, taskId: string, text: string): Message {
  return { messageId: id("msg"), contextId, taskId, role: Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: text }, metadata: {}, filename: "", mediaType: "text/plain" }],
    metadata: {}, extensions: [], referenceTaskIds: [] };
}

function status(contextId: string, taskId: string, state: TaskState, text: string): TaskStatus {
  return { state, message: textMessage(contextId, taskId, text), timestamp: now() };
}

function task(contextId: string, taskId: string, state: TaskState, text: string, metadata: Record<string, unknown>): Task {
  return { id: taskId, contextId, status: status(contextId, taskId, state, text), artifacts: [], history: [], metadata };
}

function isNotFound(error: unknown): boolean { return (error as { code?: number; response?: { statusCode?: number } }).code === 404 || (error as { response?: { statusCode?: number } }).response?.statusCode === 404; }

async function sandboxStatus(name: string): Promise<any> {
  const response = await custom.getNamespacedCustomObject({ group: "agents.x-k8s.io", version: "v1beta1", namespace: LAB_NAMESPACE, plural: "sandboxes", name });
  return response;
}

function sandboxResource(workspace: Workspace): Record<string, unknown> {
  const agentProfile = profile(workspace.profileId);
  const authSecret = agentProfile.authBinding === "gemini-oauth"
    ? { secretName: "aira-gemini-auth" }
    : { secretName: "aira-codex-auth", items: [{ key: "auth.json", path: "auth.json" }] };
  return {
    apiVersion: "agents.x-k8s.io/v1beta1", kind: "Sandbox", metadata: { name: workspace.sandboxName, namespace: LAB_NAMESPACE, labels: { "aira.dev/task-id": workspace.workspaceId } },
    spec: { service: true, operatingMode: "Running", podTemplate: { metadata: { labels: { "aira.dev/task-id": workspace.workspaceId } }, spec: {
      serviceAccountName: "aira-runner", automountServiceAccountToken: false, terminationGracePeriodSeconds: 15,
      securityContext: { fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{ name: "runner", image: agentProfile.runnerImage, imagePullPolicy: "IfNotPresent", ports: [{ containerPort: 8080, name: "http" }],
        env: [{ name: "SSL_CERT_FILE", value: "/etc/ssl/certs/host-ca-bundle.crt" }, { name: "AIRA_PROFILE_ID", value: agentProfile.id }],
        resources: { requests: { cpu: agentProfile.resources.cpuRequest, memory: agentProfile.resources.memoryRequest }, limits: { cpu: agentProfile.resources.cpuLimit, memory: agentProfile.resources.memoryLimit } },
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, allowPrivilegeEscalation: false, readOnlyRootFilesystem: false, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "Unconfined" } },
        volumeMounts: [{ name: "state", mountPath: "/state" }, { name: "auth-seed", mountPath: "/auth-seed", readOnly: true }, { name: "host-ca", mountPath: "/etc/ssl/certs/host-ca-bundle.crt", subPath: "host-ca-bundle.crt", readOnly: true }],
        readinessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 2, periodSeconds: 3 }
      }],
      volumes: [
        { name: "state", persistentVolumeClaim: { claimName: workspace.pvcName } },
        { name: "auth-seed", secret: authSecret },
        { name: "host-ca", configMap: { name: "aira-host-ca", items: [{ key: "ca-certificates.crt", path: "host-ca-bundle.crt" }] } }
      ]
    } } }
  };
}

async function withAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = admissionLock;
  let release = (): void => undefined;
  admissionLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await operation(); }
  finally { release(); }
}

async function setSandboxMode(name: string, operatingMode: "Running" | "Suspended"): Promise<void> {
  await custom.patchNamespacedCustomObject({
    group: "agents.x-k8s.io", version: "v1beta1", namespace: LAB_NAMESPACE, plural: "sandboxes", name,
    body: [{ op: "add", path: "/spec/operatingMode", value: operatingMode }]
  });
}

async function reserveSandboxSlot(workspace: Workspace, taskId: string): Promise<boolean> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (cancellations.has(taskId)) throw new Error(`task ${taskId} canceled while waiting for capacity`);
    const result = await withAdmissionLock(async (): Promise<"running" | "reserved" | "wait"> => {
      try {
        const current: any = await sandboxStatus(workspace.sandboxName);
        if (current.spec?.operatingMode !== "Suspended") return "running";
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const listed = await custom.listNamespacedCustomObject({ group: "agents.x-k8s.io", version: "v1beta1", namespace: LAB_NAMESPACE, plural: "sandboxes" }) as any;
      const active = (listed.items ?? listed.body?.items ?? []).filter((item: any) => item.spec?.operatingMode !== "Suspended").length;
      if (active + slotReservations.size >= MAX_ACTIVE_SANDBOXES) return "wait";
      slotReservations.add(workspace.workspaceId);
      return "reserved";
    });
    if (result === "running") return false;
    if (result === "reserved") return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timed out waiting for one of ${MAX_ACTIVE_SANDBOXES} active Sandbox slots`);
}

async function ensureSandbox(runtimeId: string, taskId: string): Promise<Workspace> {
  let workspace = store.workspace(runtimeId);
  if (!workspace) {
    const sandboxName = dnsName(runtimeId);
    const pvcName = `${sandboxName}-state`;
    try { await core.readNamespacedPersistentVolumeClaim({ namespace: LAB_NAMESPACE, name: pvcName }); }
    catch (error) {
      if (!isNotFound(error)) throw error;
      await core.createNamespacedPersistentVolumeClaim({ namespace: LAB_NAMESPACE, body: {
        metadata: { name: pvcName, labels: { "aira.dev/task-id": taskId } },
        spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "2Gi" } } }
      } });
    }
    workspace = store.createWorkspace(runtimeId, sandboxName, pvcName, defaultProfile);
  }
  const reserved = await reserveSandboxSlot(workspace, taskId);
  try {
    let existing = true;
    try { await sandboxStatus(workspace.sandboxName); }
    catch (error) {
      if (!isNotFound(error)) throw error;
      existing = false;
    }
    if (existing) await setSandboxMode(workspace.sandboxName, "Running");
    else await custom.createNamespacedCustomObject({ group: "agents.x-k8s.io", version: "v1beta1", namespace: LAB_NAMESPACE, plural: "sandboxes", body: sandboxResource(workspace) });
    await waitForSandbox(workspace);
    return store.workspace(runtimeId)!;
  } finally {
    if (reserved) slotReservations.delete(workspace.workspaceId);
  }
}

async function suspendSandbox(workspace: Workspace): Promise<void> {
  try { await setSandboxMode(workspace.sandboxName, "Suspended"); }
  catch (error) { if (isNotFound(error)) return; else throw error; }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { await core.readNamespacedPod({ namespace: LAB_NAMESPACE, name: workspace.sandboxName }); }
    catch (error) { if (isNotFound(error)) return; else throw error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`sandbox ${workspace.sandboxName} did not release its Pod after suspension`);
}

async function sendApproval(workspace: Workspace, requestId: string, decision: unknown): Promise<void> {
  const upstream = await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/approval/${encodeURIComponent(requestId)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(decision)
  });
  if (!upstream.ok) throw new Error(`runner approval failed (${upstream.status}): ${await upstream.text()}`);
}

async function waitForSandbox(workspace: Workspace): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const sandbox: any = await sandboxStatus(workspace.sandboxName);
      const conditions = sandbox.status?.conditions ?? [];
      const ready = conditions.some((condition: any) => condition.type === "Ready" && condition.status === "True");
      if (ready) {
        const pod = await core.readNamespacedPod({ namespace: LAB_NAMESPACE, name: workspace.sandboxName });
        if (pod.metadata?.uid) store.updateWorkspace(workspace.workspaceId, { podUid: pod.metadata.uid });
        const health = await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/healthz`);
        if (health.ok) return;
      }
    } catch (error) { lastError = String(error); }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`sandbox ${workspace.sandboxName} did not become ready: ${lastError}`);
}

async function* sse(response: Response): AsyncGenerator<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("runner did not provide a response stream");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const line = frame.split("\n").find((item) => item.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6));
    }
  }
}

function artifact(file: { path: string; text: string }): Artifact {
  return { artifactId: `file:${file.path}`, name: file.path, description: "workspace file exported from runner PVC", metadata: { path: file.path }, extensions: [],
    parts: [{ content: { $case: "text", value: file.text }, metadata: {}, filename: file.path, mediaType: "text/plain" }] };
}

const executor: AgentExecutor = {
  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const userMessage = context.userMessage;
    const metadata = (userMessage.metadata ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : userMessage.messageId;
    const prompt = userMessage.parts.find((part) => part.content?.$case === "text")?.content?.value;
    if (!prompt) throw new Error("A2A message requires a text part");
    if (context.task) {
      const copies = (context.task.history ?? []).filter((message) => message.messageId === userMessage.messageId).length;
      if (copies > 1) {
        const duplicate = await store.load(context.taskId, context.context);
        if (duplicate) bus.publish(AgentEvent.task(duplicate));
        bus.finished();
        return;
      }
    } else {
      const duplicate = store.findDuplicateSubmission(idempotencyKey);
      if (duplicate) { bus.publish(AgentEvent.task(duplicate)); bus.finished(); return; }
    }

    const pendingRequestId = context.task?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED
      && typeof context.task.metadata?.requestId === "string" ? context.task.metadata.requestId : undefined;
    if (context.task && pendingRequestId) {
      bus.publish(AgentEvent.task(context.task));
      const normalized = prompt.trim().toLowerCase();
      const decision = metadata.decision === "accept" || ["accept", "approve", "yes"].includes(normalized)
        ? "accept"
        : metadata.decision === "decline" || ["decline", "reject", "no"].includes(normalized) ? "decline" : undefined;
      if (!decision) {
        const required = status(context.contextId, context.taskId, TaskState.TASK_STATE_INPUT_REQUIRED, "Reply with accept or decline for the pending permission request.");
        store.transitionTask(context.taskId, required, { requestId: pendingRequestId });
        bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: required, metadata: { requestId: pendingRequestId } }));
        return;
      }
      const workspace = store.workspaceForTask(context.taskId);
      if (!workspace) throw new Error(`task ${context.taskId} has no runtime for pending approval`);
      await sendApproval(workspace, pendingRequestId, { decision });
      store.event(context.taskId, "a2a/approval-message", { requestId: pendingRequestId, decision, messageId: userMessage.messageId });
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const current = await store.load(context.taskId, context.context);
        const state = current?.status?.state;
        if (state === TaskState.TASK_STATE_COMPLETED || state === TaskState.TASK_STATE_FAILED
          || state === TaskState.TASK_STATE_CANCELED || state === TaskState.TASK_STATE_REJECTED) return;
        if (state === TaskState.TASK_STATE_INPUT_REQUIRED && current?.metadata?.requestId !== pendingRequestId) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`task ${context.taskId} did not settle after approval response`);
    }

    const executionId = randomUUID();
    const existingRuntime = context.task ? store.workspaceForTask(context.taskId) : undefined;
    const runtimeId = existingRuntime?.workspaceId ?? context.taskId;
    const taskMetadata = {
      ...(context.task?.metadata ?? {}), runtimeId, isolationScope: "a2a-task", idempotencyKey, executionId,
      airaExtension: "metadata.idempotencyKey"
    };
    const a2aTask: Task = context.task ? {
      ...context.task,
      status: status(context.contextId, context.taskId, TaskState.TASK_STATE_SUBMITTED, "message persisted; provisioning task sandbox"),
      metadata: taskMetadata
    } : task(context.contextId, context.taskId, TaskState.TASK_STATE_SUBMITTED, "work persisted; provisioning task sandbox", taskMetadata);
    if (context.task) store.transitionTask(context.taskId, a2aTask.status, taskMetadata);
    else store.bindTask(context.taskId, context.contextId, runtimeId, idempotencyKey, a2aTask);
    store.setTaskExecution(context.taskId, executionId);
    store.event(context.taskId, "a2a/task-submitted", a2aTask);
    bus.publish(AgentEvent.task(a2aTask));
    let workspace: Workspace | undefined;
    try {
      workspace = await ensureSandbox(runtimeId, context.taskId);
      const working = status(context.contextId, context.taskId, TaskState.TASK_STATE_WORKING, `runner ${workspace.sandboxName} is processing an agent turn`);
      const executionMetadata = { executionId, profileId: workspace.profileId, harnessType: workspace.harnessType, harnessVersion: workspace.harnessVersion };
      store.event(context.taskId, "a2a/status", { status: working, metadata: executionMetadata });
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: working, metadata: executionMetadata }));
      const controller = new AbortController(); inflight.set(context.taskId, controller);
      const turn = await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/turn`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ taskId: context.taskId, workspaceId: runtimeId, sessionId: workspace.sessionId, threadId: workspace.threadId, prompt })
      });
      if (!turn.ok) throw new Error(`runner returned ${turn.status}: ${await turn.text()}`);
      let runError: { error: string; uncertain: boolean } | undefined;
      let turnFinished = false;
      let turnCancelled = false;
      const seenFrames = new Set<string>();
      for await (const frame of sse(turn)) {
        const envelope = frame as { eventId?: string; sequence?: number; at?: string; sourceProtocol?: string; event?: any };
        const event = envelope.event ?? {};
        const frameKey = JSON.stringify(event);
        if (seenFrames.has(frameKey)) continue;
        seenFrames.add(frameKey);
        store.event(context.taskId, "harness/normalized", {
          executionId,
          eventId: envelope.eventId,
          sequence: envelope.sequence,
          observedAt: envelope.at,
          sourceProtocol: envelope.sourceProtocol ?? workspace.harnessType,
          event
        });
        if (typeof event.type === "string") {
          if (event.type === "session" && event.sessionId) {
            store.updateWorkspace(runtimeId, {
              sessionId: String(event.sessionId),
              threadId: workspace.harnessType === "direct-codex" ? String(event.sessionId) : workspace.threadId,
              providerResume: typeof event.provider === "object" ? event.provider : null
            });
          }
          if (event.type === "turn" && event.turnId) {
            store.setTaskTurn(context.taskId, String(event.turnId));
            if (event.phase === "completed") turnFinished = true;
            if (event.phase === "cancelled") turnCancelled = true;
          }
          if (event.type === "error") runError = { error: String(event.error), uncertain: event.uncertain === true };
          if (event.type === "permission") {
            const required = status(context.contextId, context.taskId, TaskState.TASK_STATE_INPUT_REQUIRED, "The agent requested permission; resolve it through the coordinator approval endpoint.");
            const approvalMetadata = { ...executionMetadata, requestId: event.requestId, turnId: event.turnId, options: event.options };
            store.transitionTask(context.taskId, required, approvalMetadata);
            store.event(context.taskId, "a2a/status", { status: required, metadata: approvalMetadata });
            bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: required, metadata: approvalMetadata }));
          } else if (event.type !== "message") {
            const progress = status(context.contextId, context.taskId, TaskState.TASK_STATE_WORKING, `Agent event: ${event.type}`);
            bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: progress, metadata: { ...executionMetadata, observableEvent: event.type } }));
          }
          continue;
        }

        // Compatibility for workspaces still running the pre-ACP direct runner image.
        const method = event.method ?? "runner/event";
        if (method === "runner/thread" && event.params?.threadId) store.updateWorkspace(runtimeId, { threadId: String(event.params.threadId) });
        if (method === "runner/approval-required") {
          const required = status(context.contextId, context.taskId, TaskState.TASK_STATE_INPUT_REQUIRED, "Codex requested approval; use the runner approval endpoint to resolve it.");
          bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: required, metadata: { requestId: event.params?.requestId } }));
        } else if (method !== "item/agentMessage/delta") {
          const progress = status(context.contextId, context.taskId, TaskState.TASK_STATE_WORKING, `Codex event: ${method}`);
          bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: progress, metadata: { observableEvent: method } }));
        }
      }
      inflight.delete(context.taskId);
      if (runError) {
        const error = new Error(runError.error) as Error & { uncertain?: boolean };
        error.uncertain = runError.uncertain;
        throw error;
      }
      if (turnCancelled || cancellations.has(context.taskId)) {
        const canceled = status(context.contextId, context.taskId, TaskState.TASK_STATE_CANCELED, "agent turn canceled by request");
        const cancellationMetadata = { executionId, cancellationRequested: true, automaticRetry: false };
        store.transitionTask(context.taskId, canceled, cancellationMetadata);
        store.event(context.taskId, "a2a/status", { status: canceled, metadata: cancellationMetadata });
        bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: canceled, metadata: cancellationMetadata }));
        return;
      }
      if (workspace.harnessType !== "direct-codex" && !turnFinished) {
        const error = new Error("runner stream ended without a terminal turn event") as Error & { uncertain?: boolean };
        error.uncertain = true;
        throw error;
      }
      const files = await (await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/artifacts`)).json() as { files: Array<{ path: string; text: string }> };
      const outputs: Artifact[] = [];
      for (const file of files.files) {
        const output = artifact(file); store.event(context.taskId, "a2a/artifact", output);
        outputs.push(output);
        bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId, artifact: output, append: false, lastChunk: true, metadata: {} }));
      }
      const complete = status(context.contextId, context.taskId, TaskState.TASK_STATE_COMPLETED, "Agent turn completed; artifacts exported from persistent workspace");
      store.transitionTask(context.taskId, complete, executionMetadata, outputs);
      store.event(context.taskId, "a2a/status", { status: complete, metadata: executionMetadata });
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: complete, metadata: executionMetadata }));
    } catch (error) {
      inflight.delete(context.taskId);
      if (cancellations.has(context.taskId)) {
        const canceled = status(context.contextId, context.taskId, TaskState.TASK_STATE_CANCELED, "agent turn canceled by request");
        const cancellationMetadata = { executionId, cancellationRequested: true, automaticRetry: false };
        store.transitionTask(context.taskId, canceled, cancellationMetadata);
        store.event(context.taskId, "a2a/status", { status: canceled, metadata: cancellationMetadata });
        bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: canceled, metadata: cancellationMetadata }));
        return;
      }
      const failed = status(context.contextId, context.taskId, TaskState.TASK_STATE_FAILED, `interrupted or failed: ${String(error)}`);
      const uncertain = (error as { uncertain?: boolean }).uncertain !== false;
      const failureMetadata = { executionId, uncertainSideEffects: uncertain, automaticRetry: false };
      store.transitionTask(context.taskId, failed, failureMetadata);
      store.event(context.taskId, "a2a/status", { status: failed, metadata: failureMetadata });
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: failed, metadata: failureMetadata }));
    } finally {
      const runtime = workspace ?? store.workspace(runtimeId);
      if (runtime) {
        try {
          await suspendSandbox(runtime);
          store.event(context.taskId, "sandbox/suspended", { sandboxName: runtime.sandboxName, releasedPod: true });
        } catch (error) {
          const current = await store.load(context.taskId, context.context);
          if (current) store.transitionTask(context.taskId, current.status, { resourceReleaseFailed: true });
          store.event(context.taskId, "sandbox/suspend-failed", { sandboxName: runtime.sandboxName, error: String(error) });
          console.error(`failed to suspend ${runtime.sandboxName}: ${String(error)}`);
        }
      }
      cancellations.delete(context.taskId);
      bus.finished();
    }
  },
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const existing = await store.load(taskId, {} as any);
    if (!existing) throw new Error(`unknown task ${taskId}`);
    cancellations.add(taskId);
    const workspace = store.workspaceForTask(taskId);
    try {
      if (workspace) {
        let running = false;
        try {
          const sandbox: any = await sandboxStatus(workspace.sandboxName);
          running = sandbox.spec?.operatingMode !== "Suspended";
        } catch (error) { if (!isNotFound(error)) throw error; }
        if (running) {
          const upstream = await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/cancel/${taskId}`, { method: "POST" });
          if (!upstream.ok) throw new Error(`runner cancellation failed (${upstream.status}): ${await upstream.text()}`);
        }
      }
    } catch (error) {
      cancellations.delete(taskId);
      throw error;
    }
    const canceled = status(existing.contextId, taskId, TaskState.TASK_STATE_CANCELED, "cancellation requested; runner interrupted");
    store.transitionTask(taskId, canceled, { cancellationRequested: true, automaticRetry: false });
    store.event(taskId, "a2a/status", canceled); bus.publish(AgentEvent.statusUpdate({ taskId, contextId: existing.contextId, status: canceled, metadata: {} })); bus.finished();
  }
};

const publicUrl = process.env.AIRA_PUBLIC_URL ?? "http://127.0.0.1:8081";
const card: AgentCard = {
  name: "AIRA ACP Kubernetes Lab", description: "Task-isolated profile-selected coding agents via Kubernetes Agent Sandbox", version: "0.3.0",
  provider: { organization: "AIRA local lab", url: "https://a2a-protocol.org/" },
  supportedInterfaces: [{ url: `${publicUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
  capabilities: { streaming: true, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [],
  defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain", "application/json"], signatures: [],
  skills: [{ id: "isolated-agent-task", name: "Isolated coding task", description: "Runs each A2A task in its own suspendable persistent Sandbox.", tags: ["coding", "acp", "kubernetes", "isolation"], examples: ["Implement a function and tests"], inputModes: ["text/plain"], outputModes: ["text/plain"], securityRequirements: [] }]
};
const handler = new DefaultRequestHandler(card, store, executor);
const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/.well-known/agent-card.json", (_request, response) => response.json(card));
app.get("/healthz", (_request, response) => response.json({ ok: true, defaultProfileId: defaultProfile.id, maxActiveSandboxes: MAX_ACTIVE_SANDBOXES }));
app.get("/transcripts/:taskId", (request, response) => response.json({ taskId: request.params.taskId, events: store.transcript(request.params.taskId) }));
app.get("/tasks/:taskId/runtime", async (request, response) => {
  const workspace = store.workspaceForTask(request.params.taskId);
  if (!workspace) { response.sendStatus(404); return; }
  try {
    const sandbox: any = await sandboxStatus(workspace.sandboxName);
    response.json({ ...workspace, runtimeId: workspace.workspaceId, operatingMode: sandbox.spec?.operatingMode ?? "Running", podPresent: sandbox.status?.conditions?.some((condition: any) => condition.type === "Ready" && condition.status === "True") === true });
  } catch (error) {
    if (isNotFound(error)) response.json({ ...workspace, runtimeId: workspace.workspaceId, operatingMode: "Missing", podPresent: false });
    else response.status(500).json({ error: String(error) });
  }
});
app.get("/workspaces/:workspaceId", (request, response) => {
  const workspace = store.workspace(request.params.workspaceId); if (!workspace) { response.sendStatus(404); return; } response.json(workspace);
});
async function forwardApproval(workspace: Workspace | undefined, requestId: string, decision: unknown, response: express.Response): Promise<void> {
  if (!workspace) { response.sendStatus(404); return; }
  try { await sendApproval(workspace, requestId, decision); response.json({ accepted: true }); }
  catch (error) { response.status(502).json({ error: String(error) }); }
}
app.post("/tasks/:taskId/approvals/:requestId", async (request, response) => {
  await forwardApproval(store.workspaceForTask(request.params.taskId), request.params.requestId, request.body, response);
});
app.post("/workspaces/:workspaceId/approvals/:requestId", async (request, response) => {
  await forwardApproval(store.workspace(request.params.workspaceId), request.params.requestId, request.body, response);
});
app.use("/a2a", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.listen(8081, "0.0.0.0", () => console.log(`AIRA A2A controller listening on 8081 in ${LAB_NAMESPACE}`));
