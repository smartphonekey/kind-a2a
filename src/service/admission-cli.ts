#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DurableTaskStore, TaskStoreError } from "./task-store.js";
import { requireSqliteWalFix, SqliteRuntimeError } from "./sqlite-runtime.js";

function main(): void {
  const { values } = parseArgs({ options: { db: { type: "string" }, expect: { type: "string" }, "max-active": { type: "string" } },
    strict: true, allowPositionals: false });
  const path = z.string().refine(isAbsolute).parse(values.db);
  if (!lstatSync(path).isFile()) throw new Error("existing regular database file required");
  if ((values.expect === undefined) !== (values["max-active"] === undefined)) throw new Error("both limit arguments required");
  const limit = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().min(1).max(32));
  const change = values.expect === undefined ? undefined : {
    expected: limit.parse(values.expect), maxActive: limit.parse(values["max-active"])
  };
  requireSqliteWalFix(process.versions.sqlite);
  const existing = new DatabaseSync(path, { readOnly: true });
  try {
    existing.prepare("SELECT id,tenant,subject,context_id,profile_id FROM execution_tasks LIMIT 0").get();
    existing.prepare("SELECT id,task_id,phase FROM task_executions LIMIT 0").get();
  } finally { existing.close(); }
  const store = new DurableTaskStore(path);
  try {
    const admission = change ? store.changeAdmissionLimit(change.expected, change.maxActive) : store.admission();
    process.stdout.write(JSON.stringify(admission) + "\n");
  } finally { store.close(); }
}

try { main(); }
catch (error) {
  process.stderr.write(error instanceof TaskStoreError ? `${error.code}: ${error.message}\n`
    : error instanceof SqliteRuntimeError ? `${error.message}\n`
    : "Usage: admission-cli --db /absolute/existing/tasks.sqlite [--expect N --max-active N] (limits 1-32)\n");
  process.exitCode = 1;
}
