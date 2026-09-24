// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AuditRead, AuditScope } from "./checked-volume-audit.js";
import { assertPreparedSchema, collectRegistryUpgradeSnapshot, parseRegistryUpgradeRecords, registryUpgradeSQL } from "./prepared-upgrade.js";

export const anchoredMigrations = ["0023_resource_anchors.sql", "0024_resource_anchor_thread_identity.sql",
  "0025_anchored_volume_removal.sql", "0026_preparation_revocation.sql"] as const;
const count = z.number().int().nonnegative().safe();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const anchoredRecoverySchema = z.object({
  contract: z.literal("resource-anchors-through-0026"),
  volumes: z.object({ anchored: count, reserved: count, retired: count, fingerprint: sha256 }).strict(),
  workloads: z.object({ anchored: count, revoked: count, observed: count, fingerprint: sha256 }).strict(),
  pins: z.object({ anchored: count, fingerprint: sha256 }).strict(),
  columns: z.array(z.object({ table: z.string(), name: z.string(), type: z.string(), nullable: z.boolean(), defaultHash: sha256.nullable() }).strict()),
  constraints: z.array(z.object({ table: z.string(), name: z.string(), fingerprint: sha256 }).strict()),
  triggers: z.array(z.object({ table: z.string(), name: z.string(), fingerprint: sha256 }).strict()),
  functions: z.array(z.object({ name: z.string(), arguments: z.string(), fingerprint: sha256 }).strict()),
}).strict();

// JSON recovery documents are hashed whole: new nested evidence cannot vanish
// from the projection while its enclosing workload/volume identity stays equal.
// Pretty constraint deparsing normalizes redundant BETWEEN/AND parentheses that
// pg_restore reparses; use PostgreSQL's deparser rather than editing SQL strings.
export function resourceRecoverySQL(adoption = false): string { return `
SELECT json_build_object(
  'contract', '${adoption ? "volume-adoption-through-0027" : "resource-anchors-through-0026"}',
  'volumes', (SELECT json_build_object(
    'anchored', count(*) FILTER (WHERE to_jsonb(v)->>'resource_anchor' IS NOT NULL),
    'reserved', count(*) FILTER (WHERE to_jsonb(v)->>'anchor_reservation' IS NOT NULL),
    'retired', count(*) FILTER (WHERE to_jsonb(v)->>'anchored_removal_observation' IS NOT NULL),
    ${adoption ? "'adopted', count(*) FILTER (WHERE to_jsonb(v)->>'anchor_adoption' IS NOT NULL)," : ""}
    'fingerprint', encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object('id', v.id,
      'anchor', to_jsonb(v)->'resource_anchor', 'reservation', to_jsonb(v)->'anchor_reservation',
      ${adoption ? "'adoption', to_jsonb(v)->'anchor_adoption'," : ""}
      'observation', to_jsonb(v)->'anchored_removal_observation') ORDER BY v.id)::text, '[]'), 'UTF8')), 'hex')) FROM public.volumes v),
  'workloads', (SELECT json_build_object(
    'anchored', count(*) FILTER (WHERE to_jsonb(w)->>'resource_anchors' IS NOT NULL),
    'revoked', count(*) FILTER (WHERE to_jsonb(w)->'resource_anchors'->>'preparationRevocation' IS NOT NULL),
    'observed', count(*) FILTER (WHERE to_jsonb(w)->'resource_anchors'->>'revocationObservation' IS NOT NULL),
    'fingerprint', encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object('id', w.id,
      'resources', to_jsonb(w)->'resource_anchors') ORDER BY w.id)::text, '[]'), 'UTF8')), 'hex')) FROM public.workloads w),
  'pins', (SELECT json_build_object(
    'anchored', count(*) FILTER (WHERE to_jsonb(g)->>'resource_anchors_required' = 'true'),
    ${adoption ? `'migrating', count(*) FILTER (WHERE to_jsonb(g)->>'volume_anchor_migration' IS NOT NULL AND COALESCE(to_jsonb(g)->'volume_anchor_migration'->>'complete','false')<>'true'),
    'completed', count(*) FILTER (WHERE to_jsonb(g)->'volume_anchor_migration'->>'complete'='true'),` : ""}
    'fingerprint', encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object('ownerKind', g.owner_kind, 'ownerId', g.owner_id,
      ${adoption ? "'migration', to_jsonb(g)->'volume_anchor_migration'," : ""}
      'required', COALESCE(to_jsonb(g)->'resource_anchors_required', 'false'::jsonb)) ORDER BY g.owner_kind, g.owner_id)::text, '[]'), 'UTF8')), 'hex'))
    FROM public.runtime_volume_admission_guards g),
  'columns', (SELECT COALESCE(json_agg(json_build_object('table', c.relname, 'name', a.attname,
    'type', format_type(a.atttypid, a.atttypmod), 'nullable', NOT a.attnotnull,
    'defaultHash', encode(sha256(convert_to(pg_get_expr(d.adbin, d.adrelid), 'UTF8')), 'hex')) ORDER BY c.relname, a.attname), '[]'::json)
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname IN ('volumes','workloads','runtime_volume_admission_guards') AND a.attnum>0 AND NOT a.attisdropped),
  'constraints', (SELECT COALESCE(json_agg(json_build_object('table', c.relname, 'name', t.conname,
    'fingerprint', encode(sha256(convert_to(pg_get_constraintdef(t.oid, true), 'UTF8')), 'hex')) ORDER BY c.relname, t.conname), '[]'::json)
    FROM pg_catalog.pg_constraint t JOIN pg_catalog.pg_class c ON c.oid=t.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('volumes','workloads','runtime_volume_admission_guards')),
  'triggers', (SELECT COALESCE(json_agg(json_build_object('table', c.relname, 'name', t.tgname,
    'fingerprint', encode(sha256(convert_to(pg_get_triggerdef(t.oid, false), 'UTF8')), 'hex')) ORDER BY c.relname, t.tgname), '[]'::json)
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('volumes','workloads','runtime_volume_admission_guards') AND NOT t.tgisinternal),
  'functions', (SELECT COALESCE(json_agg(json_build_object('name', p.proname, 'arguments', pg_get_function_identity_arguments(p.oid),
    'fingerprint', encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex')) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::json)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f')
);
`; }
export const anchoredUpgradeSQL = registryUpgradeSQL(resourceRecoverySQL());

