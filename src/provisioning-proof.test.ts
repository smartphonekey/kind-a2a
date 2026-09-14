// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { assertProvisioningInventory, assertReopenedVolume, provisioningInventory } from "./live/agyn-provisioning.js";

test("provisioning inventory omits secret payloads and requires stable, non-deleting identities", async () => {
  const secret = { metadata: { name: "older", uid: "secret-uid" } };
  const claim = { metadata: { name: "workspace", uid: "pvc-uid" }, spec: { volumeName: "old-disk" }, status: { phase: "Bound" } };
  const core: any = { listNamespacedSecret: async (_: any, options: any) => {
    assert.equal(options.middlewareMergeStrategy, "append"); assert.equal(options.middleware.length, 1);
    await options.middleware[0].pre({ setHeaderParam: (key: string, value: string) => {
      assert.equal(key, "Accept"); assert.equal(value, "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1");
    } }).toPromise();
    return { kind: "PartialObjectMetadataList", items: [secret] };
  }, listNamespacedPersistentVolumeClaim: async () => ({ items: [claim] }) };
  const inventory = await provisioningInventory(core);
  assert.deepEqual(inventory.secrets, [{ name: "older", uid: "secret-uid" }]);
  assert(!JSON.stringify(inventory).includes("never-record-this"));
  (secret as any).data = { token: "never-record-this" };
  await assert.rejects(provisioningInventory(core), error => !String(error).includes("never-record-this"));
  delete (secret as any).data;
  (secret.metadata as any).deletionTimestamp = "2026-09-14T00:00:00Z";
  await assert.rejects(provisioningInventory(core));
  core.listNamespacedSecret = async () => { throw Object.assign(new Error("never-record-this"), { code: 500, body: "never-record-this" }); };
  await assert.rejects(provisioningInventory(core), /^Error: Secret metadata request failed \(500\)$/);
});

test("first-provision inventory protects all old workspaces/secrets and allows exactly the named new bound claim", () => {
  const before = { claims: [{ name: "old", uid: "old-uid", spec: { volumeName: "old-disk" }, phase: "Bound" }], secrets: [{ name: "old-secret", uid: "old-secret-uid" }] };
  const after = { claims: [...before.claims, { name: "new", uid: "new-uid", spec: { volumeName: "new-disk" }, phase: "Bound" }], secrets: [...before.secrets] };
  assertProvisioningInventory(before, structuredClone(before));
  assertProvisioningInventory(before, after, "new");
  assert.throws(() => assertProvisioningInventory(before, after));
  for (const edit of [
    (x: any) => { x.secrets.push({ name: "leaked", uid: "leaked" }); },
    (x: any) => { x.secrets[0].uid = "replacement"; },
    (x: any) => { x.claims[0].uid = "replacement"; },
    (x: any) => { x.claims[0].spec.volumeName = "other-disk"; },
    (x: any) => { x.claims.shift(); }, (x: any) => { x.claims[1].phase = "Pending"; },
    (x: any) => { x.claims[1].uid = "old-uid"; }, (x: any) => { x.claims[1].name = "unexpected"; }
  ]) { const copy = structuredClone(after); edit(copy); assert.throws(() => assertProvisioningInventory(before, copy, "new")); }
});

test("reopened volume proof rejects changed ownership, identity, allocation or a closed record", () => {
  const before = { meta: { id: "record" }, ownerKind: "RUNTIME_OWNER_KIND_AGENT_INSTANCE", ownerId: "instance", threadId: "instance",
    runnerId: "runner", organizationId: "organization", agentId: "agent", volumeId: "definition", sizeGb: "1", volumeDefinitionId: "definition", agentClassId: "agent" };
  const after: any = { ...before, instanceId: "claim", status: "VOLUME_STATUS_ACTIVE" };
  assertReopenedVolume(before, after, "claim");
  for (const key of [...Object.keys(before), "instanceId", "status", "removedAt"]) {
    const copy = structuredClone(after); copy[key] = "changed";
    assert.throws(() => assertReopenedVolume(before, copy, "claim"), key);
  }
});
