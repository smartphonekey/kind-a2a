// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Define MCP tools for progress, artifacts, outcomes and execution status.
 *
 * @module
 * @remarks Tool arguments cannot select a task, execution or instance. A durable
 * outcome ACK requires the agent to stop work; it neither certifies runtime
 * removal nor settles the task. The service worker owns that transition.
 * @see SERVICE.md#reporting-setup-contract
 * @see src/service/events.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ExecutionReport, type OutcomeReport } from "../service/events.js";

/** A committed event sequence; identical retries return the same sequence with duplicate=true. */
export type ReportReceipt = { executionId: string; sequence: number; duplicate: boolean };
/** Durable execution state, not provider liveness or evidence that compute was released. */
export type ExecutionStatus = {
  executionId: string;
  phase: string;
  canceled: boolean;
  outcome: OutcomeReport | null;
};

/**
 * A client already bound by authentication to one execution and instance.
 * Implementations must resolve reports only after durable acceptance, reject
 * eventId reuse with changed content, and preserve receipts for identical retries.
 */
export interface ReportingClient {
  /**
   * An outcome closes new reporting; identical retries can recover receipts even
   * after that outcome, while authorized. Retry the ID/content, never the work.
   */
  report(event: ExecutionReport): Promise<ReportReceipt>;
  /** Read acknowledged state; an unavailable status must not be treated as completion. */
  status(): Promise<ExecutionStatus>;
}

/**
 * Create an unconnected server over an already-scoped client.
 * Artifacts precede the outcome; turn_done is resumable, task_completed closes
 * the task after settlement. Backend failures become sanitized MCP errors,
 * never receipts or automatic retries. The caller owns transport and closure.
 */
export function createReportingMcp(client: ReportingClient): McpServer {
  const server = new McpServer({ name: "execution-reporting", version: "0.1.0" });
  const eventId = z.string().min(1).max(128).describe("Unique event ID within this execution. Reuse it when retrying the same report.");
  const message = z.string().min(1).max(16_384);
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const report = async (event: ExecutionReport) => {
    try {
      const receipt = await client.report(event);
      return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], structuredContent: receipt };
    } catch {
      // Transport errors may contain endpoint credentials or private infrastructure details.
      return { isError: true, content: [{ type: "text" as const,
        text: "Report was not acknowledged. Retry the same event ID and content, or check execution status. Do not repeat the work itself." }] };
    }
  };
  server.registerTool("report_progress", {
    description: "Record progress for the current execution. Progress does not complete the execution.",
    inputSchema: z.object({ eventId, message, percent: z.number().min(0).max(100).optional() }).strict(), annotations
  }, input => report({ ...input, kind: "progress" }));
  server.registerTool("report_artifact", {
    description: "Publish a bounded text artifact for the current execution.",
    inputSchema: z.object({ eventId, artifactId: z.string().min(1).max(128), name: z.string().min(1).max(256),
      text: z.string().max(65_536) }).strict(), annotations
  }, input => report({ ...input, kind: "artifact" }));
  server.registerTool("report_outcome", {
    description: "Report the execution outcome before stopping. Use input_required with a question when blocked on input, turn_done for a resumable turn, task_completed only for a finished task, or failed with an explanation. Report artifacts first. Do not perform further work after acknowledgement.",
    inputSchema: z.object({ eventId, message,
      outcome: z.enum(["turn_done", "task_completed", "input_required", "failed"]) }).strict(), annotations
  }, input => report({ ...input, kind: "outcome" }));
  server.registerTool("get_execution_status", {
    description: "Check whether an outcome was acknowledged for the current execution.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    try {
      const status = await client.status();
      return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Execution status is unavailable. Do not assume the execution completed." }] };
    }
  });
  return server;
}
