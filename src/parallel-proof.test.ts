// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { assertFifoRelease, assertQueuedOnly, assertSeparateTasks, parallelProgram, type ParallelSnapshot } from "./live/parallel-proof.js";
import { assertProbe, probeConnection } from "./live/network-proof.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "a2a-parallel-test-"));
  const children: { child: ChildProcess; done: Promise<number | null> }[] = [];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.done));
    rmSync(directory, { recursive: true, force: true });
  });
  const start = (root: string, marker: string, turn: 1 | 2, timeoutMs = 5000) => {
    const program = parallelProgram({ root, marker, turn, timeoutMs, tcpPort: 0, udpPort: 0 });
    const child = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stdout!.resume(); child.stderr!.on("data", data => { stderr += data; });
    const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    children.push({ child, done });
    const ready = async () => {
      const path = join(root, `parallel-ready-${turn}.json`);
      for (let attempt = 0; attempt < 150 && !existsSync(path); attempt++) {
        assert.equal(child.exitCode, null, stderr); await delay(20);
      }
      assert(existsSync(path), "barrier did not start");
      return JSON.parse(readFileSync(path, "utf8"));
    };
    return { child, done, ready, stderr: () => stderr };
  };
  const release = (root: string, marker: string, turn: 1 | 2) => writeFileSync(join(root, `parallel-release-${turn}.json`), JSON.stringify({ marker, turn }));
  return { directory, start, release };
}

test("parallel barrier holds two live processes and preserves separate workspace continuation", async t => {
  const { directory, start, release } = fixture(t);
  const a = join(directory, "a"), b = join(directory, "b"); mkdirSync(a); mkdirSync(b);
  const a1 = start(a, "marker-a", 1), b1 = start(b, "marker-b", 1);
  const aReady = await a1.ready(), bReady = await b1.ready();
  assert.notEqual(aReady.pid, bReady.pid);
  for (const [state, marker] of [[aReady, "marker-a"], [bReady, "marker-b"]] as const) {
    assertProbe(await probeConnection({ protocol: "tcp", host: "127.0.0.1", port: state.tcpPort, token: marker }), true);
    assertProbe(await probeConnection({ protocol: "udp", host: "127.0.0.1", port: state.udpPort, token: marker }), true);
  }
  assert(!existsSync(join(a, "parallel-completed-1.json")));
  release(a, "marker-a", 1); assert.equal(await a1.done, 0, a1.stderr());
  const a2 = start(a, "marker-a", 2); await a2.ready();
  assert.equal(b1.child.exitCode, null);
  assert.equal(readFileSync(join(a, "parallel-followup.txt"), "utf8"), "marker-a");
  assert(!existsSync(join(b, "parallel-followup.txt")));
  assert(!existsSync(join(a, "parallel-completed-2.json")), "old turn release authorized the follow-up");
  assert.equal(readFileSync(join(a, "parallel-actions.txt"), "utf8"), "1:marker-a\n2:marker-a\n");
  assert.equal(readFileSync(join(b, "parallel-actions.txt"), "utf8"), "1:marker-b\n");
  release(a, "marker-a", 2); assert.equal(await a2.done, 0, a2.stderr());
  assert.equal(b1.child.exitCode, null);
  release(b, "marker-b", 1); assert.equal(await b1.done, 0, b1.stderr());
});

test("parallel barrier rejects wrong releases and replay instead of reporting success", async t => {
  const { directory, start, release } = fixture(t);
  const first = start(directory, "expected", 1); await first.ready();
  release(directory, "another-task", 1);
  assert.equal(await first.done, 1); assert.match(first.stderr(), /identity mismatch/);
  assert(!existsSync(join(directory, "parallel-completed-1.json")));
  const replay = start(directory, "expected", 1);
  assert.equal(await replay.done, 1); assert.match(replay.stderr(), /EEXIST/);
  assert.equal(readFileSync(join(directory, "parallel-actions.txt"), "utf8"), "1:expected\n");
});

test("parallel barrier timeout cannot masquerade as completion", async t => {
  const { directory, start } = fixture(t);
  const blocked = start(directory, "timeout", 1, 25);
  assert.equal(await blocked.done, 1); assert.match(blocked.stderr(), /timed out/);
  assert(!existsSync(join(directory, "parallel-completed-1.json")));
});

const snapshot = (name: string): ParallelSnapshot => ({ taskId: `task-${name}`, executionId: `exec-${name}`,
  instanceId: `instance-${name}`, threadId: `thread-${name}`, profileId: "same-agent-profile", uid: `pod-${name}`,
  pvc: [`pvc-${name}`], marker: `marker-${name}`, mapping: [{ instance_id: `instance-${name}`, codex_thread_id: `session-${name}` }] });

test("parallel identity proof rejects shared runtime, PVC or native session", () => {
  const a = snapshot("a"); assertSeparateTasks(a, snapshot("b"));
  for (const key of ["taskId", "executionId", "instanceId", "threadId", "uid", "marker"] as const) {
    const b = snapshot("b"); b[key] = a[key]; assert.throws(() => assertSeparateTasks(a, b));
  }
  const pvc = snapshot("b"); pvc.pvc = a.pvc; assert.throws(() => assertSeparateTasks(a, pvc));
  const session = snapshot("b"); session.mapping[0].codex_thread_id = a.mapping[0].codex_thread_id;
  assert.throws(() => assertSeparateTasks(a, session));
  const profile = snapshot("b"); profile.profileId = "different-agent"; assert.throws(() => assertSeparateTasks(a, profile));
});

test("FIFO evidence requires an untouched queued execution and confirmed release before claim", () => {
  const queued = { executionId: "next", kind: "execution.queued", sequence: 2 };
  const stopped = { executionId: "first", kind: "runtime.stopped", sequence: 3 };
  const claimed = { executionId: "next", kind: "execution.claimed", sequence: 4 };
  assertQueuedOnly([queued], "next"); assert.throws(() => assertQueuedOnly([], "next"));
  for (const kind of ["execution.claimed", "execution.dispatching", "execution.dispatched", "agent.progress"]) {
    assert.throws(() => assertQueuedOnly([queued, { ...queued, kind }], "next"));
  }
  assertFifoRelease([queued, stopped, claimed], "first", "next");
  assert.throws(() => assertFifoRelease([queued, claimed], "first", "next"));
  assert.throws(() => assertFifoRelease([queued, stopped, { ...claimed, sequence: 1 }], "first", "next"));
});
