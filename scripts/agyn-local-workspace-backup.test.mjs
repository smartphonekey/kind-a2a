// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { workspacePaths } from "./agyn-local-workspace-backup.mjs";
const fixture = () => {
  const claim = { metadata: { uid: "1234", namespace: "work", name: "workspace" },
    spec: { storageClassName: "local-path", volumeName: "pv-1234" }, status: { phase: "Bound" } };
  const volume = { metadata: { name: "pv-1234" }, status: { phase: "Bound" }, spec: { storageClassName: "local-path",
    claimRef: { uid: "1234", namespace: "work", name: "workspace" }, hostPath: { path: "/var/lib/rancher/k3s/storage/pvc-1234_work_workspace" },
    nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: ["node"] }] }] } } } };
  return { claim, volume };
};
test("local backup binds each directory to an exact bound PVC and node", () => {
  const { claim, volume } = fixture();
  assert.deepEqual(workspacePaths([claim], [volume], "node"), ["pvc-1234_work_workspace"]);
  volume.spec.local = volume.spec.hostPath; delete volume.spec.hostPath;
  assert.deepEqual(workspacePaths([claim], [volume], "node"), ["pvc-1234_work_workspace"]);
});
for (const [name, change] of Object.entries({
  "replaced claim": x => x.volume.spec.claimRef.uid = "replaced",
  "unexpected path": x => x.volume.spec.hostPath.path = "/var/lib/rancher/k3s/storage/../other",
  "different node": x => x.volume.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values = ["other"],
  "unbound claim": x => x.claim.status.phase = "Pending",
  "deleting volume": x => x.volume.metadata.deletionTimestamp = "now",
  "other storage": x => x.claim.spec.storageClassName = "other",
  "clone": x => x.claim.spec.dataSource = { name: "other" },
  "ambiguous local source": x => x.volume.spec.local = x.volume.spec.hostPath,
})) test(`local backup refuses ${name}`, () => {
  const f = fixture(); change(f); assert.throws(() => workspacePaths([f.claim], [f.volume], "node"));
});
test("local backup refuses duplicate and empty claims", () => {
  const { claim, volume } = fixture();
  assert.throws(() => workspacePaths([], [], "node"));
  assert.throws(() => workspacePaths([claim, claim], [volume], "node"));
});
