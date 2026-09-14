// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { assertQuotaRejection, parseQuotaBudget, quotaFixture, QuotaFixture, quotaLabel } from "./live/quota-proof.js";

const run = "7c51e3d1-5fa9-465c-8c0a-d3fbbcb0f635";
const hard = { "requests.cpu": "1500m", "requests.memory": "5Gi", "limits.cpu": "6", "limits.memory": "5Gi", "count/pods": "2" };
const render = () => ({ apiVersion: "v1", kind: "ResourceQuota", metadata: { name: `a2a-quota-${run}`, namespace: "agyn-workloads" }, spec: { hard } });
const fixture = () => quotaFixture(JSON.stringify(render()), run, hard);
function fake(mode = "", provisioning = false) {
  const state = { current: undefined as any, busy: false, calls: [] as any[], claims: 2 };
  const budget = provisioning ? { ...hard, persistentvolumeclaims: "3" } : hard;
  const deniedResource = provisioning ? "persistentvolumeclaims" : "count/pods";
  const spec = quotaFixture(JSON.stringify({ ...render(), spec: { hard: budget } }), run, budget, deniedResource);
  const status = (spec: any) => ({ hard: structuredClone(spec.hard), used: Object.fromEntries(Object.keys(spec.hard).map(key =>
    [key, key === "persistentvolumeclaims" ? String(state.claims) : "0"])) });
  const error = (code: number) => Object.assign(new Error(`fixture ${code}`), { code });
  const api: any = {
    list: async (_version: string, kind: string, namespace: string) => {
      assert.equal(namespace, "agyn-workloads");
      return { items: kind === "Pod" ? state.busy ? [{}] : [] : kind === "PersistentVolumeClaim" ? Array(state.claims).fill({}) : mode === "existing-quota" ? [{}] : [] };
    },
    create: async (spec: any) => {
      state.calls.push("create");
      if (mode === "conflict") throw error(409);
      state.current = { ...structuredClone(spec), metadata: { ...structuredClone(spec.metadata), uid: "quota-uid", resourceVersion: "1" }, status: status(spec.spec) };
      if (mode === "lost-create") throw error(500);
      return structuredClone(state.current);
    },
    read: async () => { if (!state.current) throw error(404); return structuredClone(state.current); },
    replace: async (spec: any) => {
      state.calls.push("replace");
      assert.equal(spec.metadata.uid, state.current.metadata.uid);
      assert.equal(spec.metadata.resourceVersion, state.current.metadata.resourceVersion, "replace omitted compare-and-change");
      if (mode === "replace-conflict") throw error(409);
      state.current = { ...structuredClone(spec), metadata: { ...spec.metadata, resourceVersion: "2" }, status: status(spec.spec) };
      if (mode === "lost-replace") throw error(500);
      return structuredClone(state.current);
    },
    delete: async (_spec: any, _p: any, _d: any, _g: any, _o: any, _s: any, body: any) => {
      assert.deepEqual(body.preconditions, { uid: state.current.metadata.uid, resourceVersion: state.current.metadata.resourceVersion });
      state.calls.push("delete"); state.current = undefined;
    }
  };
  return { state, quota: new QuotaFixture(api, spec, undefined, deniedResource) };
}

test("first-provision quota requires an explicit PVC mode and exact additional workspace slot", async () => {
  const budget = { ...hard, persistentvolumeclaims: "3" };
  assert.deepEqual(parseQuotaBudget(budget, "persistentvolumeclaims"), budget);
  assert.throws(() => parseQuotaBudget(budget));
  for (const value of [undefined, 3, "0", "-1", "1.5", "01", "9007199254740992", "3m"])
    assert.throws(() => parseQuotaBudget({ ...hard, persistentvolumeclaims: value }, "persistentvolumeclaims"));
  const { state, quota } = fake("", true);
  state.claims = 1;
  await assert.rejects(quota.create(), /exactly one/);
  await quota.close(); assert.deepEqual(state.calls, []);
});

