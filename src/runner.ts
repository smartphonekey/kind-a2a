import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
import { now, redact } from "./common.js";

type RpcMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type PendingApproval = { id: number; resolve: (decision: unknown) => void };

class CodexAppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  readonly approvals = new Map<string, PendingApproval>();

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    this.child = spawn("codex", ["app-server"], {
      env: { ...process.env, CODEX_HOME: "/state/codex" },
      stdio: "pipe"
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk.toString()));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("event", { method: "runner/stderr", params: { text: chunk.toString() } }));
    this.child.on("exit", (code, signal) => {
      this.emit("event", { method: "runner/exited", params: { code, signal } });
      for (const request of this.pending.values()) request.reject(new Error(`codex app-server exited (${code ?? signal})`));
      this.pending.clear();
      this.child = undefined;
    });
    await this.request("initialize", { clientInfo: { name: "aira-a2a-runner", title: "AIRA A2A runner", version: "0.1.0" } });
    this.notify("initialized", {});
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { this.emit("event", { method: "runner/invalid-json", params: { line } }); continue; }
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(String((message.error as { message?: string }).message ?? JSON.stringify(message.error))));
        else pending.resolve(message.result);
      } else if (typeof message.id === "number" && message.method) {
        this.handleServerRequest(message);
      } else if (message.method) {
        this.emit("event", redact(message));
      }
    }
  }

  private handleServerRequest(message: RpcMessage): void {
    if (typeof message.id !== "number" || !message.method) return;
    const requestNumber = message.id;
    const approval = message.method.includes("requestApproval") || message.method.includes("requestUserInput");
    if (!approval) {
      this.respond(message.id, { decision: "decline" });
      return;
    }
    const requestId = `${message.method}:${message.id}`;
    this.emit("event", redact({ method: "runner/approval-required", params: { requestId, original: message } }));
    const timeout = setTimeout(() => {
      if (this.approvals.delete(requestId)) this.respond(requestNumber, { decision: "decline" });
    }, 120_000);
    this.approvals.set(requestId, { id: requestNumber, resolve: (decision) => { clearTimeout(timeout); this.respond(requestNumber, decision); } });
  }

  private send(message: RpcMessage): void {
    if (!this.child) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = ++this.sequence;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: Record<string, unknown>): void { this.send({ method, params }); }
  respond(id: number, result: unknown): void { this.send({ id, result }); }
  async interrupt(threadId: string, turnId?: string): Promise<void> { await this.request("turn/interrupt", { threadId, turnId }); }
}

const app = express();
app.use(express.json({ limit: "1mb" }));
const server = new CodexAppServer();
let queue = Promise.resolve();
const active = new Map<string, { threadId: string; turnId?: string }>();

function sse(response: express.Response, event: unknown): void {
  response.write(`data: ${JSON.stringify(redact({ at: now(), event }))}\n\n`);
}

app.get("/healthz", async (_request, response) => {
  try { await server.start(); response.json({ ok: true }); } catch (error) { response.status(503).json({ ok: false, error: String(error) }); }
});

app.post("/turn", async (request, response) => {
  const { taskId, workspaceId, threadId, prompt } = request.body as { taskId: string; workspaceId: string; threadId?: string; prompt: string };
  if (!taskId || !workspaceId || !prompt) { response.status(400).json({ error: "taskId, workspaceId, and prompt are required" }); return; }
  response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const unsubscribe = (event: unknown) => sse(response, event);
  server.on("event", unsubscribe);
  try {
    queue = queue.then(async () => {
      await server.start();
      const thread = threadId
        ? await server.request("thread/resume", { threadId, cwd: "/state/workspace", approvalPolicy: "on-request", sandbox: "workspace-write" })
        : await server.request("thread/start", { cwd: "/state/workspace", approvalPolicy: "on-request", sandbox: "workspace-write", serviceName: "aira-a2a-lab" });
      const currentThreadId = String((thread as { thread?: { id?: string } }).thread?.id);
      if (!currentThreadId) throw new Error("app-server did not return a thread id");
      sse(response, { method: "runner/thread", params: { workspaceId, threadId: currentThreadId, resumed: Boolean(threadId) } });
      const completion = new Promise<unknown>((resolve, reject) => {
        const listener = (message: RpcMessage) => {
          const params = message.params ?? {};
          if (message.method === "turn/completed" && String((params.turn as { id?: string } | undefined)?.id ?? "") === active.get(taskId)?.turnId) { server.off("event", listener); resolve(message); }
          if (message.method === "runner/exited") { server.off("event", listener); reject(new Error("app-server exited mid-turn")); }
        };
        server.on("event", listener);
      });
      const started = await server.request("turn/start", {
        threadId: currentThreadId,
        input: [{ type: "text", text: String(prompt) }],
        cwd: "/state/workspace",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/state/workspace"], networkAccess: false },
        effort: "low"
      });
      const turnId = String((started as { turn?: { id?: string } }).turn?.id);
      active.set(taskId, { threadId: currentThreadId, turnId });
      sse(response, { method: "runner/turn", params: { taskId, threadId: currentThreadId, turnId } });
      await completion;
      active.delete(taskId);
      sse(response, { method: "runner/completed", params: { taskId, threadId: currentThreadId } });
    });
    await queue;
  } catch (error) {
    sse(response, { method: "runner/error", params: { taskId, error: String(error) } });
  } finally {
    server.off("event", unsubscribe);
    response.end();
  }
});

app.post("/cancel/:taskId", async (request, response) => {
  const current = active.get(request.params.taskId);
  if (!current) { response.status(404).json({ error: "task is not active" }); return; }
  try { await server.interrupt(current.threadId, current.turnId); response.json({ canceled: true }); }
  catch (error) { response.status(500).json({ error: String(error) }); }
});

app.post("/approval/:requestId", (request, response) => {
  const pending = server.approvals.get(request.params.requestId);
  if (!pending) { response.status(404).json({ error: "approval not pending" }); return; }
  server.approvals.delete(request.params.requestId);
  pending.resolve(request.body ?? { decision: "decline" });
  response.json({ accepted: true });
});

async function files(root: string, prefix = ""): Promise<Array<{ path: string; text: string }>> {
  const output: Array<{ path: string; text: string }> = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (["node_modules", ".git", ".codex"].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...await files(absolute, relative));
    else if (entry.isFile()) {
      const stat = await fs.stat(absolute);
      if (stat.size <= 64_000) output.push({ path: relative, text: await fs.readFile(absolute, "utf8") });
    }
  }
  return output;
}

app.get("/artifacts", async (_request, response) => response.json({ files: await files("/state/workspace") }));
app.listen(8080, "0.0.0.0", () => console.log("AIRA runner listening on 8080"));
