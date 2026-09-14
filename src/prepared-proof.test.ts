// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { assertPreparedRemoval, capturePreparedPod } from "./live/prepared-proof.js";
import { id } from "./test/prepared-upgrade-fixture.js";

function fixture() {
  const instanceId = id(1), agentId = id(2), runnerId = id(3), workloadId = id(4), podUid = id(5);
  const backend = `kubernetes-namespace/v1/agyn-workloads/${id(6)}`;
  const labels = { "app.kubernetes.io/managed-by": "k8s-runner", "agyn.dev/managed-by": "agents-orchestrator", "managed-by": "agents-orchestrator",
    "agent-instance-id": instanceId, "agent-id": agentId, volume_key: id(7) };
  const binding = { workloadId, instanceUid: podUid, backendId: backend, volumes: [
    { instanceId: "workspace-pvc", instanceUid: id(8), volumeKey: id(7), backendId: backend, identityLabels: labels }] };
  const pod: any = { metadata: { name: "workload-pod", uid: podUid, namespace: "agyn-workloads", labels: { "agent-instance-id": instanceId, "agent-id": agentId, workload_key: workloadId },
    annotations: { "agyn.io/prepared-state": "active", "agyn.io/prepared-binding": JSON.stringify({ ...binding, instanceUid: undefined }) } },
    spec: { volumes: [{ persistentVolumeClaim: { claimName: "workspace-pvc" } }], schedulingGates: [] } };
  const claims: any[] = [{ metadata: { name: "workspace-pvc", uid: id(8), namespace: "agyn-workloads", labels,
    finalizers: [`agyn.io/workload-${podUid}`] } }];
  const workload: any = { meta: { id: workloadId }, ownerKind: "RUNTIME_OWNER_KIND_AGENT_INSTANCE", ownerId: instanceId, agentInstanceId: instanceId,
    agentClassId: agentId, runnerId, status: "WORKLOAD_STATUS_STOPPED", removedAt: "2026-09-14T12:00:00Z", removalConfirmedAt: "2026-09-14T12:00:05Z",
    preparation: { phase: "PREPARED_WORKLOAD_PHASE_REMOVED", revision: "9007199254740993", backendId: backend, volumeIds: [id(7)], binding,
      removalObservation: { state: "PREPARED_WORKLOAD_REMOVAL_STATE_ABSENT", binding: structuredClone(binding) } } };
  return { instanceId, agentId, runnerId, backend, pod, claims, workload };
}
test("prepared live proof requires the exact executed Pod, PVC incarnation and explicit absence receipt", () => {
  const f = fixture(), observed = capturePreparedPod(f.pod, f.claims, f.instanceId, f.agentId, f.backend);
  f.workload.failureMessage = "PRIVATE_UNTRUSTED_FAILURE";
  f.workload.containers = [{ env: { PRIVATE_SETTING: "PRIVATE_CONTAINER_VALUE" } }];
  const evidence = assertPreparedRemoval(f.workload, observed, f.runnerId);
  assert(!JSON.stringify(evidence).includes("PRIVATE_"), "raw runtime fields entered prepared evidence");
  assert.equal(f.workload.preparation.revision, "9007199254740993");
});
for (const [name, mutate] of [
  ["legacy Pod", (f: ReturnType<typeof fixture>) => { f.pod.metadata.annotations = {}; }],
  ["still gated", (f: ReturnType<typeof fixture>) => { f.pod.spec.schedulingGates = [{ name: "agyn.io/workload-binding" }]; }],
  ["wrong task", (f: ReturnType<typeof fixture>) => { f.pod.metadata.labels["agent-instance-id"] = id(99); }],
  ["wrong backend", (f: ReturnType<typeof fixture>) => { f.backend += "other"; }],
  ["different mounted PVC", (f: ReturnType<typeof fixture>) => { f.pod.spec.volumes[0].persistentVolumeClaim.claimName = "other"; }],
  ["replacement PVC UID", (f: ReturnType<typeof fixture>) => { f.claims[0].metadata.uid = id(99); }],
  ["claim owner mismatch", (f: ReturnType<typeof fixture>) => { f.claims[0].metadata.labels["agent-instance-id"] = id(99); }],
  ["missing claim hold", (f: ReturnType<typeof fixture>) => { f.claims[0].metadata.finalizers = []; }],
  ["duplicate physical observation", (f: ReturnType<typeof fixture>) => { f.claims.push(f.claims[0]); }]
] as const) test(`prepared Pod proof rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => capturePreparedPod(f.pod, f.claims, f.instanceId, f.agentId, f.backend));
});
for (const [name, mutate] of [
  ["legacy Gateway", (w: any) => { delete w.preparation; }],
  ["unconfirmed billing end", (w: any) => { delete w.removalConfirmedAt; }],
  ["still removing", (w: any) => { w.preparation.phase = "PREPARED_WORKLOAD_PHASE_REMOVING"; }],
  ["numeric revision", (w: any) => { w.preparation.revision = 9007199254740992; }],
  ["overflowing revision", (w: any) => { w.preparation.revision = "18446744073709551616"; }],
  ["different registry Pod UID", (w: any) => { w.preparation.binding.instanceUid = id(99); }],
  ["different observed Pod UID", (w: any) => { w.preparation.removalObservation.binding.instanceUid = id(99); }],
  ["pending observation", (w: any) => { w.preparation.removalObservation.state = "PREPARED_WORKLOAD_REMOVAL_STATE_PENDING"; }],
  ["wrong runner", (w: any) => { w.runnerId = id(99); }],
  ["another instance", (w: any) => { w.ownerId = id(99); }],
  ["incomplete volume set", (w: any) => { w.preparation.volumeIds = []; }],
  ["replaced PVC binding", (w: any) => { w.preparation.binding.volumes[0].instanceUid = id(99); }]
] as const) test(`prepared removal proof rejects ${name}`, () => {
  const f = fixture(), observed = capturePreparedPod(f.pod, f.claims, f.instanceId, f.agentId, f.backend);
  mutate(f.workload); assert.throws(() => assertPreparedRemoval(f.workload, observed, f.runnerId));
});
