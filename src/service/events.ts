// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().min(1).max(128);
const summary = z.string().min(1).max(16_384);

export const reportSchema = z.discriminatedUnion("kind", [
  z.object({ eventId: identifier, kind: z.literal("progress"), message: summary,
    percent: z.number().min(0).max(100).optional() }).strict(),
  z.object({ eventId: identifier, kind: z.literal("outcome"),
    outcome: z.enum(["turn_done", "task_completed", "input_required", "failed"]), message: summary }).strict(),
  z.object({ eventId: identifier, kind: z.literal("artifact"), artifactId: identifier,
    name: z.string().min(1).max(256), text: z.string().max(65_536) }).strict()
]);

export type ExecutionReport = z.infer<typeof reportSchema>;
export type OutcomeReport = Extract<ExecutionReport, { kind: "outcome" }>;

export type TaskEvent = {
  sequence: number;
  taskId: string;
  executionId: string | null;
  at: string;
  kind: string;
  payload: Record<string, unknown>;
};

// Hash structured content independently of object key order, not JSON spelling.
export function contentHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
