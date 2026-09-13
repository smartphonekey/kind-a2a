// SPDX-License-Identifier: AGPL-3.0-only
// Operator fixture only. gateSource is supplied by the live acceptance wrapper.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

(async () => {
  const nonce = process.env.A2A_STARTUP_FAILURE_NONCE;
  assert.match(nonce ?? "", /^[a-f0-9-]{36}$/);
  const config = JSON.parse(fs.readFileSync("/agyn/config.json", "utf8"));
  assert.equal(config.sdk, "codex");
  assert.equal(config.bin, "bin/codex");
  // /agyn is this fixture Pod's emptyDir, verified before fault injection.
  // Unlink first: never follow a runtime-image symlink when writing the sentinel.
  const cli = "/agyn/bin/codex";
  assert(fs.lstatSync(cli).isFile() || fs.lstatSync(cli).isSymbolicLink());
  fs.unlinkSync(cli);
  fs.writeFileSync(cli, '#!/agyn/bin/node\nrequire("node:fs").appendFileSync("/workspace/startup-cli-started.jsonl",JSON.stringify({nonce:process.env.A2A_STARTUP_FAILURE_NONCE})+"\\n");process.exit(49);\n', { flag: "wx", mode: 0o700 });
  execFileSync("/agyn/bin/node", ["-e", gateSource], { timeout: 115_000, stdio: "inherit" });
  const record = { nonce, instanceId: process.env.AGENT_INSTANCE_ID, workloadId: process.env.WORKLOAD_ID, stage: "armed" };
  const save = () => fs.writeFileSync("/workspace/startup-failure.json", JSON.stringify(record), { mode: 0o600 });
  save();
  process.stdout.write(`A2A_STARTUP_FAILURE_ARMED ${nonce}\n`);
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync("/run/agyn-execution/fail-now")) {
    if (Date.now() >= deadline) throw new Error("fault trigger timeout");
    await delay(100);
  }
  assert.equal(fs.readFileSync("/run/agyn-execution/fail-now", "utf8"), nonce);
  record.stage = "failed";
  save();
  process.stdout.write(`A2A_STARTUP_FAILURE_INJECTED ${nonce}\n`);
  process.exitCode = 47;
})().catch(() => {
  process.stderr.write("A2A startup fixture setup failed; no agent execution is permitted\n");
  process.exitCode = 48;
});
