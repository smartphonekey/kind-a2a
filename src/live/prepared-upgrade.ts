// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AuditRead, AuditScope } from "./checked-volume-audit.js";

const count = z.number().int().nonnegative().safe();
const fingerprint = z.string().regex(/^[a-f0-9]{32}$/);
const registry = z.object({ database: z.literal("runners"), readOnly: z.literal("on"), isolation: z.literal("repeatable read"),
  migrations: z.array(z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/)),
  volumes: z.object({ total: count, checked: count, fingerprint }),
  workloads: z.object({ total: count, unconfirmed: count, prepared: count, fingerprint }),
  runner: z.object({ id: z.string().uuid(), status: z.literal("enrolled") }),
  constraints: z.array(z.object({ table: z.string(), name: z.string(), validated: z.boolean() })),
  triggers: z.array(z.object({ table: z.string(), name: z.string(), enabled: z.string() })) });
const pins = z.object({ tablePresent: z.boolean(), total: count, prepared: count, fingerprint });

// Two JSON records in the same read-only transaction. psql's conditional keeps
// this compatible with pre-0019 databases where the owner-guard table is absent.
export function registryUpgradeSQL(extension = ""): string { return `
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog, public;
SELECT json_build_object(
  'database', current_database(), 'readOnly', current_setting('transaction_read_only'),
  'isolation', current_setting('transaction_isolation'),
  'migrations', (SELECT COALESCE(json_agg(version ORDER BY version), '[]'::json) FROM public.schema_migrations),
  'volumes', (SELECT json_build_object('total', count(*), 'checked', count(*) FILTER (WHERE to_jsonb(v)->>'checked_lifecycle' = 'true'),
    'fingerprint', md5(COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'ownerKind', v.owner_kind, 'ownerId', v.owner_id,
      'runnerId', v.runner_id, 'organizationId', v.organization_id, 'threadId', v.thread_id, 'agentId', v.agent_id,
      'definitionId', v.volume_id, 'instanceId', v.instance_id, 'status', v.status, 'sizeGb', v.size_gb, 'removedAt', v.removed_at,
      'checked', COALESCE(to_jsonb(v)->'checked_lifecycle', 'false'::jsonb), 'revision', COALESCE(to_jsonb(v)->'lifecycle_revision', '1'::jsonb),
      'binding', to_jsonb(v)->'bound_instance', 'intent', to_jsonb(v)->'removal_intent') ORDER BY v.id)::text, '[]'))) FROM public.volumes v),
  'workloads', (SELECT json_build_object('total', count(*),
    'unconfirmed', count(*) FILTER (WHERE to_jsonb(w)->>'removal_confirmed_at' IS NULL),
    'prepared', count(*) FILTER (WHERE to_jsonb(w)->>'preparation_phase' IS NOT NULL),
    'fingerprint', md5(COALESCE(jsonb_agg(jsonb_build_object('id', w.id, 'ownerKind', w.owner_kind, 'ownerId', w.owner_id,
      'runnerId', w.runner_id, 'organizationId', w.organization_id, 'threadId', w.thread_id, 'agentId', w.agent_id,
      'instanceId', w.instance_id, 'status', w.status, 'removedAt', w.removed_at, 'confirmedAt', to_jsonb(w)->'removal_confirmed_at',
      'phase', to_jsonb(w)->'preparation_phase', 'revision', COALESCE(to_jsonb(w)->'preparation_revision', '0'::jsonb),
      'backend', to_jsonb(w)->'prepared_backend_id', 'volumes', to_jsonb(w)->'prepared_volume_ids',
      'binding', to_jsonb(w)->'prepared_binding', 'observation', to_jsonb(w)->'prepared_removal_observation') ORDER BY w.id)::text, '[]'))) FROM public.workloads w),
  'runner', (SELECT json_build_object('id', id, 'status', status) FROM public.runners WHERE id = :'audit_runner_id'::uuid),
  'constraints', (SELECT COALESCE(json_agg(json_build_object('table', c.relname, 'name', t.conname, 'validated', t.convalidated) ORDER BY c.relname, t.conname), '[]'::json)
    FROM pg_catalog.pg_constraint t JOIN pg_catalog.pg_class c ON c.oid=t.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('volumes','workloads','runtime_volume_admission_guards') AND t.contype='c'),
  'triggers', (SELECT COALESCE(json_agg(json_build_object('table', c.relname, 'name', t.tgname, 'enabled', t.tgenabled::text) ORDER BY c.relname, t.tgname), '[]'::json)
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('volumes','workloads','runtime_volume_admission_guards') AND NOT t.tgisinternal)
);
SELECT to_regclass('public.runtime_volume_admission_guards') IS NOT NULL AS has_owner_guards \\gset
\\if :has_owner_guards
SELECT json_build_object('tablePresent', true, 'total', count(*),
  'prepared', count(*) FILTER (WHERE to_jsonb(g)->>'prepared_backend_id' IS NOT NULL),
  'fingerprint', md5(COALESCE(jsonb_agg(jsonb_build_object('ownerKind', g.owner_kind, 'ownerId', g.owner_id,
    'backend', to_jsonb(g)->'prepared_backend_id', 'runner', to_jsonb(g)->'prepared_runner_id',
    'organization', to_jsonb(g)->'prepared_organization_id', 'thread', to_jsonb(g)->'prepared_thread_id',
    'agent', to_jsonb(g)->'prepared_agent_id') ORDER BY g.owner_kind, g.owner_id)::text, '[]')))
FROM public.runtime_volume_admission_guards g;
\\else
SELECT json_build_object('tablePresent', false, 'total', 0, 'prepared', 0, 'fingerprint', md5('[]'));
\\endif
${extension}
ROLLBACK;
`; }
export const preparedUpgradeSQL = registryUpgradeSQL();

