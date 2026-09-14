// SPDX-License-Identifier: AGPL-3.0-only
// Controlled A2A rejection between two real turns; never retries the rejected inbox item.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { AgynClient } from "../agyn-client.js";
import { assertQuotaRejection, type QuotaFixture } from "./quota-proof.js";

export async function runQuotaRejectedTurn(input: {
  taskId: string; suffix: string; first: any; gateway: AgynClient; core: CoreV1Api; quota: QuotaFixture;
  rpc: (method: string, params: unknown) => Promise<any>; events: () => Promise<any[]>;
  reconcile: (executionId: string, reason: string) => Promise<void>; record: (sample: any) => void;
}): Promise<{ executionId: string; requestId: string }> {
  const { taskId, suffix, first, gateway, core, quota, rpc, events, reconcile, record } = input;
  assert.equal(first.snapshots?.length, 1, "a completed native turn must precede quota denial");
  const snapshot = first.snapshots[0];
  assert.equal(snapshot.pvc.length, 1);
  const namespace = "agyn-workloads", name = snapshot.pvc[0];
  const claim = await core.readNamespacedPersistentVolumeClaim({ namespace, name });
  assert(claim.metadata?.uid && claim.status?.phase === "Bound", "original task PVC is not bound");
  const binding = first.events.find((event: any) => event.kind === "runtime.bound").payload;
  const previousWorkloadIds = first.workloads.map((workload: any) => workload.meta.id);
  await quota.setDenied(true);
  const message = { taskId, messageId: randomUUID(), role: "ROLE_USER", parts: [{ text:
    `Append the line quota-replayed-${suffix} to /workspace/reporting-proof.txt exactly once, then report turn_done.` }] };
  const sent = await rpc("SendMessage", { message, configuration: { returnImmediately: true } });
  assert.equal(sent.task.id, taskId);
  const queued = (await events()).filter(event => event.kind === "execution.queued");
  assert.equal(queued.length, 2, "rejected follow-up was not accepted exactly once");
  const executionId = queued[1].executionId;
  let task: any, page: any[] = [], workloads: any[] = [];
  for (let attempt = 0; attempt < 180; attempt++) {
    task = await rpc("GetTask", { id: taskId }); page = await events();
    assert(!page.some(event => event.executionId === executionId && (event.kind.startsWith("agent.") || event.kind === "execution.dispatched")),
      "quota-rejected turn executed");
    assert.equal((await core.listNamespacedPod({ namespace })).items.length, 0, "Pod appeared during zero-slot quota");
    await quota.observe(true, true);
    workloads = await gateway.workloads(binding.instanceId);
    record({ kind: "quota.rejection-sample", at: new Date().toISOString(), task, events: page, workloads });
    if (task.metadata?.resourcesReleased && task.metadata?.recoveryRequired) break;
    await delay(1000);
  }
  const requestId = assertQuotaRejection({ task, events: page, workloads, previousWorkloadIds, instanceId: binding.instanceId,
    executionId, quotaName: quota.spec.metadata!.name! });
  const retained = await core.readNamespacedPersistentVolumeClaim({ namespace, name });
  assert.equal(retained.metadata?.uid, claim.metadata.uid); assert.equal(retained.status?.phase, "Bound");
  assert.deepEqual(JSON.parse(JSON.stringify(retained.spec)), JSON.parse(JSON.stringify(claim.spec)), "task volume changed after rejection");
  record({ kind: "quota.rejected", executionId, requestId, claim: { name, uid: claim.metadata.uid, spec: claim.spec }, workloads });
  console.log(JSON.stringify({ kind: "live.quota-rejected", taskId, executionId, requestId,
    workloads: workloads.filter(workload => !previousWorkloadIds.includes(workload.meta.id)).map(workload => workload.meta.id) }));

  await assert.rejects(rpc("SendMessage", { message: { ...message, messageId: randomUUID() } }), "unreconciled follow-up was accepted");
  await quota.setDenied(false);
  // Availability returning must not silently resubmit or wake the failed turn.
  const eventCount = (await events()).length;
  for (let attempt = 0; attempt < 5; attempt++) {
    await delay(1000);
    assert.equal((await gateway.getInstance(binding.instanceId)).state, "AGENT_INSTANCE_STATE_PAUSED");
    assert.equal((await core.listNamespacedPod({ namespace })).items.length, 0, "quota restoration restarted old work");
    const current = await rpc("GetTask", { id: taskId });
    assert.equal(current.metadata?.recoveryRequired, true);
    assert.equal((await events()).length, eventCount, "quarantined task changed without reconciliation");
    await quota.observe(false, true);
  }
  await assert.rejects(rpc("SendMessage", { message: { ...message, messageId: randomUUID() } }), "quota availability bypassed reconciliation");
  await reconcile(executionId, "Operator observed the exact native quota rejection, no admitted Pod, explicit removal confirmation and unchanged task PVC. Retire the rejected inbox request without execution before continuing the existing session.");
  const reconciled = (await events()).filter(event => event.executionId === executionId && event.kind === "execution.reconciled");
  assert.equal(reconciled.length, 1); assert.equal(reconciled[0].payload.resolution, "continue");
  record({ kind: "quota.reconciled", executionId, requestId, event: reconciled[0] });
  return { executionId, requestId };
}