test("PVC quota denies the first allocation without changing Pod capacity or requiring retained storage to be zero", async () => {
  const { state, quota } = fake("", true);
  await quota.create(); await quota.setDenied(true);
  assert.equal(state.current.spec.hard.persistentvolumeclaims, "2");
  assert.equal(state.current.spec.hard["count/pods"], "2");
  await quota.observe(true, true); await quota.setDenied(false);
  state.claims = 3; state.current.status.used.persistentvolumeclaims = "3";
  await quota.observe(false, true);
  await assert.rejects(quota.setDenied(true), /exactly one/, "cannot deny a now-allocated workspace as an initial allocation");
  await quota.close(); assert.deepEqual(state.calls, ["create", "replace", "replace", "delete"]);
});

test("PVC quota retains externally changed storage budgets", async () => {
  const { state, quota } = fake("", true); await quota.create();
  state.current.spec.hard.persistentvolumeclaims = "4";
  await assert.rejects(quota.setDenied(true)); await assert.rejects(quota.close());
  assert.deepEqual(state.calls, ["create"]);
});

test("quota proof validates a complete operator budget and exactly one unscoped chart document", () => {
  assert.deepEqual(parseQuotaBudget(hard), hard);
  assert.equal(fixture().metadata!.labels![quotaLabel], run);
  for (const input of [null, [], {}, { ...hard, "count/pods": "0" }, { ...hard, "count/pods": "9" }, { ...hard, "count/pods": 2 },
    { ...hard, "requests.cpu": "7" }, { ...hard, "limits.memory": "1Gi" }, { ...hard, "limits.cpu": "invalid" },
    { ...hard, extra: "1" }, { ...hard, "requests.memory": "1.5" }]) assert.throws(() => parseQuotaBudget(input));
  for (const change of [
    (q: any) => { q.kind = "Pod"; }, (q: any) => { q.metadata.namespace = "foreign"; },
    (q: any) => { q.metadata.name = "foreign"; }, (q: any) => { q.spec.scopes = ["BestEffort"]; },
    (q: any) => { q.spec.scopeSelector = {}; }, (q: any) => { q.spec.hard = { ...hard, "count/pods": "1" }; }
  ]) { const q = render(); change(q); assert.throws(() => quotaFixture(JSON.stringify(q), run, hard)); }
  assert.throws(() => quotaFixture(JSON.stringify(render()) + "\n---\n" + JSON.stringify(render()), run, hard));
});

test("quota fixture observes native quantities, changes only with CAS and deletes with UID/version preconditions", async () => {
  const { state, quota } = fake(); await quota.create();
  state.current.spec.hard["requests.cpu"] = "1.5";
  state.current.status.hard["requests.cpu"] = "1.5";
  await quota.observe(false, true);
  await quota.setDenied(true); assert.equal(state.current.spec.hard["count/pods"], "0");
  await quota.setDenied(false); assert.deepEqual(state.current.spec.hard, hard);
  await quota.close(); assert.deepEqual(state.calls, ["create", "replace", "replace", "delete"]);
});

test("quota fixture refuses busy namespaces, existing quotas and create conflicts without deleting foreign state", async () => {
  for (const mode of ["busy", "existing-quota", "conflict"]) {
    const { state, quota } = fake(mode); state.busy = mode === "busy";
    await assert.rejects(quota.create()); await quota.close();
    assert.deepEqual(state.calls, mode === "conflict" ? ["create"] : []);
  }
});

test("quota fixture recovers only owned lost acknowledgements and does not retry a conflicting update", async () => {
  for (const mode of ["lost-create", "lost-replace", "replace-conflict"]) {
    const { state, quota } = fake(mode);
    if (mode === "lost-create") await assert.rejects(quota.create());
    else { await quota.create(); await assert.rejects(quota.setDenied(true)); }
    await quota.close();
    assert.deepEqual(state.calls, mode === "lost-create" ? ["create", "delete"] : ["create", "replace", "delete"]);
  }
});

