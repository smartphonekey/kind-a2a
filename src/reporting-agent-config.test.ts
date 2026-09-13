// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { agentReportingFiles, managedClaudeReportingConfig, managedReportingConfig } from "./reporting/agent-config.js";

test("operator runtime manifests select reporting files without A2A profile-specific code", () => {
  assert.deepEqual(agentReportingFiles('{"sdk":"codex","binary":"bin/codex"}', "/home/agent"), {
    agent: "codex", settingsFile: "/etc/codex/config.toml"
  });
  assert.deepEqual(agentReportingFiles('{"sdk":"claude","binary":"bin/claude"}', "/home/agent"), {
    agent: "claude", settingsFile: "/home/agent/.claude/settings.json", mcpFile: "/home/agent/.claude.json"
  });
  assert.deepEqual(agentReportingFiles('{"sdk":"claude"}', "/home/agent", "/workspace/.claude"), {
    agent: "claude", settingsFile: "/workspace/.claude/settings.json", mcpFile: "/workspace/.claude/.claude.json"
  });
  for (const source of ['{}', 'null', '{"sdk":"agn"}', '{"sdk":"unknown"}', '{"sdk":[]}', 'not json']) {
    assert.throws(() => agentReportingFiles(source, "/home/agent"));
  }
  assert.throws(() => agentReportingFiles('{"sdk":"claude"}', "relative"), /absolute/);
  assert.throws(() => agentReportingFiles('{"sdk":"claude"}', "/home/agent", "relative"), /absolute/);
});

test("Claude reporting preserves tracing, tools, user state and permission policy", () => {
  const settings = { permissions: { defaultMode: "default", deny: ["Bash(rm *)"] }, env: { EXISTING: "value" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "agynd-trace-hook" }] }], SessionEnd: [] } };
  const user = { hasCompletedOnboarding: true, projects: { "/workspace": { hasTrustDialogAccepted: true } },
    mcpServers: { existing: { type: "http", url: "https://tools.example/mcp" } } };
  const configured = managedClaudeReportingConfig(JSON.stringify(settings), JSON.stringify(user), "/run/agyn-execution", "/agyn/bin/node");
  const actualSettings = JSON.parse(configured.settings);
  const actualUser = JSON.parse(configured.mcp);
  assert.deepEqual(actualSettings.permissions, settings.permissions);
  assert.deepEqual(actualSettings.env, settings.env);
  assert.deepEqual(actualSettings.hooks.Stop[0], settings.hooks.Stop[0]);
  assert.deepEqual(actualSettings.hooks.SessionEnd, settings.hooks.SessionEnd);
  assert.deepEqual(actualSettings.hooks.Stop[1], { hooks: [{ type: "command",
    command: "/agyn/bin/node /run/agyn-execution/runtime.mjs stop /run/agyn-execution", timeout: 10 }] });
  assert.deepEqual(actualUser.projects, user.projects);
  assert.equal(actualUser.hasCompletedOnboarding, true);
  assert.deepEqual(actualUser.mcpServers.existing, user.mcpServers.existing);
  assert.deepEqual(actualUser.mcpServers.execution_reporting, { type: "stdio", command: "/agyn/bin/node",
    args: ["/run/agyn-execution/runtime.mjs", "mcp", "/run/agyn-execution"] });
  assert.equal(actualSettings.mcpServers, undefined, "MCP servers do not belong in Claude settings.json");
  assert(!JSON.stringify(configured).includes("token"));
  assert.deepEqual(managedClaudeReportingConfig(configured.settings, configured.mcp, "/run/agyn-execution", "/agyn/bin/node"), configured);
  const resetSettings = managedClaudeReportingConfig(JSON.stringify(settings), configured.mcp, "/run/agyn-execution", "/agyn/bin/node");
  assert.deepEqual(resetSettings, configured, "fresh daemon settings must reuse the durable MCP entry");
  assert.throws(() => managedClaudeReportingConfig(configured.settings, configured.mcp, "/run/agyn-execution", "/different/node"), /configured differently/);
  actualSettings.hooks.Stop.push(actualSettings.hooks.Stop[1]);
  assert.throws(() => managedClaudeReportingConfig(JSON.stringify(actualSettings), configured.mcp, "/run/agyn-execution", "/agyn/bin/node"), /hook already configured/);
  actualSettings.hooks.Stop.pop();
  actualSettings.hooks.Stop[1].hooks[0].timeout = 1;
  assert.throws(() => managedClaudeReportingConfig(JSON.stringify(actualSettings), configured.mcp, "/run/agyn-execution", "/agyn/bin/node"), /hook already configured/);
});

test("reporting adapters reject collisions, malformed configuration and disabled hooks", () => {
  const configure = (settings: string, mcp = "{}", directory = "/run/agyn-execution", node = "/agyn/bin/node") =>
    managedClaudeReportingConfig(settings, mcp, directory, node);
  for (const settings of ["null", "[]", "not json", '{"hooks":[]}', '{"hooks":{"Stop":{}}}',
    '{"hooks":{"Stop":[{"hooks":"invalid"}]}}', '{"hooks":{"Stop":[{"hooks":[]}]}}',
    '{"disableAllHooks":true}', '{"allowManagedHooksOnly":true}']) {
    assert.throws(() => configure(settings));
  }
  for (const mcp of ["null", "[]", "not json", '{"mcpServers":[]}', '{"mcpServers":{"execution_reporting":null}}']) {
    assert.throws(() => configure("{}", mcp));
  }
  assert.throws(() => configure("{}", "{}", "/run/unsafe;command"), /unsafe/);
  assert.throws(() => configure("{}", "{}", "/run/execution", "node"), /unsafe/);
  assert.throws(() => managedReportingConfig("[mcp_servers]\nexecution_reporting = false\n", "/run/execution", "/agyn/bin/node"), /already configured/);
});
