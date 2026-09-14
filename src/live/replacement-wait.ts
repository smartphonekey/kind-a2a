// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForInspectableReplacement<T extends { uid: string }>(options: {
  previousUid: string;
  timeoutMs: number;
  observe: () => { podUids: string[]; snapshots: T[] };
  now?: () => number;
  pause?: (ms: number) => Promise<unknown>;
}) {
  assert(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0, "finite replacement observation timeout required");
  const now = options.now ?? (() => performance.now()), pause = options.pause ?? delay;
  const started = now();
  let observedUid: string | undefined, firstObservedMs: number | undefined, polls = 0;
  while (now() - started < options.timeoutMs) {
    const { podUids, snapshots } = options.observe();
    polls++;
    const elapsedMs = now() - started;
    assert(podUids.length <= 1 && snapshots.length <= 1, "multiple task Pods observed during replacement");
    if (podUids.length) {
      assert(podUids[0] && podUids[0] !== options.previousUid, "deleted predecessor Pod reappeared");
      assert(!observedUid || observedUid === podUids[0], "replacement incarnation changed before inspection");
      observedUid = podUids[0];
      firstObservedMs ??= elapsedMs;
    }
    if (snapshots.length) {
      assert(snapshots[0].uid === podUids[0], "inspection does not belong to the observed replacement Pod");
      if (elapsedMs < options.timeoutMs) return { snapshots, observation: { uid: observedUid!, firstObservedMs: firstObservedMs!, elapsedMs, polls } };
    }
    const remaining = options.timeoutMs - (now() - started);
    if (remaining > 0) await pause(Math.min(1000, remaining));
  }
  throw new Error(observedUid ? "replacement Pod appeared but did not become inspectable within the recovery window"
    : "no replacement Pod observed within the recovery window");
}