test("quota fixture retains replaced, externally edited or busy resources for reconciliation", async () => {
  for (const edit of [
    (s: any) => { s.current.metadata.uid = "replacement"; },
    (s: any) => { s.current.metadata.labels[quotaLabel] = "foreign"; },
    (s: any) => { s.current.spec.hard["limits.cpu"] = "7"; },
    (s: any) => { s.current.spec.scopes = ["BestEffort"]; },
    (s: any) => { s.busy = true; }
  ]) {
    const { state, quota } = fake(); await quota.create(); edit(state);
    await assert.rejects(quota.setDenied(true)); await assert.rejects(quota.close());
    assert.deepEqual(state.calls, ["create"]);
  }
});

const rejected = () => ({ task: { status: { state: "TASK_STATE_INPUT_REQUIRED" }, metadata: {
  resourcesReleased: true, recoveryRequired: true, uncertainSideEffects: true, automaticRetry: false } },
  events: ["execution.queued", "execution.claimed", "execution.provider_receipt", "execution.uncertain", "runtime.stopped"].map(kind => ({
    kind, executionId: "rejected-execution", payload: kind === "execution.provider_receipt" ? { requestId: "inbox-request" } : {} })),
  workloads: [{ meta: { id: "previous" }, agentInstanceId: "instance", status: "WORKLOAD_STATUS_STOPPED", removalConfirmedAt: "2026-09-14T00:00:00Z" },
    { meta: { id: "rejected" }, agentInstanceId: "instance", status: "WORKLOAD_STATUS_FAILED", removalConfirmedAt: "2026-09-14T00:00:01Z",
      failureReason: "WORKLOAD_FAILURE_REASON_START_FAILED", failureMessage: `exceeded quota: a2a-quota-${run}, count/pods` }],
  previousWorkloadIds: ["previous"], instanceId: "instance", executionId: "rejected-execution", quotaName: `a2a-quota-${run}` });

test("quota rejection proof requires a retained receipt, native quota failure, quarantine and confirmed removal", () => {
  assert.equal(assertQuotaRejection(rejected()), "inbox-request");
  for (const edit of [
    (x: any) => { x.task.metadata.recoveryRequired = false; }, (x: any) => { x.task.metadata.resourcesReleased = false; },
    (x: any) => { x.task.metadata.automaticRetry = true; }, (x: any) => { x.workloads.pop(); },
    (x: any) => { x.workloads[1].failureMessage = "unrelated failure"; },
    (x: any) => { delete x.workloads[1].removalConfirmedAt; x.workloads[1].removedAt = "2026-09-14T00:00:00Z"; },
    (x: any) => { x.workloads[1].agentInstanceId = "foreign"; }, (x: any) => { x.workloads[1].instanceId = "runner-pod"; },
    (x: any) => { x.events[2].payload.workloadId = "runner-pod"; }, (x: any) => { x.events.splice(2, 1); },
    (x: any) => { x.events.push({ kind: "agent.outcome", executionId: x.executionId }); },
    (x: any) => { x.events.push({ kind: "execution.dispatched", executionId: x.executionId }); },
    (x: any) => { x.events.push({ kind: "execution.recovered", executionId: x.executionId }); }
  ]) { const sample = rejected(); edit(sample); assert.throws(() => assertQuotaRejection(sample)); }
});

test("first-provision rejection requires PVC denial, no earlier workload and confirmed secret cleanup", () => {
  const sample = { ...rejected(), deniedResource: "persistentvolumeclaims" as const };
  sample.previousWorkloadIds = []; sample.workloads.shift();
  sample.workloads[0].failureMessage = `exceeded quota: a2a-quota-${run}, persistentvolumeclaims`;
  assert.equal(assertQuotaRejection(sample), "inbox-request");
  for (const edit of [
    (x: any) => { x.previousWorkloadIds = ["previous"]; },
    (x: any) => { x.workloads[0].failureMessage += "; startup_secret_cleanup_unconfirmed"; },
    (x: any) => { x.workloads[0].failureMessage = `exceeded quota: a2a-quota-${run}, count/pods`; },
    (x: any) => { delete x.deniedResource; }
  ]) { const copy = structuredClone(sample); edit(copy); assert.throws(() => assertQuotaRejection(copy)); }
});
