import { randomUUID } from "node:crypto";
import express from "express";
import * as k8s from "@kubernetes/client-node";
import { AgentEvent, DefaultRequestHandler, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { UserBuilder, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { Role, TaskState, type AgentCard, type Artifact, type Message, type Task, type TaskStatus } from "@a2a-js/sdk";
import { CONTROLLER_DB, LAB_NAMESPACE, MAX_ACTIVE_SANDBOXES, dnsName, id, now, stableWorkspaceId } from "./common.js";
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
    apiVersion: "agents.x-k8s.io/v1beta1", kind: "Sandbox", metadata: { name: workspace.sandboxName, namespace: LAB_NAMESPACE, labels: { "aira.dev/workspace": workspace.workspaceId } },
    spec: { service: true, podTemplate: { metadata: { labels: { "aira.dev/workspace": workspace.workspaceId } }, spec: {
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

async function ensureSandbox(workspaceId: string): Promise<Workspace> {
  let workspace = store.workspace(workspaceId);
  if (!workspace) {
    const listed = await custom.listNamespacedCustomObject({ group: "agents.x-k8s.io", version: "v1beta1", namespace: LAB_NAMESPACE, plural: "sandboxes" }) as any;
    const active = (listed.items ?? listed.body?.items ?? []).filter((item: any) => item.spec?.operatingMode !== "Suspended").length;
    if (active >= MAX_ACTIVE_SANDBOXES) throw new Error(`lab permits at most ${MAX_ACTIVE_SANDBOXES} running sandboxes`);
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
    workspace = store.createWorkspace(workspaceId, sandboxName, pvcName, defaultProfile);
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
    const workspaceId = stableWorkspaceId(metadata.workspaceId);
    const idempotencyKey = typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : userMessage.messageId;
    const prompt = userMessage.parts.find((part) => part.content?.$case === "text")?.content?.value;
    if (!prompt) throw new Error("A2A message requires a text part");
    const duplicate = store.findDuplicate(workspaceId, idempotencyKey);
    if (duplicate) { bus.publish(AgentEvent.task(duplicate)); bus.finished(); return; }

    const executionId = randomUUID();
    const a2aTask = task(context.contextId, context.taskId, TaskState.TASK_STATE_SUBMITTED, "work persisted; provisioning sandbox", {
      workspaceId, idempotencyKey, executionId, airaExtension: "metadata.idempotencyKey"
    });
    store.bindTask(context.taskId, context.contextId, workspaceId, idempotencyKey, a2aTask);
    store.setTaskExecution(context.taskId, executionId);
    store.event(context.taskId, "a2a/task-submitted", a2aTask);
    bus.publish(AgentEvent.task(a2aTask));
    try {
      const workspace = await ensureSandbox(workspaceId);
      const working = status(context.contextId, context.taskId, TaskState.TASK_STATE_WORKING, `runner ${workspace.sandboxName} is processing an agent turn`);
      const executionMetadata = { executionId, profileId: workspace.profileId, harnessType: workspace.harnessType, harnessVersion: workspace.harnessVersion };
      store.event(context.taskId, "a2a/status", { status: working, metadata: executionMetadata });
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: working, metadata: executionMetadata }));
      const controller = new AbortController(); inflight.set(context.taskId, controller);
      const turn = await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/turn`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ taskId: context.taskId, workspaceId, sessionId: workspace.sessionId, threadId: workspace.threadId, prompt })
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
            store.updateWorkspace(workspaceId, {
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
    } finally { cancellations.delete(context.taskId); bus.finished(); }
  },
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const existing = await store.load(taskId, {} as any);
    if (!existing) throw new Error(`unknown task ${taskId}`);
    cancellations.add(taskId);
    const workspace = store.workspace(String((existing.metadata ?? {}).workspaceId));
    try {
      if (workspace) {
        const upstream = await fetch(`http://${workspace.sandboxName}.${LAB_NAMESPACE}.svc.cluster.local:8080/cancel/${taskId}`, { method: "POST" });
        if (!upstream.ok) throw new Error(`runner cancellation failed (${upstream.status}): ${await upstream.text()}`);
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
  name: "AIRA ACP Kubernetes Lab", description: "Persistent profile-selected coding-agent workspaces via Kubernetes Agent Sandbox", version: "0.2.0",
  provider: { organization: "AIRA local lab", url: "https://a2a-protocol.org/" },
  supportedInterfaces: [{ url: `${publicUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
  capabilities: { streaming: true, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [],
  defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain", "application/json"], signatures: [],
  skills: [{ id: "agent-workspace", name: "Persistent coding workspace", description: "Creates or reuses isolated profile-selected agent workspaces.", tags: ["coding", "acp", "kubernetes"], examples: ["Implement a function and tests"], inputModes: ["text/plain"], outputModes: ["text/plain"], securityRequirements: [] }]
};
const handler = new DefaultRequestHandler(card, store, executor);
const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/.well-known/agent-card.json", (_request, response) => response.json(card));
app.get("/healthz", (_request, response) => response.json({ ok: true, defaultProfileId: defaultProfile.id }));
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
