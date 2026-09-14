// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { waitForInspectableReplacement } from "./live/replacement-wait.js";

function clock() {
  let time = 0;
  return { now: () => time, pause: async (ms: number) => { time += ms; } };
}

test("replacement observation includes reconciliation, retry backoff and container initialization", async () => {
  const timer = clock();
  const result = await waitForInspectableReplacement({ previousUid: "old", timeoutMs: 180_000, ...timer,
    observe: () => ({ podUids: timer.now() >= 75_000 ? ["replacement"] : [],
      snapshots: timer.now() >= 95_000 ? [{ uid: "replacement", marker: "once", configured: false }] : [] }) });
  assert.deepEqual(result.snapshots, [{ uid: "replacement", marker: "once", configured: false }]);
  assert.deepEqual(result.observation, { uid: "replacement", firstObservedMs: 75_000, elapsedMs: 95_000, polls: 96 });
});

test("replacement observation distinguishes missing from uninspectable Pods", async () => {
  for (const podUids of [[], ["replacement"]]) {
    const timer = clock();
    await assert.rejects(waitForInspectableReplacement({ previousUid: "old", timeoutMs: 1500, ...timer,
      observe: () => ({ podUids, snapshots: [] }) }), podUids.length ? /did not become inspectable/ : /no replacement Pod observed/);
    assert.equal(timer.now(), 1500);
  }
});

test("replacement observation rejects overlap, predecessor reuse and mismatched inspections", async () => {
  for (const observation of [
    { podUids: ["a", "b"], snapshots: [{ uid: "a" }] },
    { podUids: ["old"], snapshots: [] },
    { podUids: ["a"], snapshots: [{ uid: "b" }] },
    { podUids: [], snapshots: [{ uid: "a" }] },
    { podUids: ["a"], snapshots: [{ uid: "a" }, { uid: "a" }] }
  ]) {
    await assert.rejects(waitForInspectableReplacement({ previousUid: "old", timeoutMs: 10_000, ...clock(), observe: () => observation }));
  }
});

test("replacement observation cannot hide repeated native restarts", async () => {
  let attempts = 0;
  await assert.rejects(waitForInspectableReplacement({ previousUid: "old", timeoutMs: 10_000, ...clock(),
    observe: () => ({ podUids: [++attempts === 1 ? "first" : "second"], snapshots: [] }) }), /incarnation changed/);
});

test("replacement observation does not retry a failed operator read", async () => {
  let calls = 0;
  await assert.rejects(waitForInspectableReplacement({ previousUid: "old", timeoutMs: 10_000, ...clock(),
    observe: () => { calls++; throw new Error("operator read failed"); } }), /operator read failed/);
  assert.equal(calls, 1);
});

test("replacement observation charges probe time to its deadline", async () => {
  let time = 0;
  await assert.rejects(waitForInspectableReplacement({ previousUid: "old", timeoutMs: 10_000, now: () => time,
    observe: () => { time = 10_001; return { podUids: ["replacement"], snapshots: [{ uid: "replacement" }] }; } }), /did not become inspectable/);
});

test("replacement observation requires a bounded positive deadline", async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 1.5]) {
    await assert.rejects(waitForInspectableReplacement({ previousUid: "old", timeoutMs, observe: () => { throw new Error("must not observe"); } }), /finite replacement/);
  }
});
