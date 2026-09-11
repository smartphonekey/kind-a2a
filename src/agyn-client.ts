export type AgynParticipant = { id: string; nickname?: string };
export type AgynThread = { id: string; participants: AgynParticipant[]; messageCount?: number };
export type AgynMessage = { id: string; threadId: string; senderId: string; body: string; createdAt: string };
export type AgynInstance = { meta: { id: string }; state: string; handle: string; defaultThreadId?: string };

type GatewayError = { code?: string; message?: string };

export class AgynClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly organizationId: string,
    readonly identityId: string
  ) {}

  async createThread(agentHandle: string): Promise<AgynThread> {
    const response = await this.call<{ thread: AgynThread }>("ThreadsGateway", "CreateThread", {
      participants: [{ participantId: this.identityId }, { participantNickname: agentHandle }],
      organizationId: this.organizationId
    });
    return response.thread;
  }

  async sendMessage(threadId: string, body: string): Promise<AgynMessage> {
    const response = await this.call<{ message: AgynMessage }>("ThreadsGateway", "SendMessage", {
      threadId, senderId: this.identityId, body
    });
    return response.message;
  }

  async messages(threadId: string): Promise<AgynMessage[]> {
    const response = await this.call<{ messages?: AgynMessage[] }>("ThreadsGateway", "GetMessages", {
      threadId, pageSize: 200, order: "MESSAGE_ORDER_NEWEST_FIRST"
    });
    return response.messages ?? [];
  }

  async getInstance(id: string): Promise<AgynInstance> {
    const response = await this.call<{ instance: AgynInstance }>("AgentsGateway", "GetInstance", { id });
    return response.instance;
  }

  async pauseInstance(id: string, reason: string): Promise<AgynInstance> {
    const response = await this.call<{ instance: AgynInstance }>("AgentsGateway", "PauseInstance", { id, pauseReason: reason });
    return response.instance;
  }

  async resumeInstance(id: string): Promise<AgynInstance> {
    const response = await this.call<{ instance: AgynInstance }>("AgentsGateway", "ResumeInstance", { id });
    return response.instance;
  }

  private async call<T>(service: string, method: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/agynio.api.gateway.v1.${service}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as GatewayError;
      throw new Error(`Agyn ${service}.${method} failed (${response.status}${error.code ? ` ${error.code}` : ""}): ${error.message ?? response.statusText}`);
    }
    return await response.json() as T;
  }
}
