export type AgynParticipant = { id: string; nickname?: string };
export type AgynThread = { id: string; participants: AgynParticipant[]; messageCount?: number };
export type AgynMessage = { id: string; threadId: string; senderId: string; body: string; createdAt: string };
export type AgynInstance = { meta: { id: string }; state: string; handle: string; defaultThreadId?: string; label?: string; agentId?: string };
export type AgynWorkload = { meta: { id: string }; status: string; removedAt?: string; removalConfirmedAt?: string; agentInstanceId?: string;
  containers?: { name: string; role: string; status?: string }[] };

type GatewayError = { code?: string; message?: string };

export class AgynRpcError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly rpcCode?: string) {
    super(message);
    this.name = "AgynRpcError";
  }
}

export class AgynClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly organizationId: string,
    readonly identityId: string
  ) {}

  async createThread(agentHandle: string, signal?: AbortSignal): Promise<AgynThread> {
    const response = await this.call<{ thread: AgynThread }>("ThreadsGateway", "CreateThread", {
      participants: [{ participantId: this.identityId }, { participantNickname: agentHandle }],
      organizationId: this.organizationId
    }, signal);
    return response.thread;
  }

  async sendMessage(threadId: string, body: string, signal?: AbortSignal): Promise<AgynMessage> {
    const response = await this.call<{ message: AgynMessage }>("ThreadsGateway", "SendMessage", {
      threadId, senderId: this.identityId, body
    }, signal);
    return response.message;
  }

  async messages(threadId: string): Promise<AgynMessage[]> {
    const response = await this.call<{ messages?: AgynMessage[] }>("ThreadsGateway", "GetMessages", {
      threadId, pageSize: 200, order: "MESSAGE_ORDER_NEWEST_FIRST"
    });
    return response.messages ?? [];
  }

  async getInstance(id: string, signal?: AbortSignal): Promise<AgynInstance> {
    const response = await this.call<{ instance: AgynInstance }>("AgentsGateway", "GetInstance", { id }, signal);
    return response.instance;
  }

  async pauseInstance(id: string, reason: string, signal?: AbortSignal): Promise<AgynInstance> {
    const response = await this.call<{ instance: AgynInstance }>("AgentsGateway", "PauseInstance", { id, pauseReason: reason }, signal);
    return response.instance;
  }

  async resumeInstance(id: string, signal?: AbortSignal): Promise<AgynInstance> {
    const response = await this.call<{ instance: AgynInstance }>("AgentsGateway", "ResumeInstance", { id }, signal);
    return response.instance;
  }

  async createInstance(agentId: string, label: string, signal?: AbortSignal): Promise<AgynInstance> {
    return (await this.call<{ instance: AgynInstance }>("AgentsGateway", "CreateInstance", { agentId, label }, signal)).instance;
  }

  async instances(agentId: string, signal?: AbortSignal): Promise<AgynInstance[]> {
    return this.pages<AgynInstance>("AgentsGateway", "ListInstances", { agentId, organizationId: this.organizationId }, "instances", signal);
  }

  async instanceThreads(instanceId: string, signal?: AbortSignal): Promise<AgynThread[]> {
    // GetThreads only permits querying the caller's own participant identity.
    const threads = await this.pages<AgynThread>("ThreadsGateway", "GetThreads", { participantId: this.identityId }, "threads", signal);
    return threads.filter(thread => thread.participants.some(participant => participant.id === instanceId));
  }

  async createInstanceThread(instanceId: string, signal?: AbortSignal): Promise<AgynThread> {
    return (await this.call<{ thread: AgynThread }>("ThreadsGateway", "CreateThread", {
      participants: [{ participantId: this.identityId }, { participantId: instanceId }], organizationId: this.organizationId
    }, signal)).thread;
  }

  async workloads(instanceId: string, signal?: AbortSignal): Promise<AgynWorkload[]> {
    return this.pages<AgynWorkload>("RunnersGateway", "ListWorkloadsByAgentInstance", { agentInstanceId: instanceId }, "workloads", signal);
  }

  async terminalSession(workloadId: string, argv: string[], signal?: AbortSignal): Promise<{ ticket: string; websocketUrl: string }> {
    return this.call("TerminalGateway", "CreateTerminalSession", {
      workloadId, containerName: "main", kind: "SESSION_KIND_EXEC", command: { argv: { argv } }
    }, signal);
  }

  private async pages<T>(service: string, method: string, body: Record<string, unknown>, field: string, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let pageToken = "";
    do {
      if (seen.has(pageToken) || seen.size >= 1000) throw new Error("Agyn pagination did not terminate within its bound");
      seen.add(pageToken);
      const result = await this.call<Record<string, unknown>>(service, method, { ...body, pageSize: 100, pageToken }, signal);
      if (result[field] !== undefined && !Array.isArray(result[field])) throw new Error("invalid Agyn list response");
      items.push(...(result[field] ?? []) as T[]);
      if (result.nextPageToken !== undefined && typeof result.nextPageToken !== "string") throw new Error("invalid Agyn page token");
      pageToken = result.nextPageToken as string || "";
    } while (pageToken);
    return items;
  }

  private async call<T>(service: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/agynio.api.gateway.v1.${service}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as GatewayError;
      throw new AgynRpcError(`Agyn ${service}.${method} failed (${response.status}${error.code ? ` ${error.code}` : ""}): ${error.message ?? response.statusText}`,
        response.status, error.code);
    }
    return await response.json() as T;
  }
}
