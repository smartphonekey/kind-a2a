// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { assertHeldFailure, finalizerPatch, type HeldPod } from "./live/removal-proof.js";

const nonce = "21f17139-095e-4264-89e8-17082ba1ec63";
const held: HeldPod = { name: "fixture", uid: "pod-uid", agentId: "agent", instanceId: "instance", containerName: "agent-dynamic-name", finalizer: `a2a-lab.agyn.dev/removal-${nonce}` };
const pod = () => ({ metadata: { name: held.name, uid: held.uid, namespace: "agyn-workloads", resourceVersion: "7",
  labels: { "agent-id": held.agentId, "agyn.dev/managed-by": "agents-orchestrator" }, finalizers: ["other.example/owner"] },
  spec: { containers: [{ name: held.containerName, env: [{ name: "AGENT_INSTANCE_ID", value: held.instanceId }] }] } });

test("removal proof: finalizer changes require exact ownership and retain unrelated finalizers", () => {
  const original = pod(), patch = finalizerPatch(original, held, true);
  assert.deepEqual(patch, [{ op: "test", path: "/metadata/uid", value: held.uid },
    { op: "test", path: "/metadata/resourceVersion", value: "7" },
    { op: "replace", path: "/metadata/finalizers", value: ["other.example/owner", held.finalizer] }]);
  original.metadata.finalizers.push(held.finalizer);
  assert.deepEqual(finalizerPatch(original, held, false)[2].value, ["other.example/owner"]);
  for (const changed of [ { ...original, metadata: { ...original.metadata, uid: "replacement" } },
    { ...original, metadata: { ...original.metadata, resourceVersion: "" } },
    { ...original, metadata: { ...original.metadata, namespace: "elsewhere" } },
    { ...original, metadata: { ...original.metadata, finalizers: [] } },
    { ...original, spec: { containers: [] } },
    { ...original, spec: { containers: [...original.spec.containers, ...original.spec.containers] } },
    { ...original, spec: { containers: [{ ...original.spec.containers[0], name: "wrong" }] } }]) assert.throws(() => finalizerPatch(changed, held, false));
  assert.throws(() => finalizerPatch({ ...pod(), metadata: { ...pod().metadata, deletionTimestamp: "now" } }, held, true));
  assert.throws(() => finalizerPatch(original, held, true));
});

test("removal proof: held failed Pod blocks release and the queued follow-up", () => {
  const sample = { pod: { ...pod(), metadata: { ...pod().metadata, finalizers: [held.finalizer], deletionTimestamp: "2026-09-13T12:00:00Z" } },
    task: { metadata: { resourcesReleased: false } }, workloads: [{ meta: { id: "workload" }, agentInstanceId: "instance",
      status: "WORKLOAD_STATUS_FAILED", removedAt: "2026-09-13T12:00:00Z" }], events: [
        { kind: "execution.queued", executionId: "execution" }, { kind: "execution.claimed", executionId: "execution" },
        { kind: "execution.dispatched", executionId: "execution" }, { kind: "execution.queued", executionId: "follow-up" }] };
  assertHeldFailure(sample, held, "workload", "execution");
  for (const change of [
    (s: any) => { s.workloads[0].removalConfirmedAt = "2026-09-13T12:00:01Z"; },
    (s: any) => { s.task.metadata.resourcesReleased = true; },
    (s: any) => { s.workloads = []; },
    (s: any) => { s.workloads.push(structuredClone(s.workloads[0])); },
    (s: any) => { s.workloads[0].meta.id = "other"; },
    (s: any) => { s.workloads[0].removedAt = "invalid"; },
    (s: any) => { s.pod.metadata.uid = "replacement"; },
    (s: any) => { s.pod.metadata.finalizers = []; },
    (s: any) => { delete s.pod.metadata.deletionTimestamp; },
    (s: any) => { s.events.push({ kind: "runtime.stopped", executionId: "execution" }); },
    (s: any) => { s.events.push({ kind: "execution.claimed", executionId: "follow-up" }); },
    (s: any) => { s.events.push({ kind: "agent.outcome", executionId: "execution" }); }
  ]) { const changed = structuredClone(sample); change(changed); assert.throws(() => assertHeldFailure(changed, held, "workload", "execution")); }
});

for (const mode of ["trigger", "timeout", "gate-failure", "wrong-nonce", "wrong-runtime"]) {
  test(`startup failure program: ${mode} never allows CLI execution`, async () => {
    const files = new Map<string, string>([["/agyn/config.json", JSON.stringify({ sdk: mode === "wrong-runtime" ? "claude" : "codex", bin: "bin/codex" })],
      ["/agyn/bin/codex", "original"]]);
    if (mode !== "timeout") files.set("/run/agyn-execution/fail-now", mode === "wrong-nonce" ? "wrong" : nonce);
    const calls: string[] = [], output: string[] = [];
    const fs = { readFileSync: (path: string) => { assert(files.has(path), `missing ${path}`); return files.get(path); },
      lstatSync: () => ({ isFile: () => false, isSymbolicLink: () => true }),
      unlinkSync: (path: string) => { assert.equal(path, "/agyn/bin/codex"); files.delete(path); calls.push("unlink"); },
      writeFileSync: (path: string, value: string, options: any) => { if (options?.flag === "wx") assert(!files.has(path)); files.set(path, value); },
      appendFileSync: (path: string, value: string) => files.set(path, (files.get(path) ?? "") + value), existsSync: (path: string) => files.has(path) };
    const process = { env: { A2A_STARTUP_FAILURE_NONCE: nonce, AGENT_INSTANCE_ID: "instance", WORKLOAD_ID: "workload" },
      exitCode: 0, stdout: { write: (text: string) => output.push(text) }, stderr: { write: (text: string) => output.push(text) } };
    let clock = 0;
    await runInNewContext(`const gateSource="reviewed gate";\n${readFileSync(new URL("../scripts/agyn-startup-failure.cjs", import.meta.url), "utf8")}`, {
      process, Date: { now: () => clock }, require: (name: string) => {
        if (name === "node:assert/strict") return assert;
        if (name === "node:fs") return fs;
        if (name === "node:timers/promises") return { setTimeout: async () => { clock += 10_000; } };
        assert.equal(name, "node:child_process"); return { execFileSync: (binary: string, args: string[]) => {
          assert.equal(binary, "/agyn/bin/node"); assert.equal(args.join("|"), "-e|reviewed gate"); calls.push("gate");
          if (mode === "gate-failure") throw new Error("fixture gate failed");
        } };
      }
    });
    assert.equal(process.exitCode, mode === "trigger" ? 47 : 48);
    assert.deepEqual(calls, mode === "wrong-runtime" ? [] : ["unlink", "gate"]);
    assert(!files.has("/workspace/startup-cli-started.jsonl"));
    if (mode === "trigger") {
      assert.equal(JSON.parse(files.get("/workspace/startup-failure.json")!).stage, "failed");
      // Even a daemon regression which ignored the failure would execute only this sentinel.
      runInNewContext(files.get("/agyn/bin/codex")!.replace(/^#![^\n]*\n/, ""), { process: { ...process, exit: (code: number) => assert.equal(code, 49) },
        require: (name: string) => { assert.equal(name, "node:fs"); return fs; } });
      assert.equal(JSON.parse(files.get("/workspace/startup-cli-started.jsonl")!).nonce, nonce);
    }
  });
}
