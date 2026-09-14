// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { z } from "zod";
import { persistentVolumeLabelKeys } from "./checked-volume-audit.js";

const uuid = z.string().uuid();
const volume = z.object({ instanceId: z.string().min(1), instanceUid: uuid, volumeKey: uuid,
  backendId: z.string().min(1), identityLabels: z.record(z.string()) }).strict();
const binding = z.object({ workloadId: uuid, instanceUid: uuid, backendId: z.string().min(1), volumes: z.array(volume).min(1).max(64) }).strict();
const canonical = (value: unknown) => {
  const parsed = binding.parse(value);
  parsed.volumes.sort((a, b) => a.volumeKey.localeCompare(b.volumeKey));
  for (const field of ["volumeKey", "instanceId", "instanceUid"] as const) {
    assert.equal(new Set(parsed.volumes.map(v => v[field])).size, parsed.volumes.length, `duplicate prepared volume ${field}`);
  }
  return parsed;
};
export type PreparedPodProof = { instanceId: string; agentId: string; podName: string; binding: ReturnType<typeof canonical> };

export function capturePreparedPod(pod: any, claims: any[], instanceId: string, agentId: string, backendId: string): PreparedPodProof {
  assert.equal(pod.metadata?.namespace, "agyn-workloads");
  assert.equal(pod.metadata?.labels?.["agent-instance-id"], instanceId);
  assert.equal(pod.metadata?.labels?.["agent-id"], agentId);
  assert.equal(pod.metadata?.annotations?.["agyn.io/prepared-state"], "active", "native activation was not observed");
  assert(!(pod.spec?.schedulingGates ?? []).some((g: any) => g.name === "agyn.io/workload-binding"), "prepared scheduling gate is still present");
  const annotation = JSON.parse(pod.metadata.annotations["agyn.io/prepared-binding"]);
  assert(annotation.instanceUid === undefined || annotation.instanceUid === "", "Pod annotation must not invent its own UID");
  const actual = canonical({ ...annotation, instanceUid: pod.metadata.uid });
  assert.equal(actual.workloadId, pod.metadata.labels.workload_key);
  assert.equal(actual.backendId, backendId, "prepared workload uses another backend");
  const mounted = pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim).map((v: any) => v.persistentVolumeClaim.claimName).sort();
  assert.deepEqual(mounted, actual.volumes.map(v => v.instanceId).sort(), "prepared mount set differs from Pod");
  assert.equal(claims.length, actual.volumes.length);
  assert.equal(new Set(claims.map(c => c.metadata?.name)).size, claims.length, "duplicate physical claim observation");
  for (const expected of actual.volumes) {
    const claim = claims.find(c => c.metadata?.name === expected.instanceId), metadata = claim?.metadata;
    assert.equal(metadata?.namespace, "agyn-workloads");
    assert.equal(metadata.uid, expected.instanceUid, "prepared PVC incarnation differs from physical claim");
    assert(!metadata.deletionTimestamp && !(metadata.ownerReferences?.length), "prepared PVC is terminating or controller-owned");
    assert(metadata.finalizers?.includes(`agyn.io/workload-${actual.instanceUid}`), "executing Pod has no durable PVC hold");
    assert.equal(expected.backendId, backendId);
    assert.equal(expected.identityLabels.volume_key, expected.volumeKey);
    assert.equal(expected.identityLabels["agent-instance-id"], instanceId);
    assert.equal(expected.identityLabels["agent-id"], agentId);
    const labels = Object.fromEntries(persistentVolumeLabelKeys.filter(key => metadata.labels?.[key] !== undefined).map(key => [key, metadata.labels[key]]));
    assert.deepEqual(expected.identityLabels, labels, "prepared PVC ownership differs from physical claim");
  }
  return { instanceId, agentId, podName: pod.metadata.name, binding: actual };
}

export function assertPreparedRemoval(value: unknown, observed: PreparedPodProof, runnerId: string) {
  const workload = z.object({ meta: z.object({ id: uuid }), agentInstanceId: uuid, agentClassId: uuid, ownerId: uuid,
    ownerKind: z.literal("RUNTIME_OWNER_KIND_AGENT_INSTANCE"), runnerId: uuid,
    status: z.enum(["WORKLOAD_STATUS_STOPPED", "WORKLOAD_STATUS_FAILED"]), removalConfirmedAt: z.string().datetime({ offset: true }),
    preparation: z.object({ phase: z.literal("PREPARED_WORKLOAD_PHASE_REMOVED"),
      revision: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => BigInt(value) <= 18446744073709551615n),
      backendId: z.string(), volumeIds: z.array(uuid), binding,
      removalObservation: z.object({ state: z.literal("PREPARED_WORKLOAD_REMOVAL_STATE_ABSENT"), binding }) }) }).parse(value);
  assert.equal(workload.meta.id, observed.binding.workloadId);
  assert.equal(workload.agentInstanceId, observed.instanceId); assert.equal(workload.ownerId, observed.instanceId);
  assert.equal(workload.agentClassId, observed.agentId); assert.equal(workload.runnerId, runnerId);
  assert.equal(workload.preparation.backendId, observed.binding.backendId);
  assert.deepEqual([...workload.preparation.volumeIds].sort(), observed.binding.volumes.map(v => v.volumeKey).sort(), "registry volume set differs from physical mounts");
  assert.deepEqual(canonical(workload.preparation.binding), observed.binding, "registry binding differs from the executed Pod/PVCs");
  assert.deepEqual(canonical(workload.preparation.removalObservation.binding), observed.binding, "removal observation belongs to another execution");
  return workload;
}
