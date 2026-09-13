// SPDX-License-Identifier: AGPL-3.0-only
// Register as an environment init script before any agent CLI is started.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const directory = "/run/agyn-execution";

(async () => {
  const { AGENT_INSTANCE_ID: instanceId, WORKLOAD_ID: workloadId, A2A_REPORTING_RUNTIME_SHA256: runtimeSha256 } = process.env;
  if (!instanceId || !workloadId || !/^[a-f0-9]{64}$/.test(runtimeSha256 || "")) throw new Error("gate configuration missing");
  // Re-entering in the same container is ambiguous, not permission to replay its inbox.
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(`${directory}/gate.json`, JSON.stringify({ instanceId, workloadId, runtimeSha256 }), { mode: 0o600, flag: "wx" });
  const deadline = Date.now() + 110_000;
  while (!fs.existsSync(`${directory}/received`)) {
    if (Date.now() >= deadline) throw new Error("execution setup timed out");
    await delay(100);
  }
  execFileSync(process.execPath, [`${directory}/runtime.mjs`, "install", directory, "/agyn/bin/node"], { timeout: 10_000, stdio: "ignore" });
})().catch(() => { process.stderr.write("Execution init gate failed; agent must not start\n"); process.exitCode = 1; });
