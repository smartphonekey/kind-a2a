// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditCheckedVolumes, checkedVolumeAuditSQL, collectCheckedVolumeAudit, type CheckedVolumeCapture } from "./live/checked-volume-audit.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const at = "2026-09-14T12:00:00Z";
const scope = { postgresPod: "platform-postgres-0", postgresPodUid: id(20), postgresUser: "agyn", runnerId: id(3), namespaceUid: id(21) };
function fixture(checked = false): CheckedVolumeCapture {
  const labels = { "app.kubernetes.io/managed-by": "k8s-runner", "agyn.dev/managed-by": "agents-orchestrator", "managed-by": "agents-orchestrator",
    volume_key: id(1), "agent-instance-id": id(2), "agent-id": id(5) };
  const bound = { instanceId: "pvc-one", instanceUid: id(10), volumeKey: id(1), identityLabels: structuredClone(labels) };
  const owner = { ownerKind: "agent_instance", ownerId: id(2), runnerId: id(3), organizationId: id(4), agentId: id(5), threadId: id(6) };
  return { scope, inventoryStable: true, registry: { database: "runners", readOnly: "on", isolation: "repeatable read", at,
    migrations: ["0017_workload_removal_confirmation.sql", ...(checked ? ["0018_checked_volume_lifecycle.sql", "0019_volume_workload_admission.sql"] : [])],
    counts: { volumes: 1, workloads: 1, runners: 1 }, runners: [{ id: id(3), organizationId: null, status: "enrolled" }],
    volumes: [{ ...owner, id: id(1), definitionId: id(7), instanceId: "pvc-one", sizeGb: "1", status: "active", removedAt: null,
      checkedLifecycle: checked ? true : null, revision: checked ? 2 : null, bound: checked ? bound : null, intent: null }],
    workloads: [{ ...owner, id: id(8), instanceId: "old-pod", status: "stopped", removedAt: at, removalConfirmedAt: at }],
    triggers: checked ? [{ table: "volumes", name: "volumes_checked_lifecycle", enabled: "O" },
      { table: "volumes", name: "volumes_workload_admission", enabled: "O" }, { table: "workloads", name: "workloads_volume_admission", enabled: "O" }] : [] },
    claims: [{ name: "pvc-one", uid: id(10), resourceVersion: "10", labels, deleting: false, owners: 0 }], pods: [],
    deployments: ["agents-orchestrator", "gateway", "k8s-runner", "runners"].map((name, n) => ({ name, uid: id(30+n), generation: 1,
      images: [{ name, image: `reviewed-${name}@sha256:${"a".repeat(64)}` }], ready: true })) };
}
const codes = (f: CheckedVolumeCapture) => auditCheckedVolumes(f).findings.map(item => item.code);
const db = (f: CheckedVolumeCapture): any => f.registry;

test("volume upgrade audit reports legacy observations without granting lifecycle authority", () => {
  const f = fixture(), before = structuredClone(f), result = auditCheckedVolumes(f);
  assert.deepEqual(f, before);
  assert.deepEqual(result.volumes[0].physical, [{ name: "pvc-one", uid: id(10) }]);
  assert.equal(result.summary.legacyVolumes, 1); assert.equal(result.summary.unconfirmedWorkloads, 0);
  assert.deepEqual(codes(f), ["missing-checked-volume-migration", "missing-admission-migration", "legacy-volume-requires-explicit-adoption"]);
  for (const flag of [result.permitsAdoption, result.permitsDeletion, result.permitsRollout]) assert.equal(flag, false);
});

test("volume upgrade audit never promotes a clean observation into a rollout permit", () => {
  const result = auditCheckedVolumes(fixture(true));
  assert.deepEqual(result.findings, []); assert.equal(result.observationalOnly, true); assert.equal(result.permitsRollout, false);
  assert(result.remainingRequirements.includes("fence-and-drain-all-writers"));
});

