// SPDX-License-Identifier: AGPL-3.0-only
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ExecutionReport, type OutcomeReport } from "../service/events.js";

export type ReportReceipt = { executionId: string; sequence: number; duplicate: boolean };
export type ExecutionStatus = {
  executionId: string;
  phase: string;
  canceled: boolean;
  outcome: OutcomeReport | null;
};

// Authentication binds this client to an execution; tool arguments cannot select one.
export interface ReportingClient {
  report(event: ExecutionReport): Promise<ReportReceipt>;
  status(): Promise<ExecutionStatus>;
}

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
