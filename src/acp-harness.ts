import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from "@agentclientprotocol/sdk";
import type { AgentHarness, AgentProfile, HarnessCapabilities, HarnessEvent, PromptInput } from "./harness.js";

type PendingPermission = {
  params: RequestPermissionRequest;
  turnId: string;
  resolve: (response: RequestPermissionResponse) => void;
  timer: NodeJS.Timeout;
};

export class AcpHarness implements AgentHarness {
  readonly profileId: string;
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private capabilities?: HarnessCapabilities;
  private starting?: Promise<HarnessCapabilities>;
  private sink?: (event: HarnessEvent) => void;
  private active = new Map<string, { sessionId: string; turnId: string }>();
  private sessionTurns = new Map<string, string>();
  private permissions = new Map<string, PendingPermission>();
  private permissionSequence = 0;

  constructor(private readonly agentProfile: AgentProfile) {
    this.profileId = agentProfile.id;
  }

  async start(): Promise<HarnessCapabilities> {
    if (this.connection && this.child && !this.child.killed && this.capabilities) return this.capabilities;
    if (!this.starting) this.starting = this.initialize().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async initialize(): Promise<HarnessCapabilities> {
    const child = spawn(this.agentProfile.executable, this.agentProfile.args, {
      env: { ...process.env, ...this.agentProfile.environment, CODEX_HOME: "/state/codex" },
      stdio: "pipe"
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => this.sink?.({ type: "progress", update: { stream: "stderr", text: chunk.toString() } }));
    child.on("exit", (code, signal) => this.handleExit(code, signal));

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const client: Client = {
      requestPermission: (params) => this.requestPermission(params),
      sessionUpdate: (params) => this.sessionUpdate(params)
    };
    this.connection = new ClientSideConnection(() => client, stream);
    try {
      const initialized = await Promise.race([
        this.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "aira-session-coordinator", version: "0.2.0" }
        }),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`ACP initialize timed out for profile ${this.profileId}`)), 30_000);
          timer.unref();
        })
      ]);
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`ACP protocol mismatch: requested ${PROTOCOL_VERSION}, agent selected ${initialized.protocolVersion}`);
      }
      this.capabilities = {
        protocol: "acp",
        loadSession: initialized.agentCapabilities?.loadSession === true,
        cancel: true,
        permissions: true,
        fsCallbacks: false,
        terminalCallbacks: false,
        mcp: initialized.agentCapabilities?.mcpCapabilities !== undefined
      };
      this.validateRequiredCapabilities(this.capabilities);
      return this.capabilities;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async run(input: PromptInput, emit: (event: HarnessEvent) => void): Promise<{ sessionId: string; turnId: string; outcome: unknown }> {
    this.sink = emit;
    await this.start();
    if (!this.connection) throw new Error("ACP harness is not connected");
    let sessionId: string;
    let provider: Record<string, unknown>;
    if (input.sessionId) {
      if (!this.capabilities?.loadSession) throw new Error("ACP agent does not support session/load");
      const loaded = await this.connection.loadSession({ sessionId: input.sessionId, cwd: input.cwd, mcpServers: [] });
      sessionId = input.sessionId;
      provider = { acpSessionId: sessionId, meta: loaded._meta ?? null };
    } else {
      const created = await this.connection.newSession({ cwd: input.cwd, mcpServers: [] });
      sessionId = created.sessionId;
      provider = { acpSessionId: sessionId, meta: created._meta ?? null };
    }
    emit({ type: "session", sessionId, resumed: Boolean(input.sessionId), provider });

    const turnId = randomUUID();
    this.active.set(input.taskId, { sessionId, turnId });
    this.sessionTurns.set(sessionId, turnId);
    emit({ type: "turn", turnId, phase: "started" });
    try {
      const outcome = await this.connection.prompt({ sessionId, prompt: [{ type: "text", text: input.prompt }] });
      const phase = outcome.stopReason === "cancelled" ? "cancelled" : "completed";
      emit({ type: "turn", turnId, phase, outcome });
      return { sessionId, turnId, outcome };
    } catch (error) {
      emit({ type: "error", error: String(error), uncertain: true });
      throw error;
    } finally {
      this.active.delete(input.taskId);
      this.sessionTurns.delete(sessionId);
    }
  }

  async respond(requestId: string, decision: unknown): Promise<void> {
    const pending = this.permissions.get(requestId);
    if (!pending) throw new Error(`permission ${requestId} is not pending`);
    const response = this.permissionResponse(pending.params, decision);
    clearTimeout(pending.timer);
    this.permissions.delete(requestId);
    pending.resolve(response);
    this.sink?.({ type: "permission-response", requestId, turnId: pending.turnId, outcome: response.outcome });
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active || !this.connection) throw new Error(`task ${taskId} is not active`);
    for (const [requestId, pending] of this.permissions) {
      if (pending.params.sessionId !== active.sessionId) continue;
      clearTimeout(pending.timer);
      this.permissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    await this.connection.cancel({ sessionId: active.sessionId });
  }

  async close(): Promise<void> {
    for (const pending of this.permissions.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.connection = undefined;
    this.capabilities = undefined;
  }

  private requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turnId = this.sessionTurns.get(params.sessionId) ?? "replay-or-unknown";
    const requestId = `acp:${params.sessionId}:${params.toolCall.toolCallId}:${++this.permissionSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.permissions.get(requestId);
        if (!pending) return;
        this.permissions.delete(requestId);
        pending.resolve({ outcome: { outcome: "cancelled" } });
        this.sink?.({ type: "permission-response", requestId, turnId, outcome: { outcome: "cancelled", reason: "timeout" } });
      }, 120_000);
      this.permissions.set(requestId, { params, turnId, resolve, timer });
      this.sink?.({
        type: "permission",
        requestId,
        turnId,
        options: params.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind })),
        raw: params
      });
    });
  }

  private sessionUpdate(params: SessionNotification): void {
    if (!this.sink) return;
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk") {
      this.sink({ type: "message", role: update.sessionUpdate === "agent_message_chunk" ? "agent" : "user", content: update.content, raw: params });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.sink({ type: "tool", update, raw: params });
    } else {
      this.sink({ type: "progress", update, raw: params });
    }
  }

  private permissionResponse(params: RequestPermissionRequest, decision: unknown): RequestPermissionResponse {
    const supplied = decision as { outcome?: { outcome?: string; optionId?: string }; decision?: string; optionId?: string };
    if (supplied?.outcome?.outcome === "selected" && supplied.outcome.optionId && params.options.some((option) => option.optionId === supplied.outcome?.optionId)) {
      return { outcome: { outcome: "selected", optionId: supplied.outcome.optionId } };
    }
    if (supplied?.outcome?.outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
    const requestedKind = supplied?.decision === "accept" ? "allow_once" : supplied?.decision === "decline" ? "reject_once" : undefined;
    const selected = params.options.find((option) => option.optionId === supplied?.optionId)
      ?? params.options.find((option) => option.kind === requestedKind);
    return selected ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private validateRequiredCapabilities(capabilities: HarnessCapabilities): void {
    for (const [name, required] of Object.entries(this.agentProfile.requiredCapabilities)) {
      if (required && !capabilities[name as keyof HarnessCapabilities]) throw new Error(`profile ${this.profileId} requires unsupported capability ${name}`);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = `ACP agent exited (${code ?? signal}); active turn side effects are uncertain`;
    this.connection = undefined;
    this.child = undefined;
    this.capabilities = undefined;
    for (const pending of this.permissions.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
    if (this.active.size > 0) this.sink?.({ type: "error", error, uncertain: true });
  }
}
