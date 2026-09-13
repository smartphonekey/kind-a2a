// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { reportingConfig } from "./config.js";
import { codexStopOutput } from "./stop-check.js";

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
