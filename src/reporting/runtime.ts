// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createReportingMcp } from "./mcp.js";
import { remoteReportingClient } from "./remote-client.js";
import { runStopHook } from "./hook-client.js";

export function managedReportingConfig(source: string, directory: string, node: string): string {
  if (![directory, node].every(path => isAbsolute(path) && /^[A-Za-z0-9_./-]+$/.test(path))) throw new Error("unsafe runtime path");
  const config = parse(source);
  const mcp = z.record(z.unknown()).parse(config.mcp_servers ?? {});
  if (mcp.execution_reporting) throw new Error("reporting MCP already configured");
  mcp.execution_reporting = { command: node, args: [join(directory, "runtime.mjs"), "mcp", directory], required: true };
  config.mcp_servers = mcp as typeof config.mcp_servers;
  const hooks = z.record(z.unknown()).parse(config.hooks ?? {});
  const stop = z.array(z.unknown()).parse(hooks.Stop ?? []);
  stop.push({ hooks: [{ type: "command", command: `${node} ${join(directory, "runtime.mjs")} stop ${directory}`, timeout: 10 }] });
  hooks.Stop = stop;
  config.hooks = hooks as typeof config.hooks;
  return stringify(config);
}

export async function installRuntime(directory: string, systemConfig: string, node = process.execPath): Promise<void> {
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
  const stat = lstatSync(systemConfig);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("invalid managed config");
  const configured = managedReportingConfig(readFileSync(systemConfig, "utf8"), directory, node);
  writeFileSync(`${systemConfig}.execution.tmp`, configured, { mode: 0o644, flag: "wx" });
  renameSync(`${systemConfig}.execution.tmp`, systemConfig);
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
  } else if (command === "install") await installRuntime(directory, "/etc/codex/config.toml", node);
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
