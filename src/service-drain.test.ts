// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Message } from "@a2a-js/sdk";
import { DurableTaskStore, TaskStoreError } from "./service/task-store.js";

const scope = { tenant: "tenant", subject: "operator" };
const message = () => Message.fromJSON({ messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "work" }] });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "a2a-drain-"));
  const path = join(directory, "tasks.sqlite");
  let now = 1000;
  const stores: DurableTaskStore[] = [];
  const open = () => { const store = new DurableTaskStore(path, { clock: () => now }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, store: open(), open, advance: () => { now += 1000; } };
}

test("drain: persisted switch closes new work across connections but keeps exact retries", t => {
  const f = fixture(t);
  const input = message();
  const submitted = f.store.submit(scope, input, "agent");
  const second = f.open();
  f.store.changeAdmissionControl(0, false, "  maintenance  ");
  assert.deepEqual(second.admissionControl(), { generation: 1, open: false, reason: "maintenance", changedAt: 1000 });
  assert.equal(second.submit(scope, input, "agent").execution.id, submitted.execution.id);
  assert.throws(() => second.submit(scope, message(), "agent"), (error: unknown) => error instanceof TaskStoreError && error.code === "capacity");
  assert.equal(second.claim("worker", 100, 2), undefined);
  assert.equal(f.open().admissionControl().open, false);
  second.changeAdmissionControl(1, true, "operator verified maintenance complete");
  assert.equal(f.store.claim("worker", 100, 2)?.execution.id, submitted.execution.id);
});

test("drain: recovery keeps the same reservation and never claims queued replacement work", t => {
  const f = fixture(t);
  f.store.submit(scope, message(), "agent");
  const claimed = f.store.claim("old", 100, 2)!;
  const queued = f.store.submit(scope, message(), "agent");
  f.store.changeAdmissionControl(0, false, "drain");
  f.advance();
  const recovered = f.open().claim("replacement", 100, 2)!;
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.execution.id, claimed.execution.id);
  assert.equal(recovered.lease.generation, claimed.lease.generation + 1);
  assert.equal(f.store.execution(queued.execution.id)?.phase, "queued");
  assert.equal(f.store.claim("another", 100, 2), undefined);
  assert.throws(() => f.store.heartbeat(claimed.lease, 100), (error: unknown) => error instanceof TaskStoreError && error.code === "stale_lease");
});

test("drain: stale reopening is rejected and changes retain atomic audit records", t => {
  const f = fixture(t);
  f.store.changeAdmissionControl(0, false, "planned maintenance");
  assert.throws(() => f.open().changeAdmissionControl(0, true, "stale decision"), (error: unknown) => error instanceof TaskStoreError && error.code === "conflict");
  for (const generation of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => f.store.changeAdmissionControl(generation, true, "invalid"));
  }
  assert.throws(() => f.store.changeAdmissionControl(1, true, " "));
  const db = new DatabaseSync(f.path);
  try {
    assert.deepEqual(db.prepare("SELECT generation,open,reason FROM admission_control_audit").all().map(row => ({ ...row })),
      [{ generation: 1, open: 0, reason: "planned maintenance" }]);
  } finally { db.close(); }
});

test("drain: database trigger also rejects queued activation from an old writer", t => {
  const f = fixture(t);
  const queued = f.store.submit(scope, message(), "agent");
  f.store.changeAdmissionControl(0, false, "maintenance");
  const db = new DatabaseSync(f.path);
  try {
    assert.throws(() => db.prepare("UPDATE task_executions SET phase='provisioning' WHERE id=?").run(queued.execution.id), /admission is closed/);
  } finally { db.close(); }
  assert.equal(f.store.execution(queued.execution.id)?.phase, "queued");
});

test("drain CLI: requires explicit generation/reason and cannot mix limit and control changes", t => {
  const f = fixture(t);
  const command = new URL("./service/admission-cli.js", import.meta.url);
  const run = (...args: string[]) => spawnSync(process.execPath, [command.pathname, "--db", f.path, ...args], { encoding: "utf8", timeout: 5000 });
  assert.equal(JSON.parse(run("--control").stdout).generation, 0);
  const close = run("--admission", "closed", "--expect-generation", "0", "--reason", "maintenance");
  assert.equal(close.status, 0, close.stderr);
  assert.equal(JSON.parse(close.stdout).open, false);
  for (const args of [["--admission", "open"], ["--reason", "alone"],
    ["--admission", "open", "--expect-generation", "1", "--reason", "resume", "--expect", "1", "--max-active", "2"]]) {
    assert.equal(run(...args).status, 1);
  }
  assert.equal(run("--admission", "open", "--expect-generation", "0", "--reason", "stale").status, 1);
  assert.equal(f.store.admissionControl().open, false);
});
