// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("../scripts/agyn-live-lifecycle.mjs", import.meta.url));
for (const mode of ["success", "parallel", "parallel-no-network", "child-failure", "patch-failure", "unmanaged-edit", "managed-edit", "busy"]) {
  test(`deployment wrapper: ${mode}`, t => {
    const directory = mkdtempSync(join(tmpdir(), "a2a-deployment-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "bin")); mkdirSync(join(directory, "dist/live"), { recursive: true });
    const stateFile = join(directory, "deployment.json");
    const original = { metadata: { resourceVersion: "1" }, spec: { template: { spec: { containers: [{
      name: "agents-orchestrator", image: "stock:1", env: [{ name: "AGYND_CLI_INIT_IMAGE", value: "stock-init:1" },
        { name: "STOP_TIMEOUT_SEC" }, { name: "UNMANAGED", value: "original" }, { name: "PRIVATE_FIXTURE", value: "do-not-log-this-fixture" }]
    }] } } } };
    writeFileSync(stateFile, JSON.stringify(original));
    const kubectl = join(directory, "bin/kubectl");
    writeFileSync(kubectl, `#!/usr/bin/env node
const fs=require("node:fs"),assert=require("node:assert/strict");
const args=process.argv.slice(2),file=process.env.FAKE_DEPLOYMENT,mode=process.env.FAKE_MODE;
const state=JSON.parse(fs.readFileSync(file,"utf8"));
if(args.includes("get")) {
  console.log(JSON.stringify(args.includes("deployment")?state:{items:mode==="busy"?[{metadata:{name:"existing-user-workload"}}]:[]}));
} else if(args.includes("patch")) {
  if(mode==="patch-failure"){console.error("fixture patch failure");process.exit(2);}
  const path=args.find(value=>value.startsWith("--patch-file=")).split("=")[1];
  assert.equal(fs.statSync(path).mode&0o077,0,"patch file must be private");
  const patch=JSON.parse(fs.readFileSync(path,"utf8"));
  assert.equal(patch[0].op,"test");assert.equal(patch[0].path,"/metadata/resourceVersion");
  assert.equal(patch[0].value,state.metadata.resourceVersion,"optimistic concurrency check required");
  assert.equal(patch[1].path,"/spec/template/spec/containers/0/image");
  assert.equal(patch[2].path,"/spec/template/spec/containers/0/env");
  state.spec.template.spec.containers[0].image=patch[1].value;
  state.spec.template.spec.containers[0].env=patch[2].value;
  state.metadata.resourceVersion=String(Number(state.metadata.resourceVersion)+1);
  fs.writeFileSync(file,JSON.stringify(state));
} else if(!args.includes("rollout")) {throw Error("unexpected kubectl operation");}
`, { mode: 0o700 });
    chmodSync(kubectl, 0o700);
    writeFileSync(join(directory, "dist/live/agyn-reporting.js"), `const fs=require("node:fs"),assert=require("node:assert/strict");
const file=process.env.FAKE_DEPLOYMENT,state=JSON.parse(fs.readFileSync(file,"utf8")),c=state.spec.template.spec.containers[0];
assert.equal(c.image,"reviewed:1");assert.equal(c.env.find(e=>e.name==="STOP_INACTIVE_INSTANCES").value,"true");
if(process.env.FAKE_MODE==="parallel")assert.equal(process.env.AGYN_LIVE_SCENARIO,"parallel");
if(process.env.FAKE_MODE==="unmanaged-edit")c.env.find(e=>e.name==="UNMANAGED").value="external";
if(process.env.FAKE_MODE==="managed-edit")c.image="external:1";
state.metadata.resourceVersion=String(Number(state.metadata.resourceVersion)+1);fs.writeFileSync(file,JSON.stringify(state));
process.exit(process.env.FAKE_MODE==="child-failure"?1:0);
`);
    const result = spawnSync(process.execPath, [wrapper, mode.startsWith("parallel") ? "parallel" : "completed"], { cwd: directory, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, AGYN_LIVE_ACCEPTANCE: "trusted-local",
        AGYN_LIVE_RUNNER_CHART: mode === "parallel-no-network" ? "" : "/reviewed/chart",
        AGYN_LIVE_INIT_IMAGE: "reviewed-init:1", AGYN_LIVE_ORCHESTRATOR_IMAGE: "reviewed:1", FAKE_DEPLOYMENT: stateFile, FAKE_MODE: mode } });
    assert.ifError(result.error);
    assert.equal(result.status === 0, ["success", "parallel", "unmanaged-edit"].includes(mode), result.stderr);
    assert(!(result.stdout + result.stderr).includes("do-not-log-this-fixture"), "private settings reached output");
    const current = JSON.parse(readFileSync(stateFile, "utf8")).spec.template.spec.containers[0];
    if (mode === "parallel-no-network") {
      assert.match(result.stderr, /requires the reviewed network policy chart/);
      assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), original, "preflight failure changed deployment");
    }
    if (mode === "managed-edit") assert.equal(current.image, "external:1", "external edit was overwritten");
    else {
      const expected = structuredClone(original.spec.template.spec.containers[0]);
      if (mode === "unmanaged-edit") expected.env.find(entry => entry.name === "UNMANAGED")!.value = "external";
      assert.equal(current.image, expected.image);
      assert.deepEqual([...current.env].sort((a, b) => a.name.localeCompare(b.name)), [...expected.env].sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (!["busy", "parallel-no-network"].includes(mode)) {
      for (const name of readdirSync(join(directory, ".state"))) {
        const files = readdirSync(join(directory, ".state", name));
        assert.deepEqual(files, ["before.json"], "ephemeral patch file was retained");
        assert(!readFileSync(join(directory, ".state", name, "before.json"), "utf8").includes("PRIVATE_FIXTURE"));
      }
    }
  });
}
