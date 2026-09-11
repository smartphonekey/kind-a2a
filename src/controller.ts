import { randomUUID } from "node:crypto";
import express from "express";
import * as k8s from "@kubernetes/client-node";
import { AgentEvent, DefaultRequestHandler, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { UserBuilder, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { Role, TaskState, type AgentCard, type Artifact, type Message, type Task, type TaskStatus } from "@a2a-js/sdk";
import { CONTROLLER_DB, LAB_NAMESPACE, MAX_ACTIVE_SANDBOXES, RUNNER_IMAGE, dnsName, id, now, redact, stableWorkspaceId } from "./common.js";
import { Store, type Workspace } from "./db.js";

const store = new Store(CONTROLLER_DB);
const kubeConfig = new k8s.KubeConfig();
kubeConfig.loadFromCluster();
const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
const custom = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
const inflight = new Map<string, AbortController>();

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
  return {
    apiVersion: "agents.x-k8s.io/v1beta1", kind: "Sandbox", metadata: { name: workspace.sandboxName, namespace: LAB_NAMESPACE, labels: { "aira.dev/workspace": workspace.workspaceId } },
    spec: { service: true, podTemplate: { metadata: { labels: { "aira.dev/workspace": workspace.workspaceId } }, spec: {
      serviceAccountName: "aira-runner", automountServiceAccountToken: false, terminationGracePeriodSeconds: 15,
      securityContext: { fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{ name: "runner", image: RUNNER_IMAGE, imagePullPolicy: "IfNotPresent", ports: [{ containerPort: 8080, name: "http" }],
        env: [{ name: "SSL_CERT_FILE", value: "/etc/ssl/certs/host-ca-bundle.crt" }],
        resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "2", memory: "3Gi" } },
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, allowPrivilegeEscalation: false, readOnlyRootFilesystem: false, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "Unconfined" } },
        volumeMounts: [{ name: "state", mountPath: "/state" }, { name: "auth-seed", mountPath: "/auth-seed", readOnly: true }, { name: "host-ca", mountPath: "/etc/ssl/certs/host-ca-bundle.crt", subPath: "host-ca-bundle.crt", readOnly: true }],
        readinessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 2, periodSeconds: 3 }
      }],
      volumes: [
        { name: "state", persistentVolumeClaim: { claimName: workspace.pvcName } },
        { name: "auth-seed", secret: { secretName: "aira-codex-auth", items: [{ key: "auth.json", path: "auth.json" }] } },
        { name: "host-ca", configMap: { name: "aira-host-ca", items: [{ key: "ca-certificates.crt", path: "host-ca-bundle.crt" }] } }
      ]
    } } }
  };
}

async function ensureSandbox(workspaceId: string): Promise<Workspace> {
  let workspace = store.workspace(workspaceId);
  if (!workspace) {
    const active = store.db.prepare("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number };
    if (active.count >= MAX_ACTIVE_SANDBOXES) throw new Error(`lab permits at most ${MAX_ACTIVE_SANDBOXES} workspaces`);
    const sandboxName = dnsName(workspaceId);
    const pvcName = `${sandboxName}-state`;
    try { await core.readNamespacedPersistentVolumeClaim({ namespace: LAB_NAMESPACE, name: pvcName }); }
    catch (error) {
      if (!isNotFound(error)) throw error;
      await core.createNamespacedPersistentVolumeClaim({ namespace: LAB_NAMESPACE, body: {
        metadata: { name: pvcName, labels: { "aira.dev/workspace": workspaceId } },
        spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "2Gi" } } }
      } });
    }
    workspace = store.createWorkspace(workspaceId, sandboxName, pvcName);
  }
  try { await sandboxStatus(workspace.sandboxName); }
  catch (error) {
    if (!isNotFound(error)) throw error;
    await custom.createNamespacedCustomObject({ group: "agents.x-k8s.io", version: "v1beta1", namespace: LAB_NAMESPACE, plural: "sandboxes", body: sandboxResource(workspace) });
  }
  await waitForSandbox(workspace);
  return workspace;
}