const findings: [string, (f: CheckedVolumeCapture) => void, string][] = [
  ["unknown claim", f => { f.claims.push({ ...f.claims[0], name: "unknown", uid: id(11), labels: { volume_key: id(90) } }); }, "unregistered-claim-retain"],
  ["missing claim key", f => { delete f.claims[0].labels.volume_key; }, "claim-missing-volume-key"],
  ["duplicate physical key", f => { f.claims.push({ ...f.claims[0], name: "duplicate", uid: id(11) }); }, "ambiguous-physical-volume-key"],
  ["physical name mismatch", f => { f.claims[0].name = "other-name"; }, "registry-physical-name-conflict"],
  ["wrong physical owner", f => { f.claims[0].labels["agent-instance-id"] = id(99); }, "physical-owner-mismatch"],
  ["wrong physical manager", f => { f.claims[0].labels["managed-by"] = "other"; }, "physical-manager-mismatch"],
  ["deleting claim", f => { f.claims[0].deleting = true; }, "claim-terminating-or-controller-owned"],
  ["controller-owned claim", f => { f.claims[0].owners = 1; }, "claim-terminating-or-controller-owned"],
  ["missing active claim", f => { f.claims = []; }, "no-physical-match-retain-record"],
  ["closed claim", f => { db(f).volumes[0].status = "failed"; }, "closed-record-with-physical-volume"],
  ["wrong route", f => { db(f).volumes[0].runnerId = id(98); }, "volume-outside-selected-backend"],
  ["unenrolled runner", f => { db(f).runners[0].status = "pending"; }, "selected-runner-not-enrolled"],
  ["missing owner agent", f => { db(f).volumes[0].agentId = null; }, "invalid-owner-shape"],
  ["unconfirmed billing-ended failure", f => { db(f).workloads[0].status = "failed"; db(f).workloads[0].removalConfirmedAt = null; }, "unconfirmed-workload-retain"],
  ["confirmation on live workload", f => { db(f).workloads[0].status = "running"; }, "nonterminal-removal-confirmation"],
  ["unconfirmed without volume", f => { db(f).workloads[0].ownerId = id(99); db(f).workloads[0].removalConfirmedAt = null; }, "unconfirmed-workload-retain"],
  ["two unconfirmed predecessors", f => { db(f).workloads[0].removalConfirmedAt = null; db(f).workloads.push({ ...db(f).workloads[0], id: id(9) }); db(f).counts.workloads++; }, "multiple-unconfirmed-predecessors"],
  ["workload owner contradiction", f => { db(f).workloads[0].removalConfirmedAt = null; db(f).workloads[0].organizationId = id(99); }, "workload-volume-owner-conflict"],
  ["owner volume contradiction", f => { db(f).volumes.push({ ...db(f).volumes[0], id: id(91), organizationId: id(99) }); db(f).counts.volumes++; }, "volume-owner-identity-conflict"],
  ["deleting owner has workload", f => { db(f).workloads[0].removalConfirmedAt = null; db(f).volumes[0].status = "deprovisioning"; }, "deletion-with-unconfirmed-workload"],
  ["moving inventory", f => { f.inventoryStable = false; }, "inventory-changed-during-capture"],
  ["live native Pod", f => { f.pods = [{ name: "busy", uid: id(80), resourceVersion: "1", deleting: false }]; }, "native-workloads-present"],
  ["incomplete client rollout", f => { f.deployments[0].ready = false; }, "client-rollout-incomplete"],
  ["disabled database guard", f => { db(f).triggers[0].enabled = "D"; }, "missing-or-disabled-database-guard"],
  ["missing checked metadata", f => { db(f).volumes[0].revision = null; }, "inconsistent-checked-metadata"],
  ["replacement physical UID", f => { f.claims[0].uid = id(99); }, "bound-incarnation-mismatch-retain"],
  ["missing active binding", f => { db(f).volumes[0].bound = null; }, "missing-required-binding"],
  ["retargeted binding", f => { db(f).volumes[0].bound.volumeKey = id(99); }, "invalid-persisted-binding"],
  ["unapproved binding label", f => { db(f).volumes[0].bound.identityLabels["workload_key"] = id(8); }, "invalid-persisted-binding"],
  ["missing deletion intent", f => { db(f).volumes[0].status = "deprovisioning"; }, "invalid-persisted-removal-intent"],
  ["unconfirmed deletion", f => { const v = db(f).volumes[0]; v.status = "deleted"; v.intent = { id: id(90), requestedAt: at, expected: v.bound }; }, "invalid-persisted-removal-intent"],
  ["wrong intent target", f => { const v = db(f).volumes[0]; v.status = "deprovisioning"; v.intent = { id: id(90), requestedAt: at, expected: { ...v.bound, instanceUid: id(99) } }; }, "invalid-persisted-removal-intent"]
];
for (const [name, mutate, code] of findings) test(`volume upgrade audit: ${name}`, () => {
  const f = fixture(true); mutate(f); assert(codes(f).includes(code), `missing ${code}`);
});

