// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("../scripts/agyn-live-lifecycle.mjs", import.meta.url));
for (const mode of ["success", "parallel", "streaming", "parallel-no-network", "child-failure", "patch-failure", "unmanaged-edit", "managed-edit", "busy",
  "schema-already-prepared", "schema-after-registry", "schema-before-restoration",
  "proxy-success", "proxy-child-failure", "proxy-patch-failure", "proxy-managed-edit", "proxy-uid-change", "proxy-unmanaged-edit", "proxy-unpinned", "proxy-busy", "proxy-log-failure", "proxy-pod-replaced", "proxy-restarted"]) {
  test(`deployment wrapper: ${mode}`, t => {
    const directory = mkdtempSync(join(tmpdir(), "a2a-deployment-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "bin")); mkdirSync(join(directory, "dist/live"), { recursive: true });
    const stateFile = join(directory, "deployment.json");
    const original = { metadata: { uid: "orchestrator-uid", resourceVersion: "1" },
      dependencies: Object.fromEntries(["runners", "gateway", "llm-proxy"].map(name => [name, { metadata: { uid: `${name}-uid`, resourceVersion: "1" },
        spec: { selector: { matchLabels: { app: name } }, template: { spec: { containers: [{ name, image: `stock-${name}:1` }] } } } }])),
      spec: { template: { spec: { containers: [{
      name: "agents-orchestrator", image: "stock:1", env: [{ name: "AGYND_CLI_INIT_IMAGE", value: "stock-init:1" },
        { name: "STOP_TIMEOUT_SEC" }, { name: "UNMANAGED", value: "original" }, { name: "PRIVATE_FIXTURE", value: "do-not-log-this-fixture" }]
    }] } } } };
    writeFileSync(stateFile, JSON.stringify(original));
    const kubectl = join(directory, "bin/kubectl");
    writeFileSync(kubectl, `#!/usr/bin/env node
const fs=require("node:fs"),assert=require("node:assert/strict");
const args=process.argv.slice(2),file=process.env.FAKE_DEPLOYMENT,mode=process.env.FAKE_MODE;
const state=JSON.parse(fs.readFileSync(file,"utf8"));
const name=args.includes('deployment')?args[args.indexOf('deployment')+1]:undefined;
const target=name==='agents-orchestrator'?state:state.dependencies[name];
const proxyPod={metadata:{name:'llm-proxy-fixture',uid:state.proxyPodReplaced?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111'},
spec:{containers:[{name:'llm-proxy',image:state.dependencies['llm-proxy'].spec.template.spec.containers[0].image}]},
status:{containerStatuses:[{name:'llm-proxy',restartCount:state.proxyRestarted?1:0}]}};
if(args.includes('exec')) {
  const sql=fs.readFileSync(0,'utf8');assert(sql.includes('READ ONLY')&&args.includes('ON_ERROR_STOP=1'));
  console.log(JSON.stringify({database:'runners',readOnly:'on',migrations:[mode==='schema-already-prepared'||state.preparedSchema?'0022_prepared_workloads.sql':'0017_workload_removal_confirmation.sql']}));
} else if(args.includes("get")) {
  console.log(JSON.stringify(args.includes("deployment")?target:args.includes('agyn-platform')?
    (args.includes('pod')?proxyPod:{items:[proxyPod]}):{items:["busy","proxy-busy"].includes(mode)?[{metadata:{name:"existing-user-workload"}}]:[]}));
} else if(args.includes('logs')) {
  if(mode==='proxy-log-failure')process.exit(2);
  assert(args.includes('--limit-bytes=65536')&&args.includes('--tail=200')&&args.some(x=>x.startsWith('--since-time=')));
  console.log('private-token');console.log('native: upstream refused '+JSON.stringify({status:401,vendor:'anthropic',body_state:'complete',
    error_type:'authentication_error',auth_reason:'invalid_bearer_token',credential_present:true,anthropic_oauth_beta:true,message:'private-token'}));
} else if(args.includes("patch")) {
  if(mode==="patch-failure"&&name==='agents-orchestrator'){console.error("fixture patch failure");process.exit(2);}
  if(mode==='proxy-patch-failure'&&name==='llm-proxy'){console.error('fixture proxy patch failure');process.exit(2);}
  const path=args.find(value=>value.startsWith("--patch-file=")).split("=")[1];
  assert.equal(fs.statSync(path).mode&0o077,0,"patch file must be private");
  const patch=JSON.parse(fs.readFileSync(path,"utf8"));
  assert.equal(patch[0].op,"test");assert.equal(patch[0].path,"/metadata/resourceVersion");
  assert.equal(patch[0].value,target.metadata.resourceVersion,"optimistic concurrency check required");
  assert.equal(patch[1].path,"/spec/template/spec/containers/0/image");
  if(name==='agents-orchestrator') {
    assert.equal(patch[2].path,"/spec/template/spec/containers/0/env");
    target.spec.template.spec.containers[0].env=patch[2].value;
  } else assert.equal(patch.length,2,'unmanaged dependency environment was patched');
  target.spec.template.spec.containers[0].image=patch[1].value;
  if(mode==='schema-after-registry'&&name==='runners')state.preparedSchema=true;
  target.metadata.resourceVersion=String(Number(target.metadata.resourceVersion)+1);
  fs.writeFileSync(file,JSON.stringify(state));
} else if(!args.includes("rollout")) {throw Error("unexpected kubectl operation");}
`, { mode: 0o700 });
    chmodSync(kubectl, 0o700);
    writeFileSync(join(directory, "dist/live/agyn-reporting.js"), `const fs=require("node:fs"),assert=require("node:assert/strict");
const file=process.env.FAKE_DEPLOYMENT,state=JSON.parse(fs.readFileSync(file,"utf8")),c=state.spec.template.spec.containers[0];
if(process.env.FAKE_MODE==='schema-before-restoration')state.preparedSchema=true;
assert.equal(c.image,"reviewed:1");assert.equal(c.env.find(e=>e.name==="STOP_INACTIVE_INSTANCES").value,"true");
for(const name of ['runners','gateway'])assert.equal(state.dependencies[name].spec.template.spec.containers[0].image,'reviewed-'+name+':1');
if(["parallel","streaming"].includes(process.env.FAKE_MODE))assert.equal(process.env.AGYN_LIVE_SCENARIO,process.env.FAKE_MODE);
if(process.env.FAKE_MODE==="unmanaged-edit")c.env.find(e=>e.name==="UNMANAGED").value="external";
if(process.env.FAKE_MODE==="managed-edit")c.image="external:1";
if(process.env.FAKE_MODE.startsWith('proxy-')) {
 const p=state.dependencies['llm-proxy'];assert.equal(p.spec.template.spec.containers[0].image,process.env.AGYN_LIVE_LLM_PROXY_IMAGE);
 if(process.env.FAKE_MODE==='proxy-managed-edit')p.spec.template.spec.containers[0].image='external:1';
 if(process.env.FAKE_MODE==='proxy-uid-change')p.metadata.uid='external-uid';
 if(process.env.FAKE_MODE==='proxy-unmanaged-edit')p.spec.template.spec.containers[0].env=[{name:'UNMANAGED',value:'external'}];
 if(process.env.FAKE_MODE==='proxy-pod-replaced')state.proxyPodReplaced=true;
 if(process.env.FAKE_MODE==='proxy-restarted')state.proxyRestarted=true;
}
state.metadata.resourceVersion=String(Number(state.metadata.resourceVersion)+1);fs.writeFileSync(file,JSON.stringify(state));
process.exit(["child-failure","proxy-child-failure"].includes(process.env.FAKE_MODE)?1:0);
`);
    const result = spawnSync(process.execPath, [wrapper, mode.startsWith("parallel") ? "parallel" : mode === "streaming" ? "streaming" : "completed"], { cwd: directory, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, AGYN_LIVE_ACCEPTANCE: "trusted-local",
        AGYN_LIVE_COMPUTE_RESOURCES: "", AGYN_LIVE_RUNNER_IMAGE: "", AGYN_LIVE_SUPPORTING_RESOURCES: "",
        AGYN_LIVE_RUNNER_CHART: mode === "parallel-no-network" ? "" : "/reviewed/chart",
        AGYN_LIVE_RUNNERS_IMAGE: "reviewed-runners:1", AGYN_LIVE_GATEWAY_IMAGE: "reviewed-gateway:1",
        AGYN_LIVE_LLM_PROXY_IMAGE: mode === "proxy-unpinned" ? "unpinned:latest" : mode.startsWith("proxy-") ? `reviewed-proxy@sha256:${"a".repeat(64)}` : "",
        AGYN_LIVE_INIT_IMAGE: "reviewed-init:1", AGYN_LIVE_ORCHESTRATOR_IMAGE: "reviewed:1", FAKE_DEPLOYMENT: stateFile, FAKE_MODE: mode } });
    assert.ifError(result.error);
    assert.equal(result.status === 0, ["success", "parallel", "streaming", "unmanaged-edit", "proxy-success", "proxy-unmanaged-edit"].includes(mode), result.stderr);
    assert(!(result.stdout + result.stderr).includes("do-not-log-this-fixture"), "private settings reached output");
    const current = JSON.parse(readFileSync(stateFile, "utf8")).spec.template.spec.containers[0];
    const dependencies = JSON.parse(readFileSync(stateFile, "utf8")).dependencies;
    if (mode.startsWith("schema-")) {
      assert.match(result.stderr, /checked\/prepared registry requires coordinated retain-mode rollout/);
      assert.equal(dependencies.runners.spec.template.spec.containers[0].image, mode === "schema-already-prepared" ? "stock-runners:1" : "reviewed-runners:1");
      assert.equal(dependencies.gateway.spec.template.spec.containers[0].image, mode === "schema-before-restoration" ? "reviewed-gateway:1" : "stock-gateway:1");
      assert.equal(current.image, mode === "schema-before-restoration" ? "reviewed:1" : "stock:1");
      return;
    }
    for (const name of ["runners", "gateway"]) assert.deepEqual(dependencies[name].spec, original.dependencies[name].spec, `${name} was not restored`);
    if (mode === "proxy-managed-edit") assert.equal(dependencies["llm-proxy"].spec.template.spec.containers[0].image, "external:1");
    else if (mode === "proxy-uid-change") {
      assert.equal(dependencies["llm-proxy"].metadata.uid, "external-uid");
      assert.match(dependencies["llm-proxy"].spec.template.spec.containers[0].image, /^reviewed-proxy@/);
    } else {
      const expected = structuredClone(original.dependencies["llm-proxy"].spec);
      if (mode === "proxy-unmanaged-edit") Object.assign(expected.template.spec.containers[0], { env: [{ name: "UNMANAGED", value: "external" }] });
      assert.deepEqual(dependencies["llm-proxy"].spec, expected, "proxy was not restored or external settings were overwritten");
    }
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
    if (!["busy", "parallel-no-network", "proxy-unpinned", "proxy-busy"].includes(mode)) {
      for (const name of readdirSync(join(directory, ".state"))) {
        const files = readdirSync(join(directory, ".state", name));
        assert.deepEqual(files.sort(), mode.startsWith("proxy-") ? ["before.json", "proxy-diagnostics.json"] : ["before.json"], "unexpected evidence files");
        assert(!readFileSync(join(directory, ".state", name, "before.json"), "utf8").includes("PRIVATE_FIXTURE"));
        if (mode.startsWith("proxy-")) {
          const raw = readFileSync(join(directory, ".state", name, "proxy-diagnostics.json"), "utf8");
          assert(!raw.includes("private-token"));
          const report = JSON.parse(raw);
          assert.equal(report.captured, !["proxy-patch-failure", "proxy-log-failure", "proxy-managed-edit", "proxy-pod-replaced", "proxy-restarted"].includes(mode));
          if (report.captured) assert.equal(report.refusals[0].auth_reason, "invalid_bearer_token");
        }
      }
    }
  });
}
