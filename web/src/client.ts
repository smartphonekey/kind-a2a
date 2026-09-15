// SPDX-License-Identifier: AGPL-3.0-only
import {
  A2AClient,
  type A2AMessage,
  type A2ASendMessageConfiguration,
  type A2AStreamEvent,
  type A2ATask,
  a2aMessageToContent,
  isTerminalTaskState,
} from "@assistant-ui/react-a2a";
import {
  fromThreadMessageLike,
  type ExportedMessageRepository,
  type ThreadMessage,
} from "@assistant-ui/react";

export type Profile = { id: string; name?: string };
export type Session = {
  subject: string;
  profiles: Profile[];
  defaultProfile: string;
};
export const waiting = (task?: A2ATask) =>
  task && ["input_required", "auth_required"].includes(task.status.state);
export const terminal = (task?: A2ATask) =>
  task ? isTerminalTaskState(task.status.state) : false;
export const profileName = (profile: Profile) => profile.name ?? profile.id;
export function taskTitle(task: A2ATask) {
  return typeof task.metadata?.title === "string"
    ? task.metadata.title
    : (task.history?.find((m) => m.role === "user")?.parts.find((p) => p.text)
        ?.text ?? `Task ${task.id.slice(0, 8)}`);
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/web-api/${path}`, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Sign in to continue."
        : response.status === 429
          ? "Too many requests. Try again shortly."
          : "The service is unavailable. No message was retried.",
    );
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}
export function makeClient(profileId?: string) {
  return new A2AClient({
    baseUrl: `${location.origin}/web-api/${profileId ? `agents/${encodeURIComponent(profileId)}` : "a2a"}`,
    fetchOptions: { credentials: "same-origin" },
  });
}

export function historyRepository(task?: A2ATask): ExportedMessageRepository {
  const messages: ThreadMessage[] = (task?.history ?? []).map((message) =>
    fromThreadMessageLike(
      {
        id: message.messageId,
        createdAt: new Date(task?.status.timestamp ?? 0),
        ...(message.role === "user"
          ? {
              role: "user" as const,
              content: message.parts.flatMap((p) =>
                p.text ? [{ type: "text" as const, text: p.text }] : [],
              ),
            }
          : {
              role: "assistant" as const,
              content: a2aMessageToContent(message),
              status: { type: "complete" as const, reason: "stop" as const },
            }),
        metadata: { custom: message.metadata ?? {} },
      },
      message.messageId,
      { type: "complete", reason: "stop" },
    ),
  );
  const latest = task?.status.message;
  if (
    latest &&
    latest.parts.some((p) => p.text) &&
    !messages.some((m) =>
      m.content.some(
        (p) =>
          p.type === "text" &&
          p.text === latest.parts.find((p) => p.text)?.text,
      ),
    )
  ) {
    messages.push(
      fromThreadMessageLike(
        {
          id: `status:${task!.id}`,
          role: "assistant",
          content: a2aMessageToContent(latest),
          createdAt: new Date(task?.status.timestamp ?? 0),
          status: { type: "complete", reason: "stop" },
          metadata: { custom: {} },
        },
        `status:${task!.id}`,
        { type: "complete", reason: "stop" },
      ),
    );
  }
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((message, index) => ({
      message,
      parentId: messages[index - 1]?.id ?? null,
    })),
  };
}

/** Adds task recovery to the public native client API, without patching assistant-ui internals. */
export class TaskClient extends A2AClient {
  task: A2ATask | undefined;
  streaming = false;
  onTask: (task: A2ATask) => void = () => {};
  constructor(profileId: string, task?: A2ATask) {
    super({
      baseUrl: `${location.origin}/web-api/agents/${encodeURIComponent(profileId)}`,
      fetchOptions: { credentials: "same-origin" },
    });
    this.task = task;
  }
  override async *streamMessage(
    message: A2AMessage,
    configuration?: A2ASendMessageConfiguration,
    metadata?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<A2AStreamEvent> {
    if (terminal(this.task))
      throw new Error("This task has ended. Start a new task.");
    this.streaming = true;
    try {
      const bound = this.task
        ? { ...message, taskId: this.task.id, contextId: this.task.contextId }
        : message;
      for await (const event of super.streamMessage(
        bound,
        configuration,
        metadata,
        signal,
      )) {
        if (event.type === "task") this.task = event.task;
        if (event.type === "statusUpdate" && this.task)
          this.task = {
            ...this.task,
            status: event.event.status,
            metadata: { ...this.task.metadata, ...event.event.metadata },
          };
        if (event.type === "artifactUpdate" && this.task) {
          const artifacts = [...(this.task.artifacts ?? [])];
          const index = artifacts.findIndex(
            (a) => a.artifactId === event.event.artifact.artifactId,
          );
          const artifact =
            event.event.append && index >= 0
              ? {
                  ...event.event.artifact,
                  parts: [
                    ...artifacts[index].parts,
                    ...event.event.artifact.parts,
                  ],
                }
              : event.event.artifact;
          if (index >= 0) artifacts[index] = artifact;
          else artifacts.push(artifact);
          this.task = { ...this.task, artifacts };
        }
        if (this.task) this.onTask(this.task);
        yield event;
        // A paused task does not need an open browser request (nor a running Pod).
        if (waiting(this.task) || terminal(this.task)) break;
      }
    } finally {
      this.streaming = false;
    }
  }
}
