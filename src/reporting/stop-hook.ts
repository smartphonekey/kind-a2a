// SPDX-License-Identifier: AGPL-3.0-only
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
