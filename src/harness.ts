export type HarnessCapabilities = {
  protocol: "codex-app-server" | "acp";
  loadSession: boolean;
  cancel: boolean;
  permissions: boolean;
  fsCallbacks: boolean;
  terminalCallbacks: boolean;
  mcp: boolean;
};

export type HarnessEvent =
  | { type: "session"; sessionId: string; resumed: boolean; provider: Record<string, unknown> }
  | { type: "message"; role: "agent" | "user"; content: unknown; raw?: unknown }
  | { type: "tool"; update: unknown; raw?: unknown }
  | { type: "progress"; update: unknown; raw?: unknown }
  | { type: "permission"; requestId: string; turnId: string; options: Array<{ id: string; name?: string; kind?: string }>; raw: unknown }
  | { type: "permission-response"; requestId: string; turnId: string; outcome: unknown }
  | { type: "error"; error: string; uncertain: boolean; raw?: unknown }
  | { type: "turn"; turnId: string; phase: "started" | "completed" | "cancelled"; outcome?: unknown };

export type PromptInput = { taskId: string; sessionId?: string | null; prompt: string; cwd: string };

export interface AgentHarness {
  readonly profileId: string;
  start(): Promise<HarnessCapabilities>;
  run(input: PromptInput, emit: (event: HarnessEvent) => void): Promise<{ sessionId: string; turnId: string; outcome: unknown }>;
  respond(requestId: string, decision: unknown): Promise<void>;
  cancel(taskId: string): Promise<void>;
  close(): Promise<void>;
}

export type AgentProfile = {
  id: string;
  version: number;
  harness: "direct-codex" | "acp";
  runnerImage: string;
  executable: string;
  args: string[];
  authBinding: "codex-chatgpt" | "gemini-oauth" | "none";
  requiredCapabilities: Partial<HarnessCapabilities>;
  resources: { cpuRequest: string; memoryRequest: string; cpuLimit: string; memoryLimit: string };
  environment: Record<string, string>;
};
