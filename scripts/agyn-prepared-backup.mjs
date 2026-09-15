// SPDX-License-Identifier: AGPL-3.0-only
// Read the installed registry; restore and migrate only a disposable offline copy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertPreparedSchema, collectPreparedUpgradeState, parsePreparedUpgradeState, preparedUpgradeSQL } from "../dist/live/prepared-upgrade.js";
import { anchoredMigrations, anchoredUpgradeSQL, assertAnchoredHistoryUnchanged, assertAnchoredSchema,
  collectAnchoredUpgradeState, parseAnchoredUpgradeState } from "../dist/live/anchored-upgrade.js";

const run = randomUUID(), name = `agyn-prepared-backup-${run}`;
let directory, createAttempted = false, stage = "configuration", cleanupConfirmed = false, receipt, verifySource;
const command = (program, args, input, timeout = 30_000) => execFileSync(program, args, {
  input, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"]
});
const docker = (args, input, timeout) => command("docker", args, input, timeout);
const image = process.env.AGYN_PREPARED_POSTGRES_IMAGE;
try {
  assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local");
  const contract = process.env.AGYN_PREPARED_BACKUP_CONTRACT ?? "prepared-through-0022";
  assert(["prepared-through-0022", "resource-anchors-through-0026"].includes(contract), "unknown backup contract");
  const anchored = contract === "resource-anchors-through-0026";
  const collect = anchored ? collectAnchoredUpgradeState : collectPreparedUpgradeState;
  const parse = anchored ? parseAnchoredUpgradeState : parsePreparedUpgradeState;
  const snapshotSQL = anchored ? anchoredUpgradeSQL : preparedUpgradeSQL;
  const root = process.env.AGYN_AUDIT_OUTPUT_DIR, kubeconfig = process.env.AGYN_KUBECONFIG;
  const migrations = process.env.AGYN_PREPARED_REGISTRY_MIGRATIONS;
  assert(isAbsolute(root ?? "") && isAbsolute(kubeconfig ?? "") && isAbsolute(migrations ?? ""));
  const rootInfo = lstatSync(root);
  assert(rootInfo.isDirectory() && rootInfo.uid === process.getuid() && (rootInfo.mode & 0o077) === 0, "private owned backup directory required");
  assert(/^\S+@sha256:[a-f0-9]{64}$/.test(image ?? ""), "explicit digest-pinned PostgreSQL image required");
  const scope = { postgresPod: process.env.AGYN_AUDIT_POSTGRES_POD ?? "", postgresPodUid: process.env.AGYN_AUDIT_POSTGRES_UID ?? "",
    postgresUser: process.env.AGYN_AUDIT_POSTGRES_USER ?? "", runnerId: process.env.AGYN_AUDIT_RUNNER_ID ?? "", namespaceUid: process.env.AGYN_AUDIT_NAMESPACE_UID ?? "" };
  const k = (args, input) => command("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=20s", ...args], input);
  stage = "source-snapshot";
  const before = collect(k, scope);
  if (!anchored) assert.equal(before.registry.workloads.unconfirmed, 0, "drain unconfirmed workloads before backup rehearsal");
  verifySource = () => assert.equal(collect(k, scope).fingerprint, before.fingerprint, "source changed during backup rehearsal");
  directory = mkdtempSync(join(root, "backup-"));
  const save = (file, value) => writeFileSync(join(directory, file), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  save("source.json", before);
  stage = "source-dump";
  const archive = execFileSync("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=180s", "exec", "-n", "agyn-platform", scope.postgresPod, "-c", "postgres", "--",
    "env", "PGOPTIONS=-c default_transaction_read_only=on -c lock_timeout=2000", "pg_dump", "-U", scope.postgresUser, "-d", "runners",
    "--format=custom", "--no-owner", "--no-privileges", "--lock-wait-timeout=2s"],
  { timeout: 180_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  assert(archive.subarray(0, 5).equals(Buffer.from("PGDMP")), "source did not produce a custom PostgreSQL archive");
  writeFileSync(join(directory, "runners.dump"), archive, { flag: "wx", mode: 0o600 });
  verifySource();
  stage = "offline-database-create";
  createAttempted = true;
  const container = docker(["create", "--pull=never", "--name", name, "--label", `agyn.dev/backup-run=${run}`, "--network", "none",
    "--cpus", "1", "--memory", "512m", "--pids-limit", "128", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
    "--tmpfs", "/var/run/postgresql:rw,noexec,nosuid,size=16m", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_USER=agyn",
    "-e", "POSTGRES_DB=runners", "-e", "PGDATA=/var/lib/postgresql/data", image]).trim();
  assert(/^[a-f0-9]{64}$/.test(container), "invalid disposable container identity");
  docker(["start", container]);
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    // The image's temporary initialization server accepts Unix sockets only.
    try { docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "agyn", "-d", "runners"]); ready = true; break; }
    catch { await delay(250); }
  }
  assert(ready, "disposable PostgreSQL did not become ready");
  stage = "offline-restore";
  docker(["exec", "-i", container, "pg_restore", "-U", "agyn", "-d", "runners", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges"], archive, 120_000);
  stage = "restored-snapshot";
  const sql = input => docker(["exec", "-i", container, "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-v", `audit_runner_id=${scope.runnerId}`, "-U", "agyn", "-d", "runners", "-f", "-"], input);
  const restored = parse(sql(snapshotSQL), scope);
  save("restored.json", restored);
  stage = "restore-comparison";
  assert.equal(restored.fingerprint, before.fingerprint, "restored lifecycle differs from source");
  stage = "offline-migrations";
  const applied = [];
  const versions = anchored ? anchoredMigrations : ["0018_checked_volume_lifecycle.sql", "0019_volume_workload_admission.sql", "0020_legacy_volume_adoption.sql", "0021_volume_backend_identity.sql", "0022_prepared_workloads.sql"];
  for (const version of versions) {
    if (before.registry.migrations.includes(version)) continue;
    const file = join(migrations, version); assert(lstatSync(file).isFile(), "migration must be a regular file");
    const source = readFileSync(file, "utf8");
    sql(`BEGIN;\nSET LOCAL statement_timeout = '20s';\nSET LOCAL lock_timeout = '2s';\n${source}\nINSERT INTO schema_migrations (version) VALUES ('${version}');\nCOMMIT;\n`);
    applied.push({ version, sha256: createHash("sha256").update(source).digest("hex") });
  }
  const upgradedOutput = sql(snapshotSQL), upgraded = parse(upgradedOutput, scope);
  if (anchored) {
    assertAnchoredSchema(upgraded);
    assertAnchoredHistoryUnchanged(before, upgraded);
    writeFileSync(join(directory, "rehearsal-state.jsonl"), upgradedOutput, { flag: "wx", mode: 0o600 });
  } else {
    assertPreparedSchema(upgraded);
    assert.deepEqual(upgraded.registry.volumes, before.registry.volumes, "migration rewrote volume lifecycle or adopted legacy storage");
    assert.deepEqual(upgraded.registry.workloads, before.registry.workloads, "migration rewrote workload history or inferred preparation");
    assert.equal(upgraded.pins.prepared, before.pins.prepared, "migration invented prepared owner pins");
  }
  save("rehearsal.json", { state: upgraded, migrations: applied });
  verifySource();
  receipt = { kind: anchored ? "anchored-upgrade-restored-backup" : "prepared-upgrade-restored-backup", version: 1,
    ...(anchored ? { snapshotContract: contract } : {}), scope, sourceFingerprint: before.fingerprint, restoredFingerprint: restored.fingerprint,
    archiveSha256: createHash("sha256").update(archive).digest("hex"), postgresImage: image, restoredAt: new Date().toISOString(),
    rehearsal: { schemaVerified: true, migrations: applied, legacyHistoryUnchanged: true, fingerprint: upgraded.fingerprint }, installedDatabaseModified: false };
  stage = "offline-cleanup";
} catch (error) {
  const raw = String(error?.stderr ?? "");
  const cause = [
    ["schema-already-exists", /schema .* already exists/], ["role-missing", /role .* does not exist/],
    ["unsupported-archive-version", /unsupported version .* in file header/], ["insufficient-space", /No space left on device/],
    ["archive-input-incomplete", /input file is too short|could not read from input file|does not appear to be a valid archive/],
    ["relation-already-exists", /relation .* already exists/], ["connection-unavailable", /could not connect to server|connection to server .* failed/]
  ].find(([, pattern]) => pattern.test(raw))?.[0] ?? (error?.code === "ERR_ASSERTION" ? "verification-mismatch" : "unclassified");
  if (directory) writeFileSync(join(directory, "failure.json"), JSON.stringify({ stage, cause }, null, 2), { flag: "wx", mode: 0o600 });
  console.error(`Prepared backup failed during ${stage} (${cause}); no installed migration or deployment change was authorized.`);
  process.exitCode = 1;
} finally {
  if (createAttempted) {
    try {
      const ids = docker(["ps", "-a", "-q", "--no-trunc", "--filter", `name=^/${name}$`, "--filter", `label=agyn.dev/backup-run=${run}`]).trim().split(/\r?\n/).filter(Boolean);
      assert(ids.length <= 1, "ambiguous disposable database identity");
      if (ids.length) {
        const selected = JSON.parse(docker(["inspect", ids[0], "--format", '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"run":{{json (index .Config.Labels "agyn.dev/backup-run")}}}']));
        assert(selected.id === ids[0] && selected.name === `/${name}` && selected.image === image && selected.run === run);
        docker(["rm", "--force", "--volumes", selected.id]);
        assert.equal(docker(["ps", "-a", "-q", "--no-trunc", "--filter", `id=${selected.id}`]).trim(), "", "disposable database is still present");
      }
      cleanupConfirmed = true;
    } catch {
      console.error(`Prepared backup cleanup requires reconciliation for run ${run}; no unrelated container was selected.`);
      process.exitCode = 1;
    }
  }
  if (directory) writeFileSync(join(directory, "cleanup.json"), JSON.stringify({ run, name, createAttempted, cleanupConfirmed, stage }, null, 2), { flag: "wx", mode: 0o600 });
  if (receipt && cleanupConfirmed && !process.exitCode) {
    try {
      verifySource();
      writeFileSync(join(directory, "receipt.json"), JSON.stringify({ ...receipt, cleanupConfirmed }, null, 2), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ kind: receipt.kind, directory, sourceFingerprint: receipt.sourceFingerprint,
        migrationsRehearsed: receipt.rehearsal.migrations.length, installedDatabaseModified: false, cleanupConfirmed }));
    } catch {
      writeFileSync(join(directory, "failure.json"), JSON.stringify({ stage: "source-after-cleanup", cause: "verification-mismatch" }), { flag: "wx", mode: 0o600 });
      console.error("Registry backup source changed after offline cleanup; no restore receipt was issued.");
      process.exitCode = 1;
    }
  }
}