export function parseAnchoredUpgradeState(output: string, scope: AuditScope) {
  const records = output.trim().split(/\r?\n/);
  assert.equal(records.length, 3, "incomplete anchored upgrade snapshot");
  const base = parseRegistryUpgradeRecords(records.slice(0, 2), scope);
  assertPreparedSchema(base);
  assert(base.registry.migrations.every(version => Number(version.slice(0, 4)) <= 22 || (anchoredMigrations as readonly string[]).includes(version)),
    "unreviewed resource lifecycle migration");
  let missing = false;
  for (const migration of anchoredMigrations) {
    if (!base.registry.migrations.includes(migration)) missing = true;
    else assert(!missing, "noncontiguous resource lifecycle migrations");
  }
  const recovery = anchoredRecoverySchema.parse(JSON.parse(records[2]));
  assert(recovery.volumes.anchored <= base.registry.volumes.checked && recovery.volumes.reserved === recovery.volumes.anchored &&
    recovery.volumes.retired <= recovery.volumes.anchored && recovery.workloads.anchored <= base.registry.workloads.prepared &&
    recovery.workloads.revoked <= recovery.workloads.anchored && recovery.workloads.observed <= recovery.workloads.revoked &&
    recovery.pins.anchored <= base.pins.prepared, "invalid resource lifecycle counts");
  for (const entries of [recovery.columns, recovery.constraints, recovery.triggers]) {
    assert.equal(new Set(entries.map(e => `${e.table}/${e.name}`)).size, entries.length, "duplicate schema record");
  }
  assert.equal(new Set(recovery.functions.map(f => `${f.name}(${f.arguments})`)).size, recovery.functions.length, "duplicate function record");
  const state = { ...base, recovery };
  return { kind: "anchored-upgrade-state" as const, version: 1 as const, scope, ...state,
    fingerprint: createHash("sha256").update(JSON.stringify(state)).digest("hex"), legacyRollbackForbidden: true as const };
}
export type AnchoredUpgradeState = ReturnType<typeof parseAnchoredUpgradeState>;

export function collectAnchoredUpgradeState(read: AuditRead, scope: AuditScope): AnchoredUpgradeState {
  return collectRegistryUpgradeSnapshot(read, scope, anchoredUpgradeSQL, parseAnchoredUpgradeState);
}

