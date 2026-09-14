// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only observations, never an adoption/deletion or rollout permit.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const uuid = z.string().uuid();
const text = z.string().min(1).max(256);
const nullableUuid = uuid.nullable();
const owner = z.object({ ownerKind: z.enum(["agent_instance", "sandbox"]), ownerId: uuid,
  runnerId: uuid, organizationId: uuid, threadId: nullableUuid, agentId: nullableUuid });
const volume = owner.extend({ id: uuid, definitionId: uuid, instanceId: text.nullable(), sizeGb: text,
  status: z.enum(["provisioning", "active", "failed", "deprovisioning", "deleted"]),
  checkedLifecycle: z.boolean().nullable(), revision: z.number().int().positive().nullable(),
  removedAt: text.nullable(), bound: z.unknown(), intent: z.unknown() });
const workload = owner.extend({ id: uuid, instanceId: text.nullable(),
  status: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
  removalConfirmedAt: text.nullable(), removedAt: text.nullable() });
const registrySchema = z.object({ database: z.literal("runners"), readOnly: z.literal("on"),
  isolation: z.literal("repeatable read"), at: text, migrations: z.array(text),
  counts: z.object({ volumes: z.number().int().nonnegative(), workloads: z.number().int().nonnegative(), runners: z.number().int().nonnegative() }),
  volumes: z.array(volume), workloads: z.array(workload),
  runners: z.array(z.object({ id: uuid, organizationId: nullableUuid, status: text })),
  triggers: z.array(z.object({ table: text, name: text, enabled: text })),
  constraints: z.array(z.object({ table: text, name: text, validated: z.boolean() })) });
type Volume = z.infer<typeof volume>;
type Registry = z.infer<typeof registrySchema>;
const backendId = z.string().min(1).max(512).refine(value => value.trim() === value && Buffer.byteLength(value) <= 512);
const binding = z.object({ instanceId: text, instanceUid: text, volumeKey: uuid, identityLabels: z.record(z.string()), backendId });
const intent = z.object({ id: text, requestedAt: text, confirmedAt: text.optional(), expected: binding });

export const persistentVolumeLabelKeys = ["app.kubernetes.io/managed-by", "agyn.dev/managed-by", "volume_key",
  "managed-by", "agent-instance-id", "agent-id", "sandbox-id", "sandbox-owner-id"] as const;
const metadata = z.object({ name: text, uid: text, resourceVersion: text, namespace: text.optional(),
  labels: z.record(z.string()).optional(), deletionTimestamp: text.nullable().optional(), ownerReferences: z.array(z.unknown()).optional() });
const completeList = z.object({ apiVersion: z.literal("v1"), kind: z.literal("List"),
  metadata: z.object({ resourceVersion: z.string(), continue: z.literal("").optional(), remainingItemCount: z.literal(0).optional() }), items: z.array(z.any()) });
type ObjectMeta = z.infer<typeof metadata>;
export interface AuditScope { postgresPod: string; postgresPodUid: string; postgresUser: string; runnerId: string; namespaceUid: string }
export type AuditRead = (args: string[], input?: string) => string;
interface Claim { name: string; uid: string; resourceVersion: string; labels: Record<string, string>; deleting: boolean; owners: number }
interface Pod { name: string; uid: string; resourceVersion: string; deleting: boolean }
interface Deployment { name: string; uid: string; generation: number; images: { name: string; image: string }[]; ready: boolean }
export interface CheckedVolumeCapture { registry: unknown; claims: Claim[]; pods: Pod[]; deployments: Deployment[]; scope: AuditScope; inventoryStable: boolean }
interface Finding { code: string; volumeId?: string; ownerId?: string; workloadId?: string; claim?: string }

