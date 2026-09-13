// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { reportingConfig } from "./config.js";
import { codexStopOutput } from "./stop-check.js";

async function main(): Promise<Record<string, unknown>> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error("hook input exceeds limit");
  }
  const event = z.object({ hook_event_name: z.literal("Stop") }).passthrough().parse(JSON.parse(input));
  if (event.hook_event_name !== "Stop") return {};
  const config = reportingConfig(process.env.REPORTING_CONFIG_FILE);
  const response = await fetch(`${config.url}/stop-check`, {
    method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ checkId: randomUUID() }), redirect: "error", signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error("stop check unavailable");
  const result = z.object({ decision: z.object({ action: z.enum(["allow", "remind", "stop"]), reason: z.string().max(4096) }) }).parse(await response.json());
  return codexStopOutput(result.decision);
}

try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
catch {
  process.stdout.write(`${JSON.stringify({ continue: false, stopReason: "Outcome check unavailable. Stop and let the controller reconcile; do not retry the work." })}\n`);
}
