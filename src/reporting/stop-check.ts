// SPDX-License-Identifier: AGPL-3.0-only
import type { ExecutionStatus } from "./mcp.js";

export type StopDecision = { action: "allow" | "remind" | "stop"; reason: string };

export function evaluateStop(status: ExecutionStatus, reminders: number, maxReminders = 2): StopDecision {
  if (!Number.isSafeInteger(reminders) || reminders < 0 || !Number.isSafeInteger(maxReminders) || maxReminders < 0) {
    throw new Error("invalid stop check budget");
  }
  const execution = `execution ${status.executionId}`;
  if (status.canceled) {
    return { action: "stop", reason: `The controller canceled ${execution}. Do not restart that execution.` };
  }
  // Allow the native Stop to finish normally after ACK, including while the
  // coordinator releases compute. A false cancellation notice survives resume.
  if (status.outcome && ["dispatching", "running", "releasing", "settled"].includes(status.phase)) {
    return { action: "allow", reason: `Outcome acknowledged for ${execution}.` };
  }
  if (!["dispatching", "running"].includes(status.phase)) {
    return { action: "stop", reason: `${execution} is no longer active. Do not restart that execution.` };
  }
  if (reminders >= maxReminders) {
    return { action: "stop", reason: `Outcome reporting limit reached for ${execution}. Controller reconciliation is required for that execution; do not claim success.` };
  }
  return { action: "remind", reason: `No outcome is acknowledged for ${execution}. Call report_outcome with turn_done, task_completed, input_required (including your question), or failed. Do not repeat work already performed.` };
}

export function codexStopOutput(decision: StopDecision): Record<string, unknown> {
  // Claude Code and Codex use the same command-Stop decision fields. Keep the
  // existing export name for callers; the decision contract itself is generic.
  if (decision.action === "remind") return { decision: "block", reason: decision.reason };
  if (decision.action === "stop") return { continue: false, stopReason: decision.reason };
  return {};
}
