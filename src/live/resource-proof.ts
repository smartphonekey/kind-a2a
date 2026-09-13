// SPDX-License-Identifier: AGPL-3.0-only
// Operator acceptance only; quantities use the Kubernetes SDK's parser.
import assert from "node:assert/strict";
import { quantityToScalar } from "@kubernetes/client-node/dist/util.js";

export type ComputeBounds = { requestsCpu: string; requestsMemory: string; limitsCpu: string; limitsMemory: string };
const fields = ["limitsCpu", "limitsMemory", "requestsCpu", "requestsMemory"] as const;
const scalar = (value: string, cpu: boolean): number => {
  assert.equal(typeof value, "string", "resource quantity is required");
  const parsed = Number(quantityToScalar(value));
  assert(parsed > 0 && Number.isSafeInteger(cpu ? parsed * 1000 : parsed), "resource quantity must be positive and use representable millicores/bytes");
  return parsed;
};

export function parseComputeBounds(value: unknown): ComputeBounds {
  assert(value && typeof value === "object" && !Array.isArray(value), "resource bounds must be an object");
  assert.deepEqual(Object.keys(value).sort(), fields, "all four resource bounds are required");
  const result = value as ComputeBounds;
  for (const name of fields) scalar(result[name], name.endsWith("Cpu"));
  assert(scalar(result.requestsCpu, true) <= scalar(result.limitsCpu, true), "CPU request exceeds limit");
  assert(scalar(result.requestsMemory, false) <= scalar(result.limitsMemory, false), "memory request exceeds limit");
  return { ...result };
}

export function assertPodComputeBounds(pod: any, mainName: string, main: ComputeBounds, supporting: ComputeBounds): any[] {
  const result: any[] = [];
  assert.equal(pod.spec.containers.filter((item: any) => item.name === mainName).length, 1, "main container missing or duplicated");
  for (const [role, containers] of [["container", pod.spec.containers], ["init", pod.spec.initContainers ?? []]] as const) {
    for (const container of containers) {
      const expected = role === "container" && container.name === mainName ? main : supporting;
      const actual = parseComputeBounds({ requestsCpu: container.resources?.requests?.cpu, requestsMemory: container.resources?.requests?.memory,
        limitsCpu: container.resources?.limits?.cpu, limitsMemory: container.resources?.limits?.memory });
      for (const field of fields) assert.equal(scalar(actual[field], field.endsWith("Cpu")), scalar(expected[field], field.endsWith("Cpu")), `${role}/${container.name} ${field} differs from the operator allocation`);
      result.push({ role, name: container.name, resources: actual });
    }
  }
  return result;
}

export function assertCgroupComputeBounds(value: any, expected: ComputeBounds): void {
  assert.equal(typeof value?.cpuMax, "string", "cpu.max evidence missing");
  assert.equal(typeof value?.memoryMax, "string", "memory.max evidence missing");
  const cpu = value.cpuMax.split(/\s+/).map(Number);
  assert(cpu.length === 2 && cpu.every((item: number) => Number.isSafeInteger(item) && item > 0), "CPU cgroup is unbounded or invalid");
  assert.equal(cpu[0] / cpu[1], scalar(expected.limitsCpu, true), "main CPU cgroup differs from the selected flavor");
  assert.equal(Number(value.memoryMax), scalar(expected.limitsMemory, false), "main memory cgroup differs from the selected flavor");
}
