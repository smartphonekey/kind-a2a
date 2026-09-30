// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, lstatSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Message } from "@a2a-js/sdk";
import { DurableTaskStore } from "./service/task-store.js";
import { ExecutionWorker, type RuntimeDriver } from "./service/worker.js";
import { rehearseSnapshot } from "./service/snapshot.js";
const scope = { tenant: "tenant", subject: "owner" };
const message = () => Message.fromJSON({ messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "private task" }] });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "a2a-snapshot-test-"));
  const path = join(directory, "source.sqlite");
  const store = new DurableTaskStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, store };
}

test("snapshot: WAL-consistent copy retains state but blocks new and recovered claims", async t => {
  const f = fixture(t);
  const first = f.store.submit(scope, message(), "agent");
  const lease = f.store.claim("source-worker", 1, 2)!.lease;
  const queuedMessage = message();
  const queued = f.store.submit(scope, queuedMessage, "agent");
  const before = f.store.events(scope, first.task.id);
  const result = await rehearseSnapshot(f.path, f.directory);
  assert.equal(result.receipt.taskCount, 2);
  assert.equal(result.receipt.executionCount, 2);
  assert.equal(result.receipt.wholeStackRecoveryVerified, false);
  assert.equal(result.receipt.quarantinedDatabaseSha256, createHash("sha256").update(readFileSync(result.database)).digest("hex"));
  assert.equal(lstatSync(result.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(result.database).mode & 0o777, 0o600);
  assert.deepEqual(f.store.events(scope, first.task.id), before);
  assert.equal(f.store.restoreQuarantined(), false);
  const copy = new DurableTaskStore(result.database);
  try {
    assert.equal(copy.execution(first.execution.id)?.generation, lease.generation);
    assert.equal(copy.execution(queued.execution.id)?.phase, "queued");
    assert.equal(copy.claim("replacement", 100, 2), undefined);
    assert.throws(() => copy.submit(scope, message(), "agent"), /quarantined/);
    assert.equal(copy.submit(scope, queuedMessage, "agent").duplicate, true);
    copy.changeAdmissionControl(copy.admissionControl().generation, true, "ordinary admission must not clear restore hold");
    assert.equal(copy.claim("replacement", 100, 2), undefined);
    assert.throws(() => copy.assertNotQuarantined(), /quarantined/);
    let calls = 0;
    const operation = async (): Promise<never> => { calls++; throw new Error("must not run"); };
    const driver: RuntimeDriver = { provision: operation, prepare: operation, dispatch: operation, observe: operation, release: operation };
    assert.throws(() => new ExecutionWorker(copy, driver, { concurrency: 2, leaseMs: 30, pollMs: 5, turnTimeoutMs: 100 }), /quarantined/);
    assert.equal(calls, 0);
  } finally { copy.close(); }
  const oldWriter = new DatabaseSync(result.database);
  try {
    assert.throws(() => oldWriter.prepare("UPDATE task_executions SET generation=generation+1,worker_id='old',lease_until=9999999999999 WHERE id=?").run(first.execution.id), /quarantined/);
    assert.throws(() => oldWriter.prepare("UPDATE task_executions SET generation=generation+1,phase='provisioning' WHERE id=?").run(queued.execution.id), /quarantined/);
  } finally { oldWriter.close(); }
});

test("snapshot: unsafe paths and unrelated databases fail before creating usable output", async t => {
  const f = fixture(t);
  const link = join(f.directory, "link.sqlite"); symlinkSync(f.path, link);
  await assert.rejects(rehearseSnapshot(link, f.directory), /canonical/);
  chmodSync(f.path, 0o644);
  await assert.rejects(rehearseSnapshot(f.path, f.directory), /private/);
  chmodSync(f.path, 0o600);
  const unrelatedPath = join(f.directory, "other.sqlite");
  const unrelated = new DatabaseSync(unrelatedPath); unrelated.exec("CREATE TABLE other(id INTEGER)"); unrelated.close(); chmodSync(unrelatedPath, 0o600);
  await assert.rejects(rehearseSnapshot(unrelatedPath, f.directory));
});

test("snapshot CLI refuses service startup before any provider connection", async t => {
  const f = fixture(t);
  const command = new URL("./service/snapshot-cli.js", import.meta.url);
  const run = spawnSync(process.execPath, [command.pathname, "--db", f.path, "--output-root", f.directory], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.executionQuarantined, true);
  const configPath = join(f.directory, "service.json");
  writeFileSync(configPath, JSON.stringify({ environmentProfile: "trusted-local", dbPath: join(output.directory, "tasks.sqlite"),
    credentialsFile: join(f.directory, "unused-credentials.json"), reportingSetupExecutable: "/bin/false",
    publicUrl: "http://127.0.0.1:8083", reportingUrl: "http://127.0.0.1:8083/reporting",
    defaultProfile: "agent", profiles: [{ id: "agent", agentId: "00000000-0000-0000-0000-000000000001" }] }), { mode: 0o600 });
  const startup = spawnSync(process.execPath, [new URL("./service/main.js", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, A2A_SERVICE_CONFIG_FILE: configPath }, encoding: "utf8", timeout: 5000
  });
  assert.equal(startup.status, 1);
  assert.match(startup.stderr, /restored database is quarantined/);
  assert(!startup.stderr.includes("AGYN_GATEWAY_URL is required"));
  assert(!startup.stdout.includes("listening"));
  assert(!run.stdout.includes("private task"));
  assert.equal(spawnSync(process.execPath, [command.pathname, "--db", f.path], { encoding: "utf8" }).status, 1);
});
