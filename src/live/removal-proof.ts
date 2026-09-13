// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import type { AgynWorkload } from "../agyn-client.js";

export function assertConfirmedWorkloads(instanceId: string, workloads: readonly AgynWorkload[], pinnedIds: readonly string[]): void {
  assert(instanceId && pinnedIds.length && pinnedIds.every(id => typeof id === "string" && id), "explicit instance/workload bindings are required");
  const ids = workloads.map(workload => workload.meta.id);
  assert.equal(new Set(ids).size, workloads.length, "duplicate workload identity");
  for (const id of pinnedIds) assert(ids.includes(id), "pinned workload is missing from removal evidence");
  for (const workload of workloads) {
    assert.equal(workload.agentInstanceId, instanceId, "removal evidence belongs to another instance");
    assert(["WORKLOAD_STATUS_FAILED", "WORKLOAD_STATUS_STOPPED"].includes(workload.status), "nonterminal workload remains");
    assert(workload.removalConfirmedAt && Number.isFinite(Date.parse(workload.removalConfirmedAt)), "explicit removal confirmation is required");
  }
}

export type HeldPod = { name: string; uid: string; instanceId: string; agentId: string; containerName: string; finalizer: string };

export function assertFixturePod(pod: any, held: HeldPod): void {
  assert.equal(pod.metadata?.namespace, "agyn-workloads");
  assert.equal(pod.metadata?.name, held.name);
  assert.equal(pod.metadata?.uid, held.uid, "fixture Pod identity changed");
  assert.equal(pod.metadata?.labels?.["agent-id"], held.agentId);
  assert.equal(pod.metadata?.labels?.["agyn.dev/managed-by"], "agents-orchestrator");
  const matches = pod.spec?.containers?.filter((c: any) => c.env?.some((e: any) => e.name === "AGENT_INSTANCE_ID" && e.value === held.instanceId)) ?? [];
  assert.equal(matches.length, 1, "fixture main container is absent or ambiguous");
  assert.equal(matches[0].name, held.containerName, "fixture container identity changed");
}

export function finalizerPatch(pod: any, held: HeldPod, add: boolean): any[] {
  assertFixturePod(pod, held);
  assert.match(held.finalizer, /^a2a-lab\.agyn\.dev\/removal-[a-f0-9-]{36}$/);
  assert(pod.metadata.resourceVersion, "resource version required");
  const previous: string[] = pod.metadata.finalizers ?? [];
  assert(Array.isArray(previous) && previous.every(value => typeof value === "string"));
  if (add) {
    assert(!pod.metadata.deletionTimestamp, "cannot acquire an already deleting Pod");
    assert(!previous.includes(held.finalizer), "finalizer was already acquired");
  } else assert(previous.includes(held.finalizer), "owned finalizer is missing");
  return [
    { op: "test", path: "/metadata/uid", value: held.uid },
    { op: "test", path: "/metadata/resourceVersion", value: pod.metadata.resourceVersion },
    { op: pod.metadata.finalizers ? "replace" : "add", path: "/metadata/finalizers",
      value: add ? [...previous, held.finalizer] : previous.filter(value => value !== held.finalizer) }
  ];
}

export function assertNoFollowupExecution(events: any[], executionId: string): void {
  assert.equal(events.filter(e => e.kind === "execution.queued").length, 2, "follow-up was not queued");
  const claimed = events.filter(e => e.kind === "execution.claimed" || e.kind === "execution.recovered");
  assert.equal(claimed.length, 1, "another execution acquired the task");
  assert.equal(claimed[0].executionId, executionId);
  const dispatched = events.filter(e => e.kind === "execution.dispatched");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].executionId, executionId);
  assert(!events.some(e => e.kind.startsWith("agent.")), "agent execution/reporting occurred during init failure");
}

export function assertHeldFailure(sample: { pod: any; task: any; workloads: any[]; events: any[] }, held: HeldPod, workloadId: string, executionId: string): void {
  assertFixturePod(sample.pod, held);
  assert(sample.pod.metadata.deletionTimestamp, "controller has not requested deletion");
  assert(sample.pod.metadata.finalizers?.includes(held.finalizer));
  assert.equal(sample.workloads.length, 1, "replacement workload appeared");
  const workload = sample.workloads[0];
  assert.equal(workload.meta.id, workloadId);
  assert.equal(workload.agentInstanceId, held.instanceId);
  assert(["WORKLOAD_STATUS_FAILED", "WORKLOAD_STATUS_STOPPED"].includes(workload.status));
  assert(Number.isFinite(Date.parse(workload.removedAt)), "billing end was not observed");
  assert(!workload.removalConfirmedAt, "removal was confirmed while the Pod still exists");
  assert.equal(sample.task.metadata?.resourcesReleased, false, "A2A released a held Pod");
  assert(!sample.events.some(e => e.kind === "runtime.stopped"), "A2A recorded premature runtime removal");
  assertNoFollowupExecution(sample.events, executionId);
}
