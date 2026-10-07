#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Inspect or compare-and-set shared admission policy without provider access.
 * @module
 * @remarks Only an existing absolute regular database file is accepted, never a symlink.
 * A read-only service-table probe precedes additive schema initialization, so even
 * inspection can initialize schema. Limit changes require the expected value and
 * zero reservations. Admission switches require a generation and audit reason;
 * closing preserves queued work and lets existing reservations drain. Profile limits
 * follow worker configuration (DurableTaskStore.configureAdmission); --profiles only reads them.
 * @see src/service/task-store.ts
 * @see src/service/sqlite-runtime.ts
 */
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DurableTaskStore, TaskStoreError } from "./task-store.js";
import { requireSqliteWalFix, SqliteRuntimeError } from "./sqlite-runtime.js";

function main(): void {
  const { values } = parseArgs({ options: { db: { type: "string" }, expect: { type: "string" }, "max-active": { type: "string" },
    control: { type: "boolean" }, profiles: { type: "boolean" }, admission: { type: "string" }, "expect-generation": { type: "string" },
    reason: { type: "string" } },
    strict: true, allowPositionals: false });
  const path = z.string().refine(isAbsolute).parse(values.db);
  if (!lstatSync(path).isFile()) throw new Error("existing regular database file required");
  if ((values.expect === undefined) !== (values["max-active"] === undefined)) throw new Error("both limit arguments required");
  const limit = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().min(1).max(32));
  const change = values.expect === undefined ? undefined : {
    expected: limit.parse(values.expect), maxActive: limit.parse(values["max-active"])
  };
  const controlArgs = [values.admission, values["expect-generation"], values.reason];
  const changingControl = controlArgs.some(value => value !== undefined);
  if ((changingControl && controlArgs.some(value => value === undefined)) || ((changingControl || values.control) && change)) {
    throw new Error("admission control requires all control arguments and cannot be combined with limit changes");
  }
  if (values.profiles && (change || changingControl || values.control)) throw new Error("--profiles only inspects");
  const control = changingControl ? {
    open: z.enum(["open", "closed"]).parse(values.admission) === "open",
    generation: z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(z.number().int().safe().nonnegative()).parse(values["expect-generation"]),
    reason: z.string().trim().min(1).max(4096).parse(values.reason)
  } : undefined;
  requireSqliteWalFix(process.versions.sqlite);
  const existing = new DatabaseSync(path, { readOnly: true });
  try {
    existing.prepare("SELECT id,tenant,subject,context_id,profile_id FROM execution_tasks LIMIT 0").get();
    existing.prepare("SELECT id,task_id,phase FROM task_executions LIMIT 0").get();
  } finally { existing.close(); }
  const store = new DurableTaskStore(path);
  try {
    const admission = control ? store.changeAdmissionControl(control.generation, control.open, control.reason)
      : values.control ? store.admissionControl()
      : values.profiles ? store.profileAdmission()
      : change ? store.changeAdmissionLimit(change.expected, change.maxActive) : store.admission();
    process.stdout.write(JSON.stringify(admission) + "\n");
  } finally { store.close(); }
}

try { main(); }
catch (error) {
  process.stderr.write(error instanceof TaskStoreError ? `${error.code}: ${error.message}\n`
    : error instanceof SqliteRuntimeError ? `${error.message}\n`
    : "Usage: admission-cli --db /absolute/existing/tasks.sqlite [--expect N --max-active N | --control | --profiles | --admission open|closed --expect-generation N --reason TEXT] (limits 1-32)\n");
  process.exitCode = 1;
}
