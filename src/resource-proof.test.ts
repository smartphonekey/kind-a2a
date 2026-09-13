// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { assertCgroupComputeBounds, assertPodComputeBounds, parseComputeBounds } from "./live/resource-proof.js";

const main = { requestsCpu: "500m", requestsMemory: "2Gi", limitsCpu: "2", limitsMemory: "2Gi" };
const supporting = { requestsCpu: "50m", requestsMemory: "64Mi", limitsCpu: "500m", limitsMemory: "256Mi" };
const container = (name: string, b = supporting) => ({ name, resources: { requests: { cpu: b.requestsCpu, memory: b.requestsMemory }, limits: { cpu: b.limitsCpu, memory: b.limitsMemory } } });

test("resource proof validates every container role and actual cgroups", () => {
  const pod = { spec: { containers: [container("agent", main), container("tool")], initContainers: [container("init"), { ...container("ziti"), restartPolicy: "Always" }] } };
  assert.equal(assertPodComputeBounds(pod, "agent", parseComputeBounds(main), supporting).length, 4);
  assertCgroupComputeBounds({ cpuMax: "200000 100000", memoryMax: "2147483648" }, main);
  for (const group of [pod.spec.containers, pod.spec.initContainers]) for (const item of group) {
    const saved = item.resources.limits.memory;
    item.resources.limits.memory = "3Gi";
    assert.throws(() => assertPodComputeBounds(pod, "agent", main, supporting));
    item.resources.limits.memory = saved;
  }
  for (const value of [{ cpuMax: "max 100000", memoryMax: "2147483648" }, { cpuMax: "200000 100000", memoryMax: "max" },
    { cpuMax: "300000 100000", memoryMax: "2147483648" }, {}]) assert.throws(() => assertCgroupComputeBounds(value, main));
  assert.throws(() => assertPodComputeBounds(pod, "missing", main, supporting));
});

test("resource proof rejects missing, partial, unenforceable and inverted bounds", () => {
  for (const value of [null, [], {}, { ...main, extra: "1" }, { ...main, limitsCpu: undefined }, { ...main, requestsCpu: "3" },
    { ...main, requestsMemory: "3Gi" }, { ...main, limitsMemory: "0" }, { ...main, requestsCpu: "0.0001" },
    { ...main, limitsCpu: "invalid" }, { ...main, requestsMemory: "1.5" }, { ...main, limitsMemory: "999999999999999999999" }]) {
    assert.throws(() => parseComputeBounds(value));
  }
});
