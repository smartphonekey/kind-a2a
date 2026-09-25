// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bounded SSE delivery and idle keepalives shared by both A2A HTTP bindings.
 * @module
 * @see src/service/http.ts
 * @see src/service/browser.ts
 */
import { once } from "node:events";
import type { Writable } from "node:stream";

export type SseWriteOptions = { heartbeatMs?: number; drainTimeoutMs?: number };

/**
 * Apply backpressure to preformatted frames without buffering an unbounded event queue.
 * @remarks A failed or timed-out drain aborts the request and destroys its writable,
 * allowing the HTTP owner-request slot to be released. This does not cancel durable work.
 */
export class SseWriter {
  private timer?: NodeJS.Timeout;
  private writing?: Promise<void>;
  private closed = false;
  private readonly heartbeatMs: number;
  private readonly drainTimeoutMs: number;
  private readonly interrupted = () => { clearTimeout(this.timer); if (this.writing) this.response.destroy(); };
  private readonly failed = () => { this.abort(); this.response.destroy(); };

  constructor(private readonly response: Writable, private readonly signal: AbortSignal,
    private readonly abort: () => void, options: SseWriteOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
    if (![this.heartbeatMs, this.drainTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("SSE write intervals must be positive integers");
    }
    response.once("error", this.failed);
    signal.addEventListener("abort", this.interrupted, { once: true });
    if (signal.aborted) this.interrupted();
  }

  /** Callers must await each write; only the internal idle heartbeat may compete with the event producer. */
  async write(frame: string): Promise<void> {
    if (this.writing) await this.writing;
    this.signal.throwIfAborted();
    if (this.closed) throw new Error("SSE writer is closed");
    clearTimeout(this.timer);
    const writing = this.flush(frame);
    this.writing = writing;
    try { await writing; }
    finally { if (this.writing === writing) this.writing = undefined; }
    if (!this.closed && !this.signal.aborted) {
      this.timer = setTimeout(() => { void this.write(": keep-alive\n\n").catch(() => {}); }, this.heartbeatMs);
      this.timer.unref();
    }
  }

  /** Stop heartbeats and detach listeners after the pending write; the caller still owns ending the response. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.writing?.catch(() => {});
    this.response.off("error", this.failed);
    this.signal.removeEventListener("abort", this.interrupted);
  }

  private async flush(frame: string): Promise<void> {
    try {
      if (this.response.write(frame)) return;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.drainTimeoutMs);
      try { await once(this.response, "drain", { signal: AbortSignal.any([this.signal, timeout.signal]) }); }
      finally { clearTimeout(timer); }
    } catch (error) {
      // end() can leave buffered bytes and the admission slot alive indefinitely.
      this.failed();
      throw error;
    }
  }
}
