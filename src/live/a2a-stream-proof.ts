// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { type StreamResponse, type Task, TaskState } from "@a2a-js/sdk";
import { reportSchema, type TaskEvent } from "../service/events.js";
import { taskArtifact } from "../service/artifacts.js";

export type StreamObservation = { observedAt: string; event: StreamResponse };
export type StreamProbe = {
  task: Task; observations: StreamObservation[]; finished: Promise<void>;
  assertOpen: () => void; endedAt: () => string | undefined;
};

export async function observeA2aStream(stream: AsyncGenerator<StreamResponse>): Promise<StreamProbe> {
  const first = await stream.next();
  assert(!first.done && first.value.payload?.$case === "task", "stream did not begin with a task snapshot");
  const task = first.value.payload.value;
  const observations: StreamObservation[] = [{ observedAt: new Date().toISOString(), event: first.value }];
  let endedAt: string | undefined;
  let failure: unknown;
  const finished = (async () => {
    try {
      for await (const event of stream) {
        assert(observations.length < 500, "live stream exceeded its evidence bound");
        observations.push({ observedAt: new Date().toISOString(), event });
      }
    } catch (error) { failure = error; throw error; }
    finally { endedAt = new Date().toISOString(); }
  })();
  void finished.catch(() => {});
  return { task, observations, finished, endedAt: () => endedAt, assertOpen: () => {
    if (failure) throw failure;
    assert(!endedAt, "stream ended before the task became terminal");
  } };
}

export function assertStreamMatchesDurable(probe: StreamProbe, events: TaskEvent[], expected: TaskState): void {
  assert(probe.endedAt(), "stream has not closed");
  const cut = probe.task.metadata?.snapshotSequence;
  assert(typeof cut === "number" && Number.isSafeInteger(cut) && cut >= 0, "missing atomic snapshot cursor");
  const updates = probe.observations.slice(1).map(item => item.event.payload);
  assert(updates.every(payload => payload?.$case === "statusUpdate" || payload?.$case === "artifactUpdate"));
  // The live fixture's tiny snapshot never needs overflow artifact fragments.
  assert(updates.every(payload => payload?.value.metadata?.snapshotSequence === undefined));
  const durable = events.filter(event => event.sequence > cut && ["task.status", "agent.artifact"].includes(event.kind));
  assert.deepEqual(updates.map(payload => payload?.value.metadata?.eventSequence), durable.map(event => event.sequence));
  for (let n = 0; n < durable.length; n++) {
    const event = durable[n];
    const update: NonNullable<StreamResponse["payload"]> = updates[n]!;
    assert.equal(update.value.taskId, probe.task.id);
    assert.equal(update.value.contextId, probe.task.contextId);
    if (event.kind === "task.status") {
      assert(update.$case === "statusUpdate");
      assert.deepEqual(update.value.status, event.payload.status);
      assert.deepEqual(update.value.metadata, { ...(event.payload.metadata as object), eventSequence: event.sequence });
    } else {
      assert(update.$case === "artifactUpdate" && event.executionId);
      const report = reportSchema.parse(event.payload); assert(report.kind === "artifact");
      assert.deepEqual(update.value.artifact, taskArtifact(event.executionId, report));
      assert.deepEqual(update.value.metadata, { eventSequence: event.sequence });
      assert.equal(update.value.append, false); assert.equal(update.value.lastChunk, true);
    }
  }
  const last = updates.at(-1);
  assert(last?.$case === "statusUpdate" && last.value.status?.state === expected, "stream closed without its expected terminal status");
}