async function waitForSandbox(workspace: Workspace): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const sandbox: any = await sandboxStatus(workspace.sandboxName);
      const conditions = sandbox.status?.conditions ?? [];
      const ready = conditions.some((condition: any) => condition.type === "Ready" && condition.status === "True");
      const podUid = sandbox.status?.podRef?.uid ?? sandbox.status?.pod?.uid;
      if (podUid) store.updateWorkspace(workspace.workspaceId, { podUid: String(podUid) });
      if (ready) {
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
    const workspaceId = stableWorkspaceId(metadata.workspaceId);
    const idempotencyKey = typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : userMessage.messageId;
    const prompt = userMessage.parts.find((part) => part.content?.$case === "text")?.content?.value;
    if (!prompt) throw new Error("A2A message requires a text part");
    const duplicate = store.findDuplicate(workspaceId, idempotencyKey);
    if (duplicate) { bus.publish(AgentEvent.task(duplicate)); bus.finished(); return; }

    const a2aTask = task(context.contextId, context.taskId, TaskState.TASK_STATE_SUBMITTED, "work persisted; provisioning sandbox", { workspaceId, idempotencyKey, airaExtension: "metadata.idempotencyKey" });
    store.bindTask(context.taskId, context.contextId, workspaceId, idempotencyKey, a2aTask);
    store.event(context.taskId, "a2a/task-submitted", a2aTask);
    bus.publish(AgentEvent.task(a2aTask));
    try {
      const workspace = await ensureSandbox(workspaceId);
      const working = status(context.contextId, context.taskId, TaskState.TASK_STATE_WORKING, `runner ${workspace.sandboxName} is processing Codex turn`);
      store.event(context.taskId, "a2a/status", working); bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: working, metadata: {} }));
      const controller = new AbortController(); inflight.set(context.taskId, controller);
      const turn = await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/turn`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ taskId: context.taskId, workspaceId, threadId: workspace.threadId, prompt })
      });
      if (!turn.ok) throw new Error(`runner returned ${turn.status}: ${await turn.text()}`);
      for await (const frame of sse(turn)) {
        const event = (frame as { event?: { method?: string; params?: any } }).event ?? {};
        store.event(context.taskId, "codex/observable", event);
        const method = event.method ?? "runner/event";
        if (method === "runner/thread" && event.params?.threadId) store.updateWorkspace(workspaceId, { threadId: String(event.params.threadId) });
        if (method === "runner/approval-required") {
          const required = status(context.contextId, context.taskId, TaskState.TASK_STATE_INPUT_REQUIRED, "Codex requested approval; use the runner approval endpoint to resolve it.");
          bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: required, metadata: { requestId: event.params?.requestId } }));
        } else if (method !== "item/agentMessage/delta") {
          const progress = status(context.contextId, context.taskId, TaskState.TASK_STATE_WORKING, `Codex event: ${method}`);
          bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: progress, metadata: { observableEvent: method } }));
        }
      }
      inflight.delete(context.taskId);
      const files = await (await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/artifacts`)).json() as { files: Array<{ path: string; text: string }> };
      for (const file of files.files) {
        const output = artifact(file); store.event(context.taskId, "a2a/artifact", output);
        bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId, artifact: output, append: false, lastChunk: true, metadata: {} }));
      }
      const complete = status(context.contextId, context.taskId, TaskState.TASK_STATE_COMPLETED, "Codex turn completed; artifacts exported from persistent workspace");
      store.event(context.taskId, "a2a/status", complete); bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: complete, metadata: {} }));
    } catch (error) {
      inflight.delete(context.taskId);
      const failed = status(context.contextId, context.taskId, TaskState.TASK_STATE_FAILED, `interrupted or failed: ${String(error)}`);
      store.event(context.taskId, "a2a/status", failed); bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: failed, metadata: {} }));
    } finally { bus.finished(); }
  },
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const existing = await store.load(taskId, {} as any);
    if (!existing) throw new Error(`unknown task ${taskId}`);
    inflight.get(taskId)?.abort();
    const workspace = store.workspace(String((existing.metadata ?? {}).workspaceId));
    if (workspace) await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/cancel/${taskId}`, { method: "POST" }).catch(() => undefined);
    const canceled = status(existing.contextId, taskId, TaskState.TASK_STATE_CANCELED, "cancellation requested; runner interrupted");
    store.event(taskId, "a2a/status", canceled); bus.publish(AgentEvent.statusUpdate({ taskId, contextId: existing.contextId, status: canceled, metadata: {} })); bus.finished();
  }
};

const publicUrl = process.env.AIRA_PUBLIC_URL ?? "http://127.0.0.1:8081";
const card: AgentCard = {
  name: "AIRA Codex Kubernetes Lab", description: "Persistent Codex coding workspaces via Kubernetes Agent Sandbox", version: "0.1.0",
  provider: { organization: "AIRA local lab", url: "https://a2a-protocol.org/" },
  supportedInterfaces: [{ url: `${publicUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
  capabilities: { streaming: true, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [],
  defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain", "application/json"], signatures: [],
  skills: [{ id: "codex-workspace", name: "Persistent coding workspace", description: "Creates or reuses isolated Codex-backed Kubernetes workspaces.", tags: ["coding", "codex", "kubernetes"], examples: ["Implement a function and tests"], inputModes: ["text/plain"], outputModes: ["text/plain"], securityRequirements: [] }]
};
const handler = new DefaultRequestHandler(card, store, executor);
const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/.well-known/agent-card.json", (_request, response) => response.json(card));
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.get("/transcripts/:taskId", (request, response) => response.json({ taskId: request.params.taskId, events: store.transcript(request.params.taskId) }));
app.get("/workspaces/:workspaceId", (request, response) => {
  const workspace = store.workspace(request.params.workspaceId); if (!workspace) { response.sendStatus(404); return; } response.json(workspace);
});
app.post("/workspaces/:workspaceId/approvals/:requestId", async (request, response) => {
  const workspace = store.workspace(request.params.workspaceId);
  if (!workspace) { response.sendStatus(404); return; }
  const upstream = await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/approval/${encodeURIComponent(request.params.requestId)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body)
  });
  response.status(upstream.status).send(await upstream.text());
});
app.use("/a2a", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.listen(8081, "0.0.0.0", () => console.log(`AIRA A2A controller listening on 8081 in ${LAB_NAMESPACE}`));
