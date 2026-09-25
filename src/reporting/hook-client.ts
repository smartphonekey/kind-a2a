// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bridge native Stop input to the authenticated, execution-scoped stop check.
 *
 * @module
 * @remarks The service owns the reminder budget. Missing configuration, malformed
 * input or unavailable reporting stops locally without claiming an outcome.
 * @see src/reporting/stop-check.ts
 * @see src/reporting-http.test.ts
 * @see SERVICE.md#reporting-setup-contract
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { reportingConfig } from "./config.js";
import { codexStopOutput } from "./stop-check.js";

/**
 * Check once with a fresh ID per invocation, so repeated native turn IDs cannot
 * bypass the reminder budget. Redirects are rejected and the request times out
 * after five seconds. Failures return a sanitized stop/reconcile instruction,
 * never permission to repeat work; the executable caller bounds stdin size.
 */
export async function runStopHook(input: string, configFile: string | undefined): Promise<Record<string, unknown>> {
  try {
    z.object({ hook_event_name: z.literal("Stop") }).passthrough().parse(JSON.parse(input));
    const config = reportingConfig(configFile);
    const response = await fetch(`${config.url}/stop-check`, {
      method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ checkId: randomUUID() }), redirect: "error", signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error("stop check unavailable");
    const result = z.object({ decision: z.object({ action: z.enum(["allow", "remind", "stop"]), reason: z.string().max(4096) }) }).parse(await response.json());
    return codexStopOutput(result.decision);
  } catch {
    return { continue: false, stopReason: "Outcome check unavailable. Stop and let the controller reconcile; do not retry the work." };
  }
}
