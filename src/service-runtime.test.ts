// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { requireSqliteWalFix, SqliteRuntimeError } from "./service/sqlite-runtime.js";

test("SQLite runtime: known fixed releases and their backport branches are accepted", () => {
  for (const version of ["3.51.3", "3.51.4", "3.52.0", "3.53.4", "3.50.7", "3.50.8", "3.44.6", "3.44.7", "4.0.0"]) {
    assert.doesNotThrow(() => requireSqliteWalFix(version), version);
  }
});

test("SQLite runtime: vulnerable, missing and malformed versions are rejected", () => {
  for (const version of [undefined, "", "3.7.0", "3.44.5", "3.45.0", "3.49.7", "3.50.4", "3.50.6", "3.51.0", "3.51.2",
    "2.99.9", "3.51.3-custom", "3.51", "3.51.3.1", "v3.51.3", "99999999999999999999.1.1"]) {
    assert.throws(() => requireSqliteWalFix(version), SqliteRuntimeError, String(version));
  }
});

for (const entry of ["main", "admission-cli"]) {
  test(`SQLite runtime: ${entry} refuses an unpatched runtime before modifying the task database`, t => {
    const directory = mkdtempSync(join(tmpdir(), "a2a-sqlite-version-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "tasks.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE preserved (id INTEGER PRIMARY KEY)"); db.close();
    const before = readFileSync(path);
    const config = join(directory, "config.json");
    writeFileSync(config, JSON.stringify({ environmentProfile: "trusted-local", dbPath: path,
      credentialsFile: join(directory, "credentials.json"), reportingSetupExecutable: "/bin/false",
      publicUrl: "http://127.0.0.1:8083", reportingUrl: "http://127.0.0.1:8083/reporting", defaultProfile: "agent",
      profiles: [{ id: "agent", agentId: "00000000-0000-0000-0000-000000000001" }] }));
    const preload = "data:text/javascript," + encodeURIComponent("Object.defineProperty(process.versions,'sqlite',{value:'3.50.4'});");
    const args = ["--import", preload, new URL(`./service/${entry}.js`, import.meta.url).pathname];
    if (entry === "admission-cli") args.push("--db", path, "--expect", "2", "--max-active", "1");
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH, A2A_SERVICE_CONFIG_FILE: config } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /requires SQLite with the WAL-reset fix/);
    assert.equal(result.stdout, "");
    assert.deepEqual(readFileSync(path), before);
  });
}
