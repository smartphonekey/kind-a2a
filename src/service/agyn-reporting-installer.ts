#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AgynClient } from "../agyn-client.js";
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
    profileId: z.string().min(1).max(128), reporting: z.object({ url: z.string().url(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
  }).strict().parse(JSON.parse(input));
  stage = "environment";
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error("installer environment missing"); return value; };
  const client = new AgynClient(required("AGYN_GATEWAY_URL"), required("AGYN_TOKEN"), required("AGYN_ORGANIZATION_ID"), required("AGYN_IDENTITY_ID"));
  const signal = AbortSignal.timeout(110_000);
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
      await deliverBinding(ticket, { ...setup, workloadId: workload.meta.id, runtimeSha256 }, JSON.stringify({
        ...setup, workloadId: workload.meta.id, bundle: gzipSync(bundle).toString("base64"), reporting: { ...setup.reporting, allowInsecureLocal }
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
