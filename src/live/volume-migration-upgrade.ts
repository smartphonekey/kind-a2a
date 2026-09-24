// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AuditRead, AuditScope } from "./checked-volume-audit.js";
import { anchoredMigrations, anchoredRecoverySchema, assertAnchoredSchema, resourceRecoverySQL } from "./anchored-upgrade.js";
import { assertPreparedSchema, collectRegistryUpgradeSnapshot, parseRegistryUpgradeRecords, registryUpgradeSQL } from "./prepared-upgrade.js";

export const volumeMigrationVersions = [...anchoredMigrations, "0027_volume_anchor_migration.sql"] as const;
const count = z.number().int().nonnegative().safe();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const recoverySchema = anchoredRecoverySchema.extend({
  contract: z.literal("volume-adoption-through-0027"),
  volumes: anchoredRecoverySchema.shape.volumes.extend({ adopted: count }).strict(),
  pins: anchoredRecoverySchema.shape.pins.extend({ migrating: count, completed: count }).strict(),
}).strict();

export const volumeMigrationUpgradeSQL = registryUpgradeSQL(resourceRecoverySQL(true));

export function parseVolumeMigrationUpgradeState(output: string, scope: AuditScope) {
  const records = output.trim().split(/\r?\n/);
  assert.equal(records.length, 3, "incomplete volume migration snapshot");
  const base = parseRegistryUpgradeRecords(records.slice(0, 2), scope);
  assertPreparedSchema(base);
  assert(base.registry.migrations.every(v => Number(v.slice(0, 4)) <= 22 || (volumeMigrationVersions as readonly string[]).includes(v)),
    "unreviewed volume lifecycle migration");
  let gap = false;
  for (const version of volumeMigrationVersions) {
    if (!base.registry.migrations.includes(version)) gap = true;
    else assert(!gap, "noncontiguous volume lifecycle migrations");
  }
  const recovery = recoverySchema.parse(JSON.parse(records[2]));
  assert(recovery.volumes.anchored <= base.registry.volumes.checked && recovery.volumes.reserved + recovery.volumes.adopted === recovery.volumes.anchored &&
    recovery.volumes.retired <= recovery.volumes.anchored && recovery.workloads.anchored <= base.registry.workloads.prepared &&
    recovery.workloads.revoked <= recovery.workloads.anchored && recovery.workloads.observed <= recovery.workloads.revoked &&
    recovery.pins.anchored <= base.pins.prepared && recovery.pins.completed <= recovery.pins.anchored &&
    recovery.pins.completed + recovery.pins.migrating <= base.pins.total, "invalid volume migration lifecycle counts");
  if (!base.registry.migrations.includes(volumeMigrationVersions.at(-1)!)) {
    assert.equal(recovery.volumes.adopted + recovery.pins.migrating + recovery.pins.completed, 0, "migration evidence predates its contract");
  }
  for (const entries of [recovery.columns, recovery.constraints, recovery.triggers]) {
    assert.equal(new Set(entries.map(e => `${e.table}/${e.name}`)).size, entries.length, "duplicate schema record");
  }
  assert.equal(new Set(recovery.functions.map(f => `${f.name}(${f.arguments})`)).size, recovery.functions.length, "duplicate function record");
  const state = { ...base, recovery };
  return { kind: "volume-migration-upgrade-state" as const, version: 1 as const, scope, ...state,
    fingerprint: createHash("sha256").update(JSON.stringify(state)).digest("hex"), legacyRollbackForbidden: true as const };
}
export type VolumeMigrationUpgradeState = ReturnType<typeof parseVolumeMigrationUpgradeState>;

export function collectVolumeMigrationUpgradeState(read: AuditRead, scope: AuditScope) {
  return collectRegistryUpgradeSnapshot(read, scope, volumeMigrationUpgradeSQL, parseVolumeMigrationUpgradeState);
}

