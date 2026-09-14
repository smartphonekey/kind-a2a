// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DurableTaskStore, TaskStoreError, type DispatchReceipt, type Execution, type Runtime } from "./task-store.js";

/** Provider operations must not retry non-idempotent sends. Reporting is a separate channel. */
export interface RuntimeDriver {
  provision(execution: Execution, recovering: boolean, signal: AbortSignal): Promise<Runtime>;
  prepare(execution: Execution, signal: AbortSignal): Promise<void>;
  dispatch(execution: Execution, signal: AbortSignal, onAccepted: (receipt: DispatchReceipt) => void): Promise<string>;
  observe(execution: Execution, signal: AbortSignal): Promise<"running" | "interrupted">;
  release(execution: Execution, signal: AbortSignal): Promise<{ stopped: boolean }>;
}

export type WorkerOptions = {
  concurrency: number; leaseMs: number; pollMs: number; turnTimeoutMs: number;
  workerId?: string; onError?: (error: { executionId: string; phase: string; retrying: boolean }) => void;
};

export class ExecutionWorker {
  private readonly workerId: string;
  private readonly stopping = new AbortController();
  private readonly jobs = new Set<Promise<void>>();
  private loop?: Promise<void>;

  constructor(private readonly store: DurableTaskStore, private readonly driver: RuntimeDriver, private readonly options: WorkerOptions) {
    for (const value of [options.concurrency, options.leaseMs, options.pollMs, options.turnTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("worker limits must be positive integers");
    }
    if (options.leaseMs < options.pollMs * 3) throw new Error("lease must allow at least three poll intervals");
    this.workerId = options.workerId ?? randomUUID();
    this.store.configureAdmission(options.concurrency);
  }

  start(): void {
    if (this.loop) throw new Error("worker already started");
    this.loop = this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop;
    await Promise.all(this.jobs);
  }

  private async schedule(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        while (this.jobs.size < this.options.concurrency) {
          const claimed = this.store.claim(this.workerId, this.options.leaseMs, this.options.concurrency);
          if (!claimed) break;
          const job = this.run(claimed).finally(() => { this.jobs.delete(job); });
          this.jobs.add(job);
        }
      } catch { this.options.onError?.({ executionId: "", phase: "scheduler", retrying: true }); }
      await this.pause(this.stopping.signal);
    }
  }

  private async run(claimed: NonNullable<ReturnType<DurableTaskStore["claim"]>>): Promise<void> {
    const { lease, recovered } = claimed;
    const lost = new AbortController();
    const signal = AbortSignal.any([this.stopping.signal, lost.signal]);
    const heartbeat = setInterval(() => {
      try { this.store.heartbeat(lease, this.options.leaseMs); }
      catch { lost.abort(); }
    }, Math.max(1, Math.floor(this.options.leaseMs / 3)));
    try {
      while (!signal.aborted) {
        const execution = this.store.execution(lease.executionId)!;
        if (["settled", "uncertain"].includes(execution.phase)) return;
        try {
          if (execution.phase === "provisioning") {
            // A recovered create must reconcile provider identity, never create another instance.
            const runtime = await this.driver.provision(execution, recovered, signal);
            this.store.bind(lease, runtime);
          } else if (execution.phase === "releasing") {
            const evidence = await this.driver.release(execution, signal);
            if (evidence.stopped) { this.store.settle(lease, evidence); return; }
            await this.pause(signal);
          } else if (execution.canceled || execution.outcome) {
            this.store.releasing(lease);
          } else if (execution.phase === "ready") {
            await this.driver.prepare(execution, signal);
            signal.throwIfAborted();
            const dispatch = this.store.beginDispatch(lease);
            const requestId = await this.driver.dispatch(dispatch, signal, receipt => this.store.recordDispatchReceipt(lease, receipt));
            this.store.dispatched(lease, requestId);
          } else if (execution.phase === "dispatching") {
            this.store.markUncertain(lease, "Dispatch acknowledgement missing; automatic resend is disabled");
          } else if (!execution.startedAt || Date.now() - execution.startedAt >= this.options.turnTimeoutMs ||
              await this.driver.observe(execution, signal) === "interrupted") {
            this.store.markUncertain(lease, "Execution interrupted or deadline exceeded before a durable outcome");
          } else await this.pause(signal);
        } catch (error) {
          if (signal.aborted || error instanceof TaskStoreError && error.code === "stale_lease") return;
          const current = this.store.execution(lease.executionId)!;
          if (current.phase === "releasing") {
            this.options.onError?.({ executionId: current.id, phase: current.phase, retrying: true });
            await this.pause(signal);
          } else {
            this.store.markUncertain(lease, `Provider operation failed during ${current.phase}; inspect provider state before continuing`);
          }
        }
      }
    } catch {
      this.options.onError?.({ executionId: lease.executionId, phase: "worker", retrying: false });
    } finally {
      clearInterval(heartbeat);
      // Do not settle on process exit. The next owner reconciles the recorded phase after lease expiry.
    }
  }

  private async pause(signal: AbortSignal): Promise<void> {
    await delay(this.options.pollMs, undefined, { signal }).catch(() => {});
  }
}