type ResourceSchemaState = Pick<AnchoredUpgradeState, "registry" | "pins"> & {
  recovery: Pick<AnchoredUpgradeState["recovery"], "columns" | "constraints" | "triggers" | "functions">;
};
export function assertAnchoredSchema(state: ResourceSchemaState): void {
  assertPreparedSchema(state);
  for (const migration of anchoredMigrations) assert(state.registry.migrations.includes(migration), `missing required migration ${migration}`);
  for (const [table, name] of [["workloads", "workloads_resource_anchors_shape"], ["volumes", "volumes_resource_anchor_shape"],
    ["volumes", "volumes_anchored_removal_state"], ["runtime_volume_admission_guards", "runtime_resource_anchor_pin"]]) {
    assert(state.registry.constraints.some(c => c.table === table && c.name === name && c.validated), `missing validated constraint ${name}`);
    assert(state.recovery.constraints.some(c => c.table === table && c.name === name), `missing constraint definition ${name}`);
  }
  for (const [table, name] of [["workloads", "workloads_resource_anchors"], ["volumes", "volumes_resource_anchor"],
    ["runtime_volume_admission_guards", "runtime_resource_anchor_owner"]]) {
    assert(state.registry.triggers.some(t => t.table === table && t.name === name && ["O", "A"].includes(t.enabled)), `missing enabled guard ${name}`);
    assert(state.recovery.triggers.some(t => t.table === table && t.name === name), `missing trigger definition ${name}`);
  }
  for (const [table, name] of [["workloads", "resource_anchors"], ["volumes", "resource_anchor"], ["volumes", "anchor_reservation"],
    ["volumes", "anchored_removal_observation"], ["runtime_volume_admission_guards", "resource_anchors_required"]]) {
    const pin = name === "resource_anchors_required";
    assert(state.recovery.columns.some(c => c.table === table && c.name === name && c.type === (pin ? "boolean" : "jsonb") &&
      c.nullable === !pin && c.defaultHash === (pin ? createHash("sha256").update("false").digest("hex") : null)), `invalid lifecycle column ${name}`);
  }
  for (const name of ["guard_resource_anchor_owner", "guard_workload_resource_anchors", "guard_volume_resource_anchor",
    "valid_registry_resource_anchor", "valid_registry_preparation_revocation", "valid_registry_revocation_observation"]) {
    assert.equal(state.recovery.functions.filter(f => f.name === name).length, 1, `missing or ambiguous lifecycle function ${name}`);
  }
}

export function assertAnchoredHistoryUnchanged(before: AnchoredUpgradeState, after: AnchoredUpgradeState): void {
  assert.deepEqual(after.registry.volumes, before.registry.volumes, "migration changed volume lifecycle");
  assert.deepEqual(after.registry.workloads, before.registry.workloads, "migration changed workload lifecycle");
  assert.deepEqual(after.pins, before.pins, "migration changed prepared owner pins");
  for (const key of ["volumes", "workloads", "pins"] as const) {
    assert.deepEqual(after.recovery[key], before.recovery[key], `migration changed ${key} recovery evidence`);
  }
}

export function verifyAnchoredBackup(file: string, state: AnchoredUpgradeState): void {
  assert(isAbsolute(file), "explicit absolute anchored backup receipt required");
  const uid = process.getuid?.();
  assert(typeof uid === "number", "backup verification requires POSIX ownership");
  for (const path of [dirname(file), file, join(dirname(file), "runners.dump"), join(dirname(file), "rehearsal-state.jsonl")]) {
    const info = lstatSync(path);
    assert((path === dirname(file) ? info.isDirectory() : info.isFile()) && info.uid === uid && (info.mode & 0o077) === 0,
      "private owned anchored backup required");
  }
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(receipt.kind, "anchored-upgrade-restored-backup");
  assert.equal(receipt.version, 1);
  assert.equal(receipt.snapshotContract, state.recovery.contract);
  assert.equal(receipt.installedDatabaseModified, false);
  assert(/^\S+@sha256:[a-f0-9]{64}$/.test(receipt.postgresImage), "pinned restore image required");
  assert(receipt.cleanupConfirmed === true && receipt.rehearsal?.schemaVerified === true && receipt.rehearsal?.legacyHistoryUnchanged === true,
    "verified offline migration and cleanup required");
  assert.deepEqual(receipt.scope, state.scope, "backup scope differs from upgrade scope");
  assert.equal(receipt.sourceFingerprint, state.fingerprint, "database changed since backup");
  assert.equal(receipt.restoredFingerprint, state.fingerprint, "restored lifecycle differs from source");
  assert.equal(receipt.archiveSha256, createHash("sha256").update(readFileSync(join(dirname(file), "runners.dump"))).digest("hex"), "backup archive changed");
  const applied = z.array(z.object({ version: z.enum(anchoredMigrations), sha256 }).strict()).parse(receipt.rehearsal.migrations);
  assert.deepEqual(applied.map(m => m.version), anchoredMigrations.filter(m => !state.registry.migrations.includes(m)), "incomplete migration rehearsal");
  const rehearsal = parseAnchoredUpgradeState(readFileSync(join(dirname(file), "rehearsal-state.jsonl"), "utf8"), state.scope);
  assert.equal(receipt.rehearsal.fingerprint, rehearsal.fingerprint, "rehearsal changed since verification");
  assertAnchoredSchema(rehearsal);
  assertAnchoredHistoryUnchanged(state, rehearsal);
}
