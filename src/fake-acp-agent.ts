import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";

type Rpc = { jsonrpc?: string; id?: number; method?: string; params?: any; result?: any; error?: any };
const sessions = new Map<string, { cwd: string; cancelled: boolean }>();
const pending = new Map<number, (message: Rpc) => void>();
let sessionSequence = 0;
let requestSequence = 9000;

function send(message: Rpc): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function update(sessionId: string, value: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: value } });
}

function clientRequest(method: string, params: unknown): Promise<Rpc> {
  const id = ++requestSequence;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

async function request(message: Rpc): Promise<void> {
  const id = message.id!;
  const params = message.params ?? {};
  if (message.method === "initialize") {
    send({ id, result: {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: process.env.FAKE_ACP_NO_LOAD !== "1" },
      agentInfo: { name: "aira-fake-acp", version: "1.0.0" }
    } });
    return;
  }
  if (message.method === "session/new") {
    const sessionId = `fake-session-${++sessionSequence}`;
    sessions.set(sessionId, { cwd: params.cwd, cancelled: false });
    send({ id, result: { sessionId } });
    return;
  }
  if (message.method === "session/load") {
    sessions.set(params.sessionId, { cwd: params.cwd, cancelled: false });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } });
    send({ id, result: {} });
    return;
  }
  if (message.method !== "session/prompt") {
    send({ id, error: { code: -32601, message: `unsupported fake method ${message.method}` } });
    return;
  }

  const session = sessions.get(params.sessionId);
  if (!session) {
    send({ id, error: { code: -32000, message: "unknown session" } });
    return;
  }
  const prompt = String(params.prompt?.[0]?.text ?? "");
  session.cancelled = false;
  if (prompt.includes("[exit-after-marker]")) {
    const marker = path.join(session.cwd, "interrupted-side-effect.txt");
    await fs.writeFile(marker, `${await fs.readFile(marker, "utf8").catch(() => "")}once\n`);
    process.exit(42);
  }
  if (prompt.includes("[wait]")) {
    for (let index = 0; index < 100 && !session.cancelled; index += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    send({ id, result: { stopReason: session.cancelled ? "cancelled" : "end_turn" } });
    return;
  }

  const tool = { sessionUpdate: "tool_call", toolCallId: "fake-tool-1", title: "Write fixture", kind: "edit", status: "pending", content: [] };
  update(params.sessionId, tool);
  update(params.sessionId, tool);
  const permission = await clientRequest("session/request_permission", {
    sessionId: params.sessionId,
    toolCall: { toolCallId: "fake-tool-1", title: "Write fixture", kind: "edit", status: "pending" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" }
    ]
  });
  const selected = permission.result?.outcome?.outcome === "selected" && permission.result.outcome.optionId === "allow-once";
  update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: selected ? "approved" : "not approved" } });
  send({ id, result: { stopReason: "end_turn" } });
}

function notification(message: Rpc): void {
  if (message.method !== "session/cancel") return;
  const session = sessions.get(message.params?.sessionId);
  if (session) session.cancelled = true;
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message: Rpc;
  try { message = JSON.parse(line) as Rpc; } catch { return; }
  if (typeof message.id === "number" && ("result" in message || "error" in message)) {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  } else if (typeof message.id === "number" && message.method) {
    void request(message).catch((error) => send({ id: message.id, error: { code: -32000, message: String(error) } }));
  } else if (message.method) notification(message);
});
