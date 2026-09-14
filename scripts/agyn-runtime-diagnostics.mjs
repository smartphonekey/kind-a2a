// SPDX-License-Identifier: AGPL-3.0-only
// Read-only observer in a separate process so synchronous acceptance probes
// cannot prevent diagnostic capture before an ephemeral Pod is removed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { closeSync, constants, ftruncateSync, fsyncSync, lstatSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { RuntimeDiagnosticStore } from "../dist/live/runtime-diagnostics.js";

assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local");
const [agentId, kubeconfig, output, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert(isAbsolute(kubeconfig ?? "") && isAbsolute(output ?? ""));
const parent = lstatSync(dirname(output));
assert(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0, "private evidence directory required");
const store = new RuntimeDiagnosticStore(agentId);
const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
const exec = promisify(execFile), startedAt = new Date().toISOString();
let stopping = false, polls = 0, failures = 0, fatal = false;
const abort = new AbortController();
const stop = () => { stopping = true; abort.abort(); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const save = (finished = false) => {
  const data = Buffer.from(JSON.stringify({ agentId, startedAt, observedAt: new Date().toISOString(), polls, failures, fatal,
    finished, readOnly: true, rawLogsStored: false, pods: [...store.pods.values()] }, null, 2));
  writeSync(fd, data, 0, data.length, 0); ftruncateSync(fd, data.length); fsyncSync(fd);
};
const k = async (args, maxBuffer) => (await exec("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=3s", ...args], {
  encoding: "utf8", timeout: 5000, maxBuffer, signal: abort.signal
})).stdout;
try {
  save();
  while (!stopping) {
    assert(Date.now() - Date.parse(startedAt) < 30 * 60_000, "diagnostic observer deadline exceeded");
    let pods;
    try {
      pods = JSON.parse(await k(["get", "pods", "-n", "agyn-workloads", "-l",
        `agyn.dev/managed-by=agents-orchestrator,agent-id=${agentId}`, "-o", "json"], 2 * 1024 * 1024));
    } catch {
      if (stopping) break;
      failures++; save();
      if (!polls) throw new Error("initial diagnostic inventory failed");
      await delay(500); continue;
    }
    assert(Array.isArray(pods.items) && pods.items.length <= 32, "invalid diagnostic inventory");
    for (const pod of pods.items) {
      if (stopping) break;
      await store.sample(pod, async identity => {
        // Kubernetes log reads have no UID precondition. Refuse known name
        // replacements; workload names are UUID-scoped, never reused by this fixture.
        const current = JSON.parse(await k(["get", "pod", identity.name, "-n", "agyn-workloads", "-o", "json"], 2 * 1024 * 1024));
        assert.equal(current.metadata?.uid, identity.uid);
        store.observe(current);
        return k(["logs", identity.name, "-n", "agyn-workloads", "-c", identity.container,
          "--tail=100", "--limit-bytes=16384", "--timestamps=true"], 64 * 1024);
      });
    }
    polls++; save();
    if (polls === 1) process.send?.({ ready: true });
    await delay(500);
  }
} catch {
  fatal = true; process.exitCode = 1;
} finally {
  save(true); closeSync(fd); process.disconnect?.();
}
