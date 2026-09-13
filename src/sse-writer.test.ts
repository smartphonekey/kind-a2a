// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SseWriter } from "./service/sse-writer.js";

test("SSE writer: idle comments stop on close and release listeners", { timeout: 5000 }, async t => {
  const frames: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { frames.push(chunk.toString()); callback(); } });
  const abort = new AbortController();
  const writer = new SseWriter(output, abort.signal, () => abort.abort(), { heartbeatMs: 10, drainTimeoutMs: 100 });
  t.after(async () => { abort.abort(); await writer.close(); output.destroy(); });
  await delay(25); assert.deepEqual(frames, [], "no heartbeat before the first task frame");
  await writer.write("data: task\n\n");
  await delay(50);
  assert.equal(frames[0], "data: task\n\n");
  assert(frames.slice(1).length >= 2 && frames.slice(1).every(frame => frame === ": keep-alive\n\n"));
  await writer.close();
  const count = frames.length; await delay(30); assert.equal(frames.length, count);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  assert.equal(output.listenerCount("error"), 0);
});

test("SSE writer: backpressure retains one frame, suppresses heartbeat growth and aborts on drain deadline", { timeout: 5000 }, async t => {
  const frames: string[] = [];
  const output = new Writable({ highWaterMark: 1, write(chunk) { frames.push(chunk.toString()); } });
  const abort = new AbortController();
  const writer = new SseWriter(output, abort.signal, () => abort.abort(), { heartbeatMs: 5, drainTimeoutMs: 80 });
  t.after(async () => { abort.abort(); await writer.close(); output.destroy(); });
  const writing = writer.write("data: task\n\n");
  const rejected = assert.rejects(writing, { name: "AbortError" });
  await delay(40);
  assert.deepEqual(frames, ["data: task\n\n"]);
  assert.equal(output.writableLength, Buffer.byteLength(frames[0]));
  await rejected;
  assert(abort.signal.aborted && output.destroyed);
  await writer.close();
  assert.equal(output.listenerCount("drain"), 0);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("SSE writer: a slow heartbeat serializes the next event instead of accumulating writes", { timeout: 5000 }, async t => {
  const frames: string[] = [];
  let release: (() => void) | undefined;
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    frames.push(chunk.toString());
    if (chunk.toString().startsWith(":")) release = callback; else callback();
  } });
  const abort = new AbortController();
  const writer = new SseWriter(output, abort.signal, () => abort.abort(), { heartbeatMs: 10, drainTimeoutMs: 1000 });
  t.after(async () => { abort.abort(); await writer.close(); output.destroy(); });
  await writer.write("data: one\n\n");
  await delay(40); assert(release);
  const next = writer.write("data: two\n\n");
  await delay(30);
  assert.deepEqual(frames, ["data: one\n\n", ": keep-alive\n\n"]);
  release(); await next; await writer.close();
  assert.deepEqual(frames, ["data: one\n\n", ": keep-alive\n\n", "data: two\n\n"]);
});

test("SSE writer: disconnect interrupts a pending write immediately", { timeout: 5000 }, async t => {
  const output = new Writable({ highWaterMark: 1, write() {} });
  const abort = new AbortController();
  const writer = new SseWriter(output, abort.signal, () => abort.abort());
  t.after(async () => { abort.abort(); await writer.close(); output.destroy(); });
  const writing = writer.write("data: task\n\n");
  abort.abort();
  await assert.rejects(writing, { name: "AbortError" });
  assert(output.destroyed);
  await writer.close();
  assert.equal(output.listenerCount("drain"), 0);
});
