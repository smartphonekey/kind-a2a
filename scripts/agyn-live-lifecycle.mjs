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
const scenarios = process.argv.slice(2);
assert(scenarios.length && scenarios.every(value => ["completed", "interrupted", "cancellation", "parallel"].includes(value)), "supply one or more known acceptance scenarios");
if (scenarios.includes("parallel")) assert(process.env.AGYN_LIVE_RUNNER_CHART, "parallel acceptance requires the reviewed network policy chart");
const kubeconfig = resolve(process.env.AGYN_KUBECONFIG ?? ".state/agyn-kubeconfig");
const k = (args, input) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], { input, encoding: "utf8", timeout: 90_000 });
const deployment = () => JSON.parse(k(["get", "deployment", "agents-orchestrator", "-n", "agyn-platform", "-o", "json"]));
const container = value => value.spec.template.spec.containers.find(item => item.name === "agents-orchestrator");
const managed = new Map([["AGYND_CLI_INIT_IMAGE", initImage], ["STOP_INACTIVE_INSTANCES", "true"], ["STOP_TIMEOUT_SEC", "5"]]);
const original = deployment();
const previous = container(original);
assert(previous, "orchestrator container not found");
assert.equal(JSON.parse(k(["get", "pods", "-n", "agyn-workloads", "-o", "json"])).items.length, 0, "refusing a global image change while workloads exist");
mkdirSync(resolve(".state"), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(".state/agyn-lifecycle-deploy-"));
writeFileSync(join(directory, "before.json"), JSON.stringify({ image: previous.image,
  env: previous.env.filter(entry => managed.has(entry.name)) }, null, 2), { mode: 0o600 });
const patch = (current, targetImage, replacements) => {
  const index = current.spec.template.spec.containers.findIndex(item => item.name === "agents-orchestrator");
  const env = container(current).env.filter(entry => !managed.has(entry.name)).concat(replacements);
  const patchFile = join(directory, "patch.json");
  writeFileSync(patchFile, JSON.stringify([
    { op: "test", path: "/metadata/resourceVersion", value: current.metadata.resourceVersion },
    { op: "replace", path: `/spec/template/spec/containers/${index}/image`, value: targetImage },
    { op: "replace", path: `/spec/template/spec/containers/${index}/env`, value: env }
  ]), { mode: 0o600 });
  try { k(["patch", "deployment", "agents-orchestrator", "-n", "agyn-platform", "--type=json", `--patch-file=${patchFile}`]); }
  finally { rmSync(patchFile, { force: true }); }
};
const rollout = () => k(["rollout", "status", "deployment/agents-orchestrator", "-n", "agyn-platform", "--timeout=80s"]);
try {
  patch(original, image, [...managed].map(([name, value]) => ({ name, value })));
  rollout();
  console.log(JSON.stringify({ kind: "live.deployed", image, initImage, directory }));
  for (const scenario of scenarios) {
    const child = spawn(process.execPath, ["dist/live/agyn-reporting.js"], { stdio: "inherit", env: {
      ...process.env, AGYN_LIVE_SCENARIO: scenario === "completed" ? "" : scenario
    } });
    const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("close", resolveExit); });
    if (code !== 0) throw new Error(`${scenario} acceptance failed (${code})`);
  }
} finally {
  const current = deployment();
  const ours = container(current);
  const unchanged = ours.image === previous.image && [...managed.keys()].every(name =>
    JSON.stringify(ours.env.find(entry => entry.name === name)) === JSON.stringify(previous.env.find(entry => entry.name === name)));
  if (!unchanged) {
    assert.equal(ours.image, image, "orchestrator image changed externally; refusing to overwrite it");
    for (const [name, value] of managed) {
      assert.deepEqual(ours.env.find(entry => entry.name === name), { name, value }, `managed setting ${name} changed externally`);
    }
    patch(current, previous.image, previous.env.filter(entry => managed.has(entry.name)));
    rollout();
  }
  console.log(JSON.stringify({ kind: "live.deployment-restored", image: previous.image, directory }));
}
