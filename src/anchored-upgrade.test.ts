// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { anchoredMigrations, anchoredUpgradeSQL, assertAnchoredHistoryUnchanged, assertAnchoredSchema,
  collectAnchoredUpgradeState, parseAnchoredUpgradeState, verifyAnchoredBackup } from "./live/anchored-upgrade.js";
import { parsePreparedUpgradeState, verifyPreparedBackup } from "./live/prepared-upgrade.js";
import { anchoredFixture, anchoredOutput, type AnchoredFixture } from "./test/anchored-upgrade-fixture.js";
import { id, output, scope } from "./test/prepared-upgrade-fixture.js";

const parse = (f: AnchoredFixture) => parseAnchoredUpgradeState(anchoredOutput(f), scope);

test("anchored snapshots retain a distinct contract before migration and during pending recovery", () => {
  const before = parse(anchoredFixture()), after = parse(anchoredFixture(true)), pending = parse(anchoredFixture(true, true));
  assertAnchoredSchema(after); assertAnchoredSchema(pending);
  assertAnchoredHistoryUnchanged(before, after);
  assert.equal(pending.registry.workloads.unconfirmed, 1);
  assert.equal(pending.recovery.workloads.revoked, 1);
  assert.equal(pending.recovery.workloads.observed, 0);
  assert.equal(pending.legacyRollbackForbidden, true);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.throws(() => parsePreparedUpgradeState(output(anchoredFixture(true)), scope), /unreviewed future/);
  assert.throws(() => parsePreparedUpgradeState(anchoredOutput(anchoredFixture()), scope), /incomplete/);
});

for (const [name, change] of [
  ["future schema", (f: AnchoredFixture) => f.registry.migrations.push("0027_future.sql")],
  ["substituted migration", (f: AnchoredFixture) => { f.registry.migrations[6] = "0023_different.sql"; }],
  ["migration gap", (f: AnchoredFixture) => { f.registry.migrations = f.registry.migrations.filter(m => m !== anchoredMigrations[1]); }],
  ["pre-prepared source", (f: AnchoredFixture) => { f.registry.migrations = f.registry.migrations.slice(0, 1); }],
  ["invented reservation", (f: AnchoredFixture) => { f.recovery.volumes.reserved = 1; }],
  ["unproven observation", (f: AnchoredFixture) => { f.recovery.workloads.observed = 1; }],
  ["unpinned owner", (f: AnchoredFixture) => { f.recovery.pins.anchored = 1; }],
  ["overflow count", (f: AnchoredFixture) => { f.recovery.workloads.anchored = Number.MAX_SAFE_INTEGER + 1; }],
  ["duplicate column", (f: AnchoredFixture) => f.recovery.columns.push(f.recovery.columns[0])],
  ["duplicate function", (f: AnchoredFixture) => f.recovery.functions.push(f.recovery.functions[0])],
  ["wrong contract", (f: AnchoredFixture) => { f.recovery.contract = "prepared-through-0022"; }],
] as const) test(`anchored snapshot refuses ${name}`, () => {
  const f = anchoredFixture(true); change(f); assert.throws(() => parse(f));
});

test("anchored schema requires exact columns, enabled guards and definitions", () => {
  const f = anchoredFixture(true), before = parse(f);
  for (const migration of anchoredMigrations) {
    const changed = structuredClone(before); changed.registry.migrations = changed.registry.migrations.filter(m => m !== migration);
    assert.throws(() => assertAnchoredSchema(changed), /missing required migration/);
  }
  for (const entry of f.recovery.constraints) {
    const changed = structuredClone(before); changed.registry.constraints.find(c => c.name === entry.name)!.validated = false;
    assert.throws(() => assertAnchoredSchema(changed), /missing validated/);
  }
  for (const entry of f.recovery.triggers) for (const enabled of ["D", "R"]) {
    const changed = structuredClone(before); changed.registry.triggers.find(c => c.name === entry.name)!.enabled = enabled;
    assert.throws(() => assertAnchoredSchema(changed), /missing enabled/);
  }
  for (const category of ["columns", "constraints", "triggers", "functions"] as const) {
    for (const entry of before.recovery[category]) {
      const changed = structuredClone(before); changed.recovery[category].splice(changed.recovery[category].findIndex(c => c.name === entry.name), 1);
      assert.throws(() => assertAnchoredSchema(changed));
    }
  }
  for (const column of before.recovery.columns) {
    const changed = structuredClone(before); changed.recovery.columns.find(c => c.name === column.name)!.type = "text";
    assert.throws(() => assertAnchoredSchema(changed), /invalid lifecycle column/);
  }
});

