// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAnchoredUpgradeState } from "./live/anchored-upgrade.js";
import { assertVolumeMigrationHistoryUnchanged, assertVolumeMigrationSchema, parseVolumeMigrationUpgradeState,
  verifyVolumeMigrationBackup, volumeMigrationUpgradeSQL, volumeMigrationVersions } from "./live/volume-migration-upgrade.js";
import { anchoredFixture, anchoredOutput } from "./test/anchored-upgrade-fixture.js";
import { scope } from "./test/prepared-upgrade-fixture.js";

function fixture(upgraded = false, phase = "empty") {
  const f = anchoredFixture(upgraded);
  const recovery = { ...f.recovery, contract: "volume-adoption-through-0027", volumes: { ...f.recovery.volumes, adopted: 0 },
    pins: { ...f.recovery.pins, migrating: 0, completed: 0 } };
  if (upgraded) {
    f.registry.migrations.push(volumeMigrationVersions.at(-1)!);
    recovery.columns.push(...[["volumes", "anchor_adoption"], ["runtime_volume_admission_guards", "volume_anchor_migration"]]
      .map(([table, name]) => ({ table, name, type: "jsonb", nullable: true, defaultHash: null })));
    const triggers = [["volumes", "volumes_anchor_migration"], ["workloads", "workloads_anchor_migration"],
      ["runtime_volume_admission_guards", "runtime_volume_anchor_migration"]].map(([table, name]) => ({ table, name, fingerprint: "a".repeat(64) }));
    recovery.triggers.push(...triggers);
    f.registry.triggers.push(...triggers.map(({ table, name }) => ({ table, name, enabled: "O" })));
    recovery.functions.push(...["migration_uuid", "valid_volume_anchor_migration_entry", "guard_volume_anchor_migration", "volume_anchor_migration_binding",
      "guard_migrating_volume", "guard_migrating_workload"].map(name => ({ name, arguments: "", fingerprint: "b".repeat(64) })));
  }
  if (phase !== "empty") {
    f.pins.total = Math.max(1, f.pins.total);
    recovery.pins.migrating = 1;
    if (["applied", "complete"].includes(phase)) {
      f.registry.volumes.total = Math.max(1, f.registry.volumes.total);
      f.registry.volumes.checked = 1;
      recovery.volumes.anchored = recovery.volumes.adopted = 1;
    }
    if (phase === "complete") {
      recovery.pins.migrating = 0; recovery.pins.completed = recovery.pins.anchored = f.pins.prepared = 1;
    }
  }
  return { ...f, recovery };
}
type Fixture = ReturnType<typeof fixture>;
const output = (f: Fixture) => [f.registry, f.pins, f.recovery].map(x => JSON.stringify(x)).join("\n") + "\n";
const parse = (f: Fixture) => parseVolumeMigrationUpgradeState(output(f), scope);

test("migration backup distinguishes adoption from allocation and keeps partial owners blocked", () => {
  for (const phase of ["empty", "planned", "applied", "complete", "quarantine"]) {
    const f = fixture(true, phase), state = parse(f);
    assertVolumeMigrationSchema(state);
    assert.equal(state.recovery.volumes.reserved, 0);
    assert.equal(state.legacyRollbackForbidden, true);
    assert.throws(() => parseAnchoredUpgradeState(output(f), scope));
  }
  assertVolumeMigrationHistoryUnchanged(parse(fixture()), parse(fixture(true)));
  assert.throws(() => parseVolumeMigrationUpgradeState(anchoredOutput(anchoredFixture(true)), scope));
  for (const name of ["anchor_adoption", "volume_anchor_migration", "pg_get_functiondef", "pg_get_triggerdef", "pg_get_constraintdef"]) assert(volumeMigrationUpgradeSQL.includes(name));
  assert.match(volumeMigrationUpgradeSQL, /REPEATABLE READ READ ONLY/);
});

