// SPDX-License-Identifier: AGPL-3.0-only
// Operator acceptance only. Quota errors never authorize application retries.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { loadAllYaml, type KubernetesObjectApi, type V1ResourceQuota } from "@kubernetes/client-node";
import { quantityToScalar } from "@kubernetes/client-node/dist/util.js";
import { parseComputeBounds } from "./resource-proof.js";
import { assertConfirmedWorkloads } from "./removal-proof.js";

export const quotaLabel = "a2a-lab.agyn.dev/quota-proof";
const namespace = "agyn-workloads";
const keys = ["count/pods", "limits.cpu", "limits.memory", "requests.cpu", "requests.memory"];
export type QuotaBudget = Record<string, string>;
type ObjectClient = Pick<KubernetesObjectApi, "create" | "read" | "replace" | "delete" | "list">;
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
const missing = (error: unknown) => (error as { code?: number })?.code === 404;

export function parseQuotaBudget(value: unknown): QuotaBudget {
  assert(value && typeof value === "object" && !Array.isArray(value), "explicit quota budget required");
  assert.deepEqual(Object.keys(value).sort(), keys, "all five quota keys are required");
  const hard = value as QuotaBudget;
  parseComputeBounds({ requestsCpu: hard["requests.cpu"], requestsMemory: hard["requests.memory"],
    limitsCpu: hard["limits.cpu"], limitsMemory: hard["limits.memory"] });
  assert(typeof hard["count/pods"] === "string" && /^[1-8]$/.test(hard["count/pods"]), "fixture Pod count must be an explicit integer from 1 to 8");
  return { ...hard };
}

function sameQuantities(actual: Record<string, string> | undefined, expected: QuotaBudget): boolean {
  return !!actual && Object.keys(actual).length === keys.length && keys.every(key =>
    typeof actual[key] === "string" && Number(quantityToScalar(actual[key])) === Number(quantityToScalar(expected[key])));
}

