import { AgynClient, type AgynMessage } from "./agyn-client.js";
import type { ExecutionBackend, RuntimeBinding, TurnResult } from "./execution-backend.js";

export type AgynBackendOptions = {
  profileId: string;
  agentHandle: string;
  responseTimeoutMs: number;
  pollIntervalMs: number;
};

export class AgynBackend implements ExecutionBackend {
  readonly profileId: string;

  constructor(private readonly client: AgynClient, private readonly options: AgynBackendOptions) {
    this.profileId = options.profileId;
  }

  async start(
    taskId: string,
    prompt: string,
    signal?: AbortSignal,
    onBound?: (runtime: RuntimeBinding) => void | Promise<void>
  ): Promise<TurnResult> {
    const thread = await this.client.createThread(this.options.agentHandle);
    const instance = thread.participants.find((participant) => participant.id !== this.client.identityId);
    if (!instance) throw new Error(`Agyn thread ${thread.id} did not create an agent instance`);
    const runtime: RuntimeBinding = { runtimeId: taskId, threadId: thread.id, instanceId: instance.id, profileId: this.profileId };
    await onBound?.(runtime);
    if (signal?.aborted) {
      await this.cancel(runtime);
      throw signal.reason ?? new Error("A2A turn canceled");
    }
    return await this.run(runtime, prompt, signal);
  }

  async continue(runtime: RuntimeBinding, prompt: string, signal?: AbortSignal): Promise<TurnResult> {
    const instance = await this.client.getInstance(runtime.instanceId);
    if (instance.state === "AGENT_INSTANCE_STATE_PAUSED") await this.client.resumeInstance(runtime.instanceId);
    if (instance.state === "AGENT_INSTANCE_STATE_TERMINATED") throw new Error(`Agyn instance ${runtime.instanceId} is terminated`);
    return await this.run(runtime, prompt, signal);
  }

  async release(runtime: RuntimeBinding): Promise<void> {
    const instance = await this.client.getInstance(runtime.instanceId);
    if (instance.state === "AGENT_INSTANCE_STATE_ACTIVE") {
      await this.client.pauseInstance(runtime.instanceId, "A2A turn completed; release CPU and memory");
    }
  }

  async cancel(runtime: RuntimeBinding): Promise<void> {
    const instance = await this.client.getInstance(runtime.instanceId);
    if (instance.state === "AGENT_INSTANCE_STATE_ACTIVE") {
      await this.client.pauseInstance(runtime.instanceId, "A2A task canceled");
    }
  }

  async inspect(runtime: RuntimeBinding): Promise<Record<string, unknown>> {
    const instance = await this.client.getInstance(runtime.instanceId);
    return { ...runtime, provider: "agyn", agentHandle: instance.handle, instanceState: instance.state,
      releaseAccepted: instance.state !== "AGENT_INSTANCE_STATE_ACTIVE" };
  }

  private async run(runtime: RuntimeBinding, prompt: string, signal?: AbortSignal): Promise<TurnResult> {
    const request = await this.client.sendMessage(runtime.threadId, prompt);
    const response = await this.waitForResponse(runtime.threadId, request.id, signal);
    return { ...runtime, requestMessageId: request.id, responseMessageId: response.id, response: response.body };
  }

  private async waitForResponse(threadId: string, requestMessageId: string, signal?: AbortSignal): Promise<AgynMessage> {
    const deadline = Date.now() + this.options.responseTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("A2A turn canceled");
      const messages = await this.client.messages(threadId);
      const requestIndex = messages.findIndex((message) => message.id === requestMessageId);
      const response = requestIndex >= 0
        ? messages.slice(0, requestIndex).find((message) => message.senderId !== this.client.identityId)
        : undefined;
      if (response) return response;
      await this.delay(this.options.pollIntervalMs, signal);
    }
    throw new Error(`Agyn thread ${threadId} did not answer within ${this.options.responseTimeoutMs}ms`);
  }

  private async delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("A2A turn canceled"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export function agynBackendFromEnvironment(): AgynBackend {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required for the Agyn backend`);
    return value;
  };
  const profileId = process.env.AIRA_AGENT_PROFILE ?? "codex-agyn-v1";
  const client = new AgynClient(required("AGYN_GATEWAY_URL"), required("AGYN_TOKEN"), required("AGYN_ORGANIZATION_ID"), required("AGYN_IDENTITY_ID"));
  return new AgynBackend(client, {
    profileId,
    agentHandle: required("AGYN_AGENT_HANDLE"),
    responseTimeoutMs: Number(process.env.AGYN_RESPONSE_TIMEOUT_MS ?? "600000"),
    pollIntervalMs: Number(process.env.AGYN_POLL_INTERVAL_MS ?? "1000")
  });
}
