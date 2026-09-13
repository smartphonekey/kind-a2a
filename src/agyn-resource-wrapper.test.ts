// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("../scripts/agyn-live-lifecycle.mjs", import.meta.url));
const bounds = JSON.stringify({ requestsCpu: "50m", requestsMemory: "64Mi", limitsCpu: "500m", limitsMemory: "256Mi" });
const deploymentNames = ["runners", "gateway", "k8s-runner", "agents-orchestrator"];
for (const mode of ["success", "child-failure", "runner-patch-failure", "runner-rollout-failure", "orchestrator-patch-failure",
  "lost-runner-patch-ack", "unmanaged-edit", "managed-runner-edit", "managed-orchestrator-edit", "runner-env-edit", "replaced-runner",
  "late-busy", "missing-image", "partial-bounds", "no-flag", "no-network", "setup-unmanaged-edit", "setup-managed-edit",
  "runners-patch-failure", "gateway-patch-failure", "runners-rollout-failure", "gateway-rollout-failure",
  "lost-runners-patch-ack", "lost-gateway-patch-ack", "managed-runners-edit", "managed-gateway-edit", "replaced-gateway",
  "missing-runners-image", "missing-gateway-image", "setup-busy"]) {
  test(`resource deployment wrapper: ${mode}`, t => {
    const directory = mkdtempSync(join(tmpdir(), "a2a-resource-wrapper-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "bin")); mkdirSync(join(directory, "dist/live"), { recursive: true });
    const original = Object.fromEntries(deploymentNames.map(name => [name, {
      metadata: { uid: `${name}-uid`, resourceVersion: "1" }, spec: { template: { spec: { containers: [{ name, image: `stock-${name}:1`, env: [
        { name: "UNMANAGED", value: "original" }, { name: "PRIVATE_FIXTURE", value: "do-not-log-resource-fixture" },
        ...(name === "k8s-runner" ? [{ name: "SUPPORTING_CONTAINER_RESOURCES", valueFrom: { configMapKeyRef: { name: "original", key: "bounds" } } }]
          : name === "agents-orchestrator" ? [{ name: "AGYND_CLI_INIT_IMAGE", value: "stock-init:1" }, { name: "STOP_TIMEOUT_SEC" }] : [])
      ] }] } } }
    }]));
    const stateFile = join(directory, "state.json");
    writeFileSync(stateFile, JSON.stringify({ deployments: original, failed: false, busy: false, operations: [] }));
    writeFileSync(join(directory, "bin/kubectl"), `#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2);
assert.equal(args[0],'--kubeconfig');assert.equal(args[1],'/fixture/config');
const file=process.env.FAKE_DEPLOYMENT,mode=process.env.FAKE_MODE,state=JSON.parse(fs.readFileSync(file,'utf8'));
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const fail=()=>{state.failed=true;save();process.exit(2)};
if(args.includes('get')) {
  console.log(JSON.stringify(args.includes('deployment')?state.deployments[args[args.indexOf('deployment')+1]]:{items:state.busy?[{metadata:{name:'unreleased'}}]:[]}));
} else if(args.includes('patch')) {
  const name=args[args.indexOf('deployment')+1],d=state.deployments[name],c=d.spec.template.spec.containers[0];
  if(!state.failed && ((mode==='runner-patch-failure'&&name==='k8s-runner')||(mode==='orchestrator-patch-failure'&&name==='agents-orchestrator')||mode===name+'-patch-failure'))fail();
  const path=args.find(a=>a.startsWith('--patch-file=')).slice('--patch-file='.length);
  assert.equal(fs.statSync(path).mode&0o077,0);
  const p=JSON.parse(fs.readFileSync(path,'utf8'));
  assert.equal(p[0].op,'test');assert.equal(p[0].path,'/metadata/resourceVersion');assert.equal(p[0].value,d.metadata.resourceVersion);
  assert.equal(p[1].path,'/spec/template/spec/containers/0/image');
  if(['runners','gateway'].includes(name))assert.equal(p.length,2,'unmanaged dependency environment was patched');
  else {assert.equal(p[2].path,'/spec/template/spec/containers/0/env');c.env=p[2].value;}
  c.image=p[1].value;d.metadata.resourceVersion=String(Number(d.metadata.resourceVersion)+1);state.operations.push({op:'patch',name});save();
  if(!state.failed&&((mode==='lost-runner-patch-ack'&&name==='k8s-runner')||mode==='lost-'+name+'-patch-ack'))fail();
} else if(args.includes('rollout')) {
  const name=args.find(a=>a.startsWith('deployment/')).slice('deployment/'.length);
  state.operations.push({op:'rollout',name});save();
  if(!state.failed&&((mode==='runner-rollout-failure'&&name==='k8s-runner')||mode===name+'-rollout-failure'))fail();
  if(mode==='setup-busy'&&name==='runners'){state.busy=true;save();}
  if(mode.startsWith('setup-')&&!state.edited&&args.includes('deployment/k8s-runner')) {
    const d=state.deployments['agents-orchestrator'],c=d.spec.template.spec.containers[0];
    if(mode==='setup-managed-edit')c.image='external:1';else c.env.find(e=>e.name==='UNMANAGED').value='external';
    d.metadata.resourceVersion=String(Number(d.metadata.resourceVersion)+1);state.edited=true;save();
  }
} else throw Error('unexpected kubectl');
`, { mode: 0o700 });
    writeFileSync(join(directory, "dist/live/agyn-reporting.js"), `const fs=require('node:fs'),assert=require('node:assert/strict');
const file=process.env.FAKE_DEPLOYMENT,s=JSON.parse(fs.readFileSync(file,'utf8')),mode=process.env.FAKE_MODE;
s.childRan=true;
assert.equal(process.env.AGYN_LIVE_COMPUTE_RESOURCES,'true');
for(const name of ['runners','gateway','k8s-runner','agents-orchestrator'])assert.equal(s.deployments[name].spec.template.spec.containers[0].image,'reviewed-'+name+':1');
const runner=s.deployments['k8s-runner'].spec.template.spec.containers[0];
assert.equal(runner.env.find(e=>e.name==='SUPPORTING_CONTAINER_RESOURCES').value,process.env.AGYN_LIVE_SUPPORTING_RESOURCES);
if(mode==='unmanaged-edit')for(const d of Object.values(s.deployments))d.spec.template.spec.containers[0].env.find(e=>e.name==='UNMANAGED').value='external';
if(mode==='managed-runner-edit')runner.image='external:1';
if(mode==='managed-orchestrator-edit')s.deployments['agents-orchestrator'].spec.template.spec.containers[0].image='external:1';
for(const name of ['runners','gateway'])if(mode==='managed-'+name+'-edit')s.deployments[name].spec.template.spec.containers[0].image='external:1';
if(mode==='runner-env-edit')runner.env.find(e=>e.name==='SUPPORTING_CONTAINER_RESOURCES').value='external';
if(mode==='replaced-runner'){s.deployments['k8s-runner'].metadata.uid='replacement';runner.image='external:1';}
if(mode==='replaced-gateway'){s.deployments.gateway.metadata.uid='replacement';s.deployments.gateway.spec.template.spec.containers[0].image='external:1';}
if(mode==='late-busy')s.busy=true;
for(const d of Object.values(s.deployments))d.metadata.resourceVersion=String(Number(d.metadata.resourceVersion)+1);
fs.writeFileSync(file,JSON.stringify(s));process.exit(mode==='child-failure'?1:0);
`);
    const result = spawnSync(process.execPath, [wrapper, "completed"], { cwd: directory, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, FAKE_DEPLOYMENT: stateFile, FAKE_MODE: mode,
        AGYN_KUBECONFIG: "/fixture/config", AGYN_LIVE_ACCEPTANCE: "trusted-local", AGYN_LIVE_INIT_IMAGE: "reviewed-init:1",
        AGYN_LIVE_ORCHESTRATOR_IMAGE: "reviewed-agents-orchestrator:1", AGYN_LIVE_RUNNER_IMAGE: mode === "missing-image" ? "" : "reviewed-k8s-runner:1",
        AGYN_LIVE_RUNNERS_IMAGE: mode === "missing-runners-image" ? "" : "reviewed-runners:1",
        AGYN_LIVE_GATEWAY_IMAGE: mode === "missing-gateway-image" ? "" : "reviewed-gateway:1",
        AGYN_LIVE_RUNNER_CHART: mode === "no-network" ? "" : "/reviewed/chart", AGYN_LIVE_COMPUTE_RESOURCES: mode === "no-flag" ? "" : "true",
        AGYN_LIVE_SUPPORTING_RESOURCES: mode === "partial-bounds" ? "{}" : bounds } });
    assert.ifError(result.error);
    assert.equal(result.status === 0, ["success", "unmanaged-edit", "setup-unmanaged-edit"].includes(mode), result.stderr);
    assert(!(result.stdout + result.stderr).includes("do-not-log-resource-fixture"), "private deployment fields were logged");
    const current = JSON.parse(readFileSync(stateFile, "utf8"));
    if (mode === "success") assert.deepEqual(current.operations, [...deploymentNames, ...[...deploymentNames].reverse()]
      .flatMap(name => [{ op: "patch", name }, { op: "rollout", name }]), "dependencies must roll out first and restore last");
    if (["missing-runners-image", "missing-gateway-image"].includes(mode)) assert.match(result.stderr, /Runners and Gateway removal-confirmation images are required/);
    if (mode.includes("patch-failure") || mode.includes("rollout-failure") || mode.startsWith("lost-") || mode.startsWith("missing-") ||
        ["partial-bounds", "no-flag", "no-network", "setup-managed-edit", "setup-busy"].includes(mode)) {
      assert(!current.childRan, "acceptance child ran after setup failed");
    }
    for (const name of deploymentNames) {
      const c = current.deployments[name].spec.template.spec.containers[0];
      if (mode === "late-busy") { assert.equal(c.image, `reviewed-${name}:1`); continue; }
      if (mode === "setup-busy") { assert.equal(c.image, `${name === "runners" ? "reviewed" : "stock"}-${name}:1`); continue; }
      if (mode === `managed-${name}-edit` || name === "gateway" && mode === "replaced-gateway") {
        assert.equal(c.image, "external:1", "external dependency image was overwritten"); continue;
      }
      if ((name === "k8s-runner" && ["managed-runner-edit", "replaced-runner"].includes(mode)) || (name === "agents-orchestrator" && ["managed-orchestrator-edit", "setup-managed-edit"].includes(mode))) {
        assert.equal(c.image, "external:1", "external image was overwritten"); continue;
      }
      if (name === "k8s-runner" && mode === "runner-env-edit") {
        assert.equal(c.env.find((entry: any) => entry.name === "SUPPORTING_CONTAINER_RESOURCES").value, "external"); continue;
      }
      const expected = structuredClone(original[name].spec.template.spec.containers[0]);
      if (mode === "unmanaged-edit" || (name === "agents-orchestrator" && mode === "setup-unmanaged-edit")) expected.env.find(entry => entry.name === "UNMANAGED")!.value = "external";
      assert.equal(c.image, expected.image, `${name} was not restored despite a different deployment's conflict`);
      assert.deepEqual([...c.env].sort((a: any, b: any) => a.name.localeCompare(b.name)), [...expected.env].sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (existsSync(join(directory, ".state"))) for (const entry of readdirSync(join(directory, ".state"))) {
      const path = join(directory, ".state", entry);
      assert.deepEqual(readdirSync(path), ["before.json"]);
      assert(!readFileSync(join(path, "before.json"), "utf8").includes("PRIVATE_FIXTURE"));
      assert.equal(JSON.parse(readFileSync(join(path, "before.json"), "utf8")).deployments.length, 4);
    }
  });
}
