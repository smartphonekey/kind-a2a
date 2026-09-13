// SPDX-License-Identifier: AGPL-3.0-only
// Real-agent operator acceptance; no special parallel-task logic enters the service.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgynClient } from "../agyn-client.js";
import { assertInstanceAbsent, instancePods } from "./kubernetes-proof.js";
import { assertProbe, probeProgram, tcpPort, udpPort } from "./network-proof.js";
import { assertFifoRelease, assertQueuedOnly, assertSeparateTasks, parallelProgram } from "./parallel-proof.js";

type Context = {
  kubeconfig: string; directory: string; agentId: string; suffix: string; gateway: AgynClient;
  tasks: string[]; rpc: (method: string, params: unknown) => Promise<any>;
  events: (taskId: string) => Promise<any[]>; inspect: (instanceId: string) => any[];
};

export async function runParallelAcceptance(context: Context): Promise<void> {
  const { kubeconfig, agentId, suffix, rpc, events, inspect, gateway } = context;
  const evidence: any = { agentId, startedAt: new Date().toISOString(), passed: false, samples: [], network: [], reporters: [] };
  const save = () => writeFileSync(join(context.directory, "parallel.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const markers = { a: `a-${suffix}`, b: `b-${suffix}` };
  const prompt = (marker: string, turn: 1 | 2) => `Parallel-isolation acceptance, turn ${turn}. Report progress, then run this JavaScript once using your command-execution tool and /agyn/bin/node -e. Keep waiting for the command until it exits; poll its running-command handle if needed. The operator, not you, releases its barrier. Do not create release files, detach it, report an outcome, or perform other work while it runs. If it fails, report the failure and do not retry or repair the fixture. After success, read /workspace/reporting-proof.txt, publish its exact contents as a text artifact, and report turn_done. JavaScript: ${parallelProgram({ root: "/workspace", marker, turn })}`;
  const send = async (marker: string, turn: 1 | 2, taskId?: string) => {
    const messageId = randomUUID();
    const result = await rpc("SendMessage", { message: { messageId, taskId, role: "ROLE_USER", parts: [{ text: prompt(marker, turn) }] }, configuration: { returnImmediately: true } });
    const id = result.task.id as string;
    if (!taskId) context.tasks.push(id); else assert.equal(id, taskId);
    const queued = (await events(id)).find(event => event.kind === "execution.queued" && event.payload.messageId === messageId);
    assert(queued?.executionId, "accepted message has no durable execution");
    return { taskId: id, executionId: queued.executionId as string, messageId, marker, turn };
  };
  type Turn = Awaited<ReturnType<typeof send>>;
  const exec = (snapshot: any, program: string, argument?: unknown) => {
    const pods = instancePods(kubeconfig, snapshot.instanceId);
    assert.equal(pods.length, 1, "expected exactly one live pod for this instance");
    const pod = pods[0]; assert.equal(pod.metadata.uid, snapshot.uid, "fixture pod was replaced unexpectedly");
    const container = pod.spec.containers.find((item: any) => item.env?.some((env: any) => env.name === "AGENT_INSTANCE_ID" && env.value === snapshot.instanceId));
    assert(container);
    return JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "-n", "agyn-workloads", "exec", pod.metadata.name, "-c", container.name,
      "--", "/agyn/bin/node", "-e", program, ...(argument === undefined ? [] : [JSON.stringify(argument)])], { encoding: "utf8", timeout: 12_000 }));
  };
  const state = (snapshot: any, turn: Turn) => exec(snapshot, `const fs=require('node:fs'),n=JSON.parse(process.argv[1]).turn;
    const read=p=>fs.existsSync('/workspace/'+p)?JSON.parse(fs.readFileSync('/workspace/'+p,'utf8')):null;
    const ready=read('parallel-ready-'+n+'.json');let alive=false;if(ready)try{process.kill(ready.pid,0);alive=true;}catch{}
    console.log(JSON.stringify({ready,alive,heartbeat:read('parallel-heartbeat-'+n+'.json'),completed:read('parallel-completed-'+n+'.json'),
      actions:fs.existsSync('/workspace/parallel-actions.txt')?fs.readFileSync('/workspace/parallel-actions.txt','utf8'):null,
      followup:fs.existsSync('/workspace/parallel-followup.txt')?fs.readFileSync('/workspace/parallel-followup.txt','utf8'):null,
      hasServiceAccountToken:fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')}));`, { turn: turn.turn });
  const holding = (snapshot: any, turn: Turn) => {
    const sample = state(snapshot, turn);
    assert.equal(sample.ready?.marker, turn.marker); assert.equal(sample.ready.turn, turn.turn);
    assert.equal(sample.alive, true); assert.equal(sample.completed, null, "barrier completed before operator release");
    assert.equal(sample.hasServiceAccountToken, false);
    assert(Date.now() - sample.heartbeat.at < 10_000, "barrier heartbeat stopped");
    evidence.samples.push({ taskId: turn.taskId, executionId: turn.executionId, at: Date.now(), ...sample }); save();
    return sample;
  };
  const ready = async (turn: Turn) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      const history = await events(turn.taskId);
      assert(!history.some(event => event.executionId === turn.executionId && ["execution.uncertain", "agent.outcome"].includes(event.kind)), "turn ended before its barrier");
      const binding = history.find(event => event.kind === "runtime.bound")?.payload;
      if (binding && history.some(event => event.executionId === turn.executionId && event.kind === "execution.dispatched")) {
        const found = inspect(binding.instanceId);
        if (found.length === 1) {
          const pod = instancePods(kubeconfig, binding.instanceId)[0];
          assert(pod && pod.metadata.uid === found[0].uid);
          assert.equal(pod.metadata.labels["agent-id"], agentId);
          assert(!pod.spec.hostNetwork && !pod.spec.hostPID && !pod.spec.hostIPC);
          assert(!pod.spec.volumes.some((volume: any) => volume.hostPath), "fixture has a host mount");
          assert.equal(pod.spec.automountServiceAccountToken, false);
          const snapshot = { ...found[0], ...binding, ...turn, marker: found[0].marker, podIP: pod.status.podIP,
            podSecurityContext: pod.spec.securityContext,
            resources: pod.spec.containers.map((item: any) => ({ name: item.name, resources: item.resources, securityContext: item.securityContext })),
            initResources: (pod.spec.initContainers ?? []).map((item: any) => ({ name: item.name, resources: item.resources, securityContext: item.securityContext })) };
          if (state(snapshot, turn).ready) {
            assert.equal(snapshot.marker, turn.marker); holding(snapshot, turn);
            return snapshot;
          }
        }
      }
      await delay(1000);
    }
    throw new Error(`parallel turn did not reach barrier: ${turn.taskId}/${turn.turn}`);
  };
  const release = (snapshot: any, turn: Turn) => {
    holding(snapshot, turn);
    const result = exec(snapshot, `const fs=require('node:fs'),x=JSON.parse(process.argv[1]);
      const r=JSON.parse(fs.readFileSync('/workspace/parallel-ready-'+x.turn+'.json','utf8'));
      if(r.marker!==x.marker)throw Error('wrong barrier');process.kill(r.pid,0);
      if(fs.existsSync('/workspace/parallel-release-'+x.turn+'.json'))throw Error('barrier already released');
      fs.writeFileSync('/workspace/parallel-release-'+x.turn+'.tmp',JSON.stringify(x),{flag:'wx',mode:0o600});
      fs.renameSync('/workspace/parallel-release-'+x.turn+'.tmp','/workspace/parallel-release-'+x.turn+'.json');
      console.log(JSON.stringify({released:true,at:Date.now()}));`, { marker: turn.marker, turn: turn.turn });
    evidence.samples.push({ kind: "operator.released", ...turn, ...result }); save();
  };
  const settled = async (turn: Turn, snapshot: any, anotherTurnQueued: boolean) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const history = await events(turn.taskId);
      assert(!history.some(event => event.executionId === turn.executionId && event.kind === "execution.uncertain"), "parallel turn quarantined");
      if (history.some(event => event.executionId === turn.executionId && event.kind === "execution.settled")) {
        assert(history.some(event => event.executionId === turn.executionId && event.kind === "agent.outcome" && event.payload.outcome === "turn_done"));
        assert(history.some(event => event.executionId === turn.executionId && event.kind === "agent.artifact" && event.payload.text === turn.marker));
        assert(!instancePods(kubeconfig, snapshot.instanceId).some(pod => pod.metadata.uid === snapshot.uid), "settlement preceded old Pod removal");
        const workloads = await gateway.workloads(snapshot.instanceId);
        assert(workloads.find(workload => workload.meta.id === snapshot.labels["workload_key"])?.removalConfirmedAt, "old workload has no confirmed removal");
        if (!anotherTurnQueued) {
          assertInstanceAbsent(kubeconfig, snapshot.instanceId);
          const task = await rpc("GetTask", { id: turn.taskId });
          assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED");
          assert.equal(task.metadata.resourcesReleased, true);
        }
        evidence.samples.push({ kind: "turn.settled", ...turn, history, workloads }); save();
        return history;
      }
      await delay(1000);
    }
    throw new Error("parallel turn did not settle");
  };
  const reporter = (snapshot: any, other: Turn) => exec(snapshot, `const fs=require('node:fs'),crypto=require('node:crypto'),other=JSON.parse(process.argv[1]);
    (async()=>{const c=JSON.parse(fs.readFileSync('/run/agyn-execution/binding.json','utf8'));
      const auth={authorization:'Bearer '+c.token};const target=new URL(c.url+'/status');target.searchParams.set('executionId',other.executionId);
      const response=await fetch(target,{headers:auth,redirect:'error',signal:AbortSignal.timeout(5000)});
      const status=response.ok?await response.json():{};
      const taskResponse=await fetch(new URL('/tasks/'+other.taskId+'/events',c.url),{headers:auth,redirect:'error',signal:AbortSignal.timeout(5000)});
      console.log(JSON.stringify({status:response.status,executionId:status.executionId,phase:status.phase,crossTaskStatus:taskResponse.status,
        credentialHash:crypto.createHash('sha256').update(c.token).digest('hex')}));
    })().catch(()=>{console.error('reporter scope probe failed');process.exitCode=1;});`, other);

  try {
    const a1 = await send(markers.a, 1);
    const a2 = await send(markers.a, 2, a1.taskId);
    const b1 = await send(markers.b, 1);
    evidence.turns = { a1, a2, b1 }; save();
    console.log(JSON.stringify({ kind: "live.parallel-queued", tasks: [a1.taskId, b1.taskId], followup: a2.executionId }));
    const a = await ready(a1); const b = await ready(b1);
    assertSeparateTasks(a, b); evidence.initial = { a, b }; save();
    const firstA = holding(a, a1); const firstB = holding(b, b1);
    for (let tick = 0; tick < 5; tick++) {
      assertQueuedOnly(await events(a1.taskId), a2.executionId);
      assert(!holding(a, a1).followup); assert(!holding(b, b1).followup);
      assert.equal(instancePods(kubeconfig, a.instanceId).length + instancePods(kubeconfig, b.instanceId).length, 2);
      await delay(1000);
    }
    assert(holding(a, a1).heartbeat.at > firstA.heartbeat.at); assert(holding(b, b1).heartbeat.at > firstB.heartbeat.at);
    for (const [source, target] of [[a, b], [b, a]]) for (const protocol of ["tcp", "udp"] as const) {
      const probe = (pod: any, host: string, marker: string) => {
        const command = probeProgram({ protocol, host, port: protocol === "tcp" ? tcpPort : udpPort, token: marker });
        return exec(pod, command[2], JSON.parse(command[3]));
      };
      const own = probe(source, "127.0.0.1", source.marker); assertProbe(own, true);
      const listener = probe(target, "127.0.0.1", target.marker); assertProbe(listener, true);
      const cross = probe(source, target.podIP, target.marker); assertProbe(cross, false, listener);
      evidence.network.push({ source: source.instanceId, target: target.instanceId, protocol, own, listener, cross }); save();
    }
    const aReporter = reporter(a, b1); const bReporter = reporter(b, a1);
    for (const [scope, turn] of [[aReporter, a1], [bReporter, b1]] as const) {
      assert.equal(scope.status, 200); assert.equal(scope.executionId, turn.executionId); assert.equal(scope.phase, "running");
      assert.equal(scope.crossTaskStatus, 401, "reporter credential crossed into A2A owner access");
    }
    assert.notEqual(aReporter.credentialHash, bReporter.credentialHash);
    evidence.reporters.push(aReporter, bReporter); save();
    assertQueuedOnly(await events(a1.taskId), a2.executionId);
    release(a, a1); await settled(a1, a, true);
    const followup = await ready(a2); evidence.followup = followup;
    assertFifoRelease(await events(a1.taskId), a1.executionId, a2.executionId);
    assertSeparateTasks(followup, b);
    assert.notEqual(followup.uid, a.uid);
    for (const key of ["instanceId", "threadId", "profileId", "marker"] as const) assert.equal(followup[key], a[key]);
    assert.deepEqual(followup.pvc, a.pvc);
    assert.deepEqual(followup.native, a.native);
    assert.equal(holding(followup, a2).actions, `1:${markers.a}\n2:${markers.a}\n`);
    assert.equal(holding(followup, a2).followup, markers.a);
    const unchangedB = holding(b, b1);
    assert.equal(unchangedB.actions, `1:${markers.b}\n`); assert.equal(unchangedB.followup, null);
    const nextReporter = reporter(followup, b1);
    assert.equal(nextReporter.status, 200); assert.equal(nextReporter.phase, "running");
    assert.equal(nextReporter.executionId, a2.executionId); assert.notEqual(nextReporter.credentialHash, aReporter.credentialHash);
    assert.equal(nextReporter.crossTaskStatus, 401); evidence.reporters.push(nextReporter); save();
    release(followup, a2); await settled(a2, followup, false);
    assert(holding(b, b1).heartbeat.at > unchangedB.heartbeat.at, "other task stopped advancing during follow-up");
    release(b, b1); await settled(b1, b, false);
    const instances = await gateway.instances(agentId);
    assert.equal(instances.length, 2, "one agent/task binding created extra instances");
    assert.deepEqual(new Set(instances.map(instance => instance.meta.id)), new Set([a.instanceId, b.instanceId]));
    evidence.passed = true; console.log(JSON.stringify({ kind: "live.parallel-passed", tasks: [a1.taskId, b1.taskId], instances: instances.map(i => i.meta.id) }));
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error); throw error;
  } finally { evidence.finishedAt = new Date().toISOString(); save(); }
}