for (const [name, mutate] of [
  ["count mismatch", (f: CheckedVolumeCapture) => { db(f).counts.volumes++; }],
  ["duplicate volume ID", (f: CheckedVolumeCapture) => { db(f).volumes.push(db(f).volumes[0]); db(f).counts.volumes++; }],
  ["duplicate workload ID", (f: CheckedVolumeCapture) => { db(f).workloads.push(db(f).workloads[0]); db(f).counts.workloads++; }],
  ["duplicate claim UID", (f: CheckedVolumeCapture) => { f.claims.push({ ...f.claims[0], name: "other" }); }],
  ["missing confirmation field", (f: CheckedVolumeCapture) => { delete db(f).workloads[0].removalConfirmedAt; }],
  ["read write database", (f: CheckedVolumeCapture) => { db(f).readOnly = "off"; }],
  ["wrong database", (f: CheckedVolumeCapture) => { db(f).database = "agents"; }],
  ["weak isolation", (f: CheckedVolumeCapture) => { db(f).isolation = "read committed"; }]
] as const) test(`volume upgrade audit rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => auditCheckedVolumes(f)); });

test("volume upgrade audit distinguishes confirmed deletion from missing active storage", () => {
  const f = fixture(true), v = db(f).volumes[0];
  v.status = "deleted"; v.intent = { id: id(90), requestedAt: at, confirmedAt: at, expected: v.bound }; f.claims = [];
  assert.deepEqual(codes(f), []); assert.equal(auditCheckedVolumes(f).permitsDeletion, false);
});

test("volume upgrade audit requires independent sandbox-user verification", () => {
  const f = fixture(), v = db(f).volumes[0];
  v.ownerKind = "sandbox"; v.agentId = null; v.threadId = null; db(f).workloads = []; db(f).counts.workloads = 0;
  delete f.claims[0].labels["agent-id"]; delete f.claims[0].labels["agent-instance-id"];
  f.claims[0].labels["sandbox-id"] = id(2); f.claims[0].labels["sandbox-owner-id"] = id(90);
  assert(codes(f).includes("sandbox-user-ownership-needs-agents-service"));
  assert(!codes(f).includes("physical-owner-mismatch"));
});

function collectorFixture(mode = "stable") {
  const f = fixture(), calls: string[][] = []; let queried = false;
  const meta = (name: string, uid: string, namespace?: string) => ({ name, uid, namespace, resourceVersion: "1" });
  const list = (items: unknown[]) => ({ apiVersion: "v1", kind: "List", metadata: { resourceVersion: "100" }, items });
  const read = (args: string[], input?: string) => {
    calls.push(args);
    if (args[0] === "exec") {
      assert.deepEqual(input, checkedVolumeAuditSQL); assert(args.includes("-i") && args.includes("-X") && args.includes("ON_ERROR_STOP=1"));
      assert(args.includes("PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000"));
      queried = true; if (mode === "database-failure") throw new Error("PRIVATE_DATABASE_OUTPUT");
      return JSON.stringify(f.registry);
    }
    assert.equal(args[0], "get", "audit attempted a non-read Kubernetes operation"); assert.equal(input, undefined);
    if (args[1] === "namespace") return JSON.stringify({ metadata: meta("agyn-workloads", queried && mode === "namespace-replaced" ? id(99) : scope.namespaceUid) });
    if (args[1] === "pod") return JSON.stringify({ metadata: meta(scope.postgresPod, scope.postgresPodUid, "agyn-platform"),
      spec: { containers: [{ env: [{ name: "PASSWORD", value: "PRIVATE_POD_VALUE" }] }] },
      status: { phase: "Running", containerStatuses: [{ name: "postgres", ready: true,
        containerID: queried && mode === "database-container-replaced" ? "containerd://different" : "containerd://postgres", restartCount: queried && mode === "database-restarted" ? 1 : 0 }] } });
    if (args[1] === "pvc") {
      const response: any = list(f.claims.map(c => ({ kind: "PersistentVolumeClaim", metadata: { ...meta(c.name, queried && mode === "claim-replaced" ? id(99) : c.uid, "agyn-workloads"),
        labels: { ...c.labels, "private-annotation": "PRIVATE_LABEL_VALUE" } } })));
      if (mode === "partial") response.metadata.continue = "next";
      if (mode === "remaining") response.metadata.remainingItemCount = 1;
      if (mode === "malformed-page-token") response.metadata.continue = false;
      if (mode === "cross-namespace") response.items[0].metadata.namespace = "other";
      if (mode === "malformed") response.items = null;
      return JSON.stringify(response);
    }
    if (args[1] === "pods") return JSON.stringify(list([]));
    if (args[1] === "deployments") return JSON.stringify(list(f.deployments.filter(d => mode !== "missing-client" || d.name !== "runners").map(d => ({ kind: "Deployment",
      metadata: { ...meta(d.name, d.uid, "agyn-platform"), generation: d.generation },
      spec: { replicas: 1, template: { spec: { containers: d.images.map(image => ({ ...image, env: [{ name: "PRIVATE", value: "PRIVATE_DEPLOYMENT_VALUE" }] })) } } },
      status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } }))));
    throw new Error("unexpected fixture query");
  };
  return { calls, read };
}

test("volume upgrade collector uses a read-only MVCC query and projects only audit metadata", () => {
  const fake = collectorFixture(), result = collectCheckedVolumeAudit(fake.read, scope);
  assert.equal(result.inventoryStable, true); assert.equal(result.summary.legacyVolumes, 1);
  assert.equal(fake.calls.filter(call => call[0] === "exec").length, 1);
  assert(!JSON.stringify(result).includes("PRIVATE_"));
  assert.match(checkedVolumeAuditSQL, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(checkedVolumeAuditSQL, /ROLLBACK;/); assert(!/service_token_hash|'containers'|failure_message/.test(checkedVolumeAuditSQL));
});

test("volume upgrade collector reports replacement during its observation window", () => {
  const result = collectCheckedVolumeAudit(collectorFixture("claim-replaced").read, scope);
  assert.equal(result.inventoryStable, false); assert(result.findings.some(f => f.code === "inventory-changed-during-capture"));
});
for (const mode of ["partial", "remaining", "malformed-page-token", "cross-namespace", "malformed", "missing-client", "namespace-replaced", "database-restarted", "database-container-replaced", "database-failure"]) {
  test(`volume upgrade collector refuses ${mode}`, () => {
    assert.throws(() => collectCheckedVolumeAudit(collectorFixture(mode).read, scope), error => error instanceof Error && !error.message.includes("PRIVATE_"));
  });
}
test("volume upgrade collector rejects unpinned scope before any external call", () => {
  const fake = collectorFixture(); assert.throws(() => collectCheckedVolumeAudit(fake.read, { ...scope, runnerId: "" })); assert.equal(fake.calls.length, 0);
});

test("volume upgrade lifecycle fingerprint excludes observation time but detects lifecycle changes", () => {
  const f = fixture(), first = auditCheckedVolumes(f).registryFingerprint;
  db(f).at = "2026-09-14T12:01:00Z"; assert.equal(auditCheckedVolumes(f).registryFingerprint, first);
  db(f).volumes[0].status = "failed"; assert.notEqual(auditCheckedVolumes(f).registryFingerprint, first);
});

const cli = fileURLToPath(new URL("../scripts/agyn-checked-volume-audit.mjs", import.meta.url));
for (const mode of ["clean", "findings", "read-failure", "public-directory", "symlink-directory", "no-opt-in"]) test(`volume upgrade CLI: ${mode}`, t => {
  const directory = mkdtempSync(join(tmpdir(), "volume-audit-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin"), output = join(directory, "output"), calls = join(directory, "calls");
  mkdirSync(bin, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  let selectedOutput = output;
  if (mode === "public-directory") chmodSync(output, 0o755);
  if (mode === "symlink-directory") { selectedOutput = join(directory, "linked"); symlinkSync(output, selectedOutput); }
  const fake = collectorFixture(), responses: Record<string, unknown> = {};
  for (const kind of ["namespace", "pod", "pvc", "pods", "deployments"]) responses[kind] = JSON.parse(fake.read(["get", kind]));
  responses.exec = fixture(mode === "clean").registry;
  writeFileSync(join(bin, "kubectl"), `#!${process.execPath}
const fs=require('node:fs'),responses=${JSON.stringify(responses)},args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(${JSON.stringify(mode)}==='read-failure'){console.error('PRIVATE_TOOL_ERROR');process.exit(1);}
if(args[3]==='exec') {
 const sql=fs.readFileSync(0,'utf8');if(!sql.includes('REPEATABLE READ READ ONLY')||!args.includes('ON_ERROR_STOP=1'))process.exit(3);
 console.log(JSON.stringify(responses.exec));
} else if(args[3]==='get') console.log(JSON.stringify(responses[args[4]]));
else process.exit(4);
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [cli], { cwd: directory, encoding: "utf8", timeout: 20_000, env: {
    PATH: bin, AGYN_LIVE_ACCEPTANCE: mode === "no-opt-in" ? "" : "trusted-local", AGYN_KUBECONFIG: "/fixture/kubeconfig",
    AGYN_AUDIT_OUTPUT_DIR: selectedOutput, AGYN_AUDIT_POSTGRES_POD: scope.postgresPod, AGYN_AUDIT_POSTGRES_UID: scope.postgresPodUid,
    AGYN_AUDIT_POSTGRES_USER: scope.postgresUser, AGYN_AUDIT_RUNNER_ID: scope.runnerId, AGYN_AUDIT_NAMESPACE_UID: scope.namespaceUid
  } });
  assert.ifError(result.error); assert(!`${result.stdout}${result.stderr}`.includes("PRIVATE_"));
  assert.equal(result.status, mode === "clean" ? 0 : mode === "findings" ? 2 : 1, result.stderr);
  if (mode === "clean" || mode === "findings") {
    const receipt = JSON.parse(result.stdout), path = join(receipt.directory, "audit.json"), report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(lstatSync(receipt.directory).mode & 0o077, 0); assert.equal(lstatSync(path).mode & 0o077, 0);
    assert.equal(receipt.permitsRollout, false); assert.equal(report.permitsAdoption, false); assert(!JSON.stringify(report).includes("PRIVATE_"));
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 11);
  } else {
    assert.equal(readdirSync(output).length, 0);
    if (mode !== "read-failure") assert(!readdirSync(directory).includes("calls"), "invalid configuration invoked kubectl");
  }
});