export function parseRegistryUpgradeRecords(records: string[], scope: AuditScope) {
  assert.equal(records.length, 2, "incomplete registry upgrade snapshot");
  const db = registry.parse(JSON.parse(records[0])), ownerPins = pins.parse(JSON.parse(records[1]));
  assert.equal(db.runner.id, scope.runnerId, "upgrade runner identity changed");
  assert.equal(new Set(db.migrations).size, db.migrations.length, "duplicate migration versions");
  assert(db.volumes.checked <= db.volumes.total && db.workloads.prepared <= db.workloads.total &&
    db.workloads.unconfirmed <= db.workloads.total && ownerPins.prepared <= ownerPins.total, "invalid upgrade counts");
  assert(ownerPins.tablePresent || ownerPins.total === 0 && ownerPins.prepared === 0, "missing owner-pin table has rows");
  return { registry: db, pins: ownerPins };
}

export function parsePreparedUpgradeState(output: string, scope: AuditScope) {
  const state = parseRegistryUpgradeRecords(output.trim().split(/\r?\n/), scope);
  const { registry: db, pins: ownerPins } = state;
  assert(db.migrations.every(version => Number(version.slice(0, 4)) <= 22), "unreviewed future database migration");
  return { kind: "prepared-upgrade-state" as const, version: 1, scope, ...state,
    fingerprint: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    legacyRollbackForbidden: db.volumes.checked > 0 || db.workloads.prepared > 0 || ownerPins.prepared > 0 };
}
export type PreparedUpgradeState = ReturnType<typeof parsePreparedUpgradeState>;

export function assertLegacyRegistrySchema(read: AuditRead): void {
  let snapshot;
  try {
    snapshot = z.object({ database: z.literal("runners"), readOnly: z.literal("on"), migrations: z.array(z.string()).min(1) }).parse(JSON.parse(read([
      "exec", "-i", "-n", "agyn-platform", "platform-postgres-0", "-c", "postgres", "--", "env",
      "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000", "psql", "-X", "-q", "-A", "-t",
      "-v", "ON_ERROR_STOP=1", "-U", "agyn", "-d", "runners", "-f", "-"
    ], `BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT json_build_object('database', current_database(), 'readOnly', current_setting('transaction_read_only'),
  'migrations', (SELECT json_agg(version ORDER BY version) FROM public.schema_migrations));
ROLLBACK;\n`)));
  } catch { throw new Error("legacy rollout schema check failed; refusing deployment changes"); }
  assert(snapshot.migrations.every(version => /^\d{4}_[a-z0-9_]+\.sql$/.test(version) && Number(version.slice(0, 4)) <= 17),
    "checked/prepared registry requires coordinated retain-mode rollout; legacy image changes and restoration refused");
}

export function verifyPreparedBackup(file: string, state: PreparedUpgradeState): void {
  assert(isAbsolute(file), "explicit absolute prepared backup receipt required");
  const uid = process.getuid?.();
  assert(typeof uid === "number", "prepared backup verification requires POSIX ownership");
  for (const path of [dirname(file), file, join(dirname(file), "runners.dump")]) {
    const info = lstatSync(path);
    assert((path === dirname(file) ? info.isDirectory() : info.isFile()) && info.uid === uid && (info.mode & 0o077) === 0,
      "private owned prepared backup and receipt required");
  }
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(receipt.kind, "prepared-upgrade-restored-backup", "verified restore receipt required");
  assert.equal(receipt.version, 1);
  assert(receipt.cleanupConfirmed === true && receipt.rehearsal?.schemaVerified === true && receipt.rehearsal?.legacyHistoryUnchanged === true,
    "verified migration rehearsal and disposable database cleanup required");
  assert.deepEqual(receipt.scope, state.scope, "backup scope differs from upgrade scope");
  assert.equal(receipt.sourceFingerprint, state.fingerprint, "database changed since verified backup");
  assert.equal(receipt.restoredFingerprint, state.fingerprint, "backup restore did not reproduce the source lifecycle");
  assert.equal(receipt.archiveSha256, createHash("sha256").update(readFileSync(join(dirname(file), "runners.dump"))).digest("hex"), "backup archive changed");
}

