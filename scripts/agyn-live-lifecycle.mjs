// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only, opt-in deployment wrapper. Restore only the fields this run owns.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local");
const image = process.env.AGYN_LIVE_ORCHESTRATOR_IMAGE;
const initImage = process.env.AGYN_LIVE_INIT_IMAGE;
assert(image && initImage, "explicit reviewed orchestrator and daemon integration images are required");
const runnersImage = process.env.AGYN_LIVE_RUNNERS_IMAGE;
const gatewayImage = process.env.AGYN_LIVE_GATEWAY_IMAGE;
assert(runnersImage && gatewayImage, "explicit reviewed Runners and Gateway removal-confirmation images are required");
const bounded = process.env.AGYN_LIVE_COMPUTE_RESOURCES === "true";
assert(!process.env.AGYN_LIVE_COMPUTE_RESOURCES || bounded, "AGYN_LIVE_COMPUTE_RESOURCES must be true when set");
const runnerImage = process.env.AGYN_LIVE_RUNNER_IMAGE;
const supportingResources = process.env.AGYN_LIVE_SUPPORTING_RESOURCES;
if (bounded) {
  assert(runnerImage && supportingResources, "resource acceptance requires explicit runner image and supporting bounds");
  const bounds = JSON.parse(supportingResources);
  assert(bounds && typeof bounds === "object" && !Array.isArray(bounds));
  assert.deepEqual(Object.keys(bounds).sort(), ["limitsCpu", "limitsMemory", "requestsCpu", "requestsMemory"]);
  assert(Object.values(bounds).every(value => typeof value === "string" && value.trim()), "supporting bounds must be complete strings");
  assert(process.env.AGYN_LIVE_RUNNER_CHART, "resource acceptance requires the reviewed network policy chart");
} else assert(!runnerImage && !supportingResources, "resource settings require AGYN_LIVE_COMPUTE_RESOURCES=true");
const scenarios = process.argv.slice(2);
assert(scenarios.length && scenarios.every(value => ["completed", "interrupted", "cancellation", "parallel", "streaming", "startup-failure"].includes(value)), "supply one or more known acceptance scenarios");
if (scenarios.includes("startup-failure")) {
  assert(bounded, "startup-failure acceptance requires the bounded resource profile");
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(process.env.AGYN_LIVE_PLATFORM_MODEL_ID ?? ""),
    "startup-failure requires an explicit platform model metadata UUID; it never invokes that model");
}
if (scenarios.includes("parallel")) assert(process.env.AGYN_LIVE_RUNNER_CHART, "parallel acceptance requires the reviewed network policy chart");
const kubeconfig = resolve(process.env.AGYN_KUBECONFIG ?? ".state/agyn-kubeconfig");
const k = (args, input) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], { input, encoding: "utf8", timeout: 90_000 });
const deployment = name => JSON.parse(k(["get", "deployment", name, "-n", "agyn-platform", "-o", "json"]));
const container = (value, name) => value.spec.template.spec.containers.find(item => item.name === name);
const targets = [
  { name: "runners", image: runnersImage, managed: new Map() },
  { name: "gateway", image: gatewayImage, managed: new Map() },
  ...(bounded ? [{ name: "k8s-runner", image: runnerImage, managed: new Map([["SUPPORTING_CONTAINER_RESOURCES", supportingResources]]) }] : []),
  { name: "agents-orchestrator", image, managed: new Map([["AGYND_CLI_INIT_IMAGE", initImage], ["STOP_INACTIVE_INSTANCES", "true"], ["STOP_TIMEOUT_SEC", "5"]]) }
].map(target => {
  const original = deployment(target.name), previous = container(original, target.name);
  assert(previous, `${target.name} container not found`);
  return { ...target, original, previous, attempted: false };
});
const assertIdle = message => assert.equal(JSON.parse(k(["get", "pods", "-n", "agyn-workloads", "-o", "json"])).items.length, 0, message);
assertIdle("refusing a global image change while workloads exist");
mkdirSync(resolve(".state"), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(".state/agyn-lifecycle-deploy-"));
writeFileSync(join(directory, "before.json"), JSON.stringify({ deployments: targets.map(target => ({ name: target.name,
  uid: target.original.metadata.uid, image: target.previous.image,
  env: (target.previous.env ?? []).filter(entry => target.managed.has(entry.name)) })) }, null, 2), { mode: 0o600 });
