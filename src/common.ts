import { createHash, randomUUID } from "node:crypto";

export const LAB_NAMESPACE = process.env.AIRA_NAMESPACE ?? "aira-a2a-lab";
export const CONTROLLER_DB = process.env.AIRA_DB_PATH ?? "/data/controller.sqlite";
export const RUNNER_IMAGE = process.env.AIRA_RUNNER_IMAGE ?? "aira-a2a-runner:0.1.0";
export const MAX_ACTIVE_SANDBOXES = 2;

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function dnsName(workspaceId: string): string {
  return `runner-${workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 42)}`;
}

export function stableWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(value)) {
    throw new Error("metadata.workspaceId must be a lowercase DNS label up to 41 characters");
  }
  return value;
}

export function redact(value: unknown): unknown {
  const text = JSON.stringify(value);
  const redacted = text
    .replace(/(?:sk-|sess-|eyJ)[A-Za-z0-9._-]{12,}/g, "[REDACTED]")
    .replace(/("(?:token|authorization|api[_-]?key|secret)"\s*:\s*")[^"]+/gi, "$1[REDACTED]");
  return JSON.parse(redacted);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
