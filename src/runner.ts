import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
import { AcpHarness } from "./acp-harness.js";
import { now, redact } from "./common.js";
import { DirectCodexHarness } from "./direct-harness.js";
import type { AgentHarness, HarnessEvent } from "./harness.js";
import { profile } from "./profiles.js";

const selectedProfile = profile(process.env.AIRA_PROFILE_ID ?? "codex-direct-v1");
const harness: AgentHarness = selectedProfile.harness === "acp"
  ? new AcpHarness(selectedProfile)
  : new DirectCodexHarness(selectedProfile);
const app = express();
app.use(express.json({ limit: "1mb" }));
let queue = Promise.resolve();
let eventSequence = 0;
const runnerInstanceId = randomUUID();

function sse(response: express.Response, event: HarnessEvent): void {
  const sequence = ++eventSequence;
  response.write(`data: ${JSON.stringify(redact({
    eventId: `${runnerInstanceId}:${sequence}`,
    sequence,
    at: now(),
    sourceProtocol: selectedProfile.harness,
    event
  }))}\n\n`);
}

app.get("/healthz", async (_request, response) => {
  try {
    const capabilities = await harness.start();
    response.json({ ok: true, profileId: selectedProfile.id, capabilities });
  } catch (error) {
    response.status(503).json({ ok: false, profileId: selectedProfile.id, error: String(error) });
  }
});

app.post("/turn", async (request, response) => {
  const body = request.body as { taskId?: string; workspaceId?: string; sessionId?: string; threadId?: string; prompt?: string };
  if (!body.taskId || !body.workspaceId || !body.prompt) {
    response.status(400).json({ error: "taskId, workspaceId, and prompt are required" });
    return;
  }
  response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let runError: unknown;
  queue = queue.then(async () => {
    try {
      await harness.run({
        taskId: body.taskId!,
        sessionId: body.sessionId ?? body.threadId,
        prompt: body.prompt!,
        cwd: "/state/workspace"
      }, (event) => sse(response, event));
    } catch (error) {
      runError = error;
      sse(response, { type: "error", error: String(error), uncertain: true });
    }
  });
  await queue;
  response.end();
  if (runError) console.error(`turn ${body.taskId} failed: ${String(runError)}`);
});

app.post("/cancel/:taskId", async (request, response) => {
  try {
    await harness.cancel(request.params.taskId);
    response.json({ canceled: true });
  } catch (error) {
    response.status(404).json({ error: String(error) });
  }
});

app.post("/approval/:requestId", async (request, response) => {
  try {
    await harness.respond(request.params.requestId, request.body ?? { outcome: { outcome: "cancelled" } });
    response.json({ accepted: true });
  } catch (error) {
    response.status(404).json({ error: String(error) });
  }
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
const listener = app.listen(8080, "0.0.0.0", () => console.log(`AIRA runner listening on 8080 with profile ${selectedProfile.id}`));
async function shutdown(): Promise<void> { listener.close(); await harness.close(); }
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
