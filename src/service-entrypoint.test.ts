// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("service entry point: binds real HTTP, refuses anonymous access and exits on SIGTERM", async t => {
  const portFinder = createServer(); portFinder.listen(0, "127.0.0.1"); await once(portFinder, "listening");
  const address = portFinder.address(); assert(address && typeof address !== "string");
  await new Promise<void>(resolve => portFinder.close(() => resolve()));
  const directory = mkdtempSync(join(tmpdir(), "a2a-service-main-"));
  const publicUrl = `http://127.0.0.1:${address.port}`;
  const credentialsFile = join(directory, "credentials.json");
  writeFileSync(credentialsFile, "[]", { mode: 0o600 });
  const configPath = join(directory, "service.json");
  writeFileSync(configPath, JSON.stringify({ environmentProfile: "trusted-local", dbPath: join(directory, "tasks.sqlite"),
    credentialsFile, reportingSetupExecutable: "/bin/false", publicUrl, reportingUrl: `${publicUrl}/reporting`,
    host: "127.0.0.1", port: address.port, defaultProfile: "agent", profiles: [{ id: "agent", agentId: "00000000-0000-0000-0000-000000000001" }] }));
  const child = spawn(process.execPath, [new URL("./service/main.js", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, A2A_SERVICE_CONFIG_FILE: configPath, AGYN_GATEWAY_URL: "http://127.0.0.1:1",
      AGYN_TOKEN: "test-only", AGYN_ORGANIZATION_ID: "org", AGYN_IDENTITY_ID: "operator" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = ""; let errors = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  const finished = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await finished; rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(check); reject(new Error(`service startup timed out: ${errors}`)); }, 5000);
    const check = setInterval(() => {
      if (output.includes("listening")) { clearTimeout(timeout); clearInterval(check); resolve(); }
      else if (child.exitCode !== null) { clearTimeout(timeout); clearInterval(check); reject(new Error(errors)); }
    }, 10);
  });
  assert.equal((await fetch(`${publicUrl}/healthz`)).status, 200);
  assert.equal((await fetch(`${publicUrl}/readyz`)).status, 200);
  assert.equal((await fetch(`${publicUrl}/.well-known/agent-card.json`)).status, 200);
  assert.equal((await fetch(`${publicUrl}/a2a`, { method: "POST" })).status, 401);
  child.kill("SIGTERM");
  assert.equal(await finished, 0);
  assert(!output.includes("test-only"));
});
