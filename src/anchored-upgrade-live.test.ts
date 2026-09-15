// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { anchoredUpgradeSQL, assertAnchoredSchema, parseAnchoredUpgradeState } from "./live/anchored-upgrade.js";

test("anchored PostgreSQL backup preserves populated recovery history and detects tampering", {
  skip: process.env.AGYN_ANCHORED_BACKUP_TEST !== "trusted-local", timeout: 180_000,
}, async t => {
  const image = process.env.AGYN_ANCHORED_TEST_POSTGRES_IMAGE ?? "", migrations = process.env.AGYN_ANCHORED_TEST_MIGRATIONS ?? "";
  assert(/^\S+@sha256:[a-f0-9]{64}$/.test(image), "explicit pinned offline PostgreSQL image required");
  assert(isAbsolute(migrations), "explicit reviewed migration directory required");
  const run = randomUUID(), runner = randomUUID();
  const scope = { postgresPod: "offline-postgres", postgresPodUid: randomUUID(), postgresUser: "agyn", runnerId: runner, namespaceUid: randomUUID() };
  const backend = `k8s:namespace:${scope.namespaceUid}`;
  let stage = "create";
  const docker = (args: string[], input?: string | Buffer): Buffer => {
    try { return execFileSync("docker", args, { input, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) {
      const code = String((error as { stderr?: Buffer }).stderr ?? "").match(/ERROR:\s+([0-9A-Z]{5})\b/)?.[1] ?? "unclassified";
      throw new Error(`offline PostgreSQL fixture failed during ${stage} (${code})`);
    }
  };
  const names: string[] = [];
  t.after(() => {
    stage = "cleanup";
    for (const name of names) {
      const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name}$`, "--filter", `label=agyn.dev/backup-fixture=${run}`])
        .toString().trim().split(/\r?\n/).filter(Boolean);
      assert(ids.length <= 1, "ambiguous offline fixture");
      for (const id of ids) {
        const identity = JSON.parse(docker(["inspect", id, "--format", '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"run":{{json (index .Config.Labels "agyn.dev/backup-fixture")}}}']).toString());
        assert.deepEqual(identity, { id, name: `/${name}`, image, run });
        docker(["rm", "--force", "--volumes", id]);
        assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${id}`]).toString().trim(), "");
      }
    }
  });
  const create = async () => {
    const name = `anchored-backup-fixture-${run}-${names.length}`; names.push(name);
    const id = docker(["create", "--pull=never", "--name", name, "--label", `agyn.dev/backup-fixture=${run}`, "--network", "none",
      "--cpus", "1", "--memory", "512m", "--pids-limit", "128", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
      "--tmpfs", "/var/run/postgresql:rw,noexec,nosuid,size=16m", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_USER=agyn",
      "-e", "POSTGRES_DB=runners", "-e", "PGDATA=/var/lib/postgresql/data", image]).toString().trim();
    assert(/^[a-f0-9]{64}$/.test(id)); docker(["start", id]);
    for (let attempt = 0; attempt < 80; attempt++) {
      try { docker(["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "agyn", "-d", "runners"]); return id; }
      catch { await delay(250); }
    }
    throw new Error("offline PostgreSQL readiness timed out");
  };
  const source = await create(), restored = await create();
  const sql = (container: string, input: string, variables: Record<string, string> = {}) => docker([
    "exec", "-i", container, "psql", "-X", "-q", "-A", "-t", "-U", "agyn", "-d", "runners", "-v", "ON_ERROR_STOP=1",
    "-v", "VERBOSITY=sqlstate", "-v", `audit_runner_id=${runner}`, ...Object.entries(variables).flatMap(([key, value]) => ["-v", `${key}=${value}`]), "-f", "-",
  ], input).toString();
  const snapshot = (container: string) => parseAnchoredUpgradeState(sql(container, anchoredUpgradeSQL), scope);
  stage = "migrations";
  sql(source, "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());");
  const versions = readdirSync(migrations).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert.equal(versions.length, 26, "review exactly the migrations through 0026");
  for (const [index, version] of versions.entries()) {
    assert.equal(Number(version.slice(0, 4)), index + 1);
    const file = join(migrations, version); assert(lstatSync(file).isFile(), "migration must be a regular file");
    sql(source, `BEGIN;\n${readFileSync(file, "utf8")}\nINSERT INTO schema_migrations(version) VALUES (:'version');\nCOMMIT;`, { version });
  }
  sql(source, "INSERT INTO runners (id, name, identity_id, service_token_hash, status) VALUES (:'audit_runner_id'::uuid, 'offline-fixture', :'identity'::uuid, 'unused-fixture-token-digest', 'enrolled');", { identity: randomUUID() });
  const saved: { kind: string; phase: string; workload: string; volume: string; reservation: unknown }[] = [];
  for (const kind of ["agent_instance", "sandbox"]) for (const phase of ["reserved", "revoked", "absent", "mixed", "retired"]) {
    await t.test(`${kind}/${phase}`, () => {
      stage = `${kind}/${phase}`;
      const owner = randomUUID(), agent = kind === "agent_instance" ? randomUUID() : "", work = randomUUID(), organization = randomUUID(), human = randomUUID();
      const ids = Array.from({ length: phase === "mixed" ? 2 : 1 }, () => randomUUID());
      const labels = { "app.kubernetes.io/managed-by": "k8s-runner", "agyn.dev/managed-by": "agents-orchestrator", "managed-by": "agents-orchestrator",
        ...(agent ? { "agent-instance-id": owner, "agent-id": agent } : { "sandbox-id": owner, "sandbox-owner-id": human }) };
      const anchor = { kind: "RESOURCE_ANCHOR_KIND_WORKLOAD", resourceId: work, backendId: backend, instanceUid: randomUUID(),
        identityLabels: { ...labels, ...(agent ? { "thread-id": randomUUID() } : {}) } };
      const anchors = ids.map(id => ({ kind: "RESOURCE_ANCHOR_KIND_VOLUME", resourceId: id, backendId: backend, instanceUid: randomUUID(), identityLabels: { ...labels, volume_key: id } }));
      const vars = { owner, agent, work, organization, kind, thread: agent ? owner : "", backend,
        ids: JSON.stringify(ids), ziti: randomUUID() };
      const ownerSQL = (input: string, extra: Record<string, string> = {}) => sql(source, input, { ...vars, ...extra });
      for (const id of ids) ownerSQL(`INSERT INTO volumes(id, volume_id, thread_id, runner_id, agent_id, organization_id, size_gb, status, owner_kind, owner_id, checked_lifecycle)
        VALUES (:'volume'::uuid, :'definition'::uuid, NULLIF(:'thread','')::uuid, :'audit_runner_id'::uuid, NULLIF(:'agent','')::uuid, :'organization'::uuid, 1, 'provisioning', :'kind', :'owner'::uuid, true);`, { volume: id, definition: randomUUID() });
      ownerSQL(`INSERT INTO workloads(id, runner_id, thread_id, agent_id, organization_id, status, containers, ziti_identity_id, allocated_cpu_millicores,
        allocated_ram_bytes, flavor, persistent_shells, owner_kind, owner_id, preparation_phase, preparation_revision, prepared_backend_id, prepared_volume_ids, resource_anchors)
        VALUES (:'work'::uuid, :'audit_runner_id'::uuid, NULLIF(:'thread','')::uuid, NULLIF(:'agent','')::uuid, :'organization'::uuid, 'starting', '[]', :'ziti'::uuid,
        100, 1048576, 'fixture', false, :'kind', :'owner'::uuid, 'reserved', 1, :'backend', ARRAY(SELECT jsonb_array_elements_text(:'ids'::jsonb)::uuid), '{"revision":"1"}');`);
      const reservation = { workloadId: work, preparationRevision: "1", resourceRevision: "1" };
      for (const a of anchors) ownerSQL(`UPDATE volumes SET resource_anchor=:'anchor'::jsonb, anchor_reservation=:'reservation'::jsonb,
        lifecycle_revision=lifecycle_revision+1 WHERE id=:'volume'::uuid;`, { volume: a.resourceId, anchor: JSON.stringify(a), reservation: JSON.stringify(reservation) });
      let revision = 2;
      const resources: Record<string, unknown> = { revision: String(revision), workload: anchor, volumes: anchors };
      ownerSQL("UPDATE workloads SET resource_anchors=:'resources'::jsonb WHERE id=:'work'::uuid;", { resources: JSON.stringify(resources) });
      const step = (phase: string, extraSQL = "") => {
        resources.revision = String(++revision);
        ownerSQL(`UPDATE workloads SET preparation_phase=:'phase', preparation_revision=preparation_revision+1,
          resource_anchors=:'resources'::jsonb ${extraSQL} WHERE id=:'work'::uuid;`, { phase, resources: JSON.stringify(resources) });
      };
      if (phase !== "reserved") {
        step("preparing"); step("removing");
        const proof = { workloadAnchor: anchor, volumeAnchors: anchors, instanceUid: randomUUID() };
        resources.preparationRevocation = proof; step("removing");
        if (phase !== "revoked") {
          const found = ["mixed", "retired"].includes(phase) ? [{ instanceId: `fixture-${ids[0]}`, volumeKey: ids[0], instanceUid: randomUUID(),
            identityLabels: anchors[0].identityLabels, backendId: backend, anchor: anchors[0] }] : [];
          for (const item of found) ownerSQL(`UPDATE volumes SET lifecycle_revision=lifecycle_revision+1, status='active',
            bound_instance=:'binding'::jsonb, instance_id=:'instance' WHERE id=:'volume'::uuid;`, { volume: item.volumeKey, instance: item.instanceId, binding: JSON.stringify(item) });
          resources.revocationObservation = { state: "REVOKED_PREPARATION_STATE_POD_ABSENT", revocation: proof,
            volumes: found, absentVolumeIds: ids.filter(id => !found.some(v => v.volumeKey === id)) };
          step("removed", ", status='stopped', removed_at=NOW(), removal_confirmed_at=NOW()");
          if (phase === "retired") {
            const intent = { id: randomUUID(), expected: found[0], requestedAt: new Date().toISOString(), anchored: true };
            ownerSQL(`UPDATE volumes SET lifecycle_revision=lifecycle_revision+1, status='deprovisioning', removal_intent=:'intent'::jsonb
              WHERE id=:'volume'::uuid;`, { volume: ids[0], intent: JSON.stringify(intent) });
            ownerSQL(`UPDATE volumes SET lifecycle_revision=lifecycle_revision+1, status='deleted', removed_at=NOW(), removal_intent=:'intent'::jsonb,
              anchored_removal_observation=:'observation'::jsonb WHERE id=:'volume'::uuid;`, { volume: ids[0],
              intent: JSON.stringify({ ...intent, confirmedAt: new Date().toISOString() }),
              observation: JSON.stringify({ state: "VOLUME_REMOVAL_STATE_ABSENT", backendId: backend, anchor: anchors[0] }) });
          }
        }
      }
      saved.push({ kind, phase, workload: work, volume: ids[0], reservation });
    });
  }
  stage = "source snapshot";
  const before = snapshot(source); assertAnchoredSchema(before);
  assert.equal(before.registry.volumes.total, 12); assert.equal(before.registry.workloads.total, 10);
  assert.deepEqual([before.recovery.workloads.anchored, before.recovery.workloads.revoked, before.recovery.workloads.observed], [10, 8, 6]);
  assert.equal(before.registry.workloads.unconfirmed, 4); assert.equal(before.recovery.volumes.retired, 2);
  assert.equal(before.recovery.pins.anchored, 10);
  stage = "dump and restore";
  const archive = docker(["exec", source, "pg_dump", "-U", "agyn", "-d", "runners", "--format=custom", "--no-owner", "--no-privileges"]);
  assert(archive.subarray(0, 5).equals(Buffer.from("PGDMP")));
  docker(["exec", "-i", restored, "pg_restore", "-U", "agyn", "-d", "runners", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges"], archive);
  assert.equal(snapshot(restored).fingerprint, before.fingerprint, "restore changed a populated lifecycle or guard definition");
  stage = "restored immutability";
  for (const row of saved.filter(r => r.phase === "revoked")) {
    assert.throws(() => sql(restored, "UPDATE workloads SET resource_anchors=resource_anchors-'preparationRevocation' WHERE id=:'id'::uuid;", { id: row.workload }), /\(55000\)/);
  }
  assert.equal(snapshot(restored).fingerprint, before.fingerprint);

  // Deliberate corruption is confined to this newly restored offline fixture.
  // It checks the backup projection independently of the registry's write guards.
  const detect = (name: string, table: string, column: string, id: string, value: string) => {
    stage = `tamper/${name}`;
    const original = sql(restored, `SELECT ${column}::text FROM ${table} WHERE id=:'id'::uuid;`, { id }).trim();
    sql(restored, `BEGIN; ALTER TABLE ${table} DISABLE TRIGGER USER; UPDATE ${table} SET ${column}=${value} WHERE id=:'id'::uuid;
      ALTER TABLE ${table} ENABLE TRIGGER USER; COMMIT;`, { id });
    const changed = snapshot(restored);
    assert.deepEqual(changed.registry, before.registry, "corruption check changed a field already covered by the prepared snapshot");
    assert.deepEqual(changed.pins, before.pins);
    assert.notEqual(changed.fingerprint, before.fingerprint, `${name} was omitted from the snapshot`);
    sql(restored, `BEGIN; ALTER TABLE ${table} DISABLE TRIGGER USER; UPDATE ${table} SET ${column}=:'original'::jsonb WHERE id=:'id'::uuid;
      ALTER TABLE ${table} ENABLE TRIGGER USER; COMMIT;`, { id, original });
    assert.equal(snapshot(restored).fingerprint, before.fingerprint);
  };
  for (const kind of ["agent_instance", "sandbox"]) {
    const pending = saved.find(r => r.kind === kind && r.phase === "revoked")!;
    const confirmed = saved.find(r => r.kind === kind && r.phase === "mixed")!;
    const retired = saved.find(r => r.kind === kind && r.phase === "retired")!;
    detect(`${kind}/proof`, "workloads", "resource_anchors", pending.workload, "jsonb_set(resource_anchors, '{preparationRevocation,instanceUid}', '\"00000000-0000-4000-8000-000000000099\"')");
    detect(`${kind}/observation`, "workloads", "resource_anchors", confirmed.workload, "jsonb_set(resource_anchors, '{revocationObservation,absentVolumeIds}', '[]')");
    detect(`${kind}/reservation`, "volumes", "anchor_reservation", pending.volume, "jsonb_set(anchor_reservation, '{resourceRevision}', '\"9007199254740993\"')");
    // This valid-shape change is rejected by the active guard, but still must be
    // fingerprinted if storage corruption removes the separate native receipt.
    detect(`${kind}/retirement`, "volumes", "anchored_removal_observation", retired.volume, "NULL");
  }
  stage = "same-name function replacement";
  const originalFunction = sql(restored, "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='guard_resource_anchor_owner';");
  sql(restored, "CREATE OR REPLACE FUNCTION guard_resource_anchor_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;");
  assert.notEqual(snapshot(restored).fingerprint, before.fingerprint, "same-name weakened guard was invisible");
  sql(restored, originalFunction);
  assert.equal(snapshot(restored).fingerprint, before.fingerprint);
  stage = "same-name constraint replacement";
  const definitionSQL = "SELECT pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conname='runtime_prepared_pin';";
  const originalConstraint = sql(restored, definitionSQL).trim();
  assert.equal(originalConstraint, sql(source, definitionSQL).trim(), "PostgreSQL constraint deparsing changed across restore");
  sql(restored, "BEGIN; ALTER TABLE runtime_volume_admission_guards DROP CONSTRAINT runtime_prepared_pin; ALTER TABLE runtime_volume_admission_guards ADD CONSTRAINT runtime_prepared_pin CHECK (true); COMMIT;");
  assert.notEqual(snapshot(restored).fingerprint, before.fingerprint, "same-name weakened constraint was invisible");
  sql(restored, `BEGIN; ALTER TABLE runtime_volume_admission_guards DROP CONSTRAINT runtime_prepared_pin;
    ALTER TABLE runtime_volume_admission_guards ADD CONSTRAINT runtime_prepared_pin ${originalConstraint}; COMMIT;`);
  assert.equal(snapshot(restored).fingerprint, before.fingerprint);
  assert.equal(snapshot(source).fingerprint, before.fingerprint, "restore tests changed the source database");
  t.diagnostic("10 valid histories, 4 pending workloads, mixed found/absent workspaces, 2 retirements, 8 document corruption checks and same-name function/constraint replacement verified; no installed database or agent was used");
});