export function assertPreparedSchema(state: Pick<PreparedUpgradeState, "registry" | "pins">): void {
  for (const migration of ["0017_workload_removal_confirmation.sql", "0018_checked_volume_lifecycle.sql", "0019_volume_workload_admission.sql",
    "0020_legacy_volume_adoption.sql", "0021_volume_backend_identity.sql", "0022_prepared_workloads.sql"]) {
    assert(state.registry.migrations.includes(migration), `missing required migration ${migration}`);
  }
  assert(state.pins.tablePresent, "durable owner pins are unavailable");
  for (const [table, name] of [["volumes", "volumes_checked_state"], ["volumes", "volumes_checked_backend"], ["workloads", "workloads_preparation_shape"],
    ["runtime_volume_admission_guards", "runtime_prepared_pin"]]) {
    assert(state.registry.constraints.some(c => c.table === table && c.name === name && c.validated), `missing validated constraint ${name}`);
  }
  for (const [table, name] of [["volumes", "volumes_checked_lifecycle"], ["volumes", "volumes_workload_admission"],
    ["volumes", "volumes_legacy_adoption"], ["volumes", "volumes_prepared_owner"], ["workloads", "workloads_volume_admission"],
    ["workloads", "workloads_preparation"], ["runtime_volume_admission_guards", "runtime_prepared_pin"]]) {
    assert(state.registry.triggers.some(g => g.table === table && g.name === name && ["O", "A"].includes(g.enabled)), `missing enabled guard ${name}`);
  }
}

export function collectPreparedUpgradeState(read: AuditRead, scope: AuditScope): PreparedUpgradeState {
  return collectRegistryUpgradeSnapshot(read, scope, preparedUpgradeSQL, parsePreparedUpgradeState);
}

export function collectRegistryUpgradeSnapshot<T>(read: AuditRead, scope: AuditScope, sql: string,
  parse: (output: string, scope: AuditScope) => T): T {
  assert([scope.postgresPod, scope.postgresUser].every(value => /^[a-z][a-z0-9_-]{0,62}$/.test(value)), "invalid upgrade database selector");
  assert([scope.postgresPodUid, scope.namespaceUid, scope.runnerId].every(value => z.string().uuid().safeParse(value).success), "explicit upgrade scope UUIDs required");
  // Do not expose raw kubectl errors, Pod specifications or database output.
  try {
    const boundary = () => {
      const ns = JSON.parse(read(["get", "namespace", "agyn-workloads", "-o", "json"]));
      const pg = JSON.parse(read(["get", "pod", scope.postgresPod, "-n", "agyn-platform", "-o", "json"]));
      const main = pg.status?.containerStatuses?.find((c: any) => c.name === "postgres");
      assert(ns.metadata?.uid === scope.namespaceUid && ns.metadata.name === "agyn-workloads" && !ns.metadata.deletionTimestamp);
      assert(pg.metadata?.uid === scope.postgresPodUid && pg.metadata.name === scope.postgresPod && pg.metadata.namespace === "agyn-platform" && !pg.metadata.deletionTimestamp);
      assert(pg.status?.phase === "Running" && main?.ready === true && Number.isSafeInteger(main.restartCount) && main.restartCount >= 0 &&
        typeof main.containerID === "string" && main.containerID.length > 0);
      return { containerId: main.containerID, restarts: main.restartCount };
    };
    const before = boundary();
    const output = read(["exec", "-i", "-n", "agyn-platform", scope.postgresPod, "-c", "postgres", "--", "env",
      "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000", "psql", "-X", "-q", "-A", "-t",
      "-v", "ON_ERROR_STOP=1", "-v", `audit_runner_id=${scope.runnerId}`, "-U", scope.postgresUser, "-d", "runners", "-f", "-"], sql);
    assert.deepEqual(boundary(), before);
    return parse(output, scope);
  } catch { throw new Error("prepared upgrade snapshot failed; database/boundary reconciliation required"); }
}
