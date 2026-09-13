// SPDX-License-Identifier: AGPL-3.0-only
// Executed by Agyn's authenticated TerminalGateway, never by an agent tool.
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { setTimeout: delay } = require("node:timers/promises");
const directory = "/run/agyn-execution";

(async () => {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.mode & 0o077) throw new Error("private gate required");
  const gate = JSON.parse(fs.readFileSync(`${directory}/gate.json`, "utf8"));
  if (gate.instanceId !== process.env.AGENT_INSTANCE_ID || gate.workloadId !== process.env.WORKLOAD_ID) throw new Error("gate identity mismatch");
  if (fs.existsSync(`${directory}/received`)) throw new Error("gate already bound");
  if (!process.stdin.isTTY) throw new Error("terminal transport required");
  // Disable terminal echo before acknowledging readiness to receive credentials.
  process.stdin.setRawMode(true);
  process.stdout.write(`${JSON.stringify({ ready: true, ...gate })}\n`);
  const input = await new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("input timeout")), 30_000);
    process.stdin.on("data", chunk => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) { clearTimeout(timer); reject(new Error("input limit")); return; }
      if (data.endsWith("\n")) { clearTimeout(timer); process.stdin.pause(); resolve(data); }
    });
  });
  const payload = JSON.parse(input);
  if (payload.instanceId !== gate.instanceId || payload.workloadId !== gate.workloadId || !/^[a-f0-9-]{36}$/.test(payload.executionId)) throw new Error("binding mismatch");
  const bundle = gunzipSync(Buffer.from(payload.bundle, "base64"), { maxOutputLength: 8 * 1024 * 1024 });
  if (createHash("sha256").update(bundle).digest("hex") !== gate.runtimeSha256) throw new Error("runtime digest mismatch");
  fs.writeFileSync(`${directory}/runtime.mjs`, bundle, { mode: 0o500, flag: "wx" });
  fs.writeFileSync(`${directory}/binding.json`, JSON.stringify(payload.reporting), { mode: 0o600, flag: "wx" });
  fs.writeFileSync(`${directory}/expected.json`, JSON.stringify({ executionId: payload.executionId, instanceId: gate.instanceId }), { mode: 0o600, flag: "wx" });
  fs.writeFileSync(`${directory}/inbox-control.json`, JSON.stringify({ version: 1, instance_id: gate.instanceId,
    allowed_message_id: payload.requestId, ack_only_message_ids: payload.retiredRequestIds }), { mode: 0o600, flag: "wx" });
  fs.writeFileSync(`${directory}/received`, "", { mode: 0o600, flag: "wx" });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(`${directory}/configured.json`)) {
    if (Date.now() >= deadline) throw new Error("configuration timeout");
    await delay(100);
  }
  process.stdout.write(fs.readFileSync(`${directory}/configured.json`, "utf8") + "\n");
})().catch(() => { process.stderr.write("Execution binding rejected\n"); process.exitCode = 1; });
