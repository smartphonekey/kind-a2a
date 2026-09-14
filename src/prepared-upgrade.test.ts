// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertPreparedSchema, collectPreparedUpgradeState, parsePreparedUpgradeState, preparedUpgradeSQL, verifyPreparedBackup } from "./live/prepared-upgrade.js";
import { fixture, id, migrations, output, scope, type Fixture } from "./test/prepared-upgrade-fixture.js";

const parse = (f: Fixture) => parsePreparedUpgradeState(output(f), scope);

test("prepared upgrade distinguishes an installed migration from irreversible prepared owner history", () => {
  const f = fixture(true), clean = parse(f);
  assertPreparedSchema(clean); assert.equal(clean.legacyRollbackForbidden, false);
  f.registry.workloads.prepared = 1;
  const prepared = parse(f); assert.equal(prepared.legacyRollbackForbidden, true); assert.notEqual(prepared.fingerprint, clean.fingerprint);
  f.registry.workloads.prepared = 0; f.pins.prepared = 1;
  assert.equal(parse(f).legacyRollbackForbidden, true, "history GC cannot erase the rollback boundary");
  f.pins.prepared = 0; f.registry.volumes.checked = 1;
  assert.equal(parse(f).legacyRollbackForbidden, true, "checked volumes also require compatible writers");
});

for (const [name, mutate] of [
  ["read-write snapshot", (f: Fixture) => { f.registry.readOnly = "off"; }],
  ["weak isolation", (f: Fixture) => { f.registry.isolation = "read committed"; }],
  ["other database", (f: Fixture) => { f.registry.database = "agents"; }],
  ["other runner", (f: Fixture) => { f.registry.runner.id = id(99); }],
  ["unenrolled runner", (f: Fixture) => { f.registry.runner.status = "pending"; }],
  ["future schema", (f: Fixture) => { f.registry.migrations = [...f.registry.migrations, "0023_future.sql"]; }],
  ["duplicate migration", (f: Fixture) => { f.registry.migrations = [...f.registry.migrations, migrations[0]]; }],
  ["invalid counts", (f: Fixture) => { f.registry.workloads.prepared = 3; }],
  ["missing owner table", (f: Fixture) => { f.pins.tablePresent = false; }]
] as const) test(`prepared upgrade refuses ${name}`, () => { const f = fixture(true); mutate(f); assert.throws(() => parse(f)); });

test("prepared schema requires every migration, validated constraint and enabled writer guard", () => {
  const base = fixture(true);
  for (const migration of migrations) {
    const f = structuredClone(base); f.registry.migrations = f.registry.migrations.filter(v => v !== migration);
    assert.throws(() => assertPreparedSchema(parse(f)), /missing required migration/);
  }
  for (const constraint of base.registry.constraints) {
    const f = structuredClone(base); f.registry.constraints.find(c => c.name === constraint.name)!.validated = false;
    assert.throws(() => assertPreparedSchema(parse(f)), /missing validated constraint/);
  }
  for (const guard of base.registry.triggers) for (const enabled of ["D", "R"]) {
    const f = structuredClone(base); f.registry.triggers.find(g => g.name === guard.name)!.enabled = enabled;
    assert.throws(() => assertPreparedSchema(parse(f)), /missing enabled guard/);
  }
});

