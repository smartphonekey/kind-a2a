// SPDX-License-Identifier: AGPL-3.0-only
// Native CLI config/MCP discovery only: isolated HOME, no credentials or model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentReportingFiles, managedClaudeReportingConfig } from "../reporting/agent-config.js";

assert.equal(process.env.CLAUDE_REPORTING_CONFIG_ACCEPTANCE, "true", "opt in to a native CLI configuration probe");
const binary = process.env.CLAUDE_REPORTING_BINARY ?? "claude";
mkdirSync(resolve(".state"), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(".state/claude-reporting-config-"));
const evidence: Record<string, unknown>[] = [];
for (const relocated of [false, true]) {
  const root = join(directory, relocated ? "relocated" : "default");
  const home = join(root, "home"), workspace = join(root, "workspace"), runtime = join(root, "reporting");
  for (const path of [home, workspace, runtime]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const configDir = relocated ? join(root, "state") : undefined;
  const files = agentReportingFiles('{"sdk":"claude"}', home, configDir);
  assert(files.agent === "claude");
  mkdirSync(dirname(files.settingsFile), { recursive: true, mode: 0o700 });
  const configured = managedClaudeReportingConfig("{}", "{}", runtime, process.execPath);
  writeFileSync(files.settingsFile, configured.settings, { mode: 0o600 });
  writeFileSync(files.mcpFile, configured.mcp, { mode: 0o600 });
  copyFileSync(new URL("../reporting/runtime.mjs", import.meta.url), join(runtime, "runtime.mjs"));
  const env = { PATH: process.env.PATH, HOME: home, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
  const version = execFileSync(binary, ["--version"], { cwd: workspace, env, encoding: "utf8", timeout: 15_000 }).trim();
  const result = execFileSync(binary, ["mcp", "get", "execution_reporting"], { cwd: workspace, env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  assert.match(result, /Status:[^\n]*Connected/, "native CLI did not connect to the installed reporting MCP");
  assert.match(result, /Scope:[^\n]*User/, "reporting MCP was not discovered at user scope");
  const reconfigured = managedClaudeReportingConfig(readFileSync(files.settingsFile, "utf8"), readFileSync(files.mcpFile, "utf8"), runtime, process.execPath);
  assert.equal(JSON.parse(reconfigured.settings).hooks.Stop.length, 1, "reconfiguration duplicated the stop hook");
  writeFileSync(files.settingsFile, reconfigured.settings, { mode: 0o600 });
  writeFileSync(files.mcpFile, reconfigured.mcp, { mode: 0o600 });
  const replacement = execFileSync(binary, ["mcp", "get", "execution_reporting"], { cwd: workspace, env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  assert.match(replacement, /Status:[^\n]*Connected/, "native CLI did not reconnect after configuration reuse");
  evidence.push({ relocated, version, files, connected: true, reconfigured: true, modelCalls: 0, credentialsProvided: false });
}
writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ kind: "claude.reporting-config", passed: true, directory, evidence }));
