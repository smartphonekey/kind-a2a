// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only first-allocation fault. Existing PVCs and secrets are never deleted.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { CoreV1Api } from "@kubernetes/client-node";
import { PromiseMiddlewareWrapper } from "@kubernetes/client-node/dist/gen/middleware.js";
import { restoreQuotaAndReconcile } from "./agyn-quota.js";
import { assertQuotaRejection } from "./quota-proof.js";

const namespace = "agyn-workloads";
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
const sorted = <T extends { name: string }>(items: T[]) => items.sort((a, b) => a.name.localeCompare(b.name));

export async function provisioningInventory(core: CoreV1Api) {
  const claims = (await core.listNamespacedPersistentVolumeClaim({ namespace })).items.map(claim => {
    assert(claim.metadata?.name && claim.metadata.uid && !claim.metadata.deletionTimestamp);
    return { name: claim.metadata.name, uid: claim.metadata.uid, spec: wire(claim.spec), phase: claim.status?.phase };
  });
  // Negotiate metadata at the API, not by fetching and then discarding credentials.
  const metadataOnly = new PromiseMiddlewareWrapper({ pre: async context => {
    context.setHeaderParam("Accept", "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1"); return context;
  }, post: async context => context });
  const secretList = await core.listNamespacedSecret({ namespace }, { middleware: [metadataOnly], middlewareMergeStrategy: "append" })
    .catch((error: unknown) => { throw new Error(`Secret metadata request failed (${Number((error as { code?: number })?.code) || "unknown"})`); });
  assert.equal(secretList.kind, "PartialObjectMetadataList", "API did not honor metadata-only negotiation");
  const secrets = secretList.items.map(secret => {
    assert(secret.data === undefined && secret.stringData === undefined, "unexpected credential payload in metadata response");
    assert(secret.metadata?.name && secret.metadata.uid && !secret.metadata.deletionTimestamp);
    return { name: secret.metadata.name, uid: secret.metadata.uid };
  });
  return { claims: sorted(claims), secrets: sorted(secrets) };
}
type Inventory = Awaited<ReturnType<typeof provisioningInventory>>;

export function assertProvisioningInventory(before: Inventory, after: Inventory, newClaim?: string) {
  assert.deepEqual(after.secrets, before.secrets, "startup credentials leaked or existing secret identities changed");
  const original = after.claims.filter(claim => before.claims.some(prior => prior.name === claim.name));
  assert.deepEqual(original, before.claims, "existing workspace identity/spec/phase changed");
  const added = after.claims.filter(claim => !before.claims.some(prior => prior.name === claim.name));
  assert.equal(added.length, newClaim ? 1 : 0, "unexpected workspace allocation");
  if (newClaim) {
    assert.equal(added[0].name, newClaim);
    assert.equal(added[0].phase, "Bound");
    assert(!before.claims.some(claim => claim.uid === added[0].uid), "new workspace reused an existing PVC identity");
  }
}

export async function runProvisioningRejectedTurn(input: Omit<Parameters<typeof restoreQuotaAndReconcile>[0],
  "instanceId" | "executionId" | "requestId" | "reason"> & {
    before: Inventory; volumes: (instanceId: string) => Promise<any[]>;
  }) {
  const { taskId, core, quota, gateway, rpc, events, record } = input;
  assert.equal(quota.deniedResource, "persistentvolumeclaims");
  let task: any, page: any[] = [], workloads: any[] = [], binding: any, executionId: string | undefined;
  for (let attempt = 0; attempt < 180; attempt++) {
    task = await rpc("GetTask", { id: taskId }); page = await events();
    const queued = page.filter(event => event.kind === "execution.queued");
    assert.equal(queued.length, 1, "initial rejection must accept exactly one execution");
    executionId = queued[0].executionId;
    assert(!page.some(event => event.kind.startsWith("agent.") || event.kind === "execution.dispatched"), "rejected initial turn executed");
    assert.equal((await core.listNamespacedPod({ namespace })).items.length, 0, "Pod admitted before first PVC rejection");
    await quota.observe(true, true);
    binding = page.find(event => event.kind === "runtime.bound")?.payload;
    if (binding) workloads = await gateway.workloads(binding.instanceId);
    record({ kind: "provisioning.rejection-sample", at: new Date().toISOString(), task, events: page, workloads });
    if (task.metadata?.resourcesReleased && task.metadata?.recoveryRequired) break;
    await delay(1000);
  }
  assert(binding?.instanceId && executionId, "initial task did not retain an instance binding");
  const requestId = assertQuotaRejection({ task, events: page, workloads, previousWorkloadIds: [], instanceId: binding.instanceId,
    executionId, quotaName: quota.spec.metadata!.name!, deniedResource: "persistentvolumeclaims" });
  const inventory = await provisioningInventory(core);
  assertProvisioningInventory(input.before, inventory);
  const volumes = await input.volumes(binding.instanceId);
  assert.equal(volumes.length, 1, "first allocation must retain one volume record");
  const volume = volumes[0];
  assert(volume.meta?.id && volume.removedAt && !volume.instanceId);
  assert.equal(volume.status, "VOLUME_STATUS_FAILED");
  assert.equal(volume.ownerKind, "RUNTIME_OWNER_KIND_AGENT_INSTANCE");
  assert.equal(volume.ownerId, binding.instanceId);
  record({ kind: "provisioning.rejected", executionId, requestId, binding, workloads, volume, inventory });
  console.log(JSON.stringify({ kind: "live.provisioning-rejected", taskId, executionId, requestId, volumeId: volume.meta.id }));
  await restoreQuotaAndReconcile({ ...input, instanceId: binding.instanceId, executionId, requestId,
    reason: "Operator observed first-PVC quota rejection, no admitted Pod or PVC, confirmed workload removal and unchanged baseline secrets/workspaces. Retire the rejected inbox request without executing it; continue this task with a new message." });
  assertProvisioningInventory(input.before, await provisioningInventory(core));
  return { executionId, requestId, binding, volume };
}

export function assertReopenedVolume(before: any, after: any, claimName: string) {
  for (const key of ["ownerKind", "ownerId", "threadId", "runnerId", "organizationId", "agentId", "volumeId", "sizeGb", "volumeDefinitionId", "agentClassId"])
    assert.deepEqual(after[key], before[key], `volume ${key} changed during reopening`);
  assert.equal(after.meta?.id, before.meta.id, "volume record identity changed");
  assert.equal(after.status, "VOLUME_STATUS_ACTIVE");
  assert(!after.removedAt, "reopened volume still marked removed");
  assert.equal(after.instanceId, claimName);
}