const patch = (target, current, targetImage, replacements) => {
  assert.equal(current.metadata.uid, target.original.metadata.uid, `${target.name} deployment identity changed`);
  const index = current.spec.template.spec.containers.findIndex(item => item.name === target.name);
  assert(index >= 0, `${target.name} container removed`);
  const currentContainer = container(current, target.name);
  const env = (currentContainer.env ?? []).filter(entry => !target.managed.has(entry.name)).concat(replacements);
  const patchFile = join(directory, "patch.json");
  writeFileSync(patchFile, JSON.stringify([
    { op: "test", path: "/metadata/resourceVersion", value: current.metadata.resourceVersion },
    { op: "replace", path: `/spec/template/spec/containers/${index}/image`, value: targetImage },
    ...(target.managed.size ? [{ op: currentContainer.env ? "replace" : "add", path: `/spec/template/spec/containers/${index}/env`, value: env }] : [])
  ]), { mode: 0o600 });
  try { k(["patch", "deployment", target.name, "-n", "agyn-platform", "--type=json", `--patch-file=${patchFile}`]); }
  finally { rmSync(patchFile, { force: true }); }
};
const rollout = name => k(["rollout", "status", `deployment/${name}`, "-n", "agyn-platform", "--timeout=80s"]);
const sameManaged = (target, left, right) => left && right && left.image === right.image && [...target.managed.keys()].every(name =>
  JSON.stringify(left.env?.find(entry => entry.name === name)) === JSON.stringify(right.env?.find(entry => entry.name === name)));
try {
  for (const target of targets) {
    assertIdle("workloads appeared during deployment setup; refusing further changes");
    const current = deployment(target.name);
    assert(sameManaged(target, container(current, target.name), target.previous), `${target.name} managed settings changed during setup`);
    target.attempted = true;
    patch(target, current, target.image, [...target.managed].map(([name, value]) => ({ name, value })));
    rollout(target.name);
  }
  console.log(JSON.stringify({ kind: "live.deployed", image, initImage, runnerImage, runnersImage, gatewayImage, bounded, directory }));
  for (const scenario of scenarios) {
    const child = spawn(process.execPath, [scenario === "startup-failure" ? "dist/live/agyn-removal.js" : "dist/live/agyn-reporting.js"], { stdio: "inherit", env: {
      ...process.env, AGYN_LIVE_SCENARIO: scenario === "completed" ? "" : scenario
    } });
    const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("close", resolveExit); });
    if (code !== 0) throw new Error(`${scenario} acceptance failed (${code})`);
  }
} finally {
  assertIdle("workload cleanup unconfirmed; retaining integration deployments for reconciliation");
  const errors = [];
  for (const target of [...targets].reverse().filter(target => target.attempted)) {
    try {
      const current = deployment(target.name), ours = container(current, target.name), previous = target.previous;
      assert.equal(current.metadata.uid, target.original.metadata.uid, `${target.name} deployment identity changed`);
      assert(ours, `${target.name} container removed`);
      if (!sameManaged(target, ours, previous)) {
        assert.equal(ours.image, target.image, `${target.name} image changed externally; refusing to overwrite it`);
        for (const [name, value] of target.managed) {
          assert.deepEqual(ours.env?.find(entry => entry.name === name), { name, value }, `managed setting ${name} changed externally`);
        }
        patch(target, current, previous.image, (previous.env ?? []).filter(entry => target.managed.has(entry.name)));
        rollout(target.name);
      }
      console.log(JSON.stringify({ kind: "live.deployment-restored", deployment: target.name, image: previous.image, directory }));
    } catch (error) { errors.push(error); }
  }
  if (errors.length) {
    throw new AggregateError(errors, "deployment restoration requires operator reconciliation");
  }
}
