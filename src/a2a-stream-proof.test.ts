// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { StreamResponse, Task, TaskState, TaskStatus } from "@a2a-js/sdk";
import { observeA2aStream, assertStreamMatchesDurable } from "./live/a2a-stream-proof.js";
import { taskArtifact } from "./service/artifacts.js";
import type { TaskEvent } from "./service/events.js";

const task = Task.fromJSON({ id: "task", contextId: "context", status: { state: "TASK_STATE_WORKING" }, metadata: { snapshotSequence: 10 } });
const report = { kind: "artifact", eventId: "report", artifactId: "file", name: "result", text: "proof" } as const;
const artifact = taskArtifact("execution", report);
const status = TaskStatus.fromJSON({ state: "TASK_STATE_COMPLETED", timestamp: "2026-09-13T00:00:00.000Z" });
const update: StreamResponse = { payload: { $case: "artifactUpdate", value: {
  taskId: task.id, contextId: task.contextId, artifact, append: false, lastChunk: true, metadata: { eventSequence: 11 }
} } };
const completed: StreamResponse = { payload: { $case: "statusUpdate", value: {
  taskId: task.id, contextId: task.contextId, status, metadata: { eventSequence: 13 }
} } };
const events: TaskEvent[] = [
  { sequence: 11, kind: "agent.artifact", payload: report },
  { sequence: 12, kind: "agent.outcome", payload: {} },
  { sequence: 13, kind: "task.status", payload: { status } }
].map(event => ({ ...event, taskId: task.id, executionId: "execution", at: "2026-09-13T00:00:00.000Z" }));

test("live stream proof: observes before completion and verifies the exact durable suffix", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stream = (async function* () {
    yield { payload: { $case: "task", value: task } } as StreamResponse;
    await gate; yield update; yield completed;
  })();
  const probe = await observeA2aStream(stream);
  probe.assertOpen(); release(); await probe.finished;
  assertStreamMatchesDurable(probe, events, TaskState.TASK_STATE_COMPLETED);
  assert.throws(probe.assertOpen, /ended/);
  assert(probe.observations.every(item => Number.isFinite(Date.parse(item.observedAt))));
});

test("live stream proof: rejects missing, reordered, altered, foreign or nonterminal updates", async () => {
  const stream = (async function* () {
    yield { payload: { $case: "task", value: task } } as StreamResponse;
    yield update; yield completed;
  })();
  const probe = await observeA2aStream(stream); await probe.finished;
  const verify = (values: StreamResponse[], snapshot = task) => assertStreamMatchesDurable({ ...probe, task: snapshot,
    observations: [probe.observations[0], ...values.map(event => ({ event, observedAt: probe.observations[0].observedAt }))]
  }, events, TaskState.TASK_STATE_COMPLETED);
  assert.throws(() => verify([completed]));
  assert.throws(() => verify([completed, update]));
  assert.throws(() => verify([update, update, completed]));
  const altered = structuredClone(update); assert(altered.payload?.$case === "artifactUpdate");
  altered.payload.value.artifact!.name = "changed";
  assert.throws(() => verify([altered, completed]));
  const foreign = structuredClone(update); assert(foreign.payload?.$case === "artifactUpdate");
  foreign.payload.value.taskId = "other-task";
  assert.throws(() => verify([foreign, completed]));
  const metadata = structuredClone(completed); assert(metadata.payload?.$case === "statusUpdate");
  metadata.payload.value.metadata!.resourcesReleased = false;
  assert.throws(() => verify([update, metadata]));
  assert.throws(() => verify([update, completed], { ...task, metadata: {} }));
  assert.throws(() => verify([update]));
});

test("live stream proof: a source failure cannot pass as graceful closure", async () => {
  const stream = (async function* () {
    yield { payload: { $case: "task", value: task } } as StreamResponse;
    throw new Error("source failed");
  })();
  const probe = await observeA2aStream(stream);
  await assert.rejects(probe.finished, /source failed/);
  assert.throws(probe.assertOpen, /source failed/);
});
