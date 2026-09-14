// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Message } from "@a2a-js/sdk";
import { DurableTaskStore, TaskStoreError, type Admission } from "./service/task-store.js";
import { ExecutionWorker, type RuntimeDriver } from "./service/worker.js";

const scope = { tenant: "org", subject: "operator" };
const input = (taskId = "") => Message.fromJSON({ messageId: randomUUID(), taskId, role: "ROLE_USER", parts: [{ text: "work" }] });
const conflict = (error: unknown) => error instanceof TaskStoreError && error.code === "conflict";
const invalid = (error: unknown) => error instanceof TaskStoreError && error.code === "invalid";

function fixture(t: TestContext, clock?: () => number) {
  const directory = mkdtempSync(join(tmpdir(), "a2a-admission-"));
  const path = join(directory, "tasks.sqlite");
  const stores: DurableTaskStore[] = [];
  const open = () => { const store = new DurableTaskStore(path, { clock }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, open, store: open() };
}

type Attempt = { maxActive: number; expected?: number };
type Reply = { admission: Admission; executionId: string | null; recovered: boolean; error?: string };
async function contend(path: string, attempts: Attempt[]): Promise<Reply[]> {
  const moduleUrl = new URL("./service/task-store.js", import.meta.url).href;
  const children = attempts.map((attempt, n) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {once} from 'node:events';
      const data=JSON.parse(process.argv[1]);
      const {DurableTaskStore,TaskStoreError}=await import(data.moduleUrl);
      const store=new DurableTaskStore(data.path,{clock:()=>1000});
      const start=once(process,'message');
      process.send({kind:'ready'});
      await start;
      try {
        let claim;
        if(data.expected===undefined) claim=store.claim('process-'+data.n,10000,data.maxActive);
        else store.changeAdmissionLimit(data.expected,data.maxActive);
        process.send({kind:'result',admission:store.admission(),executionId:claim?.execution.id??null,recovered:!!claim?.recovered});
      } catch(error) {
        if(!(error instanceof TaskStoreError)) throw error;
        process.send({kind:'result',admission:store.admission(),executionId:null,recovered:false,error:error.code});
      } finally { store.close();process.disconnect(); }
      `, JSON.stringify({ moduleUrl, path, n, ...attempt })], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 15_000, killSignal: "SIGKILL"
    });
    let result: Reply | undefined;
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
    const exited = new Promise<number | null>(resolve => { child.once("close", resolve); });
    const ready = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("message", message => {
        const value = message as Reply & { kind: string };
        if (value.kind === "ready") resolve();
        else if (value.kind === "result") result = value;
      });
      child.once("close", () => reject(new Error(`contender exited before barrier: ${stderr}`)));
    });
    return { child, ready, exited, result: () => result, stderr: () => stderr };
  });
  try {
    await Promise.all(children.map(child => child.ready));
    for (const { child } of children) child.send("claim");
    return await Promise.all(children.map(async child => {
      assert.equal(await child.exited, 0, child.stderr());
      const result = child.result();
      assert(result, "contender must return an admission result");
      return result;
    }));
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.exited));
  }
}

test("admission: a second connection cannot raise the shared limit through claim", t => {
  const f = fixture(t);
  const first = f.store;
  const second = f.open();
  first.submit(scope, input(), "agent-one");
  first.submit(scope, input(), "agent-two");
  assert(first.claim("worker-one", 60_000, 1));
  assert.throws(() => second.claim("worker-two", 60_000, 2), conflict);
  assert.equal(first.claim("worker-one", 60_000, 1), undefined);
  assert.deepEqual(second.admission(), { maxActive: 1, reserved: 1 });
});

test("admission: startup pins the limit durably even without a queued task", t => {
  const f = fixture(t);
  assert.deepEqual(f.store.admission(), { maxActive: null, reserved: 0 });
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.store.configureAdmission(value), invalid);
    assert.throws(() => f.store.claim("invalid", 100, value), invalid);
    assert.throws(() => f.store.changeAdmissionLimit(value, 2), invalid);
    assert.throws(() => f.store.changeAdmissionLimit(2, value), invalid);
  }
  assert.deepEqual(f.store.admission(), { maxActive: null, reserved: 0 });
  assert.throws(() => f.store.changeAdmissionLimit(2, 1), conflict);
  f.store.configureAdmission(2);
  const reopened = f.open();
  reopened.configureAdmission(2);
  assert.throws(() => reopened.configureAdmission(1), conflict);
  assert.throws(() => reopened.claim("wrong", 100, 3), conflict);
  assert.deepEqual(reopened.admission(), { maxActive: 2, reserved: 0 });
});

test("admission: worker construction rejects config drift before any provider call", t => {
  const { store } = fixture(t);
  store.configureAdmission(1);
  let calls = 0;
  const operation = async (): Promise<never> => { calls++; throw new Error("provider must not be used"); };
  const driver: RuntimeDriver = { provision: operation, prepare: operation, dispatch: operation, observe: operation, release: operation };
  assert.throws(() => new ExecutionWorker(store, driver,
    { concurrency: 2, leaseMs: 150, pollMs: 5, turnTimeoutMs: 5000 }), conflict);
  assert.equal(calls, 0);
  assert.deepEqual(store.admission(), { maxActive: 1, reserved: 0 });
});

test("admission: every unreleased phase retains its slot through lease expiry and recovery", async t => {
  for (const phase of ["provisioning", "ready", "dispatching", "running", "outcome", "canceled", "releasing", "ambiguous"]) {
    await t.test(phase, t => {
      let now = 1000;
      const { store, open } = fixture(t, () => now);
      const first = store.submit(scope, input(), "agent");
      const lease = store.claim("original", 100, 1)!.lease;
      const next = store.submit({ tenant: "other-org", subject: "other-owner" }, input(), "other-agent");
      if (phase !== "provisioning") store.bind(lease, { instanceId: "instance", threadId: "thread", profileId: "agent" });
      if (!["provisioning", "ready"].includes(phase)) store.beginDispatch(lease);
      if (!["provisioning", "ready", "dispatching"].includes(phase)) store.dispatched(lease, "request");
      if (["outcome", "releasing"].includes(phase)) {
        store.report("instance", first.execution.id, { eventId: "done", kind: "outcome", outcome: "turn_done", message: "done" });
      }
      if (phase === "releasing") store.releasing(lease);
      if (phase === "ambiguous") store.markUncertain(lease, "side effects unknown");
      if (phase === "canceled") store.requestCancel(scope, first.task.id);
      assert.deepEqual(store.admission(), { maxActive: 1, reserved: 1 });
      assert.equal(store.claim("other", 100, 1), undefined);
      now += 101;
      const replacement = open();
      assert.throws(() => replacement.changeAdmissionLimit(1, 2), conflict);
      const recovered = replacement.claim("replacement", 100, 1)!;
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.execution.id, first.execution.id);
      assert.equal(recovered.lease.generation, lease.generation + 1);
      assert.deepEqual(replacement.admission(), { maxActive: 1, reserved: 1 });
      assert.equal(replacement.claim("other", 100, 1), undefined);
      assert.throws(() => store.heartbeat(lease, 100), error => error instanceof TaskStoreError && error.code === "stale_lease");
      replacement.markUncertain(recovered.lease, "reconcile before retry");
      assert.throws(() => replacement.settle(recovered.lease, { stopped: false }), conflict);
      assert.equal(replacement.admission().reserved, 1);
      replacement.settle(recovered.lease, { stopped: true });
      assert.equal(replacement.admission().reserved, 0);
      assert.equal(replacement.claim("other", 100, 1)!.execution.id, next.execution.id);
      assert.equal(replacement.admission().reserved, 1);
    });
  }
});

test("admission: resizing requires drained reservations, compares the old limit and fences already-open claimers", t => {
  const { store, open } = fixture(t);
  const stale = open();
  const first = store.submit(scope, input(), "agent");
  const lease = store.claim("worker", 60_000, 2)!.lease;
  const events = store.events(scope, first.task.id);
  assert.throws(() => stale.changeAdmissionLimit(2, 3), conflict);
  assert.throws(() => stale.changeAdmissionLimit(1, 3), conflict);
  assert.deepEqual(store.events(scope, first.task.id), events);
  store.markUncertain(lease, "unknown create");
  assert.throws(() => stale.changeAdmissionLimit(2, 1), conflict);
  store.settle(lease, { stopped: true });
  assert.equal(store.execution(first.execution.id)!.phase, "uncertain");
  const stopped = store.get(scope, first.task.id);
  assert.deepEqual(stale.changeAdmissionLimit(2, 1), { maxActive: 1, reserved: 0 });
  assert.deepEqual(store.get(scope, first.task.id), stopped);
  assert.throws(() => store.claim("stale", 100, 2), conflict);
  assert.throws(() => stale.changeAdmissionLimit(2, 3), conflict);
  assert.throws(() => store.submit(scope, input(first.task.id), "agent"), conflict);
  store.submit(scope, input(), "agent");
  assert(store.claim("new", 100, 1));
});

test("admission: additive migration counts old reservations and allows recovery above the new ceiling", t => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-admission-migrate-"));
  const path = join(directory, "tasks.sqlite");
  let now = 1000;
  const old = new DurableTaskStore(path, { clock: () => now });
  old.submit(scope, input(), "agent");
  old.claim("old-one", 100, 2);
  old.submit(scope, input(), "agent");
  old.claim("old-two", 100, 2);
  const queued = old.submit(scope, input(), "agent");
  const snapshot = old.get(scope, queued.task.id);
  old.close();
  // The previous schema has the same execution rows and no admission table.
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TRIGGER execution_admission_capacity");
  legacy.exec("DROP TABLE execution_admission");
  legacy.close();
  const store = new DurableTaskStore(path, { clock: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.configureAdmission(1);
  assert.deepEqual(store.get(scope, queued.task.id), snapshot);
  assert.deepEqual(store.admission(), { maxActive: 1, reserved: 2 });
  assert.equal(store.claim("new", 100, 1), undefined);
  now += 101;
  const one = store.claim("recovery-one", 100, 1)!;
  const two = store.claim("recovery-two", 100, 1)!;
  assert(one.recovered && two.recovered);
  assert.notEqual(one.execution.id, two.execution.id);
  assert.equal(store.claim("new", 100, 1), undefined);
  store.markUncertain(one.lease, "inspect old instance"); store.settle(one.lease, { stopped: true });
  assert.equal(store.claim("new", 100, 1), undefined);
  store.markUncertain(two.lease, "inspect old instance"); store.settle(two.lease, { stopped: true });
  assert.equal(store.claim("new", 100, 1)!.execution.id, queued.execution.id);
  assert.equal(store.admission().reserved, 1);
});

test("admission: the database constraint also rejects a legacy claimer that ignores the persisted limit", t => {
  const { store, path } = fixture(t);
  store.submit(scope, input(), "agent");
  const claimed = store.claim("new-worker", 60_000, 1)!;
  const queued = store.submit(scope, input(), "agent");
  const legacy = new DatabaseSync(path);
  try {
    const update = legacy.prepare(`UPDATE task_executions SET phase='provisioning',worker_id='old-worker',
      generation=generation+1,lease_until=? WHERE id=?`);
    assert.throws(() => update.run(Date.now() + 60_000, queued.execution.id), /execution admission capacity exceeded/);
    assert.equal(store.execution(queued.execution.id)!.phase, "queued");
    assert.equal(store.execution(queued.execution.id)!.generation, 0);
    assert.deepEqual(store.admission(), { maxActive: 1, reserved: 1 });
    store.markUncertain(claimed.lease, "inspect original instance");
    store.settle(claimed.lease, { stopped: true });
    update.run(Date.now() + 60_000, queued.execution.id);
    assert.equal(store.execution(queued.execution.id)!.phase, "provisioning");
    assert.deepEqual(store.admission(), { maxActive: 1, reserved: 1 });
  } finally { legacy.close(); }
});

test("admission: six barrier-synchronized processes share two slots across owners and profiles", { timeout: 20_000 }, async t => {
  const { store, path } = fixture(t, () => 1000);
  store.configureAdmission(2);
  for (let n = 0; n < 8; n++) store.submit({ tenant: `org-${n}`, subject: `owner-${n}` }, input(), `agent-${n}`);
  const results = await contend(path, [2, 2, 2, 3, 3, 3].map(maxActive => ({ maxActive })));
  assert.equal(results.filter(result => result.error === "conflict").length, 3);
  const claimed = results.filter(result => result.executionId);
  assert.equal(claimed.length, 2);
  assert.equal(new Set(claimed.map(result => result.executionId)).size, 2);
  assert(results.every(result => !result.recovered && result.admission.maxActive === 2 && result.admission.reserved <= 2));
  assert.deepEqual(store.admission(), { maxActive: 2, reserved: 2 });
});

test("admission: competing operator changes cannot both match the same old limit", { timeout: 20_000 }, async t => {
  const { store, path } = fixture(t);
  store.configureAdmission(2);
  const results = await contend(path, [{ expected: 2, maxActive: 3 }, { expected: 2, maxActive: 4 }]);
  assert.equal(results.filter(result => !result.error).length, 1);
  assert.equal(results.filter(result => result.error === "conflict").length, 1);
  assert([3, 4].includes(store.admission().maxActive!));
  assert.equal(store.admission().reserved, 0);
});

test("admission: a claim racing an operator change cannot escape the new ceiling", { timeout: 20_000 }, async t => {
  const { store, path } = fixture(t, () => 1000);
  store.configureAdmission(2);
  store.submit(scope, input(), "agent");
  const [claim, change] = await contend(path, [{ maxActive: 2 }, { expected: 2, maxActive: 1 }]);
  if (claim.executionId) {
    assert.equal(change.error, "conflict");
    assert.deepEqual(store.admission(), { maxActive: 2, reserved: 1 });
  } else {
    assert.equal(claim.error, "conflict");
    assert.equal(change.error, undefined);
    assert.deepEqual(store.admission(), { maxActive: 1, reserved: 0 });
  }
});

test("admission CLI: inspect and compare-and-change use the persisted policy without creating another database", t => {
  const { store, path, directory } = fixture(t);
  const command = new URL("./service/admission-cli.js", import.meta.url);
  const run = (...args: string[]) => spawnSync(process.execPath, [command.pathname, ...args], { encoding: "utf8", timeout: 5000 });
  store.configureAdmission(2);
  const inspect = run("--db", path);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout), { maxActive: 2, reserved: 0 });
  const changed = run("--db", path, "--expect", "2", "--max-active", "1");
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(JSON.parse(changed.stdout), { maxActive: 1, reserved: 0 });
  const mismatch = run("--db", path, "--expect", "2", "--max-active", "3");
  assert.equal(mismatch.status, 1); assert.match(mismatch.stderr, /conflict:/);
  store.submit(scope, input(), "agent");
  store.claim("busy", 60_000, 1);
  const busy = run("--db", path, "--expect", "1", "--max-active", "2");
  assert.equal(busy.status, 1); assert.match(busy.stderr, /reservations must drain/);
  const missing = join(directory, "missing.sqlite");
  const symlink = join(directory, "symlink.sqlite");
  const unrelated = join(directory, "unrelated.sqlite");
  const db = new DatabaseSync(unrelated);
  db.exec("CREATE TABLE preserved (id INTEGER PRIMARY KEY)"); db.close();
  const original = readFileSync(unrelated);
  symlinkSync(path, symlink);
  for (const args of [[], ["--db", missing], ["--db", symlink], ["--db", unrelated], ["--db", "relative.sqlite"],
    ["--db", path, "--expect", "1"], ["--db", path, "--max-active", "2"], ["--db", path, "--unexpected"],
    ["--db", path, "--expect", "1", "--max-active", "0"], ["--db", path, "--expect", "1", "--max-active", "33"]]) {
    const result = run(...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /Usage: admission-cli/);
  }
  assert(!existsSync(missing));
  assert.deepEqual(readFileSync(unrelated), original);
  assert.deepEqual(store.admission(), { maxActive: 1, reserved: 1 });
});
