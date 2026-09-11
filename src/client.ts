import { randomUUID } from "node:crypto";
import { ClientFactory } from "@a2a-js/sdk/client";
import { Role, type Message, type StreamResponse, type Task } from "@a2a-js/sdk";

const baseUrl = process.env.AIRA_URL ?? "http://127.0.0.1:8081";
const [command, ...args] = process.argv.slice(2);
const factory = new ClientFactory();

function message(workspaceId: string, contextId: string, prompt: string, idempotencyKey: string): Message {
  return { messageId: randomUUID(), contextId: contextId as Message["contextId"], taskId: "", role: Role.ROLE_USER,
    parts: [{ content: { $case: "text", value: prompt }, metadata: {}, filename: "", mediaType: "text/plain" }],
    metadata: { workspaceId, idempotencyKey }, extensions: [], referenceTaskIds: [] };
}

async function stream(workspaceId: string, prompt: string, contextId: string = randomUUID(), idempotencyKey: string = randomUUID()): Promise<void> {
  const client = await factory.createFromUrl(baseUrl);
  let final: Task | undefined;
  for await (const event of client.sendMessageStream({ tenant: "", message: message(workspaceId, contextId, prompt, idempotencyKey), configuration: { acceptedOutputModes: ["text/plain"], taskPushNotificationConfig: undefined, returnImmediately: false }, metadata: {} })) {
    const response = event as StreamResponse;
    console.log(JSON.stringify(response));
    if (response.payload?.$case === "task") final = response.payload.value;
  }
  if (final) console.log(JSON.stringify({ finalTaskId: final.id, contextId: final.contextId, state: final.status?.state }, null, 2));
}

if (command === "submit") {
  const [workspaceId, prompt, contextId, idempotencyKey] = args;
  if (!workspaceId || !prompt) throw new Error("usage: client submit <workspace-id> <prompt> [context-id] [idempotency-key]");
  await stream(workspaceId, prompt, contextId, idempotencyKey);
} else if (command === "cancel") {
  const [taskId] = args; if (!taskId) throw new Error("usage: client cancel <task-id>");
  const client = await factory.createFromUrl(baseUrl); console.log(JSON.stringify(await client.cancelTask({ tenant: "", id: taskId, metadata: {} }), null, 2));
} else if (command === "task") {
  const [taskId] = args; if (!taskId) throw new Error("usage: client task <task-id>");
  const client = await factory.createFromUrl(baseUrl); console.log(JSON.stringify(await client.getTask({ tenant: "", id: taskId }), null, 2));
} else {
  throw new Error("commands: submit, cancel, task");
}
