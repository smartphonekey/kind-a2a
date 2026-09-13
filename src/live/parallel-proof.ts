// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";

export type BarrierOptions = { root: string; marker: string; turn: 1 | 2; timeoutMs?: number; tcpPort?: number; udpPort?: number };

// Self-contained: the same function runs in unit-test children and real Codex tools.
export async function holdParallelTurn(options: BarrierOptions): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const net = await import("node:net");
  const dgram = await import("node:dgram");
  const { default: EventEmitter } = await import("node:events");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { root, marker, turn } = options;
  if (!path.isAbsolute(root) || !/^[A-Za-z0-9_-]{1,80}$/.test(marker) || ![1, 2].includes(turn)) throw new Error("invalid barrier identity");
  const file = (name: string) => path.join(root, name);
  if (turn === 1) fs.writeFileSync(file("reporting-proof.txt"), marker, { flag: "wx", mode: 0o600 });
  else {
    if (fs.readFileSync(file("reporting-proof.txt"), "utf8") !== marker) throw new Error("workspace marker changed");
    fs.writeFileSync(file("parallel-followup.txt"), marker, { flag: "wx", mode: 0o600 });
  }
  fs.appendFileSync(file("parallel-actions.txt"), `${turn}:${marker}\n`, { mode: 0o600 });
  const reply = (data: Buffer | string) => `${JSON.stringify({ nonce: JSON.parse(data.toString()).nonce, token: marker })}\n`;
  const tcp = net.createServer(socket => {
    let data = "";
    socket.setTimeout(3000, () => socket.destroy()); socket.on("error", () => {});
    socket.on("data", chunk => {
      data += chunk;
      if (data.length > 1024) return void socket.destroy();
      if (data.includes("\n")) { try { socket.end(reply(data)); } catch { socket.destroy(); } }
    });
  });
  const udp = dgram.createSocket("udp4");
  udp.on("message", (data, remote) => {
    if (data.length > 1024) return;
    try { udp.send(reply(data), remote.port, remote.address); } catch {}
  });
  const startedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    tcp.listen(options.tcpPort ?? 19081, "0.0.0.0"); await EventEmitter.once(tcp, "listening");
    udp.bind(options.udpPort ?? 19082, "0.0.0.0"); await EventEmitter.once(udp, "listening");
    const tcpAddress = tcp.address();
    if (!tcpAddress || typeof tcpAddress === "string") throw new Error("listener address unavailable");
    const state = { marker, turn, pid: process.pid, startedAt, tcpPort: tcpAddress.port, udpPort: udp.address().port };
    const writeHeartbeat = () => {
      fs.writeFileSync(file(`parallel-heartbeat-${turn}.tmp`), JSON.stringify({ ...state, at: Date.now() }), { mode: 0o600 });
      fs.renameSync(file(`parallel-heartbeat-${turn}.tmp`), file(`parallel-heartbeat-${turn}.json`));
    };
    writeHeartbeat(); heartbeat = setInterval(writeHeartbeat, 200);
    fs.writeFileSync(file(`parallel-ready-${turn}.tmp`), JSON.stringify(state), { flag: "wx", mode: 0o600 });
    fs.renameSync(file(`parallel-ready-${turn}.tmp`), file(`parallel-ready-${turn}.json`));
    console.log(JSON.stringify({ kind: "barrier.ready", ...state }));
    while (!fs.existsSync(file(`parallel-release-${turn}.json`))) {
      if (Date.now() - startedAt > (options.timeoutMs ?? 210_000)) throw new Error("parallel barrier timed out");
      await delay(100);
    }
    const release = JSON.parse(fs.readFileSync(file(`parallel-release-${turn}.json`), "utf8"));
    if (release.marker !== marker || release.turn !== turn) throw new Error("parallel release identity mismatch");
    fs.writeFileSync(file(`parallel-completed-${turn}.json`), JSON.stringify({ ...state, finishedAt: Date.now() }), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ kind: "barrier.completed", marker, turn }));
  } finally {
    clearInterval(heartbeat);
    if (tcp.listening) await new Promise<void>(resolve => tcp.close(() => resolve()));
    try { udp.close(); } catch {}
  }
}

export function parallelProgram(options: BarrierOptions): string {
  return `(${holdParallelTurn.toString()})(${JSON.stringify(options)}).catch(e=>{console.error(e.message);process.exitCode=1;})`;
}

export type ParallelSnapshot = {
  taskId: string; executionId: string; instanceId: string; threadId: string; profileId: string;
  uid: string; pvc: string[]; marker: string; native: { instanceId: string; sessionId: string }[];
};

export function assertSeparateTasks(a: ParallelSnapshot, b: ParallelSnapshot): void {
  for (const key of ["taskId", "executionId", "instanceId", "threadId", "uid", "marker"] as const) {
    assert(a[key] && b[key]); assert.notEqual(a[key], b[key], `${key} leaked across tasks`);
  }
  assert.equal(a.profileId, b.profileId, "the test must use the same agent profile");
  assert.equal(a.pvc.length, 1); assert.equal(b.pvc.length, 1);
  assert.notEqual(a.pvc[0], b.pvc[0], "tasks mounted the same PVC");
  for (const snapshot of [a, b]) {
    assert.equal(snapshot.native.length, 1);
    assert.equal(snapshot.native[0].instanceId, snapshot.instanceId);
    assert(snapshot.native[0].sessionId);
  }
  assert.notEqual(a.native[0].sessionId, b.native[0].sessionId, "tasks reused a native session");
}

export function assertQueuedOnly(events: any[], executionId: string): void {
  const own = events.filter(event => event.executionId === executionId);
  assert.equal(own.length, 1, "follow-up did work before its preceding turn released compute");
  assert.equal(own[0].kind, "execution.queued");
}

export function assertFifoRelease(events: any[], first: string, followup: string): void {
  const stopped = events.find(event => event.executionId === first && event.kind === "runtime.stopped");
  const claimed = events.find(event => event.executionId === followup && event.kind === "execution.claimed");
  assert(stopped && claimed, "missing release or claim evidence");
  assert(claimed.sequence > stopped.sequence, "follow-up was claimed before confirmed release");
}
