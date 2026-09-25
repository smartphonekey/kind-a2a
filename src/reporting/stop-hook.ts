// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Standalone native Stop executable using the private REPORTING_CONFIG_FILE.
 *
 * @module
 * @remarks Rejects stdin larger than 64 KiB and emits one JSON hook decision.
 * Input/configuration/transport failure emits a stop-and-reconcile instruction,
 * not success; exit status alone is not the decision. Importing runs the hook.
 * @see SERVICE.md#reporting-setup-contract
 * @see src/reporting/hook-client.ts
 * @see src/reporting-http.test.ts
 */
import { runStopHook } from "./hook-client.js";

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error("hook input exceeds limit");
  }
  process.stdout.write(`${JSON.stringify(await runStopHook(input, process.env.REPORTING_CONFIG_FILE))}\n`);
}

try { await main(); }
catch {
  process.stdout.write(`${JSON.stringify({ continue: false, stopReason: "Outcome check unavailable. Stop and let the controller reconcile; do not retry the work." })}\n`);
}
