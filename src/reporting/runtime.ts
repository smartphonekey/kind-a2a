// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createReportingMcp } from "./mcp.js";
import { remoteReportingClient } from "./remote-client.js";
import { runStopHook } from "./hook-client.js";
import { agentReportingFiles, managedReportingConfig, managedClaudeReportingConfig, type AgentReportingFiles } from "./agent-config.js";

export { managedReportingConfig } from "./agent-config.js";

export async function installRuntime(directory: string, config: string | AgentReportingFiles, node = process.execPath): Promise<void> {
  const bindingFile = join(directory, "binding.json");
  const expected = z.object({ executionId: z.string().uuid(), instanceId: z.string().uuid() }).parse(JSON.parse(readFileSync(join(directory, "expected.json"), "utf8")));
  const status = await remoteReportingClient(bindingFile).status();
  if (status.executionId !== expected.executionId || status.canceled || status.outcome || status.phase !== "dispatching") throw new Error("execution is not eligible to start");
  if (process.env.AGENT_INSTANCE_ID !== expected.instanceId) throw new Error("runtime identity mismatch");
  const control = z.object({ version: z.literal(1), instance_id: z.literal(expected.instanceId),
    allowed_message_id: z.string().uuid(), ack_only_message_ids: z.array(z.string().uuid()).max(256)
  }).strict().parse(JSON.parse(readFileSync(join(directory, "inbox-control.json"), "utf8")));
  if (new Set([control.allowed_message_id, ...control.ack_only_message_ids]).size !== control.ack_only_message_ids.length + 1 ||
      process.env.AGYN_INBOX_JOURNAL_DIR !== "/workspace/.agyn/inbox-journal" ||
      process.env.AGYN_INBOX_CONTROL_FILE !== join(directory, "inbox-control.json")) throw new Error("inbox replay guard is not configured");
  const target = typeof config === "string" ? { agent: "codex" as const, settingsFile: config } : config;
  const readConfig = (path: string): string => {
    if (!isAbsolute(path)) throw new Error("absolute config path required");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("invalid managed config");
    return readFileSync(path, "utf8");
  };
  const settings = readConfig(target.settingsFile);
  let updates: { path: string; value: string; mode: number }[];
  if (target.agent === "codex") {
    updates = [{ path: target.settingsFile, value: managedReportingConfig(settings, directory, node), mode: 0o644 }];
  } else {
    if (target.mcpFile === target.settingsFile) throw new Error("distinct Claude config files required");
    const configured = managedClaudeReportingConfig(settings, readConfig(target.mcpFile), directory, node);
    updates = [{ path: target.settingsFile, value: configured.settings, mode: 0o600 }, { path: target.mcpFile, value: configured.mcp, mode: 0o600 }];
  }
  // Validate every config before changing any. A write failure leaves the init
  // gate closed; no configured acknowledgement is published for partial setup.
  for (const update of updates) {
    writeFileSync(`${update.path}.execution.tmp`, update.value, { mode: update.mode, flag: "wx" });
    renameSync(`${update.path}.execution.tmp`, update.path);
  }
  writeFileSync(join(directory, "configured.tmp"), JSON.stringify({ ...expected, reportingConfigured: true }), { mode: 0o600, flag: "wx" });
  renameSync(join(directory, "configured.tmp"), join(directory, "configured.json"));
}

async function main() {
  const [command, directory, node] = process.argv.slice(2);
  if (!directory || !isAbsolute(directory)) throw new Error("runtime directory is required");
  const bindingFile = join(directory, "binding.json");
  if (command === "mcp") {
    await createReportingMcp(remoteReportingClient(bindingFile)).connect(new StdioServerTransport());
  } else if (command === "stop") {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 65536) throw new Error("hook input exceeds limit");
    }
    process.stdout.write(`${JSON.stringify(await runStopHook(input, bindingFile))}\n`);
  } else if (command === "install") {
    const target = agentReportingFiles(readFileSync("/agyn/config.json", "utf8"), homedir(), process.env.CLAUDE_CONFIG_DIR);
    await installRuntime(directory, target, node);
  }
  else throw new Error("unknown runtime command");
}

// The bundle is the only executable; importing this module in tests has no effects.
if (process.argv[1]?.endsWith("runtime.mjs")) {
  try { await main(); }
  catch {
    if (process.argv[2] === "stop") process.stdout.write('{"continue":false,"stopReason":"Execution reporting unavailable; controller reconciliation required."}\n');
    else { process.stderr.write("Execution reporting runtime failed\n"); process.exitCode = 1; }
  }
}
