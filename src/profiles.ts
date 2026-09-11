import { RUNNER_IMAGE } from "./common.js";
import type { AgentProfile } from "./harness.js";

export const profiles: Record<string, AgentProfile> = {
  "codex-agyn-v1": {
    id: "codex-agyn-v1", version: 1, harness: "agyn", runnerImage: "agyn-managed",
    executable: "codex", args: [], authBinding: "agyn-subscription",
    requiredCapabilities: {},
    resources: { cpuRequest: "500m", memoryRequest: "2Gi", cpuLimit: "2", memoryLimit: "2Gi" },
    environment: {}
  },
  "codex-direct-v1": {
    id: "codex-direct-v1", version: 1, harness: "direct-codex", runnerImage: RUNNER_IMAGE,
    executable: "codex", args: ["app-server"], authBinding: "codex-chatgpt",
    requiredCapabilities: { loadSession: true, cancel: true, permissions: true },
    resources: { cpuRequest: "500m", memoryRequest: "1Gi", cpuLimit: "2", memoryLimit: "3Gi" }, environment: {}
  },
  "codex-acp-v1": {
    id: "codex-acp-v1", version: 1, harness: "acp", runnerImage: RUNNER_IMAGE,
    executable: "/app/node_modules/.bin/codex-acp", args: [], authBinding: "codex-chatgpt",
    requiredCapabilities: { loadSession: true, cancel: true, permissions: true },
    resources: { cpuRequest: "500m", memoryRequest: "1Gi", cpuLimit: "2", memoryLimit: "3Gi" },
    environment: { NO_BROWSER: "1", INITIAL_AGENT_MODE: "agent", CODEX_PATH: "/usr/local/bin/codex" }
  },
  "codex-acp-review-v1": {
    id: "codex-acp-review-v1", version: 1, harness: "acp", runnerImage: RUNNER_IMAGE,
    executable: "/app/node_modules/.bin/codex-acp", args: [], authBinding: "codex-chatgpt",
    requiredCapabilities: { loadSession: true, cancel: true, permissions: true },
    resources: { cpuRequest: "500m", memoryRequest: "1Gi", cpuLimit: "2", memoryLimit: "3Gi" },
    environment: { NO_BROWSER: "1", INITIAL_AGENT_MODE: "read-only", CODEX_PATH: "/usr/local/bin/codex" }
  },
  "gemini-acp-v1": {
    id: "gemini-acp-v1", version: 1, harness: "acp", runnerImage: RUNNER_IMAGE,
    executable: "/usr/local/bin/gemini", args: ["--acp"], authBinding: "gemini-oauth",
    requiredCapabilities: { loadSession: true, cancel: true, permissions: true },
    resources: { cpuRequest: "500m", memoryRequest: "1Gi", cpuLimit: "2", memoryLimit: "3Gi" },
    environment: { NO_BROWSER: "1", HOME: "/state/gemini-home" }
  }
};

export function profile(id: string): AgentProfile {
  const selected = profiles[id];
  if (!selected) throw new Error(`unknown operator profile ${id}`);
  return selected;
}
