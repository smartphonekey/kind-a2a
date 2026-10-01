// SPDX-License-Identifier: AGPL-3.0-only
/** WAL-consistent SQLite rehearsal copies, permanently held away from execution. @module */
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync, mkdtempSync, chmodSync, openSync, fsyncSync, closeSync, writeFileSync, renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableTaskStore } from "./task-store.js";
import { requireSqliteWalFix } from "./sqlite-runtime.js";

function privateOwned(path: string, directory: boolean): void {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error("canonical absolute path required");
  const info = lstatSync(path);
  if ((directory ? !info.isDirectory() : !info.isFile()) || !process.getuid || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error("private owned path required");
  }
}
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function sync(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }

/**
 * Read a trusted source; create only a new private output directory. Never restore in place.
 * @remarks A consistent A2A snapshot is not a multi-database or workspace backup. The hold
 * intentionally has no release command: copied queued work may have executed after capture.
 */
export async function rehearseSnapshot(sourcePath: string, outputRoot: string) {
  requireSqliteWalFix(process.versions.sqlite);
  privateOwned(sourcePath, false); privateOwned(outputRoot, true);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let directory: string | undefined;
  try {
    source.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
    source.prepare("SELECT id,tenant,subject,context_id,profile_id FROM execution_tasks LIMIT 0").get();
    source.prepare("SELECT id,task_id,phase FROM task_executions LIMIT 0").get();
    directory = mkdtempSync(join(outputRoot, "a2a-restore-rehearsal-"));
    const pending = join(directory, ".pending.sqlite");
    let database = pending;
    source.prepare("VACUUM INTO ?").run(database);
    chmodSync(database, 0o600);
    const snapshotSha256 = await sha256(database);
    const copy = new DurableTaskStore(database);
    try { copy.quarantineRestoredCopy(snapshotSha256, "Offline restore rehearsal; never resume automatically"); }
    finally { copy.close(); }
    const verify = new DatabaseSync(database, { readOnly: true });
    let taskCount: number, executionCount: number;
    try {
      const checks = verify.prepare("PRAGMA integrity_check").all();
      if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok" || verify.prepare("PRAGMA foreign_key_check").all().length) {
        throw new Error("restored database integrity check failed");
      }
      taskCount = Number((verify.prepare("SELECT count(*) AS n FROM execution_tasks").get() as { n: number }).n);
      executionCount = Number((verify.prepare("SELECT count(*) AS n FROM task_executions").get() as { n: number }).n);
    } finally { verify.close(); }
    sync(database);
    database = join(directory, "tasks.sqlite");
    renameSync(pending, database);
    sync(directory);
    const receipt = { version: 1, kind: "a2a-sqlite-restore-rehearsal", snapshotSha256,
      quarantinedDatabaseSha256: await sha256(database), taskCount, executionCount, integrityVerified: true,
      executionQuarantined: true, sourceOpenedReadOnly: true, wholeStackRecoveryVerified: false,
      createdAt: new Date().toISOString() };
    const path = join(directory, "receipt.json");
    writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    sync(path); sync(directory);
    return { directory, database, receipt };
  } catch (error) {
    if (directory) writeFileSync(join(directory, "failure.json"), JSON.stringify({ kind: "a2a-snapshot-failed", verified: false }) + "\n", { mode: 0o600, flag: "wx" });
    throw error;
  } finally { source.close(); }
}
