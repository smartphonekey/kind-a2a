#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stdin/stdout executable that installs execution-scoped MCP reporting into an Agyn workload.
 * @module
 * @remarks Wait for one unremoved workload and its registered main container, then
 * deliver the bundled runtime and credential through an immutable terminal command.
 * The payload supplies current/retired request IDs for the inbox guard; the delivered
 * runtime installs runtime-specific MCP/Stop configuration. Success requires identity-bound
 * delivery and remote completion, proving setup only, not an outcome or release.
 * Failures emit only allowlisted diagnostics.
 * @see src/service/agyn-terminal.ts
 * @see src/reporting/runtime.ts
 * @see src/reporting/agent-config.ts
 * @see daemon::internal/daemon/init_scripts
 * @see daemon::internal/inboxjournal/journal
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { agynClientFromEnvironment } from "./agyn-gateway-auth.js";
import { deliverBinding, reportingTargetReady } from "./agyn-terminal.js";
import { setupFailure, type SetupStage } from "./setup-diagnostics.js";

let stage: SetupStage = "input";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16384) throw new Error("installer input limit");
  }
  const setup = z.object({ executionId: z.string().uuid(), instanceId: z.string().uuid(), threadId: z.string().uuid(),
    requestId: z.string().uuid(), retiredRequestIds: z.array(z.string().uuid()).max(256),
    profileId: z.string().min(1).max(128), reporting: z.object({ url: z.string().url(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
    setupTimeoutMs: z.number().int().min(20_000).max(600_000).default(120_000)
  }).strict().parse(JSON.parse(input));
  const { setupTimeoutMs, ...binding } = setup;
  stage = "environment";
  const client = await agynClientFromEnvironment();
  // Finish ten seconds inside the caller's deadline so a failure is still diagnosed rather than killed.
  const signal = AbortSignal.timeout(setupTimeoutMs - 10_000);
  const bundle = readFileSync(new URL("../reporting/runtime.mjs", import.meta.url));
  const runtimeSha256 = createHash("sha256").update(bundle).digest("hex");
  const receiver = readFileSync(new URL("../reporting/receiver.cjs", import.meta.url), "utf8");
  const allowInsecureLocal = process.env.A2A_ALLOW_INSECURE_LOCAL_REPORTING === "true";
  stage = "runtime";
  while (!signal.aborted) {
    const instance = await client.getInstance(setup.instanceId, signal);
    if (instance.state !== "AGENT_INSTANCE_STATE_ACTIVE") throw new Error("runtime no longer active");
    const workloads = (await client.workloads(setup.instanceId, signal)).filter(workload => !workload.removalConfirmedAt);
    if (workloads.length > 1 || workloads.some(workload => workload.agentInstanceId !== setup.instanceId)) throw new Error("ambiguous workload identity");
    const workload = workloads[0];
    if (workload?.status === "WORKLOAD_STATUS_FAILED") throw new Error("runtime failed");
    if (workload?.status === "WORKLOAD_STATUS_RUNNING" && reportingTargetReady(workload)) {
      stage = "ticket";
      const ticket = await client.terminalSession(workload.meta.id, ["/agyn/bin/node", "-e", receiver], signal);
      stage = "delivery";
      await deliverBinding(ticket, { ...binding, workloadId: workload.meta.id, runtimeSha256 }, JSON.stringify({
        ...binding, workloadId: workload.meta.id, bundle: gzipSync(bundle).toString("base64"), reporting: { ...binding.reporting, allowInsecureLocal }
      }), signal, allowInsecureLocal);
      process.stdout.write(JSON.stringify({ executionId: setup.executionId, instanceId: setup.instanceId, workloadId: workload.meta.id, reportingConfigured: true }) + "\n");
      return;
    }
    await delay(500, undefined, { signal });
  }
  throw new Error("runtime did not start");
}

try { await main(); }
catch (error) {
  process.stdout.write(JSON.stringify(setupFailure(stage, error)) + "\n");
  process.stderr.write("Agyn execution reporting setup failed\n"); process.exitCode = 1;
}
