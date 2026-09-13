// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { claudeNativeProbe, liveAgentProfileSchema, nativeIdentities, persistentAgentEnv } from "./live/agent-profile.js";
import { assertReviewedDeployment } from "./live/kubernetes-proof.js";

test("live deployment preflight requires a reviewed image and complete observed rollout", () => {
  const deployment = { metadata: { name: "runners", uid: randomUUID(), generation: 5 },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "runners", image: "reviewed:confirmation" }] } } },
    status: { observedGeneration: 5, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
  assertReviewedDeployment(deployment, "runners", "reviewed:confirmation");
  assert.throws(() => assertReviewedDeployment(deployment, "runners", ""));
  assert.throws(() => assertReviewedDeployment(deployment, "runners", "legacy:billing"));
  assert.throws(() => assertReviewedDeployment(deployment, "gateway", "reviewed:confirmation"));
  for (const status of [{ observedGeneration: 4 }, { replicas: 2 }, { updatedReplicas: 0 }, { readyReplicas: 0 }, { availableReplicas: 0 }]) {
    assert.throws(() => assertReviewedDeployment({ ...deployment, status: { ...deployment.status, ...status } }, "runners", "reviewed:confirmation"));
  }
  assert.throws(() => assertReviewedDeployment({ ...deployment, metadata: { ...deployment.metadata, deletionTimestamp: new Date().toISOString() } }, "runners", "reviewed:confirmation"));
  assert.throws(() => assertReviewedDeployment({ ...deployment, spec: { ...deployment.spec, replicas: 0 } }, "runners", "reviewed:confirmation"));
});

test("live agent profiles carry references, not credentials or controller overrides", () => {
  const profile = { version: 1, sdk: "claude", model: "claude-sonnet-5", runtimeImageId: randomUUID(),
    runtimeImageTag: "0.1.21", subscriptionId: randomUUID() };
  assert.deepEqual(liveAgentProfileSchema.parse(profile), profile);
  for (const override of [{ sdk: "unknown" }, { version: 2 }, { subscriptionId: "" }, { model: "--bad" },
    { runtimeImageTag: "latest;cmd" }, { token: "never-accept-credentials" }, { controller: "custom" }]) {
    assert.throws(() => liveAgentProfileSchema.parse({ ...profile, ...override }));
  }
  assert.deepEqual(persistentAgentEnv("codex"), { WORKSPACE_DIR: "/workspace", CODEX_HOME: "/workspace/.codex" });
  assert.deepEqual(persistentAgentEnv("claude"), { WORKSPACE_DIR: "/workspace", CLAUDE_CONFIG_DIR: "/workspace/.claude", AGYN_CLAUDE_SESSION_DIR: "/workspace/.agyn/claude-session" });
});

test("native identity evidence cannot pass by comparing missing provider fields", () => {
  const instanceId = randomUUID(), sessionId = randomUUID();
  const codex = { instance_id: instanceId, codex_thread_id: sessionId };
  const claude = { version: 1, agent_id: randomUUID(), instance_id: instanceId, session_id: sessionId,
    work_dir: "/workspace", state_dir: "/workspace/.claude" };
  for (const [sdk, record] of [["codex", codex], ["claude", claude]] as const) {
    assert.deepEqual(nativeIdentities(sdk, [record]), [{ instanceId, sessionId }]);
    assert.throws(() => nativeIdentities(sdk, []));
    assert.throws(() => nativeIdentities(sdk, [record, record]));
  }
  assert.throws(() => nativeIdentities("claude", [codex]));
  assert.throws(() => nativeIdentities("codex", [claude]));
  const used = { ...codex, created_at_unix_ms: 1000, last_used_at_unix_ms: 1000 };
  assert.deepEqual(nativeIdentities("codex", [used]), nativeIdentities("codex", [{ ...used, last_used_at_unix_ms: 2000 }]));
  assert.notDeepEqual(nativeIdentities("codex", [used]), nativeIdentities("codex", [{ ...used, created_at_unix_ms: 2000 }]));
  for (const override of [{ work_dir: "/other" }, { state_dir: "/root/.claude" }, { version: 2 }, { session_id: "" }]) {
    assert.throws(() => nativeIdentities("claude", [{ ...claude, ...override }]));
  }
});

