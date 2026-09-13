// SPDX-License-Identifier: AGPL-3.0-only
import { AgynClient } from "../agyn-client.js";
import type { DispatchReceipt, Execution, Runtime } from "./task-store.js";
import type { RuntimeDriver } from "./worker.js";

export type AgynExecutionProfile = { id: string; agentId: string };
export type ExecutionSetup = (execution: Execution, signal: AbortSignal) => Promise<{ workloadId: string }>;

export class AgynRuntimeDriver implements RuntimeDriver {
  private readonly profiles: Map<string, AgynExecutionProfile>;

  constructor(private readonly client: AgynClient, profiles: AgynExecutionProfile[], private readonly setup: ExecutionSetup) {
    this.profiles = new Map(profiles.map(profile => [profile.id, profile]));
    if (!profiles.length || this.profiles.size !== profiles.length) throw new Error("unique runtime profiles are required");
    if (profiles.some(profile => !profile.id || !profile.agentId)) throw new Error("profile and Agyn agent IDs are required");
  }

  async provision(execution: Execution, recovering: boolean, signal: AbortSignal): Promise<Runtime> {
    const agentId = this.profile(execution.profileId).agentId;
    const label = instanceLabel(execution.taskId);
    const matches = (await this.client.instances(agentId, signal)).filter(instance => instance.label === label);
    if (matches.length > 1) throw new Error("ambiguous provisioned instances");
    if (!matches.length && recovering) throw new Error("provision acknowledgement missing; manual reconciliation required");
    const instance = matches[0] ?? await this.client.createInstance(agentId, label, signal);
    const threads = await this.client.instanceThreads(instance.meta.id, signal);
    if (threads.length > 1 || !threads.length && recovering) throw new Error("ambiguous provisioned threads");
    const thread = threads[0] ?? await this.client.createInstanceThread(instance.meta.id, signal);
    const participants = new Set(thread.participants.map(participant => participant.id));
    if (participants.size !== 2 || !participants.has(instance.meta.id) || !participants.has(this.client.identityId)) {
      throw new Error("task thread has unexpected participants");
    }
    return { instanceId: instance.meta.id, threadId: thread.id, profileId: execution.profileId };
  }

  async prepare(execution: Execution, signal: AbortSignal): Promise<void> {
    const runtime = this.runtime(execution);
    const instance = await this.client.getInstance(runtime.instanceId, signal);
    if (instance.agentId !== this.profile(execution.profileId).agentId) throw new Error("pinned agent class does not match the runtime");
    if (instance.state === "AGENT_INSTANCE_STATE_PAUSED") await this.client.resumeInstance(runtime.instanceId, signal);
    else if (instance.state !== "AGENT_INSTANCE_STATE_ACTIVE") throw new Error("runtime cannot resume");
  }

  async dispatch(execution: Execution, signal: AbortSignal, onAccepted: (receipt: DispatchReceipt) => void): Promise<string> {
    const runtime = this.runtime(execution);
    const prompt = execution.message.parts.map(part => part.content?.value).join("\n");
    const request = await this.client.sendMessage(runtime.threadId, prompt, signal);
    if (!request.id || request.threadId !== runtime.threadId) throw new Error("invalid dispatch acknowledgement");
    onAccepted({ requestId: request.id });
    // Agyn starts a pod only for an inbox item. A trusted init gate must prevent
    // agent execution until setup installs reporting in that exact workload.
    const { workloadId } = await this.setup({ ...execution, requestId: request.id }, signal);
    if (!workloadId) throw new Error("setup did not bind a workload");
    onAccepted({ requestId: request.id, workloadId });
    return request.id;
  }

  async observe(execution: Execution, signal: AbortSignal): Promise<"running" | "interrupted"> {
    const runtime = this.runtime(execution);
    const instance = await this.client.getInstance(runtime.instanceId, signal);
    if (instance.state !== "AGENT_INSTANCE_STATE_ACTIVE") return "interrupted";
    const workloads = await this.client.workloads(runtime.instanceId, signal);
    const active = workloads.filter(workload => !workload.removalConfirmedAt);
    if (!execution.workloadId || active.length !== 1 || active[0].meta.id !== execution.workloadId ||
        active[0].agentInstanceId !== runtime.instanceId || active[0].status !== "WORKLOAD_STATUS_RUNNING") return "interrupted";
    // Chat replies are not completion events. Only the authenticated reporting channel supplies outcomes.
    return "running";
  }

  async release(execution: Execution, signal: AbortSignal): Promise<{ stopped: boolean }> {
    const instances = execution.runtime ? [await this.client.getInstance(execution.runtime.instanceId, signal)]
      : (await this.client.instances(this.profile(execution.profileId).agentId, signal)).filter(instance => instance.label === instanceLabel(execution.taskId));
    // A lost creation acknowledgement with no visible instance is not proof that creation never happened.
    if (!instances.length) return { stopped: false };
    let stopped = true;
    for (let instance of instances) {
      if (instance.state === "AGENT_INSTANCE_STATE_ACTIVE") {
        instance = await this.client.pauseInstance(instance.meta.id, "A2A execution stopped; retain durable state", signal);
      }
      if (!["AGENT_INSTANCE_STATE_PAUSED", "AGENT_INSTANCE_STATE_TERMINATED"].includes(instance.state)) stopped = false;
      const workloads = await this.client.workloads(instance.meta.id, signal);
      if (execution.requestId && !workloads.length || execution.workloadId && !workloads.some(workload => workload.meta.id === execution.workloadId)) stopped = false;
      // removedAt ends metering and may be stamped by a FAILED status report.
      // Only explicit lifecycle confirmation proves runner-observed absence.
      if (workloads.some(workload => !workload.removalConfirmedAt)) stopped = false;
    }
    return { stopped };
  }

  private runtime(execution: Execution): Runtime {
    this.profile(execution.profileId);
    if (!execution.runtime || execution.runtime.profileId !== execution.profileId) throw new Error("runtime binding is missing or mismatched");
    return execution.runtime;
  }
  private profile(id: string): AgynExecutionProfile {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error("pinned runtime profile is unavailable");
    return profile;
  }
}

function instanceLabel(taskId: string): string {
  // Agyn handle suffixes are at most 32 characters. Preserve all UUID bits.
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(taskId)) throw new Error("invalid task UUID");
  return taskId.replaceAll("-", "");
}
