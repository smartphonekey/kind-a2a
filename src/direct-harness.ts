import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentHarness, HarnessCapabilities, HarnessEvent, PromptInput } from "./harness.js";
import type { AgentProfile } from "./harness.js";

type RpcMessage = { id?: number; method?: string; params?: Record<string, any>; result?: any; error?: any };

export class DirectCodexHarness extends EventEmitter implements AgentHarness {
  readonly profileId: string;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  private approvals = new Map<string, { turnId: string; requestId: number; resolve: (decision: unknown) => void }>();
  private active = new Map<string, { sessionId: string; turnId: string }>();
  private sink?: (event: HarnessEvent) => void;
  private capabilities?: HarnessCapabilities;
  private starting?: Promise<HarnessCapabilities>;

  constructor(private readonly agentProfile: AgentProfile) { super(); this.profileId = agentProfile.id; }

  async start(): Promise<HarnessCapabilities> {
    if (this.child && !this.child.killed && this.capabilities) return this.capabilities;
    if (!this.starting) this.starting = this.initialize().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async initialize(): Promise<HarnessCapabilities> {
      const child = spawn(this.agentProfile.executable, this.agentProfile.args, { env: { ...process.env, ...this.agentProfile.environment, CODEX_HOME: "/state/codex" }, stdio: "pipe" });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      this.child = child;
      child.stdout.on("data", (chunk: Buffer) => this.read(chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => this.sink?.({ type: "progress", update: { stream: "stderr", text: chunk.toString() } }));
      child.on("exit", (code, signal) => {
        const error = new Error(`direct Codex harness exited (${code ?? signal})`);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear(); this.child = undefined; this.capabilities = undefined;
        this.emit("notification", { method: "harness/exited", params: { code, signal } });
        this.sink?.({ type: "error", error: error.message, uncertain: true });
      });
      await this.request("initialize", { clientInfo: { name: "aira-direct-harness", version: "0.2.0" } });
      this.send({ method: "initialized", params: {} });
      this.capabilities = { protocol: "codex-app-server", loadSession: true, cancel: true, permissions: true, fsCallbacks: false, terminalCallbacks: false, mcp: true };
      return this.capabilities;
  }

  async run(input: PromptInput, emit: (event: HarnessEvent) => void): Promise<{ sessionId: string; turnId: string; outcome: unknown }> {
    this.sink = emit; await this.start();
    const opened = input.sessionId
      ? await this.request("thread/resume", { threadId: input.sessionId, cwd: input.cwd, approvalPolicy: "on-request", sandbox: "workspace-write" })
      : await this.request("thread/start", { cwd: input.cwd, approvalPolicy: "on-request", sandbox: "workspace-write", serviceName: "aira-a2a-lab" });
    const sessionId = String(opened.thread?.id ?? "");
    if (!sessionId) throw new Error("direct Codex harness did not return a thread id");
    emit({ type: "session", sessionId, resumed: Boolean(input.sessionId), provider: { threadId: sessionId } });
    const started = await this.request("turn/start", { threadId: sessionId, input: [{ type: "text", text: input.prompt }], cwd: input.cwd,
      approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: false }, effort: "low" });
    const turnId = String(started.turn?.id ?? randomUUID());
    this.active.set(input.taskId, { sessionId, turnId }); emit({ type: "turn", turnId, phase: "started" });
    const outcome = await new Promise<unknown>((resolve, reject) => {
      const listener = (message: RpcMessage) => {
        const eventTurnId = String(message.params?.turn?.id ?? message.params?.turnId ?? "");
        if (message.method === "turn/completed" && eventTurnId === turnId) { this.off("notification", listener); resolve(message); }
        if (message.method === "harness/exited") { this.off("notification", listener); reject(new Error("direct harness exited mid-turn; side effects are uncertain")); }
      };
      this.on("notification", listener);
    });
    this.active.delete(input.taskId); emit({ type: "turn", turnId, phase: "completed", outcome });
    return { sessionId, turnId, outcome };
  }

  async respond(requestId: string, decision: unknown): Promise<void> {
    const pending = this.approvals.get(requestId); if (!pending) throw new Error(`permission ${requestId} is not pending`);
    this.approvals.delete(requestId); pending.resolve(decision);
    this.sink?.({ type: "permission-response", requestId, turnId: pending.turnId, outcome: decision });
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId); if (!active) throw new Error(`task ${taskId} is not active`);
    await this.request("turn/interrupt", { threadId: active.sessionId, turnId: active.turnId });
    this.sink?.({ type: "turn", turnId: active.turnId, phase: "cancelled" });
  }

  async close(): Promise<void> { this.child?.kill("SIGTERM"); this.child = undefined; this.capabilities = undefined; }

  private read(chunk: string): void {
    this.buffer += chunk;
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, boundary).trim(); this.buffer = this.buffer.slice(boundary + 1); if (!line) continue;
      let message: RpcMessage; try { message = JSON.parse(line) as RpcMessage; } catch { this.sink?.({ type: "error", error: "invalid direct harness JSON", uncertain: false }); continue; }
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const pending = this.pending.get(message.id); if (!pending) continue; this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(String(message.error?.message ?? JSON.stringify(message.error)))); else pending.resolve(message.result);
      } else if (typeof message.id === "number" && message.method) this.serverRequest(message);
      else if (message.method) { this.emit("notification", message); this.normalize(message); }
    }
  }

  private serverRequest(message: RpcMessage): void {
    if (typeof message.id !== "number" || !message.method) return;
    const supported = message.method.includes("requestApproval") || message.method.includes("requestUserInput");
    if (!supported) { this.send({ id: message.id, result: { decision: "decline" } }); return; }
    const requestId = `${message.method}:${message.id}`; const turnId = String(message.params?.turnId ?? "unknown");
    this.approvals.set(requestId, { requestId: message.id, turnId, resolve: (decision) => this.send({ id: message.id, result: decision }) });
    this.sink?.({ type: "permission", requestId, turnId, options: [], raw: message });
    setTimeout(() => {
      const pending = this.approvals.get(requestId);
      if (pending) {
        this.approvals.delete(requestId);
        pending.resolve({ decision: "decline" });
        this.sink?.({ type: "permission-response", requestId, turnId, outcome: { decision: "decline", reason: "timeout" } });
      }
    }, 120_000);
  }

  private normalize(message: RpcMessage): void {
    if (!this.sink) return;
    if (message.method?.includes("agentMessage")) this.sink({ type: "message", role: "agent", content: message.params, raw: message });
    else if (message.method?.includes("item/") || message.method?.includes("command")) this.sink({ type: "tool", update: message.params, raw: message });
    else this.sink({ type: "progress", update: { method: message.method, params: message.params }, raw: message });
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = ++this.sequence; this.send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  private send(message: RpcMessage): void { if (!this.child) throw new Error("direct harness is not running"); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
}