for (const [name, mutate] of [
  ["future schema", (f: Fixture) => f.registry.migrations.push("0028_future.sql")],
  ["migration gap", (f: Fixture) => { f.registry.migrations = f.registry.migrations.filter(x => x !== volumeMigrationVersions[1]); }],
  ["legacy contract", (f: Fixture) => { f.recovery.contract = "resource-anchors-through-0026"; }],
  ["double provenance", (f: Fixture) => { f.recovery.volumes.reserved = 1; }],
  ["unanchored completion", (f: Fixture) => { f.recovery.pins.completed = 1; }],
  ["missing owner block", (f: Fixture) => { f.recovery.pins.migrating = f.pins.total + 1; }],
  ["pre-contract provenance", (f: Fixture) => { f.registry.migrations.pop(); }],
] as const) test(`migration backup rejects ${name}`, () => {
  const f = fixture(true, "applied"); mutate(f); assert.throws(() => parse(f));
});

test("migration schema verification includes every new column, guard and function", () => {
  const baseline = parse(fixture(true));
  for (const category of ["columns", "triggers", "functions"] as const) {
    for (const entry of baseline.recovery[category]) {
      const changed = structuredClone(baseline);
      changed.recovery[category].splice(changed.recovery[category].findIndex(x => x.name === entry.name), 1);
      assert.throws(() => assertVolumeMigrationSchema(changed));
    }
  }
  for (const trigger of baseline.registry.triggers.filter(x => x.name.includes("anchor_migration"))) {
    const changed = structuredClone(baseline); changed.registry.triggers.find(x => x.name === trigger.name)!.enabled = "D";
    assert.throws(() => assertVolumeMigrationSchema(changed));
  }
  for (const category of ["volumes", "pins"] as const) {
    const f = fixture(true, "applied"), before = parse(f);
    f.recovery[category].fingerprint = "9".repeat(64);
    const after = parse(f);
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.throws(() => assertVolumeMigrationHistoryUnchanged(before, after));
  }
});

for (const mode of ["valid", "wrong-contract", "legacy-receipt", "incomplete-rehearsal", "changed-dump", "changed-plan", "disabled-block"]) {
  test(`volume migration backup receipt: ${mode}`, t => {
    const root = mkdtempSync(join(tmpdir(), "volume-migration-backup-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const state = parse(fixture()), after = fixture(true), archive = Buffer.from("PGDMP fixture");
    const receipt = { kind: "volume-migration-restored-backup", version: 1, snapshotContract: state.recovery.contract, scope,
      installedDatabaseModified: false, cleanupConfirmed: true, sourceFingerprint: state.fingerprint, restoredFingerprint: state.fingerprint,
      archiveSha256: createHash("sha256").update(archive).digest("hex"), postgresImage: `postgres@sha256:${"a".repeat(64)}`,
      rehearsal: { schemaVerified: true, legacyHistoryUnchanged: true, fingerprint: parse(after).fingerprint,
        migrations: volumeMigrationVersions.map(version => ({ version, sha256: "b".repeat(64) })) } };
    if (mode === "wrong-contract") receipt.snapshotContract = "old" as typeof receipt.snapshotContract;
    if (mode === "legacy-receipt") receipt.kind = "anchored-upgrade-restored-backup";
    if (mode === "incomplete-rehearsal") receipt.rehearsal.migrations.pop();
    if (mode === "changed-plan") { after.recovery.pins.fingerprint = "9".repeat(64); receipt.rehearsal.fingerprint = parse(after).fingerprint; }
    if (mode === "disabled-block") { after.registry.triggers.find(x => x.name === "volumes_anchor_migration")!.enabled = "D"; receipt.rehearsal.fingerprint = parse(after).fingerprint; }
    const file = join(root, "receipt.json");
    writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
    writeFileSync(join(root, "runners.dump"), mode === "changed-dump" ? "changed" : archive, { mode: 0o600 });
    writeFileSync(join(root, "rehearsal-state.jsonl"), output(after), { mode: 0o600 });
    if (mode === "valid") verifyVolumeMigrationBackup(file, state);
    else assert.throws(() => verifyVolumeMigrationBackup(file, state));
  });
}
