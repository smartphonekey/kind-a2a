// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { V1Pod } from "@kubernetes/client-node";
import { RuntimeDiagnosticStore, runtimePodIdentity, safePodState, safeRuntimeLog, startRuntimeDiagnostics } from "./live/runtime-diagnostics.js";

const fixture = () => {
  const agentId = randomUUID(), instanceId = randomUUID(), workloadId = randomUUID();
  const pod: V1Pod = { metadata: { name: `workload-${workloadId}`, namespace: "agyn-workloads", uid: randomUUID(), labels: {
    "agent-id": agentId, "agent-instance-id": instanceId, "agyn.io/workload-id": workloadId, "agyn.dev/managed-by": "agents-orchestrator"
  } }, spec: { containers: [{ name: "agent-main", env: [{ name: "AGENT_INSTANCE_ID", value: instanceId }, { name: "SECRET", value: "never-export-this" }] }] },
  status: { phase: "Running", containerStatuses: [{ name: "agent-main", image: "fixture", imageID: "fixture", ready: true, restartCount: 0,
    state: { running: {} } }] } };
  return { pod, agentId };
};

test("runtime diagnostics retain safe result metadata, not arbitrary log text", () => {
  const log = "2026/09/14 daemon exited: Claude returned an error result; reconciliation required (result_subtype=error_during_execution, terminal_reason=api_error, api_status=400)";
  assert.deepEqual(safeRuntimeLog(log + "\n" + log + "\nSECRET never-export-this\n{\"thinking\":\"never-export-this\"}"), [
    { kind: "claude_result_error", subtype: "error_during_execution", terminalReason: "api_error", apiStatus: 400 }
  ]);
  assert.deepEqual(safeRuntimeLog("Claude returned an error result; reconciliation required (result_subtype=never-export-this, terminal_reason=private, api_status=999)"), [
    { kind: "claude_result_error", subtype: "unknown", terminalReason: "unknown", apiStatus: 0 }
  ]);
  assert.deepEqual(safeRuntimeLog("daemon exited: private provider response"), [{ kind: "daemon_failure_unclassified" }]);
  assert.deepEqual(safeRuntimeLog("claude process exited: exit status 1"), [{ kind: "claude_process_exit", exitCode: 1 }]);
  assert.throws(() => safeRuntimeLog("x".repeat(65537)), /bound/);
});

test("runtime diagnostics reject foreign or ambiguous Pod bindings before reading logs", async () => {
  for (const mutate of [
    (p: V1Pod) => { p.metadata!.namespace = "agyn-platform"; },
    (p: V1Pod) => { p.metadata!.labels!["agent-id"] = randomUUID(); },
    (p: V1Pod) => { delete p.metadata!.labels!["agent-instance-id"]; },
    (p: V1Pod) => { p.metadata!.labels!["agyn.dev/managed-by"] = "foreign"; },
    (p: V1Pod) => { p.metadata!.name = "other"; },
    (p: V1Pod) => { p.spec!.containers.push(structuredClone(p.spec!.containers[0])); }
  ]) {
    const { pod, agentId } = fixture(); mutate(pod);
    let reads = 0;
    await assert.rejects(new RuntimeDiagnosticStore(agentId).sample(pod, async () => { reads++; return ""; }));
    assert.equal(reads, 0);
  }
});

test("runtime diagnostic state excludes env, raw termination messages and unknown reasons", () => {
  const { pod, agentId } = fixture();
  pod.status!.containerStatuses![0].state = { terminated: { exitCode: 137, signal: 9, reason: "OOMKilled", message: "never-export-this" } };
  const state = safePodState(pod);
  assert.equal(state.containers[0].exitCode, 137); assert.equal(state.containers[0].reason, "OOMKilled");
  assert(!JSON.stringify({ state, identity: runtimePodIdentity(pod, agentId) }).includes("never-export-this"));
  pod.status!.containerStatuses![0].state!.terminated!.reason = "never-export-this";
  assert.equal(safePodState(pod).containers[0].reason, "unknown");
});