export function assertVolumeMigrationSchema(state: VolumeMigrationUpgradeState): void {
  assertAnchoredSchema(state);
  assert(state.registry.migrations.includes(volumeMigrationVersions.at(-1)!), "missing volume migration schema");
  for (const [table, name] of [["volumes", "anchor_adoption"], ["runtime_volume_admission_guards", "volume_anchor_migration"]]) {
    assert(state.recovery.columns.some(c => c.table === table && c.name === name && c.type === "jsonb" && c.nullable && c.defaultHash === null),
      `invalid migration evidence column ${name}`);
  }
  for (const [table, name] of [["volumes", "volumes_anchor_migration"], ["workloads", "workloads_anchor_migration"],
    ["runtime_volume_admission_guards", "runtime_volume_anchor_migration"]]) {
    assert(state.registry.triggers.some(t => t.table === table && t.name === name && ["O", "A"].includes(t.enabled)), `missing enabled guard ${name}`);
    assert(state.recovery.triggers.some(t => t.table === table && t.name === name), `missing migration guard definition ${name}`);
  }
  for (const name of ["migration_uuid", "valid_volume_anchor_migration_entry", "guard_volume_anchor_migration", "volume_anchor_migration_binding",
    "guard_migrating_volume", "guard_migrating_workload"]) {
    assert.equal(state.recovery.functions.filter(f => f.name === name).length, 1, `missing or ambiguous migration function ${name}`);
  }
}

export function assertVolumeMigrationHistoryUnchanged(before: VolumeMigrationUpgradeState, after: VolumeMigrationUpgradeState): void {
  assert.deepEqual(after.registry.volumes, before.registry.volumes, "schema migration changed volume lifecycle");
  assert.deepEqual(after.registry.workloads, before.registry.workloads, "schema migration changed workload lifecycle");
  assert.deepEqual(after.pins, before.pins, "schema migration changed owner pins");
  for (const key of ["volumes", "workloads", "pins"] as const) {
    assert.deepEqual(after.recovery[key], before.recovery[key], `schema migration changed ${key} evidence`);
  }
}

export function verifyVolumeMigrationBackup(file: string, state: VolumeMigrationUpgradeState): void {
  assert(isAbsolute(file), "explicit absolute migration backup receipt required");
  const uid = process.getuid?.();
  assert(typeof uid === "number", "POSIX backup ownership required");
  for (const path of [dirname(file), file, join(dirname(file), "runners.dump"), join(dirname(file), "rehearsal-state.jsonl")]) {
    const info = lstatSync(path);
    assert((path === dirname(file) ? info.isDirectory() : info.isFile()) && info.uid === uid && (info.mode & 0o077) === 0,
      "private owned migration backup required");
  }
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(receipt.kind, "volume-migration-restored-backup");
  assert.equal(receipt.version, 1);
  assert.equal(receipt.snapshotContract, state.recovery.contract);
  assert.equal(receipt.installedDatabaseModified, false);
  assert(/^\S+@sha256:[a-f0-9]{64}$/.test(receipt.postgresImage), "pinned restore image required");
  assert(receipt.cleanupConfirmed === true && receipt.rehearsal?.schemaVerified === true && receipt.rehearsal?.legacyHistoryUnchanged === true,
    "verified offline migration and cleanup required");
  assert.deepEqual(receipt.scope, state.scope, "backup scope changed");
  assert.equal(receipt.sourceFingerprint, state.fingerprint, "database changed since backup");
  assert.equal(receipt.restoredFingerprint, state.fingerprint, "restore changed migration evidence");
  assert.equal(receipt.archiveSha256, createHash("sha256").update(readFileSync(join(dirname(file), "runners.dump"))).digest("hex"), "backup archive changed");
  const applied = z.array(z.object({ version: z.enum(volumeMigrationVersions), sha256 }).strict()).parse(receipt.rehearsal.migrations);
  assert.deepEqual(applied.map(m => m.version), volumeMigrationVersions.filter(v => !state.registry.migrations.includes(v)), "incomplete migration rehearsal");
  const rehearsal = parseVolumeMigrationUpgradeState(readFileSync(join(dirname(file), "rehearsal-state.jsonl"), "utf8"), state.scope);
  assert.equal(receipt.rehearsal.fingerprint, rehearsal.fingerprint, "rehearsal evidence changed");
  assertVolumeMigrationSchema(rehearsal);
  assertVolumeMigrationHistoryUnchanged(state, rehearsal);
}
