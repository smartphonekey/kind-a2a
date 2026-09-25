// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Adapt operator-selected native agent configuration for execution reporting.
 *
 * @module
 * @remarks Generated commands reference the runtime directory, never its bearer
 * token. These adapters preserve unrelated settings; they do not harden files
 * against the trusted-local root agent.
 * @see SERVICE.md#reporting-setup-contract
 * @see src/reporting/runtime.ts
 */
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

export type AgentReportingFiles =
  | { agent: "codex"; settingsFile: string }
  | { agent: "claude"; settingsFile: string; mcpFile: string };

/**
 * Select files from the trusted runtime image's manifest, never an A2A message.
 * Unknown SDKs fail closed; Claude state paths must be absolute, while Codex
 * always uses system TOML. Selection alone neither creates nor validates files.
 */
export function agentReportingFiles(manifest: string, home: string, claudeConfigDir?: string): AgentReportingFiles {
  const { sdk } = z.object({ sdk: z.enum(["codex", "claude"]) }).parse(JSON.parse(manifest));
  if (sdk === "codex") return { agent: sdk, settingsFile: "/etc/codex/config.toml" };
  if (!isAbsolute(home) || claudeConfigDir !== undefined && !isAbsolute(claudeConfigDir)) throw new Error("absolute agent state path required");
  const directory = claudeConfigDir ?? join(home, ".claude");
  return { agent: sdk, settingsFile: join(directory, "settings.json"),
    mcpFile: claudeConfigDir === undefined ? join(home, ".claude.json") : join(directory, ".claude.json") };
}

function reportingCommands(directory: string, node: string) {
  if (![directory, node].every(path => isAbsolute(path) && /^[A-Za-z0-9_./-]+$/.test(path))) throw new Error("unsafe runtime path");
  return {
    server: { command: node, args: [join(directory, "runtime.mjs"), "mcp", directory] },
    hook: { hooks: [{ type: "command", command: `${node} ${join(directory, "runtime.mjs")} stop ${directory}`, timeout: 10 }] }
  };
}

/**
 * Add Codex's required MCP relay and Stop hook to parsed TOML.
 * Any existing execution_reporting server is a conflict, even an identical one;
 * this adapter is not a reinstallation API. Command paths must be shell-safe
 * absolute paths because native Stop hooks execute command strings.
 */
export function managedReportingConfig(source: string, directory: string, node: string): string {
  const { server, hook } = reportingCommands(directory, node);
  const config = parse(source);
  const mcp = z.record(z.unknown()).parse(config.mcp_servers ?? {});
  if (Object.hasOwn(mcp, "execution_reporting")) throw new Error("reporting MCP already configured");
  mcp.execution_reporting = { ...server, required: true };
  config.mcp_servers = mcp as typeof config.mcp_servers;
  const hooks = z.record(z.unknown()).parse(config.hooks ?? {});
  const stop = z.array(z.unknown()).parse(hooks.Stop ?? []);
  stop.push(hook);
  hooks.Stop = stop;
  config.hooks = hooks as typeof config.hooks;
  return stringify(config);
}

/**
 * Prepare Claude settings and user MCP JSON without writing either file.
 * Durable user state may reuse exact managed entries only; conflicting servers,
 * altered or duplicate managed hooks, and settings disabling user hooks fail.
 * Unrelated tools, hooks and permission settings are preserved.
 */
export function managedClaudeReportingConfig(settingsSource: string, mcpSource: string, directory: string, node: string): { settings: string; mcp: string } {
  const { server, hook } = reportingCommands(directory, node);
  const settings = z.record(z.unknown()).parse(JSON.parse(settingsSource));
  const user = z.record(z.unknown()).parse(JSON.parse(mcpSource));
  if (settings.disableAllHooks === true || settings.allowManagedHooksOnly === true) throw new Error("user reporting hooks are disabled");
  const mcp = z.record(z.unknown()).parse(user.mcpServers ?? {});
  const expectedServer = { type: "stdio", ...server };
  if (Object.hasOwn(mcp, "execution_reporting") && !isDeepStrictEqual(mcp.execution_reporting, expectedServer)) {
    throw new Error("reporting MCP already configured differently");
  }
  mcp.execution_reporting = expectedServer;
  user.mcpServers = mcp;
  const hooks = z.record(z.unknown()).parse(settings.hooks ?? {});
  const stop = z.array(z.object({ matcher: z.string().optional(),
    hooks: z.array(z.object({ type: z.string().min(1), command: z.string().optional() }).passthrough()).min(1)
  }).passthrough()).parse(hooks.Stop ?? []);
  const existing = stop.filter(entry => entry.hooks.some(item => item.command === hook.hooks[0].command));
  if (existing.length > 1 || existing.length === 1 && !isDeepStrictEqual(existing[0], hook)) throw new Error("reporting stop hook already configured differently");
  if (!existing.length) stop.push(hook);
  hooks.Stop = stop;
  settings.hooks = hooks;
  return { settings: JSON.stringify(settings, null, 2) + "\n", mcp: JSON.stringify(user, null, 2) + "\n" };
}