test("anchored fingerprints cover recovery evidence and same-name schema body changes", () => {
  const f = anchoredFixture(true), before = parse(f);
  for (const category of ["volumes", "workloads", "pins"] as const) {
    const changed = structuredClone(f); changed.recovery[category].fingerprint = "9".repeat(64);
    const after = parse(changed); assert.notEqual(after.fingerprint, before.fingerprint);
    assert.throws(() => assertAnchoredHistoryUnchanged(before, after), /recovery evidence/);
  }
  for (const category of ["constraints", "triggers", "functions"] as const) {
    const changed = structuredClone(f); changed.recovery[category][0].fingerprint = "9".repeat(64);
    assert.notEqual(parse(changed).fingerprint, before.fingerprint);
  }
  for (const raw of [output(f), anchoredOutput(f) + "{}\n", "PRIVATE_DATABASE_ERROR"]) {
    assert.throws(() => parseAnchoredUpgradeState(raw, scope));
  }
  assert.match(anchoredUpgradeSQL, /REPEATABLE READ READ ONLY/);
  for (const field of ["resource_anchor", "anchor_reservation", "anchored_removal_observation", "resource_anchors", "resource_anchors_required"]) assert(anchoredUpgradeSQL.includes(field));
  assert.match(anchoredUpgradeSQL, /sha256\(convert_to\(pg_get_functiondef/);
  assert(!/service_token_hash|failure_message|'containers'/.test(anchoredUpgradeSQL));
});

test("anchored collector uses one transaction and rechecks the same database incarnation", () => {
  let queried = false;
  const read = (args: string[], input?: string) => {
    if (args[0] === "exec") { assert.equal(input, anchoredUpgradeSQL); queried = true; return anchoredOutput(anchoredFixture(true)); }
    assert.equal(args[0], "get");
    if (args[1] === "namespace") return JSON.stringify({ metadata: { name: "agyn-workloads", uid: scope.namespaceUid } });
    return JSON.stringify({ metadata: { name: scope.postgresPod, namespace: "agyn-platform", uid: scope.postgresPodUid },
      status: { phase: "Running", containerStatuses: [{ name: "postgres", ready: true, containerID: queried ? "containerd://replacement" : "containerd://original", restartCount: 0 }] } });
  };
  assert.throws(() => collectAnchoredUpgradeState(read, scope), /reconciliation required/);
});

for (const mode of ["valid", "legacy-receipt", "wrong-contract", "wrong-scope", "changed-source", "missing-cleanup", "missing-migration", "changed-archive",
  "changed-rehearsal", "invented-evidence", "disabled-guard", "public-rehearsal", "symlink-rehearsal"]) {
  test(`anchored verified backup: ${mode}`, t => {
    const directory = mkdtempSync(join(tmpdir(), "anchored-backup-receipt-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const root = join(directory, "backup"); mkdirSync(root, { mode: 0o700 });
    const state = parse(anchoredFixture()), fixture = anchoredFixture(true), after = parse(fixture), archive = Buffer.from("PGDMP private fixture");
    const receipt = { kind: "anchored-upgrade-restored-backup", version: 1, snapshotContract: state.recovery.contract, scope,
      installedDatabaseModified: false, cleanupConfirmed: true, sourceFingerprint: state.fingerprint, restoredFingerprint: state.fingerprint,
      archiveSha256: createHash("sha256").update(archive).digest("hex"), postgresImage: `postgres@sha256:${"a".repeat(64)}`,
      rehearsal: { schemaVerified: true, legacyHistoryUnchanged: true, fingerprint: after.fingerprint,
        migrations: anchoredMigrations.map(version => ({ version, sha256: "b".repeat(64) })) } };
    if (mode === "legacy-receipt") receipt.kind = "prepared-upgrade-restored-backup";
    if (mode === "wrong-contract") receipt.snapshotContract = "wrong" as typeof receipt.snapshotContract;
    if (mode === "wrong-scope") receipt.scope = { ...scope, runnerId: id(99) };
    if (mode === "changed-source") receipt.sourceFingerprint = "9".repeat(64);
    if (mode === "missing-cleanup") receipt.cleanupConfirmed = false;
    if (mode === "missing-migration") receipt.rehearsal.migrations.pop();
    if (["changed-rehearsal", "invented-evidence"].includes(mode)) fixture.recovery.workloads.fingerprint = "9".repeat(64);
    if (mode === "disabled-guard") fixture.registry.triggers.find(t => t.name === "workloads_resource_anchors")!.enabled = "D";
    if (["invented-evidence", "disabled-guard"].includes(mode)) receipt.rehearsal.fingerprint = parse(fixture).fingerprint;
    const file = join(root, "receipt.json"), evidence = join(root, "rehearsal-state.jsonl");
    writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
    writeFileSync(join(root, "runners.dump"), mode === "changed-archive" ? "changed" : archive, { mode: 0o600 });
    writeFileSync(evidence, anchoredOutput(fixture), { mode: 0o600 });
    if (mode === "public-rehearsal") chmodSync(evidence, 0o644);
    if (mode === "symlink-rehearsal") { rmSync(evidence); symlinkSync(file, evidence); }
    if (mode === "valid") {
      verifyAnchoredBackup(file, state);
      assert.throws(() => verifyPreparedBackup(file, parsePreparedUpgradeState(output(anchoredFixture()), scope)), /verified restore receipt required/);
    } else assert.throws(() => verifyAnchoredBackup(file, state));
    assert(!readFileSync(file, "utf8").includes("private fixture"));
  });
}