function requireAudit(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function distinct(values: string[], what: string): void { requireAudit(new Set(values).size === values.length, `duplicate ${what} in audit capture`); }
function ownerKey(value: z.infer<typeof owner>): string { return `${value.ownerKind}:${value.ownerId}`; }
function identity(value: z.infer<typeof owner>): string { return JSON.stringify([value.runnerId, value.organizationId, value.threadId, value.agentId]); }
function labels(value: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(persistentVolumeLabelKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

export function auditCheckedVolumes(capture: CheckedVolumeCapture) {
  const parsed = registrySchema.safeParse(capture.registry);
  requireAudit(parsed.success, "invalid read-only registry capture");
  const db: Registry = parsed.data;
  requireAudit(db.volumes.length === db.counts.volumes && db.workloads.length === db.counts.workloads && db.runners.length === db.counts.runners,
    "registry row counts do not match the capture");
  distinct(db.volumes.map(v => v.id), "volume IDs"); distinct(db.workloads.map(w => w.id), "workload IDs");
  distinct(db.runners.map(r => r.id), "runner IDs"); distinct(db.migrations, "migration versions");
  distinct(capture.claims.map(c => c.name), "claim names"); distinct(capture.claims.map(c => c.uid), "claim UIDs");
  distinct(capture.pods.map(p => p.name), "Pod names"); distinct(capture.pods.map(p => p.uid), "Pod UIDs");
  const findings: Finding[] = [];
  const add = (code: string, detail: Omit<Finding, "code"> = {}) => findings.push({ code, ...detail });
  const hasChecked = db.migrations.includes("0018_checked_volume_lifecycle.sql");
  const hasAdmission = db.migrations.includes("0019_volume_workload_admission.sql");
  const hasAdoption = db.migrations.includes("0020_legacy_volume_adoption.sql");
  const hasBackend = db.migrations.includes("0021_volume_backend_identity.sql");
  if (!db.migrations.includes("0017_workload_removal_confirmation.sql")) add("missing-workload-confirmation-migration");
  if (!hasChecked) add("missing-checked-volume-migration");
  if (!hasAdmission) add("missing-admission-migration");
  if (!hasAdoption) add("missing-legacy-adoption-migration");
  if (!hasBackend) add("missing-volume-backend-migration");
  if (hasAdmission && !hasChecked || hasAdoption && !hasAdmission || hasBackend && !hasAdoption) add("inconsistent-migration-history");
  if (hasBackend && !db.constraints.some(c => c.table === "volumes" && c.name === "volumes_checked_backend" && c.validated)) add("missing-or-unvalidated-backend-constraint");
  for (const [table, name, required] of [
    ["volumes", "volumes_checked_lifecycle", hasChecked], ["volumes", "volumes_workload_admission", hasAdmission],
    ["workloads", "workloads_volume_admission", hasAdmission], ["volumes", "volumes_legacy_adoption", hasAdoption]
  ] as const) {
    if (required && !db.triggers.some(t => t.table === table && t.name === name && ["O", "A"].includes(t.enabled))) add("missing-or-disabled-database-guard");
  }
  if (!capture.inventoryStable) add("inventory-changed-during-capture");
  if (capture.pods.length) add("native-workloads-present");
  if (capture.deployments.some(d => !d.ready)) add("client-rollout-incomplete");
  const runner = db.runners.find(r => r.id === capture.scope.runnerId);
  if (runner?.status !== "enrolled") add("selected-runner-not-enrolled");
  const volumesById = new Map(db.volumes.map(v => [v.id, v]));
  const unconfirmedByOwner = new Map<string, z.infer<typeof workload>[]>();
  for (const w of db.workloads) {
    if (!w.removalConfirmedAt) unconfirmedByOwner.set(ownerKey(w), [...(unconfirmedByOwner.get(ownerKey(w)) ?? []), w]);
  }
  const claimsByKey = new Map<string, Claim[]>();
  for (const claim of capture.claims) {
    const key = claim.labels.volume_key;
    if (!key) add("claim-missing-volume-key", { claim: claim.name });
    else claimsByKey.set(key, [...(claimsByKey.get(key) ?? []), claim]);
    if (volumesById.get(key)?.runnerId !== capture.scope.runnerId) add("unregistered-claim-retain", { claim: claim.name });
  }
  const owners = new Map<string, Volume[]>();
  for (const v of db.volumes) owners.set(ownerKey(v), [...(owners.get(ownerKey(v)) ?? []), v]);
  for (const group of owners.values()) {
    if (new Set(group.map(identity)).size !== 1) add("volume-owner-identity-conflict", { ownerId: group[0].ownerId });
    const unconfirmed = unconfirmedByOwner.get(ownerKey(group[0])) ?? [];
    if (unconfirmed.length > 1) add("multiple-unconfirmed-predecessors", { ownerId: group[0].ownerId });
    for (const w of unconfirmed) {
      add("unconfirmed-workload-retain", { ownerId: w.ownerId, workloadId: w.id });
      if (group.some(v => identity(v) !== identity(w))) add("workload-volume-owner-conflict", { workloadId: w.id, ownerId: w.ownerId });
      if (group.some(v => ["deprovisioning", "deleted"].includes(v.status))) add("deletion-with-unconfirmed-workload", { ownerId: w.ownerId });
    }
  }
  for (const w of db.workloads) {
    if (w.removalConfirmedAt && !["stopped", "failed"].includes(w.status)) add("nonterminal-removal-confirmation", { workloadId: w.id });
    if (!w.removalConfirmedAt && !owners.has(ownerKey(w))) add("unconfirmed-workload-retain", { ownerId: w.ownerId, workloadId: w.id });
  }
  const rows = db.volumes.map(v => {
    const start = findings.length;
    const issue = (code: string) => add(code, { volumeId: v.id, ownerId: v.ownerId });
    if ((v.ownerKind === "agent_instance" && (!v.agentId || !v.threadId)) ||
      (v.ownerKind === "sandbox" && (v.agentId || v.threadId))) issue("invalid-owner-shape");
    if (v.runnerId !== capture.scope.runnerId) issue("volume-outside-selected-backend");
    if (hasChecked ? v.checkedLifecycle === null || v.revision === null : v.checkedLifecycle !== null || v.revision !== null) issue("inconsistent-checked-metadata");
    if (!v.checkedLifecycle) issue("legacy-volume-requires-explicit-adoption");
    const matches = v.runnerId === capture.scope.runnerId ? claimsByKey.get(v.id) ?? [] : [];
    if (matches.length > 1) issue("ambiguous-physical-volume-key");
    if (!matches.length && !(v.checkedLifecycle && v.status === "deleted")) issue("no-physical-match-retain-record");
    const claim = matches.length === 1 ? matches[0] : undefined;
    if (claim) {
      if (v.instanceId && v.instanceId !== claim.name) issue("registry-physical-name-conflict");
      if (claim.deleting || claim.owners) issue("claim-terminating-or-controller-owned");
      const expected = { "app.kubernetes.io/managed-by": "k8s-runner", "agyn.dev/managed-by": "agents-orchestrator", "managed-by": "agents-orchestrator" };
      if (Object.entries(expected).some(([key, value]) => claim.labels[key] !== value)) issue("physical-manager-mismatch");
      if (v.ownerKind === "agent_instance") {
        if (claim.labels["agent-instance-id"] !== v.ownerId || claim.labels["agent-id"] !== v.agentId ||
          claim.labels["sandbox-id"] !== undefined || claim.labels["sandbox-owner-id"] !== undefined) issue("physical-owner-mismatch");
      } else {
        if (claim.labels["sandbox-id"] !== v.ownerId || !claim.labels["sandbox-owner-id"] ||
          claim.labels["agent-instance-id"] !== undefined || claim.labels["agent-id"] !== undefined) issue("physical-owner-mismatch");
        issue("sandbox-user-ownership-needs-agents-service");
      }
      if (["failed", "deleted"].includes(v.status)) issue("closed-record-with-physical-volume");
    }
    if (v.checkedLifecycle) {
      const bound = binding.safeParse(v.bound), removal = intent.safeParse(v.intent);
      if (v.bound !== null && (!bound.success || bound.data.volumeKey !== v.id || bound.data.instanceId !== v.instanceId ||
        bound.data.identityLabels.volume_key !== v.id || !isDeepStrictEqual(labels(bound.data.identityLabels), bound.data.identityLabels))) issue("invalid-persisted-binding");
      if (["active", "deprovisioning", "deleted"].includes(v.status) && !bound.success) issue("missing-required-binding");
      if (bound.success && v.runnerId === capture.scope.runnerId &&
        bound.data.backendId !== `kubernetes-namespace/v1/agyn-workloads/${capture.scope.namespaceUid}`) issue("bound-backend-mismatch-retain");
      if (bound.success && claim && (bound.data.instanceId !== claim.name || bound.data.instanceUid !== claim.uid ||
        !isDeepStrictEqual(bound.data.identityLabels, labels(claim.labels)))) issue("bound-incarnation-mismatch-retain");
      if (["deprovisioning", "deleted"].includes(v.status) ?
        !removal.success || !bound.success || !isDeepStrictEqual(removal.data.expected, bound.data) ||
          (v.status === "deleted") !== Boolean(removal.data.confirmedAt) : v.intent !== null) issue("invalid-persisted-removal-intent");
    } else if (v.bound !== null || v.intent !== null) issue("unchecked-record-with-binding-or-intent");
    return { volumeId: v.id, ownerId: v.ownerId, ownerKind: v.ownerKind, runnerId: v.runnerId, organizationId: v.organizationId,
      agentId: v.agentId, threadId: v.threadId, definitionId: v.definitionId, recordedInstanceId: v.instanceId, revision: v.revision, status: v.status,
      checked: v.checkedLifecycle === true, physical: matches.map(c => ({ name: c.name, uid: c.uid })),
      findingCodes: findings.slice(start).map(f => f.code) };
  });
  return { kind: "checked-volume-upgrade-audit", version: 1, at: db.at, observationalOnly: true,
    permitsAdoption: false, permitsDeletion: false, permitsRollout: false, inventoryStable: capture.inventoryStable,
    scope: capture.scope, migrations: db.migrations, deployments: capture.deployments,
    registryFingerprint: createHash("sha256").update(JSON.stringify([db.migrations, db.triggers, db.constraints, db.counts, db.volumes, db.workloads, db.runners])).digest("hex"),
    summary: { volumes: db.volumes.length, checkedVolumes: db.volumes.filter(v => v.checkedLifecycle).length,
      legacyVolumes: db.volumes.filter(v => !v.checkedLifecycle).length, physicalClaims: capture.claims.length,
      workloads: db.workloads.length, unconfirmedWorkloads: db.workloads.filter(w => !w.removalConfirmedAt).length,
      pods: capture.pods.length, findings: findings.length }, findings, volumes: rows,
    remainingRequirements: ["fence-and-drain-all-writers", "authenticate-and-pin-backend-incarnation", "review-pvc-spec-and-data-before-adoption",
      "explicit-legacy-reconciliation", "coordinated-migrations-and-clients", "full-a2a-lifecycle-acceptance"] };
}

// JSON projections deliberately exclude runtime containers, credentials, failure
// messages, runner tokens and identity material. One MVCC snapshot covers all rows.
export const checkedVolumeAuditSQL = `
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SELECT json_build_object(
  'database', current_database(), 'readOnly', current_setting('transaction_read_only'),
  'isolation', current_setting('transaction_isolation'), 'at', statement_timestamp(),
  'migrations', (SELECT COALESCE(json_agg(version ORDER BY version), '[]'::json) FROM public.schema_migrations),
  'counts', json_build_object('volumes', (SELECT count(*) FROM public.volumes), 'workloads', (SELECT count(*) FROM public.workloads), 'runners', (SELECT count(*) FROM public.runners)),
  'volumes', (SELECT COALESCE(json_agg(json_build_object(
    'id', v.id, 'definitionId', v.volume_id, 'instanceId', v.instance_id, 'sizeGb', v.size_gb,
    'ownerKind', v.owner_kind, 'ownerId', v.owner_id, 'runnerId', v.runner_id, 'organizationId', v.organization_id,
    'threadId', v.thread_id, 'agentId', v.agent_id, 'status', v.status, 'removedAt', v.removed_at,
    'checkedLifecycle', to_jsonb(v)->'checked_lifecycle', 'revision', to_jsonb(v)->'lifecycle_revision',
    'bound', to_jsonb(v)->'bound_instance', 'intent', to_jsonb(v)->'removal_intent') ORDER BY v.id), '[]'::json) FROM public.volumes v),
  'workloads', (SELECT COALESCE(json_agg(json_build_object(
    'id', w.id, 'instanceId', w.instance_id, 'ownerKind', w.owner_kind, 'ownerId', w.owner_id, 'runnerId', w.runner_id,
    'organizationId', w.organization_id, 'threadId', w.thread_id, 'agentId', w.agent_id, 'status', w.status,
    'removedAt', w.removed_at, 'removalConfirmedAt', to_jsonb(w)->'removal_confirmed_at') ORDER BY w.id), '[]'::json) FROM public.workloads w),
  'runners', (SELECT COALESCE(json_agg(json_build_object('id', r.id, 'organizationId', r.organization_id, 'status', r.status) ORDER BY r.id), '[]'::json) FROM public.runners r),
  'triggers', (SELECT COALESCE(json_agg(json_build_object('table', c.relname, 'name', t.tgname, 'enabled', t.tgenabled::text) ORDER BY c.relname,t.tgname), '[]'::json)
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('volumes','workloads') AND NOT t.tgisinternal),
  'constraints', (SELECT COALESCE(json_agg(json_build_object('table', c.relname, 'name', t.conname, 'validated', t.convalidated) ORDER BY c.relname,t.conname), '[]'::json)
    FROM pg_catalog.pg_constraint t JOIN pg_catalog.pg_class c ON c.oid=t.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('volumes','workloads') AND t.contype='c')
);
ROLLBACK;
`;

export function collectCheckedVolumeAudit(read: AuditRead, scope: AuditScope) {
  for (const value of [scope.postgresPod, scope.postgresUser]) requireAudit(/^[a-z][a-z0-9_-]{0,62}$/.test(value), "invalid audit database selector");
  for (const value of [scope.postgresPodUid, scope.namespaceUid, scope.runnerId]) requireAudit(uuid.safeParse(value).success, "explicit audit identity UUIDs required");
  const get = (args: string[]) => {
    try { return JSON.parse(read(["get", ...args, "-o", "json"])); } catch { throw new Error("audit Kubernetes read failed"); }
  };
  const meta = (value: unknown): ObjectMeta => {
    const parsed = metadata.safeParse(value); requireAudit(parsed.success, "invalid audit object identity"); return parsed.data;
  };
  const list = (value: any): any[] => {
    const parsed = completeList.safeParse(value);
    requireAudit(parsed.success, "incomplete audit inventory");
    return parsed.data.items;
  };
  const boundaries = () => {
    const ns = meta(get(["namespace", "agyn-workloads"]).metadata);
    const pg = get(["pod", scope.postgresPod, "-n", "agyn-platform"]), pm = meta(pg.metadata);
    const container = pg.status?.containerStatuses?.find((c: any) => c.name === "postgres");
    requireAudit(ns.uid === scope.namespaceUid && ns.name === "agyn-workloads" && !ns.deletionTimestamp &&
      pm.uid === scope.postgresPodUid && pm.name === scope.postgresPod && pm.namespace === "agyn-platform" && !pm.deletionTimestamp &&
      pg.status?.phase === "Running" && container?.ready === true && Number.isInteger(container.restartCount) &&
      typeof container.containerID === "string" && container.containerID.length > 0, "audit boundary identity/readiness changed");
    return { namespaceUid: ns.uid, namespaceVersion: ns.resourceVersion, postgresUid: pm.uid, containerId: container.containerID, restarts: container.restartCount };
  };
  const inventory = () => {
    const claims: Claim[] = list(get(["pvc", "-n", "agyn-workloads"])).map(c => {
      const m = meta(c.metadata); requireAudit(c.kind === "PersistentVolumeClaim" && m.namespace === "agyn-workloads", "claim outside audit scope");
      return { name: m.name, uid: m.uid, resourceVersion: m.resourceVersion, labels: labels(m.labels), deleting: Boolean(m.deletionTimestamp), owners: m.ownerReferences?.length ?? 0 };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const pods: Pod[] = list(get(["pods", "-n", "agyn-workloads"])).map(p => {
      const m = meta(p.metadata); requireAudit(p.kind === "Pod" && m.namespace === "agyn-workloads", "Pod outside audit scope");
      return { name: m.name, uid: m.uid, resourceVersion: m.resourceVersion, deleting: Boolean(m.deletionTimestamp) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const deployments: Deployment[] = list(get(["deployments", "-n", "agyn-platform"])).filter(d =>
      ["runners", "gateway", "agents-orchestrator", "k8s-runner"].includes(d.metadata?.name)).map(d => {
      const m = meta(d.metadata); requireAudit(d.kind === "Deployment" && m.namespace === "agyn-platform" && Number.isInteger(d.metadata.generation) && Array.isArray(d.spec?.template?.spec?.containers), "invalid client deployment capture");
      const images = d.spec.template.spec.containers.map((c: any) => ({ name: text.parse(c.name), image: text.parse(c.image) })).sort((a: any, b: any) => a.name.localeCompare(b.name));
      const replicas = d.spec.replicas ?? 1;
      return { name: m.name, uid: m.uid, generation: d.metadata.generation, images, ready: !m.deletionTimestamp && replicas > 0 &&
        d.status?.observedGeneration === d.metadata.generation && ["replicas", "updatedReplicas", "readyReplicas", "availableReplicas"].every(k => d.status?.[k] === replicas) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    requireAudit(deployments.length === 4 && new Set(deployments.map(d => d.name)).size === 4, "required client deployment missing or duplicated");
    return { claims, pods, deployments };
  };
  const firstBoundary = boundaries(), first = inventory();
  let registry: unknown;
  try {
    registry = JSON.parse(read(["exec", "-i", "-n", "agyn-platform", scope.postgresPod, "-c", "postgres", "--", "env",
      "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000", "psql", "-X", "-q", "-A", "-t",
      "-v", "ON_ERROR_STOP=1", "-U", scope.postgresUser, "-d", "runners", "-f", "-"], checkedVolumeAuditSQL));
  } catch { throw new Error("read-only registry audit failed"); }
  const second = inventory(), secondBoundary = boundaries();
  requireAudit(firstBoundary.namespaceUid === secondBoundary.namespaceUid && firstBoundary.postgresUid === secondBoundary.postgresUid &&
    firstBoundary.containerId === secondBoundary.containerId && firstBoundary.restarts === secondBoundary.restarts, "audit boundary replaced during capture");
  return auditCheckedVolumes({ registry, ...second, scope, inventoryStable: isDeepStrictEqual(firstBoundary, secondBoundary) && isDeepStrictEqual(first, second) });
}
