import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpHarness } from "./acp-harness.js";
import type { AgentProfile, HarnessEvent } from "./harness.js";

const fakeAgent = fileURLToPath(new URL("./fake-acp-agent.js", import.meta.url));

function fakeProfile(environment: Record<string, string> = {}): AgentProfile {
  return {
    id: "fake-acp-v1", version: 1, harness: "acp", runnerImage: "unused",
    executable: process.execPath, args: [fakeAgent], authBinding: "none",
    requiredCapabilities: { loadSession: true, cancel: true, permissions: true },
    resources: { cpuRequest: "1m", memoryRequest: "16Mi", cpuLimit: "100m", memoryLimit: "64Mi" }, environment
  };
}

async function waitFor(events: HarnessEvent[], predicate: (event: HarnessEvent) => boolean): Promise<HarnessEvent> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for fake ACP event");
}

test("fake ACP: permission response is correlated and session/load replays history", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aira-acp-"));
  const harness = new AcpHarness(fakeProfile());
  const events: HarnessEvent[] = [];
  try {
    const first = harness.run({ taskId: "task-1", prompt: "exercise permission", cwd }, (event) => events.push(event));
    const permission = await waitFor(events, (event) => event.type === "permission");
    assert.equal(permission.type, "permission");
    await harness.respond(permission.requestId, { decision: "accept" });
    const result = await first;
    assert.equal((result.outcome as { stopReason: string }).stopReason, "end_turn");
    assert.equal(events.filter((event) => event.type === "tool").length, 2, "fake injects duplicate updates");
    assert(events.some((event) => event.type === "permission-response"));

    const resumed: HarnessEvent[] = [];
    const second = harness.run({ taskId: "task-2", sessionId: result.sessionId, prompt: "follow up", cwd }, (event) => resumed.push(event));
    const secondPermission = await waitFor(resumed, (event) => event.type === "permission");
    assert.equal(secondPermission.type, "permission");
    await harness.respond(secondPermission.requestId, { decision: "decline" });
    await second;
    assert(resumed.some((event) => event.type === "session" && event.resumed));
    assert(resumed.some((event) => event.type === "message" && JSON.stringify(event.content).includes("replayed history")));
  } finally {
    await harness.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fake ACP: cancellation returns the protocol cancelled stop reason", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aira-acp-"));
  const harness = new AcpHarness(fakeProfile());
  const events: HarnessEvent[] = [];
  try {
    const run = harness.run({ taskId: "task-cancel", prompt: "[wait]", cwd }, (event) => events.push(event));
    await waitFor(events, (event) => event.type === "turn" && event.phase === "started");
    await harness.cancel("task-cancel");
    const result = await run;
    assert.equal((result.outcome as { stopReason: string }).stopReason, "cancelled");
    assert(events.some((event) => event.type === "turn" && event.phase === "cancelled"));
  } finally {
    await harness.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fake ACP: required unsupported capability fails closed", async () => {
  const harness = new AcpHarness(fakeProfile({ FAKE_ACP_NO_LOAD: "1" }));
  try {
    await assert.rejects(harness.start(), /requires unsupported capability loadSession/);
  } finally {
    await harness.close();
  }
});

test("fake ACP: interrupted work is uncertain, not retried, and requires explicit recovery", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aira-acp-"));
  const failedHarness = new AcpHarness(fakeProfile());
  const events: HarnessEvent[] = [];
  try {
    await assert.rejects(failedHarness.run({ taskId: "task-interrupt", prompt: "[exit-after-marker]", cwd }, (event) => events.push(event)));
    assert.equal(await readFile(path.join(cwd, "interrupted-side-effect.txt"), "utf8"), "once\n");
    assert(events.some((event) => event.type === "error" && event.uncertain));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await readFile(path.join(cwd, "interrupted-side-effect.txt"), "utf8"), "once\n", "no automatic retry occurred");
  } finally {
    await failedHarness.close();
  }

  const recovery = new AcpHarness(fakeProfile());
  const recoveryEvents: HarnessEvent[] = [];
  try {
    const run = recovery.run({ taskId: "task-recovery", sessionId: "fake-session-1", prompt: "explicit recovery", cwd }, (event) => recoveryEvents.push(event));
    const permission = await waitFor(recoveryEvents, (event) => event.type === "permission");
    assert.equal(permission.type, "permission");
    await recovery.respond(permission.requestId, { decision: "decline" });
    await run;
    assert(recoveryEvents.some((event) => event.type === "session" && event.resumed));
    assert.equal(await readFile(path.join(cwd, "interrupted-side-effect.txt"), "utf8"), "once\n");
  } finally {
    await recovery.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