test("runtime diagnostics survive log disappearance and retain distinct replacement Pod identities", async () => {
  const { pod, agentId } = fixture(), store = new RuntimeDiagnosticStore(agentId);
  const log = async () => "daemon exited: private error";
  await store.sample(pod, log); await store.sample(pod, log);
  await store.sample(pod, async () => { throw new Error("private API failure"); });
  const entry = store.pods.get(pod.metadata!.uid!)!;
  assert.equal(entry.logReads, 2); assert.equal(entry.logReadFailures, 1);
  assert.equal(entry.states.length, 1); assert.equal(entry.signals.length, 1);
  const next = structuredClone(pod), workloadId = randomUUID();
  next.metadata!.uid = randomUUID(); next.metadata!.name = `workload-${workloadId}`;
  next.metadata!.labels!["agyn.io/workload-id"] = workloadId;
  await store.sample(next, log); assert.equal(store.pods.size, 2);
  assert(!JSON.stringify([...store.pods.values()]).includes("private"));
  const altered = structuredClone(pod); altered.spec!.containers[0].name = "changed";
  assert.throws(() => store.observe(altered), /identity changed/);
});

for (const mode of ["success", "foreign", "inventory-failure", "replaced", "abort-inflight"]) {
  test(`runtime diagnostic subprocess: ${mode}`, { timeout: 15_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "a2a-runtime-diagnostic-")), previousPath = process.env.PATH;
    t.after(() => { process.env.PATH = previousPath; rmSync(directory, { recursive: true, force: true }); });
    const { pod, agentId } = fixture();
    if (mode === "foreign") pod.metadata!.labels!["agent-id"] = randomUUID();
    const calls = join(directory, "calls.jsonl");
    writeFileSync(join(directory, "kubectl"), `#!/usr/bin/env node
const fs=require("node:fs"), args=process.argv.slice(2), mode=${JSON.stringify(mode)}, calls=${JSON.stringify(calls)};
const pod=${JSON.stringify(pod)};
const prior=fs.existsSync(calls)?fs.readFileSync(calls,"utf8").trim().split("\\n").length:0;
fs.appendFileSync(calls,JSON.stringify(args)+"\\n");
if(mode==="inventory-failure")process.exit(1);
if(mode==="abort-inflight"&&prior>0){setTimeout(()=>process.exit(1),30000);}
else if(args.includes("logs"))console.log("daemon exited: Claude returned an error result; reconciliation required (result_subtype=error_during_execution, terminal_reason=api_error, api_status=400) never-export-this");
else if(args.includes("pods"))console.log(JSON.stringify({items:mode==="abort-inflight"?[]:[pod]}));
else if(args.includes("pod")){if(mode==="replaced")pod.metadata.uid=${JSON.stringify(randomUUID())};console.log(JSON.stringify(pod));}
else process.exit(2);
`, { mode: 0o700 });
    process.env.PATH = `${directory}:${previousPath}`;
    const start = () => startRuntimeDiagnostics(agentId, join(directory, "kubeconfig"), directory);
    if (["foreign", "inventory-failure"].includes(mode)) await assert.rejects(start(), /initialize/);
    else {
      const observer = await start();
      try {
        if (mode === "abort-inflight") {
          for (let i = 0; i < 50 && readFileSync(calls, "utf8").trim().split("\n").length < 2; i++) await delay(50);
          assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 2);
        }
      } finally { await observer.stop(); }
    }
    const file = join(directory, "runtime-diagnostics.json"), raw = readFileSync(file, "utf8"), report = JSON.parse(raw);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(report.finished, true); assert.equal(report.readOnly, true); assert.equal(report.rawLogsStored, false);
    assert(!raw.includes("never-export-this"));
    const commands: string[][] = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert(commands.every(args => args.includes("get") || args.includes("logs")));
    if (mode === "success") assert.equal(report.pods[0].signals[0].apiStatus, 400);
    if (mode === "replaced") { assert(!commands.some(args => args.includes("logs"))); assert(report.pods[0].logReadFailures > 0); }
    if (["foreign", "inventory-failure"].includes(mode)) { assert.equal(report.fatal, true); assert(!commands.some(args => args.includes("logs"))); }
    if (mode === "abort-inflight") assert.equal(report.fatal, false);
  });
}