test("prepared snapshot requires both records and fingerprints binding changes without numeric coercion", () => {
  const f = fixture(true), before = parse(f);
  for (const raw of [JSON.stringify(f.registry), output(f) + "{}\n", "PRIVATE_SQL_ERROR", output(f).replace(/\n/, "")]) {
    assert.throws(() => parsePreparedUpgradeState(raw, scope));
  }
  f.registry.workloads.fingerprint = "d".repeat(32);
  assert.notEqual(parse(f).fingerprint, before.fingerprint);
  assert.match(preparedUpgradeSQL, /'revision', COALESCE\(to_jsonb\(w\)->'preparation_revision'/);
  assert.match(preparedUpgradeSQL, /REPEATABLE READ READ ONLY/); assert.match(preparedUpgradeSQL, /ROLLBACK;/);
  assert(!/service_token_hash|failure_message|'containers'/.test(preparedUpgradeSQL));
});

for (const mode of ["stable", "namespace-replaced", "postgres-replaced", "postgres-restarted", "database-error", "invalid-scope"]) {
  test(`prepared collector: ${mode}`, () => {
    const f = fixture(); let queried = false, calls = 0;
    const read = (args: string[], input?: string) => {
      calls++;
      if (args[0] === "exec") {
        assert.equal(input, preparedUpgradeSQL); assert(args.includes(`audit_runner_id=${scope.runnerId}`));
        assert(args.includes("PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000"));
        queried = true; if (mode === "database-error") throw new Error("PRIVATE_SQL_ERROR"); return output(f);
      }
      assert.equal(args[0], "get", "collector attempted a Kubernetes mutation");
      if (args[1] === "namespace") return JSON.stringify({ metadata: { name: "agyn-workloads", uid: queried && mode === "namespace-replaced" ? id(99) : scope.namespaceUid } });
      return JSON.stringify({ metadata: { name: scope.postgresPod, namespace: "agyn-platform", uid: queried && mode === "postgres-replaced" ? id(99) : scope.postgresPodUid },
        status: { phase: "Running", containerStatuses: [{ name: "postgres", ready: true, containerID: "containerd://postgres", restartCount: queried && mode === "postgres-restarted" ? 1 : 0 }] } });
    };
    if (mode === "stable") assert.equal(collectPreparedUpgradeState(read, scope).fingerprint, parse(f).fingerprint);
    else assert.throws(() => collectPreparedUpgradeState(read, mode === "invalid-scope" ? { ...scope, runnerId: "" } : scope),
      error => error instanceof Error && !error.message.includes("PRIVATE_SQL_ERROR"));
    assert.equal(calls, mode === "invalid-scope" ? 0 : mode === "database-error" ? 3 : 5);
  });
}

function writeBackup(directory: string, f: Fixture) {
  mkdirSync(directory, { mode: 0o700 });
  const state = parse(f), archive = Buffer.from("private dump fixture");
  writeFileSync(join(directory, "runners.dump"), archive, { mode: 0o600 });
  const receipt = { kind: "prepared-upgrade-restored-backup", version: 1, scope, sourceFingerprint: state.fingerprint,
    restoredFingerprint: state.fingerprint, archiveSha256: createHash("sha256").update(archive).digest("hex"),
    cleanupConfirmed: true, rehearsal: { schemaVerified: true, legacyHistoryUnchanged: true } };
  const file = join(directory, "receipt.json"); writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  return { file, receipt };
}
for (const mode of ["valid", "wrong-scope", "changed-source", "unverified-restore", "unverified-rehearsal", "unconfirmed-cleanup", "changed-archive", "public-receipt", "symlink-archive"]) {
  test(`prepared verified backup: ${mode}`, t => {
    const directory = mkdtempSync(join(tmpdir(), "prepared-backup-test-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
    const f = fixture(), { file, receipt } = writeBackup(join(directory, "backup"), f);
    if (mode === "wrong-scope") receipt.scope = { ...scope, runnerId: id(99) };
    if (mode === "changed-source") f.registry.workloads.fingerprint = "d".repeat(32);
    if (mode === "unverified-restore") receipt.restoredFingerprint = "d".repeat(64);
    if (mode === "unverified-rehearsal") receipt.rehearsal.schemaVerified = false;
    if (mode === "unconfirmed-cleanup") receipt.cleanupConfirmed = false;
    writeFileSync(file, JSON.stringify(receipt));
    if (mode === "changed-archive") writeFileSync(join(directory, "backup/runners.dump"), "changed");
    if (mode === "public-receipt") chmodSync(file, 0o644);
    if (mode === "symlink-archive") { rmSync(join(directory, "backup/runners.dump")); symlinkSync(file, join(directory, "backup/runners.dump")); }
    if (mode === "valid") verifyPreparedBackup(file, parse(f)); else assert.throws(() => verifyPreparedBackup(file, parse(f)));
  });
}

const wrapper = fileURLToPath(new URL("../scripts/agyn-live-lifecycle.mjs", import.meta.url));
const names = ["runners", "gateway", "k8s-runner", "agents-orchestrator"];
const image = (name: string) => `reviewed-${name}@sha256:${"a".repeat(64)}`;
for (const mode of ["success", "child-failure", "no-retain", "unpinned", "no-backup", "stale-backup", "unconfirmed", "no-secret-get", "no-secret-patch", "no-namespace-get",
  "busy", "bad-selector", "wrong-namespace", "plaintext-runner", "scale-conflict", "lost-stop-ack", "old-writer-remains", "terminating-writer", "false-deletion-ack", "drain-scale-conflict", "drain-identity-conflict", "database-drift", "late-writer", "registry-patch-failure", "migration-incomplete", "disabled-guard",
  "runner-patch-failure", "orchestrator-patch-failure", "lost-resume-ack", "managed-edit", "external-scale", "late-busy", "late-unconfirmed"]) {
  test(`prepared deployment wrapper: ${mode}`, t => {
    const directory = mkdtempSync(join(tmpdir(), "prepared-wrapper-test-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "bin")); mkdirSync(join(directory, "dist/live"), { recursive: true });
    const f = fixture(); if (mode === "unconfirmed") f.registry.workloads.unconfirmed = 1;
    const { file: backup } = writeBackup(join(directory, "backup"), f);
    if (mode === "stale-backup") f.registry.workloads.fingerprint = "d".repeat(32);
    const deployments = Object.fromEntries(names.map((name, n) => [name, { metadata: { uid: id(10+n), resourceVersion: "1" },
      spec: { replicas: 1, selector: { matchLabels: { app: name }, ...(mode === "bad-selector" && name === "agents-orchestrator" ? { matchExpressions: [{}] } : {}) },
        template: { spec: { serviceAccountName: name, containers: [{ name, image: `stock-${name}:1`, env: [
          { name: "PRIVATE_FIXTURE", value: "PRIVATE_DEPLOYMENT" }, { name: "UNMANAGED", value: "original" },
          ...(name === "k8s-runner" ? [{ name: "KUBE_NAMESPACE", value: mode === "wrong-namespace" ? "other" : "agyn-workloads" }, { name: "ZITI_ENABLED", value: mode === "plaintext-runner" ? "false" : "true" }] : []),
          ...(name === "agents-orchestrator" ? [{ name: "AGYND_CLI_INIT_IMAGE", value: "stock-init:1" }, { name: "STOP_TIMEOUT_SEC", value: "30" }] : [])] }] } } } }]));
    const stateFile = join(directory, "state.json");
    writeFileSync(stateFile, JSON.stringify({ deployments, db: f, operations: [], childRan: false, stopped: false, busy: mode === "busy" }));
    writeFileSync(join(directory, "bin/kubectl"), `#!${process.execPath}
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2),mode=process.env.FAKE_MODE;
const file=process.env.FAKE_STATE,s=JSON.parse(fs.readFileSync(file,'utf8')),save=()=>fs.writeFileSync(file,JSON.stringify(s));
const fail=()=>{save();process.exit(2)},d=s.deployments['agents-orchestrator'];
if(args.includes('auth')) {
 assert(args.includes('--as=system:serviceaccount:agyn-platform:k8s-runner'));
 const denied=mode==='no-secret-get'&&args.includes('get')&&args.includes('secrets')||mode==='no-secret-patch'&&args.includes('patch')||mode==='no-namespace-get'&&args.includes('namespace/agyn-workloads');
 console.log(denied?'no':'yes');
} else if(args.includes('exec')) {
 const sql=fs.readFileSync(0,'utf8');assert(sql.includes('REPEATABLE READ READ ONLY'));assert(args.includes('ON_ERROR_STOP=1'));
 console.log(JSON.stringify(s.db.registry)+'\\n'+JSON.stringify(s.db.pins));
} else if(args.includes('get')) {
 const resource=args[args.indexOf('get')+1];
 if(resource==='deployment')console.log(JSON.stringify(s.deployments[args[args.indexOf('deployment')+1]]));
 else if(resource==='namespace')console.log(JSON.stringify({metadata:{name:'agyn-workloads',uid:${JSON.stringify(scope.namespaceUid)}}}));
 else if(resource==='pod')console.log(JSON.stringify({metadata:{name:${JSON.stringify(scope.postgresPod)},namespace:'agyn-platform',uid:${JSON.stringify(scope.postgresPodUid)}},status:{phase:'Running',containerStatuses:[{name:'postgres',ready:true,containerID:'containerd://postgres',restartCount:0}]}}));
 else if(resource==='pods')console.log(JSON.stringify({items:args.includes('agyn-platform')?(['old-writer-remains','terminating-writer','false-deletion-ack','drain-scale-conflict','drain-identity-conflict'].includes(mode)&&!s.writerDeleted?[{metadata:{name:'old-writer'}}]:[]):s.busy?[{metadata:{name:'unreleased'}}]:[]}));
 else throw Error('unexpected get');
} else if(args.includes('wait')) {
 assert(args.includes('--for=delete')&&args.includes('pod')&&args.includes('agyn-platform')&&args.includes('--timeout=80s'));
 assert.equal(args[args.indexOf('-l')+1],'app=agents-orchestrator');assert.equal(d.spec.replicas,0);
 s.waitedForWriter=true;if(mode==='old-writer-remains')fail();
 if(mode!=='false-deletion-ack')s.writerDeleted=true;
 if(mode==='drain-scale-conflict')d.spec.replicas=1;
 if(mode==='drain-identity-conflict')d.metadata.uid='replacement-orchestrator';
 save();
} else if(args.includes('scale')) {
 const from=Number(args.find(a=>a.startsWith('--current-replicas=')).split('=')[1]),to=Number(args.find(a=>a.startsWith('--replicas=')).split('=')[1]);
 assert(args.includes('--resource-version='+d.metadata.resourceVersion));assert.equal(d.spec.replicas,from);
 if(mode==='scale-conflict'){d.spec.replicas=2;fail();}
 if(to===1)for(const [name,dep] of Object.entries(s.deployments))assert.equal(dep.spec.template.spec.containers[0].image,'reviewed-'+name+'@sha256:'+'a'.repeat(64));
 d.spec.replicas=to;d.metadata.resourceVersion=String(Number(d.metadata.resourceVersion)+1);s.operations.push({op:'scale',to});s.stopped=to===0;
 if(mode==='database-drift'&&to===0)s.db.registry.workloads.fingerprint='d'.repeat(32);
 save();if(mode==='lost-stop-ack'&&to===0||mode==='lost-resume-ack'&&to===1)fail();
} else if(args.includes('patch')) {
 assert.equal(d.spec.replicas,0,'old writer was not stopped before upgrading');
 const name=args[args.indexOf('deployment')+1],target=s.deployments[name];
 if(mode==='registry-patch-failure'&&name==='runners'||mode==='runner-patch-failure'&&name==='k8s-runner'||mode==='orchestrator-patch-failure'&&name==='agents-orchestrator')fail();
 const path=args.find(a=>a.startsWith('--patch-file=')).slice('--patch-file='.length),patch=JSON.parse(fs.readFileSync(path,'utf8'));
 assert.equal(patch[0].value,target.metadata.resourceVersion);assert.equal(patch[0].path,'/metadata/resourceVersion');
 assert.equal(fs.statSync(path).mode&0o077,0);assert.equal(patch[1].value,'reviewed-'+name+'@sha256:'+'a'.repeat(64),'old image restored');
 target.spec.template.spec.containers[0].image=patch[1].value;if(patch[2])target.spec.template.spec.containers[0].env=patch[2].value;
 target.metadata.resourceVersion=String(Number(target.metadata.resourceVersion)+1);s.operations.push({op:'patch',name});
 if(name==='runners'&&mode!=='migration-incomplete'){s.db=${JSON.stringify(fixture(true))};if(mode==='disabled-guard')s.db.registry.triggers[0].enabled='D';}
 save();
} else if(args.includes('rollout')) {
 if(mode==='late-writer'&&args.includes('deployment/runners')){d.spec.replicas=1;save();}
} else throw Error('unexpected operation');
`, { mode: 0o700 });
    writeFileSync(join(directory, "dist/live/agyn-reporting.js"), `const fs=require('node:fs'),assert=require('node:assert/strict'),file=process.env.FAKE_STATE,s=JSON.parse(fs.readFileSync(file,'utf8')),mode=process.env.FAKE_MODE;
assert.equal(process.env.AGYN_LIVE_PREPARED_WORKLOADS,'true');assert.equal(s.deployments['agents-orchestrator'].spec.replicas,1);s.childRan=true;
s.db.registry.volumes.checked=1;s.db.registry.workloads.prepared=1;s.db.pins.prepared=1;
if(mode==='managed-edit')s.deployments.gateway.spec.template.spec.containers[0].image='external:1';
if(mode==='external-scale')s.deployments.gateway.spec.replicas=2;
if(mode==='late-busy')s.busy=true;if(mode==='late-unconfirmed')s.db.registry.workloads.unconfirmed=1;
fs.writeFileSync(file,JSON.stringify(s));process.exit(mode==='child-failure'?1:0);
`);
    const result = spawnSync(process.execPath, [wrapper, "completed"], { cwd: directory, encoding: "utf8", timeout: 20_000, env: {
      ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, FAKE_STATE: stateFile, FAKE_MODE: mode,
      AGYN_LIVE_ACCEPTANCE: "trusted-local", AGYN_KUBECONFIG: "/fixture/kubeconfig", AGYN_LIVE_COMPUTE_RESOURCES: "true",
      AGYN_LIVE_PREPARED_WORKLOADS: "true", AGYN_LIVE_PREPARED_RETAIN: mode === "no-retain" ? "" : "true", AGYN_LIVE_PREPARED_BACKUP_FILE: mode === "no-backup" ? "" : backup,
      AGYN_LIVE_RUNNERS_IMAGE: image("runners"), AGYN_LIVE_GATEWAY_IMAGE: image("gateway"), AGYN_LIVE_RUNNER_IMAGE: image("k8s-runner"), AGYN_LIVE_LLM_PROXY_IMAGE: "",
      AGYN_LIVE_ORCHESTRATOR_IMAGE: mode === "unpinned" ? "unpinned:latest" : image("agents-orchestrator"), AGYN_LIVE_INIT_IMAGE: image("init"),
      AGYN_LIVE_SUPPORTING_RESOURCES: JSON.stringify({ requestsCpu: "50m", requestsMemory: "64Mi", limitsCpu: "500m", limitsMemory: "256Mi" }), AGYN_LIVE_RUNNER_CHART: "/reviewed/chart",
      AGYN_AUDIT_POSTGRES_POD: scope.postgresPod, AGYN_AUDIT_POSTGRES_UID: scope.postgresPodUid, AGYN_AUDIT_POSTGRES_USER: scope.postgresUser,
      AGYN_AUDIT_RUNNER_ID: scope.runnerId, AGYN_AUDIT_NAMESPACE_UID: scope.namespaceUid
    } });
    assert.ifError(result.error); assert.equal(result.status === 0, ["success", "terminating-writer"].includes(mode), result.stderr);
    assert(!(result.stdout + result.stderr).includes("PRIVATE_DEPLOYMENT"));
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const preflight = ["no-retain", "unpinned", "no-backup", "stale-backup", "unconfirmed", "no-secret-get", "no-secret-patch", "no-namespace-get", "busy", "bad-selector", "wrong-namespace", "plaintext-runner"].includes(mode);
    if (preflight) assert.deepEqual(state.deployments, deployments, "failed preflight mutated deployments");
    const ran = ["success", "terminating-writer", "child-failure", "managed-edit", "external-scale", "late-busy", "late-unconfirmed"].includes(mode);
    assert.equal(state.childRan, ran);
    if (["old-writer-remains", "terminating-writer", "false-deletion-ack", "drain-scale-conflict", "drain-identity-conflict"].includes(mode)) {
      assert.equal(state.waitedForWriter, true);
      if (!ran) {
        assert.deepEqual(state.operations, [{ op: "scale", to: 0 }], "unconfirmed drain allowed an image change");
        assert.deepEqual(state.db, f, "unconfirmed drain allowed registry migration");
      }
    }
    if (ran) {
      assert.deepEqual(state.operations, [{ op: "scale", to: 0 }, ...names.map(name => ({ op: "patch", name })), { op: "scale", to: 1 }]);
      for (const name of names) assert.equal(state.deployments[name].spec.template.spec.containers[0].image, mode === "managed-edit" && name === "gateway" ? "external:1" : image(name));
    } else if (!preflight && !["scale-conflict", "drain-scale-conflict", "late-writer", "lost-resume-ack"].includes(mode)) {
      assert.equal(state.deployments["agents-orchestrator"].spec.replicas, 0, "old writer restarted after uncertain/partial upgrade");
    }
    if (!preflight) {
      const evidence = readdirSync(join(directory, ".state"))[0], report = JSON.parse(readFileSync(join(directory, ".state", evidence, "prepared-retained.json"), "utf8"));
      assert.equal(report.automaticRollback, false); assert.equal(report.deploymentsRestored, false);
      assert(!JSON.stringify(report).includes("PRIVATE_DEPLOYMENT"));
      if (ran) assert.equal(report.database.legacyRollbackForbidden, true);
    }
  });
}