export function quotaFixture(rendered: string, run: string, hard: QuotaBudget): V1ResourceQuota {
  assert.match(run, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const documents = loadAllYaml(rendered);
  assert.equal(documents.length, 1, "render only the reviewed quota template");
  const quota = documents[0] as V1ResourceQuota;
  assert.equal(quota.apiVersion, "v1"); assert.equal(quota.kind, "ResourceQuota");
  assert.equal(quota.metadata?.namespace, namespace);
  assert.equal(quota.metadata?.name, `a2a-quota-${run}`);
  assert.deepEqual(Object.keys(quota.spec ?? {}), ["hard"], "quota must be namespace-wide and unscoped");
  assert(sameQuantities(quota.spec!.hard, parseQuotaBudget(hard)), "rendered budget differs from the operator selection");
  return { apiVersion: "v1", kind: "ResourceQuota", metadata: {
    name: quota.metadata.name, namespace, labels: { ...quota.metadata.labels, [quotaLabel]: run }
  }, spec: wire(quota.spec) };
}

export class QuotaFixture {
  private attempted = false;
  private uid?: string;
  private readonly initial: QuotaBudget;
  constructor(private api: ObjectClient, readonly spec: V1ResourceQuota, private record: (value: unknown) => void = () => {}) {
    this.initial = parseQuotaBudget(spec.spec?.hard);
    assert.deepEqual(wire(quotaFixture(JSON.stringify(spec), spec.metadata!.labels![quotaLabel], this.initial)), wire(spec));
  }

  private async idle(): Promise<void> {
    assert.equal((await this.api.list("v1", "Pod", namespace)).items?.length, 0, "quota mutation requires an idle workload namespace");
  }

  private owned(current: V1ResourceQuota): void {
    assert.equal(current.apiVersion, "v1"); assert.equal(current.kind, "ResourceQuota");
    assert.equal(current.metadata?.name, this.spec.metadata!.name);
    assert.equal(current.metadata?.namespace, namespace);
    assert.equal(current.metadata?.labels?.[quotaLabel], this.spec.metadata!.labels![quotaLabel], "quota owner changed");
    assert(current.metadata?.uid && current.metadata.resourceVersion, "quota identity/version missing");
    if (this.uid) assert.equal(current.metadata.uid, this.uid, "quota identity changed");
    assert.deepEqual(Object.keys(current.spec ?? {}), ["hard"], "quota scope changed");
    assert(sameQuantities(current.spec?.hard, this.initial) || sameQuantities(current.spec?.hard, { ...this.initial, "count/pods": "0" }),
      "quota budget changed externally; retain it for reconciliation");
    this.uid = current.metadata.uid;
  }

  async create(): Promise<void> {
    assert(!this.attempted, "quota creation was already attempted");
    await this.idle();
    assert.equal((await this.api.list("v1", "ResourceQuota", namespace)).items?.length, 0, "refusing to change a namespace with existing quotas");
    this.attempted = true; this.record({ kind: "quota.create-attempted", quota: this.spec });
    try { this.owned(await this.api.create(this.spec)); }
    catch (error) { if ((error as { code?: number })?.code === 409) this.attempted = false; throw error; }
    await this.observe(false, true);
  }

  async observe(denied: boolean, empty = false): Promise<V1ResourceQuota> {
    assert(this.attempted, "quota was not created by this fixture");
    const expected = { ...this.initial, ...(denied ? { "count/pods": "0" } : {}) };
    for (let attempt = 0; attempt < 120; attempt++) {
      const current = await this.api.read<V1ResourceQuota>(this.spec as any);
      this.owned(current);
      assert(sameQuantities(current.spec?.hard, expected), "quota changed during acceptance");
      const used = current.status?.used;
      if (sameQuantities(current.status?.hard, expected) && used && keys.every(key => typeof used[key] === "string") &&
          (!empty || keys.every(key => Number(quantityToScalar(used[key])) === 0))) {
        this.record({ kind: "quota.observed", quota: current }); return current;
      }
      await delay(250);
    }
    throw new Error("quota status did not converge");
  }

  async setDenied(denied: boolean): Promise<void> {
    await this.idle();
    const current = await this.observe(!denied, true);
    const next = { ...current, spec: { hard: { ...this.initial, ...(denied ? { "count/pods": "0" } : {}) } } };
    this.record({ kind: "quota.replace-attempted", uid: this.uid, resourceVersion: current.metadata!.resourceVersion, hard: next.spec.hard });
    // Keep the read resourceVersion, so concurrent changes cause a conflict.
    this.owned(await this.api.replace(next));
    await this.observe(denied, true);
  }

  async close(): Promise<void> {
    if (!this.attempted) return;
    await this.idle();
    let current: V1ResourceQuota;
    try { current = await this.api.read<V1ResourceQuota>(this.spec as any); }
    catch (error) { if (missing(error)) return; throw error; }
    this.owned(current);
    this.record({ kind: "quota.delete-attempted", uid: this.uid });
    await this.api.delete(current, undefined, undefined, undefined, undefined, undefined,
      { preconditions: { uid: this.uid, resourceVersion: current.metadata!.resourceVersion } });
    for (let attempt = 0; attempt < 120; attempt++) {
      try { this.owned(await this.api.read<V1ResourceQuota>(this.spec as any)); }
      catch (error) { if (missing(error)) { this.record({ kind: "quota.removed", uid: this.uid }); return; } throw error; }
      await delay(250);
    }
    throw new Error("quota deletion unconfirmed");
  }
}

export function assertQuotaRejection(input: { task: any; events: any[]; workloads: any[]; previousWorkloadIds: string[];
  instanceId: string; executionId: string; quotaName: string }): string {
  const { task, events, workloads, previousWorkloadIds, instanceId, executionId, quotaName } = input;
  assert.equal(task.status?.state, "TASK_STATE_INPUT_REQUIRED");
  for (const key of ["resourcesReleased", "recoveryRequired", "uncertainSideEffects"]) assert.equal(task.metadata?.[key], true, key);
  assert.equal(task.metadata?.automaticRetry, false);
  const own = events.filter(event => event.executionId === executionId);
  assert.equal(own.filter(event => event.kind === "execution.queued").length, 1);
  assert.equal(own.filter(event => event.kind === "execution.claimed").length, 1);
  const receipts = own.filter(event => event.kind === "execution.provider_receipt");
  assert.equal(receipts.length, 1, "rejected turn must retain one inbox receipt and no workload binding");
  const requestId = receipts[0].payload.requestId;
  assert(requestId && !receipts[0].payload.workloadId);
  assert(own.some(event => event.kind === "execution.uncertain") && own.some(event => event.kind === "runtime.stopped"));
  assert(!own.some(event => event.kind === "execution.dispatched" || event.kind === "execution.recovered" || event.kind.startsWith("agent.")),
    "rejected turn must not execute or report an agent outcome");
  assert(previousWorkloadIds.length && previousWorkloadIds.every(id => workloads.some(workload => workload.meta.id === id)));
  const rejected = workloads.filter(workload => !previousWorkloadIds.includes(workload.meta.id));
  assert(rejected.length > 0, "no new rejected workload was observed");
  for (const workload of rejected) {
    assert.equal(workload.failureReason, "WORKLOAD_FAILURE_REASON_START_FAILED");
    // Assertion of a controlled fault, never a production retry classifier.
    assert.equal(typeof workload.failureMessage, "string");
    assert(workload.failureMessage.includes(`exceeded quota: ${quotaName}`) && workload.failureMessage.includes("count/pods"));
    assert(!workload.instanceId && !workload.containers?.length, "runner acknowledged execution despite quota denial");
  }
  assertConfirmedWorkloads(instanceId, workloads, [...previousWorkloadIds, ...rejected.map(workload => workload.meta.id)]);
  return requestId;
}
