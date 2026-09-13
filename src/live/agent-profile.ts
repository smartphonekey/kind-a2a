// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only acceptance configuration; this is not an A2A routing contract.
import assert from "node:assert/strict";
import { z } from "zod";

export const liveAgentProfileSchema = z.object({
  version: z.literal(1),
  sdk: z.enum(["codex", "claude"]),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  runtimeImageId: z.string().uuid(),
  runtimeImageTag: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/),
  subscriptionId: z.string().uuid()
}).strict();

export type LiveAgentProfile = z.infer<typeof liveAgentProfileSchema>;
export type NativeIdentity = { instanceId: string; sessionId: string; createdAt?: number };

export function persistentAgentEnv(sdk: LiveAgentProfile["sdk"]): Record<string, string> {
  return { WORKSPACE_DIR: "/workspace", ...(sdk === "claude"
    ? { CLAUDE_CONFIG_DIR: "/workspace/.claude", AGYN_CLAUDE_SESSION_DIR: "/workspace/.agyn/claude-session" }
    : { CODEX_HOME: "/workspace/.codex" }) };
}

export function nativeIdentities(sdk: LiveAgentProfile["sdk"], records: any[]): NativeIdentity[] {
  assert.equal(records.length, 1, "exactly one native session mapping is required");
  return records.map(record => {
    if (sdk === "claude") {
      assert.equal(record.version, 1);
      assert.equal(record.work_dir, "/workspace");
      assert.equal(record.state_dir, "/workspace/.claude");
      assert(record.agent_id);
    }
    const instanceId = record.instance_id;
    const sessionId = sdk === "claude" ? record.session_id : record.codex_thread_id;
    assert(typeof instanceId === "string" && instanceId && typeof sessionId === "string" && sessionId);
    return { instanceId, sessionId, ...(sdk === "codex" && typeof record.created_at_unix_ms === "number"
      ? { createdAt: record.created_at_unix_ms } : {}) };
  });
}

// Runs inside the observed Pod. Return metadata only, never transcript bodies.
export function claudeNativeProbe() {
  const fs = require("node:fs");
  const cp = require("node:child_process");
  const mapping = JSON.parse(fs.readFileSync("/workspace/.agyn/claude-session/session.json", "utf8"));
  const projects = "/workspace/.claude/projects";
  const transcripts = fs.readdirSync(projects).map((name: string) => `${projects}/${name}/${mapping.session_id}.jsonl`)
    .filter((path: string) => fs.existsSync(path));
  if (transcripts.length !== 1) throw new Error("native transcript absent or ambiguous");
  const file = fs.openSync(transcripts[0], "r");
  let prefix: string;
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    prefix = buffer.subarray(0, fs.readSync(file, buffer, 0, buffer.length, 0)).toString("utf8");
  } finally { fs.closeSync(file); }
  let verified = false;
  for (const line of prefix.split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.sessionId !== mapping.session_id || entry.cwd !== "/workspace") throw new Error("native transcript mismatch");
    verified = true;
    break;
  }
  if (!verified) throw new Error("native transcript identity is unverifiable");
  return { mapping: [mapping], nativeTranscript: { path: transcripts[0], sessionId: mapping.session_id, workspace: "/workspace" },
    nativeVersion: cp.execFileSync("/agyn/bin/claude", ["--version"], {
      encoding: "utf8", timeout: 3000, env: { ...process.env, LD_LIBRARY_PATH: "/agyn/bin/lib" }
    }).trim() };
}
