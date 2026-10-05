// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lease-driven execution coordinator between durable task state and provider operations.
 * @module
 * @remarks Missing dispatch acknowledgements and interrupted workloads enter release
 * and quarantine, never automatic replay. Lease loss stops local work without proving
 * that a provider workload stopped.
 * @see src/service/task-store.ts
 * @see src/service/agyn-driver.ts
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskState } from "@a2a-js/sdk";
import { DurableTaskStore, TaskStoreError, type DispatchReceipt, type Execution, type Runtime } from "./task-store.js";

/** Provider lifecycle boundary; authenticated reporting, not provider chat replies, supplies outcomes. */
export interface RuntimeDriver {
  /** On recovery, reconcile the previous create's identity instead of creating a replacement. */
  provision(execution: Execution, recovering: boolean, signal: AbortSignal): Promise<Runtime>;
  prepare(execution: Execution, signal: AbortSignal): Promise<void>;
  /** Persist receipts through onAccepted as they arrive; never retry a potentially accepted send. */
  dispatch(execution: Execution, signal: AbortSignal, onAccepted: (receipt: DispatchReceipt) => void): Promise<string>;
  observe(execution: Execution, signal: AbortSignal): Promise<"running" | "interrupted">;
  /** Return stopped only on confirmed removal, not a stop request, status change or reported outcome. */
  release(execution: Execution, signal: AbortSignal): Promise<{ stopped: boolean }>;
  /**
   * Delete a terminal task's runtime and its workspace. Repeat calls must be no-ops;
   * deleted reports whether this call performed the deletion. Drivers without it keep runtimes.
   */
  retire?(taskId: string, runtime: Runtime, signal: AbortSignal): Promise<{ deleted: boolean }>;
}

/** A terminal task's runtime retirement, logged by the composition root. */
export type RetirementEvent = { taskId: string; instanceId: string; profileId: string; state: TaskState; deleted: boolean };

/**
 * Concurrency is both a local job limit and the durable ceiling shared by every worker on this database.
 * profileTurnTimeoutMs overrides turnTimeoutMs for executions of the named profiles; it does not change admission.
 */
export type WorkerOptions = {
  concurrency: number; leaseMs: number; pollMs: number; turnTimeoutMs: number;
  profileTurnTimeoutMs?: ReadonlyMap<string, number>;
  /** Interval between sweeps for terminal tasks' runtimes; failed retirements back off up to an hour. */
  retireIntervalMs?: number;
  workerId?: string; onError?: (error: { executionId: string; phase: string; retrying: boolean; taskId?: string }) => void;
  onRetired?: (event: RetirementEvent) => void;
};

/** Drive claimed phases while heartbeating generation-fenced leases; settle only after driver release evidence. */
export class ExecutionWorker {
  private readonly workerId: string;
  private readonly stopping = new AbortController();
  private readonly jobs = new Set<Promise<void>>();
  private readonly retireBackoff = new Map<string, { until: number; failures: number }>();
  private loop?: Promise<void>;
  private retiring?: Promise<void>;

  /** Initialize or verify shared admission immediately, even with no queued work or provider calls. */
  constructor(private readonly store: DurableTaskStore, private readonly driver: RuntimeDriver, private readonly options: WorkerOptions) {
    for (const value of [options.concurrency, options.leaseMs, options.pollMs, options.turnTimeoutMs, options.retireIntervalMs ?? 15_000,
      ...(options.profileTurnTimeoutMs?.values() ?? [])]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("worker limits must be positive integers");
    }
    if (options.leaseMs < options.pollMs * 3) throw new Error("lease must allow at least three poll intervals");
    this.store.assertNotQuarantined();
    this.workerId = options.workerId ?? randomUUID();
    this.store.configureAdmission(options.concurrency);
  }

  start(): void {
    if (this.loop) throw new Error("worker already started");
    this.loop = this.schedule();
    if (this.driver.retire) this.retiring = this.retireTerminalRuntimes();
  }

  /** Abort and join local jobs, leaving durable leases for recovery; this is not a remote-workload drain. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop;
    await this.retiring;
    await Promise.all(this.jobs);
  }

  /**
   * Retire terminal tasks' runtimes independently of admission and execution slots.
   * @remarks A failure backs off for that task only and never blocks the others. The
   * durable record is written only after the driver confirms deletion, so a crash
   * between the two repeats an idempotent delete rather than leaking the workspace.
   */
  private async retireTerminalRuntimes(): Promise<void> {
    const interval = this.options.retireIntervalMs ?? 15_000;
    while (!this.stopping.signal.aborted) {
      try {
        const now = Date.now();
        const due = this.store.retirableRuntimes(200).filter(candidate => (this.retireBackoff.get(candidate.taskId)?.until ?? 0) <= now).slice(0, 20);
        for (const { taskId, state, runtime } of due) {
          if (this.stopping.signal.aborted) break;
          try {
            const { deleted } = await this.driver.retire!(taskId, runtime, this.stopping.signal);
            this.store.recordRetired(taskId, runtime.instanceId, deleted);
            this.retireBackoff.delete(taskId);
            this.options.onRetired?.({ taskId, instanceId: runtime.instanceId, profileId: runtime.profileId, state, deleted });
          } catch {
            if (this.stopping.signal.aborted) break;
            const failures = (this.retireBackoff.get(taskId)?.failures ?? 0) + 1;
            this.retireBackoff.set(taskId, { failures, until: Date.now() + Math.min(3_600_000, interval * 2 ** Math.min(failures, 12)) });
            this.options.onError?.({ executionId: "", phase: "retiring", retrying: true, taskId });
          }
        }
      } catch { this.options.onError?.({ executionId: "", phase: "retiring", retrying: true }); }
      await delay(interval, undefined, { signal: this.stopping.signal }).catch(() => {});
    }
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
          } else if (!execution.startedAt || Date.now() - execution.startedAt >= this.turnTimeoutMs(execution) ||
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

  private turnTimeoutMs(execution: Execution): number {
    return this.options.profileTurnTimeoutMs?.get(execution.profileId) ?? this.options.turnTimeoutMs;
  }

  private async pause(signal: AbortSignal): Promise<void> {
    await delay(this.options.pollMs, undefined, { signal }).catch(() => {});
  }
}
