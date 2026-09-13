// SPDX-License-Identifier: AGPL-3.0-only
import type { ExecutionStatus } from "./mcp.js";

export type StopDecision = { action: "allow" | "remind" | "stop"; reason: string };

export function evaluateStop(status: ExecutionStatus, reminders: number, maxReminders = 2): StopDecision {
  if (!Number.isSafeInteger(reminders) || reminders < 0 || !Number.isSafeInteger(maxReminders) || maxReminders < 0) {
    throw new Error("invalid stop check budget");
  }
  if (status.canceled || !["dispatching", "running"].includes(status.phase)) {
    return { action: "stop", reason: "Execution is canceled, stopping, or no longer active. Do not restart it." };
  }
  if (status.outcome) return { action: "allow", reason: "Outcome acknowledged." };
  if (reminders >= maxReminders) {
    return { action: "stop", reason: "Outcome reporting limit reached. Controller reconciliation is required; do not claim success." };
  }
  return { action: "remind", reason: "No outcome is acknowledged for this execution. Call report_outcome with turn_done, task_completed, input_required (including your question), or failed. Do not repeat work already performed." };
}

export function codexStopOutput(decision: StopDecision): Record<string, unknown> {
  if (decision.action === "remind") return { decision: "block", reason: decision.reason };
  if (decision.action === "stop") return { continue: false, stopReason: decision.reason };
  return {};
}
