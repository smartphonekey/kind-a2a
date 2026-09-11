import { randomUUID } from "node:crypto";
import { ClientFactory } from "@a2a-js/sdk/client";
import { Role, type Message, type StreamResponse, type Task } from "@a2a-js/sdk";

const baseUrl = process.env.AIRA_URL ?? "http://127.0.0.1:8081";
const [command, ...args] = process.argv.slice(2);
const factory = new ClientFactory();

function message(prompt: string, contextId: string, taskId: string, idempotencyKey: string, referenceTaskIds: string[] = [], endTask = false): Message {
  return { messageId: randomUUID(), contextId: contextId as Message["contextId"], taskId: taskId as Message["taskId"], role: Role.ROLE_USER,
    parts: [{ content: { $case: "text", value: prompt }, metadata: {}, filename: "", mediaType: "text/plain" }],
    metadata: { idempotencyKey, endTask }, extensions: [], referenceTaskIds };
}

async function stream(prompt: string, contextId = "", taskId = "", idempotencyKey: string = randomUUID(), referenceTaskIds: string[] = [], endTask = false): Promise<void> {
  const client = await factory.createFromUrl(baseUrl);
  let final: Task | undefined;
  for await (const event of client.sendMessageStream({ tenant: "", message: message(prompt, contextId, taskId, idempotencyKey, referenceTaskIds, endTask), configuration: { acceptedOutputModes: ["text/plain"], taskPushNotificationConfig: undefined, returnImmediately: false }, metadata: {} })) {
    const response = event as StreamResponse;
    console.log(JSON.stringify(response));
    if (response.payload?.$case === "task") final = response.payload.value;
    if (response.payload?.$case === "statusUpdate" && final) final = { ...final, status: response.payload.value.status };
  }
  if (final) console.log(JSON.stringify({ finalTaskId: final.id, contextId: final.contextId, state: final.status?.state }, null, 2));
}

if (command === "submit") {
  const [prompt, idempotencyKey] = args;
  if (!prompt) throw new Error("usage: client submit <prompt> [idempotency-key]");
  await stream(prompt, "", "", idempotencyKey);
} else if (command === "continue") {
  const [taskId, prompt, idempotencyKey] = args;
  if (!taskId || !prompt) throw new Error("usage: client continue <task-id> <prompt> [idempotency-key]");
  const client = await factory.createFromUrl(baseUrl);
  const existing = await client.getTask({ tenant: "", id: taskId });
  await stream(prompt, existing.contextId, taskId, idempotencyKey);
} else if (command === "finish") {
  const [taskId, prompt, idempotencyKey] = args;
  if (!taskId || !prompt) throw new Error("usage: client finish <task-id> <prompt> [idempotency-key]");
  const client = await factory.createFromUrl(baseUrl);
  const existing = await client.getTask({ tenant: "", id: taskId });
  await stream(prompt, existing.contextId, taskId, idempotencyKey, [], true);
} else if (command === "followup") {
  const [referenceTaskId, prompt, idempotencyKey] = args;
  if (!referenceTaskId || !prompt) throw new Error("usage: client followup <reference-task-id> <prompt> [idempotency-key]");
  const client = await factory.createFromUrl(baseUrl);
  const existing = await client.getTask({ tenant: "", id: referenceTaskId });
  await stream(prompt, existing.contextId, "", idempotencyKey, [referenceTaskId]);
} else if (command === "cancel") {
  const [taskId] = args; if (!taskId) throw new Error("usage: client cancel <task-id>");
  const client = await factory.createFromUrl(baseUrl); console.log(JSON.stringify(await client.cancelTask({ tenant: "", id: taskId, metadata: {} }), null, 2));
} else if (command === "task") {
  const [taskId] = args; if (!taskId) throw new Error("usage: client task <task-id>");
  const client = await factory.createFromUrl(baseUrl); console.log(JSON.stringify(await client.getTask({ tenant: "", id: taskId }), null, 2));
} else {
  throw new Error("commands: submit, continue, finish, followup, cancel, task");
}