test("serialized native Claude probe verifies transcript identity without exporting message bodies", () => {
  const sessionId = randomUUID();
  const mapping = { session_id: sessionId };
  let body = { type: "user", sessionId, cwd: "/workspace", message: { content: "private-message-body" } };
  let closed = false;
  const fs = { readFileSync: () => JSON.stringify(mapping), readdirSync: () => ["project"], existsSync: () => true,
    openSync: () => 1, closeSync: () => { closed = true; }, readSync: (_file: number, buffer: Buffer) => {
      const data = Buffer.from(JSON.stringify(body) + "\n"); data.copy(buffer); return data.length;
    } };
  const run = () => runInNewContext(`(${claudeNativeProbe.toString()})()`, { Buffer, process: { env: {} }, require: (name: string) =>
    name === "node:fs" ? fs : { execFileSync: () => "2.1.97 (Claude Code)\n" } });
  const result = run();
  assert(closed);
  assert.equal(result.nativeTranscript.sessionId, sessionId);
  assert.equal(result.nativeVersion, "2.1.97 (Claude Code)");
  assert(!JSON.stringify(result).includes("private-message-body"));
  body = { ...body, sessionId: randomUUID() }; assert.throws(run, /mismatch/);
  body = { ...body, sessionId, cwd: "/other" }; assert.throws(run, /mismatch/);
});

test("execution receiver waits only for an absent init gate, with a bounded pre-credential deadline", async t => {
  const source = readFileSync(new URL("../scripts/agyn-execution-receiver.cjs", import.meta.url), "utf8");
  for (const scenario of ["ready", "delayed-directory", "delayed-file", "timeout", "unsafe", "symlink", "permission", "invalid-json", "null", "array", "wrong-identity"]) {
    await t.test(scenario, async () => {
      let now = 0, waits = 0, raw = false, stderr = "", stdout = "";
      const missing = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
      const process = { env: { AGENT_INSTANCE_ID: "instance", WORKLOAD_ID: "workload" }, exitCode: 0,
        stdin: { isTTY: true, setRawMode: () => { raw = true; throw new Error("stop before credentials"); } },
        stderr: { write: (value: string) => { stderr += value; } }, stdout: { write: (value: string) => { stdout += value; } } };
      const fs = { existsSync: () => false, lstatSync: () => {
        if (scenario === "timeout" || scenario === "delayed-directory" && waits < 3) return missing();
        if (scenario === "permission") throw Object.assign(new Error("denied"), { code: "EACCES" });
        return { isDirectory: () => scenario !== "symlink", mode: scenario === "unsafe" ? 0o755 : 0o700 };
      }, readFileSync: () => {
        if (scenario === "delayed-file" && waits < 3) return missing();
        if (scenario === "invalid-json") return "not json";
        if (scenario === "null") return "null";
        if (scenario === "array") return "[]";
        return JSON.stringify({ instanceId: scenario === "wrong-identity" ? "another" : "instance", workloadId: "workload" });
      } };
      await runInNewContext(source, { process, Date: { now: () => now }, require: (name: string) => {
        if (name === "node:fs") return fs;
        if (name === "node:timers/promises") return { setTimeout: async (ms: number) => { now += ms; waits++; } };
        return {};
      } });
      assert.equal(raw, ["ready", "delayed-directory", "delayed-file"].includes(scenario));
      assert.equal(waits, scenario === "timeout" ? 300 : scenario.startsWith("delayed") ? 3 : 0);
      assert.equal(process.exitCode, 1);
      assert.equal(stderr, "Execution binding rejected\n");
      assert.equal(stdout, "", "credentials must not be requested before validated gate and raw terminal mode");
    });
  }
});
