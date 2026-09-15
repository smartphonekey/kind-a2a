// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsePreparedUpgradeState, verifyPreparedBackup } from "./live/prepared-upgrade.js";
import { fixture, migrations, output, scope } from "./test/prepared-upgrade-fixture.js";
import { anchoredFixture, anchoredOutput } from "./test/anchored-upgrade-fixture.js";
import { anchoredMigrations, parseAnchoredUpgradeState, verifyAnchoredBackup } from "./live/anchored-upgrade.js";

const script = fileURLToPath(new URL("../scripts/agyn-prepared-backup.mjs", import.meta.url));
for (const contract of ["prepared", "anchored"]) for (const mode of ["success", "no-opt-in", "unpinned", "bad-archive", "source-drift", "lost-create-ack", "restore-error", "restored-mismatch",
  "migration-error", "history-changed", "late-source-drift", "cleanup-wrong-identity", "cleanup-error", "cleanup-source-drift",
  ...(contract === "anchored" ? ["pending-history", "unknown-contract", "future-schema", "function-body-drift", "restore-recovery-lost", "migration-recovery-changed", "disabled-anchor-guard"] : [])]) {
  test(`${contract} offline backup: ${mode}`, t => {
    const directory = mkdtempSync(join(tmpdir(), "prepared-backup-cli-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
    const root = join(directory, "output"), bin = join(directory, "bin"), migrationRoot = join(directory, "migrations"), stateFile = join(directory, "state.json");
    for (const path of [root, bin, migrationRoot]) mkdirSync(path, { mode: 0o700 });
    const anchored = contract === "anchored", withHistory = ["pending-history", "function-body-drift", "restore-recovery-lost"].includes(mode);
    const source = anchored ? anchoredFixture(withHistory, withHistory) : fixture();
    if (mode === "future-schema") source.registry.migrations.push("0027_future.sql");
    const upgraded = anchored ? anchoredFixture(true) : fixture(true);
    const versions = (anchored ? anchoredMigrations : migrations.slice(1)).filter(v => !source.registry.migrations.includes(v));
    for (const version of versions) writeFileSync(join(migrationRoot, version), `-- PRIVATE_MIGRATION_FIXTURE ${version}\n`);
    writeFileSync(stateFile, JSON.stringify({ source, restored: source, sourceReads: 0, container: false, created: false, removed: false, applied: 0 }));
    writeFileSync(join(bin, "kubectl"), `#!${process.execPath}
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2),file=process.env.FAKE_STATE,mode=process.env.FAKE_MODE,s=JSON.parse(fs.readFileSync(file,'utf8'));
if(args.includes('get')) {
 assert(!args.includes('secrets'));
 if(args.includes('namespace'))console.log(JSON.stringify({metadata:{name:'agyn-workloads',uid:${JSON.stringify(scope.namespaceUid)}}}));
 else console.log(JSON.stringify({metadata:{name:${JSON.stringify(scope.postgresPod)},namespace:'agyn-platform',uid:${JSON.stringify(scope.postgresPodUid)}},status:{phase:'Running',containerStatuses:[{name:'postgres',ready:true,containerID:'containerd://postgres',restartCount:0}]}}));
} else if(args.includes('exec')) {
 if(args.includes('pg_dump')) {
  assert(args.includes('--format=custom')&&args.includes('--no-owner')&&args.includes('--no-privileges'));
  assert(args.includes('PGOPTIONS=-c default_transaction_read_only=on -c lock_timeout=2000'));
  process.stdout.write(mode==='bad-archive'?'PRIVATE_INVALID_ARCHIVE':'PGDMP PRIVATE_ARCHIVE_DATA');
 } else {
  const sql=fs.readFileSync(0,'utf8');assert(sql.includes('REPEATABLE READ READ ONLY'));assert(args.includes('ON_ERROR_STOP=1'));
  s.sourceReads++;if(mode==='source-drift'&&s.sourceReads===2||mode==='late-source-drift'&&s.sourceReads===3)s.source.registry.workloads.fingerprint='d'.repeat(32);
  if(mode==='function-body-drift'&&s.sourceReads===2)s.source.recovery.functions[0].fingerprint='9'.repeat(64);
  fs.writeFileSync(file,JSON.stringify(s));console.log([s.source.registry,s.source.pins,s.source.recovery].filter(Boolean).map(x=>JSON.stringify(x)).join('\\n'));
 }
} else throw Error('installed Kubernetes mutation attempted');
`, { mode: 0o700 });
    writeFileSync(join(bin, "docker"), `#!${process.execPath}
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2),file=process.env.FAKE_STATE,mode=process.env.FAKE_MODE,s=JSON.parse(fs.readFileSync(file,'utf8'));
const save=()=>fs.writeFileSync(file,JSON.stringify(s)),fail=()=>{console.error('PRIVATE_SUBPROCESS_ERROR');save();process.exit(2)},cid='e'.repeat(64);
switch(args[0]) {
 case 'create':
  assert(args.includes('--pull=never'));assert.equal(args[args.indexOf('--network')+1],'none');assert.equal(args[args.indexOf('--memory')+1],'512m');
  assert(args.includes('--pids-limit')&&!args.includes('--privileged')&&!args.includes('-p'));s.name=args[args.indexOf('--name')+1];s.label=args[args.indexOf('--label')+1];s.image=args.at(-1);s.container=true;s.created=true;save();
  if(mode==='lost-create-ack')fail();console.log(cid);break;
 case 'start': assert.equal(args[1],cid);break;
 case 'exec': {
  assert(args.includes(cid));
  if(args.includes('pg_isready')){assert(args.includes('-h')&&args.includes('127.0.0.1'),'bootstrap Unix socket must not pass readiness');break;}
  const input=fs.readFileSync(0,'utf8');
  if(args.includes('pg_restore')) {
   assert.equal(input,'PGDMP PRIVATE_ARCHIVE_DATA');assert(args.includes('--exit-on-error')&&args.includes('--single-transaction'));
   if(mode==='restore-error')fail();
   if(mode==='restored-mismatch')s.restored.registry.workloads.fingerprint='d'.repeat(32);
   if(mode==='restore-recovery-lost')s.restored.recovery.workloads.fingerprint='9'.repeat(64);save();break;
  }
  assert(args.includes('psql')&&args.includes('ON_ERROR_STOP=1'));
  if(input.includes('REPEATABLE READ READ ONLY'))console.log([s.restored.registry,s.restored.pins,s.restored.recovery].filter(Boolean).map(x=>JSON.stringify(x)).join('\\n'));
  else {
   assert(input.startsWith('BEGIN;')&&input.includes('INSERT INTO schema_migrations')&&input.endsWith('COMMIT;\\n'));
   if(mode==='migration-error')fail();s.applied++;
   if(s.applied===${versions.length}){s.restored=${JSON.stringify(upgraded)};if(mode==='history-changed')s.restored.registry.volumes.fingerprint='d'.repeat(32);
    if(mode==='migration-recovery-changed')s.restored.recovery.volumes.fingerprint='9'.repeat(64);
    if(mode==='disabled-anchor-guard')s.restored.registry.triggers.find(t=>t.name==='workloads_resource_anchors').enabled='D';}
   save();
  }
  break;
 }
 case 'ps':
  if(args.some(a=>a.startsWith('name='))){assert(args.includes('name=^/'+s.name+'$'));assert(args.includes('label='+s.label));}
  else assert(args.includes('id='+cid));
  if(s.container)console.log(cid);break;
 case 'inspect':
  assert.equal(args[1],cid);assert(args.includes('--format'));
  console.log(JSON.stringify({id:cid,name:'/'+s.name,image:s.image,run:mode==='cleanup-wrong-identity'?'different-run':s.label.split('=')[1]}));break;
 case 'rm':
  assert(args.includes('--force')&&args.includes('--volumes'));assert.equal(args.at(-1),cid);
  if(mode==='cleanup-error')fail();s.container=false;s.removed=true;
  if(mode==='cleanup-source-drift')s.source.registry.workloads.fingerprint='d'.repeat(32);save();break;
 default: throw Error('unexpected docker operation');
}
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8", timeout: 20_000, env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: stateFile, FAKE_MODE: mode,
      AGYN_LIVE_ACCEPTANCE: mode === "no-opt-in" ? "" : "trusted-local", AGYN_KUBECONFIG: "/fixture/kubeconfig", AGYN_AUDIT_OUTPUT_DIR: root,
      AGYN_PREPARED_REGISTRY_MIGRATIONS: migrationRoot, AGYN_PREPARED_POSTGRES_IMAGE: mode === "unpinned" ? "postgres:latest" : `postgres@sha256:${"a".repeat(64)}`,
      AGYN_PREPARED_BACKUP_CONTRACT: mode === "unknown-contract" ? "anything" : anchored ? "resource-anchors-through-0026" : "prepared-through-0022",
      AGYN_AUDIT_POSTGRES_POD: scope.postgresPod, AGYN_AUDIT_POSTGRES_UID: scope.postgresPodUid, AGYN_AUDIT_POSTGRES_USER: scope.postgresUser,
      AGYN_AUDIT_RUNNER_ID: scope.runnerId, AGYN_AUDIT_NAMESPACE_UID: scope.namespaceUid
    } });
    const success = ["success", "pending-history"].includes(mode);
    assert.ifError(result.error); assert.equal(result.status === 0, success, result.stderr);
    assert(!(result.stdout + result.stderr).includes("PRIVATE_"), "raw subprocess or archive data reached output");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (["no-opt-in", "unpinned", "bad-archive", "source-drift", "unknown-contract", "future-schema", "function-body-drift"].includes(mode)) assert.equal(state.created, false);
    else if (["cleanup-wrong-identity", "cleanup-error"].includes(mode)) { assert.equal(state.removed, false); assert.equal(state.container, true); }
    else { assert.equal(state.removed, true, "owned offline database not cleaned up"); assert.equal(state.container, false); }
    for (const subdirectory of readdirSync(root)) {
      const evidence = join(root, subdirectory), receipt = join(evidence, "receipt.json");
      assert.equal(existsSync(receipt), success, "failed rehearsal issued an upgrade receipt");
      for (const file of readdirSync(evidence)) assert.equal(lstatSync(join(evidence, file)).mode & 0o077, 0, "private evidence file permissions");
      if (success) {
        if (anchored) verifyAnchoredBackup(receipt, parseAnchoredUpgradeState(anchoredOutput(source as ReturnType<typeof anchoredFixture>), scope));
        else verifyPreparedBackup(receipt, parsePreparedUpgradeState(output(source), scope));
        assert.equal(JSON.parse(readFileSync(receipt, "utf8")).rehearsal.migrations.length, versions.length);
        assert.equal(state.applied, versions.length);
      }
    }
  });
}
