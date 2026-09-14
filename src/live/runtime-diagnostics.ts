// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { V1Pod } from "@kubernetes/client-node";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const reasons = new Set(["Completed", "Error", "OOMKilled", "ContainerCannotRun", "ContainerCreating",
  "PodInitializing", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError"]);
const subtypes = new Set(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]);
const terminalReasons = new Set(["api_error", "completed", "max_turns", "max_budget_usd", "max_structured_output_retries", "aborted_streaming", "aborted_tools"]);

export function runtimePodIdentity(pod: V1Pod, agentId: string) {
  assert.match(agentId, uuid);
  const meta = pod.metadata, labels = meta?.labels;
  assert.equal(meta?.namespace, "agyn-workloads");
  assert.equal(labels?.["agyn.dev/managed-by"], "agents-orchestrator");
  assert.equal(labels?.["agent-id"], agentId);
  const instanceId = labels?.["agent-instance-id"], workloadId = labels?.["agyn.io/workload-id"];
  assert.match(instanceId ?? "", uuid); assert.match(workloadId ?? "", uuid); assert.match(meta?.uid ?? "", uuid);
  assert.equal(meta?.name, `workload-${workloadId}`);
  const main = pod.spec?.containers.filter(c => c.env?.some(e => e.name === "AGENT_INSTANCE_ID" && e.value === instanceId));
  assert.equal(main?.length, 1, "main container identity is absent or ambiguous");
  assert.match(main![0].name, /^[a-z0-9][a-z0-9-]{0,62}$/);
  return { name: meta!.name!, uid: meta!.uid!, agentId, instanceId: instanceId!, workloadId: workloadId!, container: main![0].name };
}

// Logs and Kubernetes termination messages may contain prompts or credentials.
// Retain only enumerated diagnostics, never raw lines, message bodies or hashes.
export function safeRuntimeLog(text: string) {
  assert(Buffer.byteLength(text) <= 64 * 1024, "diagnostic log response exceeds its bound");
  const found = new Map<string, Record<string, string | number>>();
  for (const line of text.split("\n")) {
    const result = /Claude returned an error result; reconciliation required \(result_subtype=([^, ]+), terminal_reason=([^, ]+), api_status=(\d{1,3})\)/.exec(line);
    let item: Record<string, string | number> | undefined;
    if (result) {
      const status = Number(result[3]);
      item = { kind: "claude_result_error", subtype: subtypes.has(result[1]) ? result[1] : "unknown",
        terminalReason: terminalReasons.has(result[2]) ? result[2] : "unknown", apiStatus: status >= 400 && status <= 599 ? status : 0 };
    } else if (/claude process exited: exit status \d+/.test(line)) {
      item = { kind: "claude_process_exit", exitCode: Number(/exit status (\d{1,3})\b/.exec(line)?.[1] ?? -1) };
    } else if (/terminal agent processing failure:|daemon exited:|daemon init failed:/.test(line)) {
      item = { kind: "daemon_failure_unclassified" };
    }
    if (item) found.set(JSON.stringify(item), item);
  }
  return [...found.values()];
}

export function safePodState(pod: V1Pod) {
  const time = (value: Date | undefined) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : undefined;
  const integer = (value: number | undefined) => Number.isSafeInteger(value) ? value : undefined;
  return {
    phase: ["Pending", "Running", "Succeeded", "Failed", "Unknown"].includes(pod.status?.phase ?? "") ? pod.status!.phase : "Unknown",
    deleting: !!pod.metadata?.deletionTimestamp,
    containers: [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].map(c => ({
      name: /^[a-z0-9][a-z0-9-]{0,62}$/.test(c.name) ? c.name : "unknown",
      restartCount: integer(c.restartCount),
      state: c.state?.terminated ? "terminated" : c.state?.running ? "running" : "waiting",
      reason: reasons.has(c.state?.terminated?.reason ?? c.state?.waiting?.reason ?? "") ? (c.state?.terminated?.reason ?? c.state?.waiting?.reason) : "unknown",
      exitCode: integer(c.state?.terminated?.exitCode), signal: integer(c.state?.terminated?.signal),
      finishedAt: time(c.state?.terminated?.finishedAt)
    }))
  };
}

export class RuntimeDiagnosticStore {
  readonly pods = new Map<string, { identity: ReturnType<typeof runtimePodIdentity>; states: ReturnType<typeof safePodState>[];
    signals: ReturnType<typeof safeRuntimeLog>; logReads: number; logReadFailures: number }>();
  constructor(readonly agentId: string) { assert.match(agentId, uuid); }

  observe(pod: V1Pod) {
    const identity = runtimePodIdentity(pod, this.agentId), previous = this.pods.get(identity.uid);
    if (previous) assert.deepEqual(identity, previous.identity, "diagnostic identity changed");
    assert(previous || this.pods.size < 32, "diagnostic Pod bound exceeded");
    const entry = previous ?? { identity, states: [], signals: [], logReads: 0, logReadFailures: 0 };
    const state = safePodState(pod);
    if (!entry.states.some(s => JSON.stringify(s) === JSON.stringify(state))) {
      assert(entry.states.length < 64, "diagnostic state bound exceeded"); entry.states.push(state);
    }
    this.pods.set(identity.uid, entry);
    return entry;
  }

  async sample(pod: V1Pod, readLog: (identity: ReturnType<typeof runtimePodIdentity>) => Promise<string>) {
    const entry = this.observe(pod);
    const status = pod.status?.containerStatuses?.find(c => c.name === entry.identity.container);
    if (!status?.state?.running && !status?.state?.terminated) return;
    let text: string;
    try { text = await readLog(entry.identity); }
    catch { entry.logReadFailures++; return; }
    entry.logReads++;
    for (const signal of safeRuntimeLog(text)) {
      if (!entry.signals.some(s => JSON.stringify(s) === JSON.stringify(signal))) {
        assert(entry.signals.length < 64, "diagnostic signal bound exceeded"); entry.signals.push(signal);
      }
    }
  }
}

export async function startRuntimeDiagnostics(agentId: string, kubeconfig: string, directory: string) {
  const file = join(directory, "runtime-diagnostics.json");
  const child = fork(fileURLToPath(new URL("../../scripts/agyn-runtime-diagnostics.mjs", import.meta.url)), [agentId, kubeconfig, file], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, AGYN_LIVE_ACCEPTANCE: "trusted-local" },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  const stop = async () => {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
    try { assert.equal(await exited, 0, "runtime diagnostic observer failed; inspect its evidence"); }
    finally { clearTimeout(timer); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("runtime diagnostic observer did not initialize")); }, 7000);
      const ready = (message: any) => { if (message?.ready === true) { cleanup(); resolve(); } };
      const fail = () => { cleanup(); reject(new Error("runtime diagnostic observer failed to initialize")); };
      const cleanup = () => { clearTimeout(timer); child.off("message", ready); child.off("error", fail); child.off("close", fail); };
      child.on("message", ready); child.once("error", fail); child.once("close", fail);
    });
  } catch (error) {
    await stop().catch(() => {}); throw error;
  }
  return { file, stop };
}
