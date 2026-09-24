// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

// Synthetic native evidence is confined to a newly owned offline PostgreSQL
// fixture. Real native/registry migration is covered by the Go process matrix.
export function seedVolumeMigrationBackupHistories(sql: (input: string, variables?: Record<string, string>) => string, runner: string, backend: string) {
  const rows: { owner: string; volume: string; phase: string }[] = [];
  for (const kind of ["agent_instance", "sandbox"]) for (const phase of ["planned", "reserved", "applied", "ready", "complete", "quarantine"]) {
    const owner = randomUUID(), agent = kind === "agent_instance" ? randomUUID() : "", volume = randomUUID(), organization = randomUUID();
    const vars = { runner, owner, agent, thread: agent ? owner : "", volume, organization, kind, definition: randomUUID() };
    const run = (input: string, extra: Record<string, string> = {}) => sql(input, { ...vars, ...extra });
    const previous = { instanceId: `fixture-${volume}`, instanceUid: randomUUID(), volumeKey: volume, backendId: backend,
      identityLabels: { "app.kubernetes.io/managed-by": "k8s-runner", "agyn.dev/managed-by": "agents-orchestrator", "managed-by": "agents-orchestrator", volume_key: volume,
        ...(agent ? { "agent-instance-id": owner, "agent-id": agent } : { "sandbox-id": owner, "sandbox-owner-id": randomUUID() }) } };
    const intent = { kind: "RESOURCE_ANCHOR_KIND_VOLUME", resourceId: volume, backendId: backend, identityLabels: previous.identityLabels };
    run(`INSERT INTO volumes(id,volume_id,thread_id,runner_id,agent_id,organization_id,size_gb,status,owner_kind,owner_id,checked_lifecycle)
      VALUES (:'volume'::uuid,:'definition'::uuid,NULLIF(:'thread','')::uuid,:'runner'::uuid,NULLIF(:'agent','')::uuid,:'organization'::uuid,1,
      ${phase === "quarantine" ? "'failed'" : "'provisioning'"},:'kind',:'owner'::uuid,${phase !== "quarantine"});`);
    if (phase !== "quarantine") run(`UPDATE volumes SET lifecycle_revision=lifecycle_revision+1,status='active',instance_id=:'instance',bound_instance=:'binding'::jsonb WHERE id=:'volume'::uuid;`,
      { instance: previous.instanceId, binding: JSON.stringify(previous) });
    const entry: Record<string, unknown> = phase === "quarantine"
      ? { source: { volumeId: volume, expectedRevision: "1" }, unresolvedReason: "unbound_failed_generation" }
      : { source: { volumeId: volume, expectedRevision: "2", previous }, checkedRevision: "2", adoptionId: randomUUID(), intent };
    const doc: Record<string, unknown> = { id: randomUUID(), ownerKind: kind === "agent_instance" ? "RUNTIME_OWNER_KIND_AGENT_INSTANCE" : "RUNTIME_OWNER_KIND_SANDBOX",
      ownerId: owner, runnerId: runner, organizationId: organization, backendId: backend, revision: "1", entries: [entry] };
    const persist = (extra = "") => run(`UPDATE runtime_volume_admission_guards SET volume_anchor_migration=:'document'::jsonb ${extra} WHERE owner_kind=:'kind' AND owner_id=:'owner'::uuid;`,
      { document: JSON.stringify(doc), backend });
    persist();
    if (!["planned", "quarantine"].includes(phase)) {
      const adoption = { id: entry.adoptionId, previous, anchor: { ...intent, instanceUid: randomUUID() }, instanceUid: randomUUID(), pvcSpecSha256: "a".repeat(64) };
      entry.adoption = adoption; doc.revision = "2"; persist();
      if (phase !== "reserved") {
        const binding = { ...previous, anchor: adoption.anchor };
        entry.applied = { adoption, volume: binding, state: "VOLUME_ANCHOR_ADOPTION_STATE_APPLIED" }; doc.revision = "3"; persist();
        run(`UPDATE volumes SET lifecycle_revision=lifecycle_revision+1,bound_instance=:'binding'::jsonb,resource_anchor=:'anchor'::jsonb,anchor_adoption=:'adoption'::jsonb WHERE id=:'volume'::uuid;`,
          { binding: JSON.stringify(binding), anchor: JSON.stringify(adoption.anchor), adoption: JSON.stringify(adoption) });
        if (["ready", "complete"].includes(phase)) {
          entry.ready = { adoption, volume: binding, state: "VOLUME_ANCHOR_ADOPTION_STATE_READY" }; doc.revision = "4"; persist();
          if (phase === "complete") {
            doc.complete = true; doc.revision = "5";
            persist(`,resource_anchors_required=true,prepared_backend_id=:'backend',prepared_runner_id=:'runner'::uuid,
              prepared_organization_id=:'organization'::uuid,prepared_thread_id=NULLIF(:'thread','')::uuid,prepared_agent_id=NULLIF(:'agent','')::uuid`);
          }
        }
      }
    }
    rows.push({ owner, volume, phase });
  }
  return rows;
}
