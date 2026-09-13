// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in, real-model acceptance. This creates separate Agyn fixtures and retains their durable state.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KubeConfig, KubernetesObjectApi } from "@kubernetes/client-node";
import { AgynClient } from "../agyn-client.js";
import { assertInstanceAbsent, inspectRetainedCancellationPvc, instancePods } from "./kubernetes-proof.js";
import { agentNetworkPolicies, assertPolicyUnchanged, managedLabel, NetworkFixtures } from "./network-proof.js";
import { runParallelAcceptance } from "./agyn-parallel.js";

if (process.env.AGYN_LIVE_ACCEPTANCE !== "trusted-local") throw new Error("Set AGYN_LIVE_ACCEPTANCE=trusted-local to run real-model tests");
const interrupted = process.env.AGYN_LIVE_SCENARIO === "interrupted";
const cancellation = process.env.AGYN_LIVE_SCENARIO === "cancellation";
const parallel = process.env.AGYN_LIVE_SCENARIO === "parallel";
if (process.env.AGYN_LIVE_SCENARIO && !interrupted && !cancellation && !parallel) throw new Error("Unknown live scenario");
if (parallel) assert(process.env.AGYN_LIVE_RUNNER_CHART, "parallel acceptance requires explicit workload network policies");
const scenario = interrupted ? "interrupted" : cancellation ? "cancellation" : parallel ? "parallel" : "completed";
const inspectorImage = process.env.AGYN_LIVE_INSPECTOR_IMAGE;
if (cancellation) assert(inspectorImage && /@sha256:[a-f0-9]{64}$/.test(inspectorImage), "cancellation requires a digest-pinned Node inspector image");
const expectedImage = process.env.AGYN_LIVE_INIT_IMAGE;
if (!expectedImage) throw new Error("AGYN_LIVE_INIT_IMAGE must identify the reviewed required-init/CODEX_HOME integration image");
const kubeconfig = resolve(process.env.AGYN_KUBECONFIG ?? ".state/agyn-kubeconfig");
const networkTemplate = process.env.AGYN_LIVE_RUNNER_CHART ? execFileSync("helm", ["template", "a2a-network-proof",
  resolve(process.env.AGYN_LIVE_RUNNER_CHART), "--set", "workloadIngressNetworkPolicy.enabled=true",
  "--set", "workloadNamespace=agyn-workloads", "--show-only", "templates/workload-ingress-networkpolicy.yaml"],
{ encoding: "utf8", timeout: 30_000 }) : undefined;
const deployment = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "get", "deployment", "agents-orchestrator", "-n", "agyn-platform", "-o", "json"], { encoding: "utf8" }));
assert(deployment.spec.template.spec.containers.some((container: any) => container.env.some((env: any) => env.name === "AGYND_CLI_INIT_IMAGE" && env.value === expectedImage)), "expected integration image is not deployed");
const orchestrator = deployment.spec.template.spec.containers.find((container: any) => container.name === "agents-orchestrator");
assert(process.env.AGYN_LIVE_ORCHESTRATOR_IMAGE && orchestrator?.image === process.env.AGYN_LIVE_ORCHESTRATOR_IMAGE, "expected confirmed-removal orchestrator image is not deployed");
assert(orchestrator.env.some((env: any) => env.name === "STOP_INACTIVE_INSTANCES" && env.value === "true"), "immediate stop must be explicit");
if (cancellation) assert(orchestrator.env.some((env: any) => env.name === "STOP_TIMEOUT_SEC" && env.value === "5"), "cancellation fixture requires a five-second termination grace");
const profile = process.env.AGYN_PROFILE ?? "local";
const who = JSON.parse(execFileSync("agyn", ["auth", "whoami", "--profile", profile, "-o", "json"], { encoding: "utf8" }));
const token = execFileSync("agyn", ["profile", "token", profile], { encoding: "utf8" }).trim();
const gateway = new AgynClient(who.gateway_url, token, who.organization, who.user_id);
const call = async (service: string, method: string, input: unknown): Promise<any> => {
  const response = await fetch(`${who.gateway_url}/agynio.api.gateway.v1.${service}/${method}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Live fixture ${service}.${method} failed (${response.status})`);
  return response.json();
};
const suffix = Date.now().toString(36);
const bundle = readFileSync(new URL("../reporting/runtime.mjs", import.meta.url));
const gate = readFileSync(new URL("../../scripts/agyn-execution-gate.cjs", import.meta.url), "utf8");
const templateId = process.env.AGYN_LIVE_TEMPLATE_ENVIRONMENT ?? "618e9cec-45a5-4b9d-8c28-91d40f053b65";
const { environment: template } = await call("AgentsGateway", "GetEnvironment", { id: templateId });
const { environment } = await call("AgentsGateway", "CreateEnvironment", {
  organizationId: who.organization, name: `a2a-reporting-${suffix}`, runnerId: template.runnerId, flavor: template.flavor,
  workspaceImageId: template.workspaceImageId, workspaceImageTag: template.workspaceImageTag,
  agentRuntimeImageId: template.agentRuntimeImageId, agentRuntimeImageTag: template.agentRuntimeImageTag,
  llmMode: "LLM_MODE_NATIVE", llmAllowedModels: ["gpt-5.5"], persistentShells: false, availability: "ENVIRONMENT_AVAILABILITY_PRIVATE"
});
const environmentId = environment.meta.id;
await call("AgentsGateway", "CreateVolume", { environmentId, persistent: true, name: "task-workspace", mountPath: "/workspace", size: "1Gi" });
for (const [name, value] of Object.entries({ CODEX_HOME: "/workspace/.codex", AGYN_INIT_SCRIPTS_REQUIRED: "true",
  AGYN_INBOX_JOURNAL_DIR: "/workspace/.agyn/inbox-journal", AGYN_INBOX_CONTROL_FILE: "/run/agyn-execution/inbox-control.json",
  A2A_REPORTING_RUNTIME_SHA256: createHash("sha256").update(bundle).digest("hex") })) {
  await call("AgentsGateway", "CreateEnv", { environmentId, name, value });
}
await call("AgentsGateway", "CreateInitScript", { environmentId, description: "Trusted-local execution reporting gate; fail closed before Codex starts",
  script: `/agyn/bin/node <<'AGYN_EXECUTION_GATE'\n${gate}\nAGYN_EXECUTION_GATE\n` });
const attachments = await call("LLMGateway", "ListSubscriptionAttachments", { organizationId: who.organization, environmentId });
// Resolve only the existing subscription reference; never read or copy its credential.
const templateAttachments = await call("LLMGateway", "ListSubscriptionAttachments", { organizationId: who.organization, environmentId: templateId });
const subscription = templateAttachments.subscriptionAttachments?.[0];
assert(subscription?.subscriptionId, "template has no subscription");
assert.equal(attachments.subscriptionAttachments?.length ?? 0, 0);
await call("LLMGateway", "CreateSubscriptionAttachment", { environmentId, subscriptionId: subscription.subscriptionId });
const { agent } = await call("AgentsGateway", "CreateAgent", { organizationId: who.organization, environmentId,
  name: `A2A Reporting Acceptance ${suffix}`, nickname: `a2a-reporting-${suffix}`, modelName: "gpt-5.5",
  idleTimeout: "10s", instanceIdleTtl: "24h", availability: "AGENT_AVAILABILITY_PRIVATE", finalMessage: "AGENT_FINAL_MESSAGE_DISCARD",
  configuration: JSON.stringify({ system_prompt: "Work only on the current task in /workspace. Report progress and artifacts with the execution_reporting MCP. Follow the task's acceptance-test instructions about when to report an outcome. In a stop-hook test, deliberately omit the first outcome, then obey the stop hook's reminder and call report_outcome. Use turn_done to retain the task for follow-up. After the outcome acknowledgement, perform no further work." })
});
const agentId = agent.meta.id;
await call("AgentsGateway", "SetEnvironmentRole", { environmentId, identityId: agentId, role: "ENVIRONMENT_ROLE_USER" });
console.log(JSON.stringify({ kind: "live.fixture", environmentId, agentId }));

mkdirSync(resolve(".state"), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(".state/agyn-reporting-live-"));
const finder = createServer(); finder.listen(0, "127.0.0.1"); await once(finder, "listening");
const address = finder.address(); assert(address && typeof address !== "string");
await new Promise<void>(r => finder.close(() => r()));
const base = `http://127.0.0.1:${address.port}`;
const bearer = randomBytes(32).toString("base64url");
const credentialsFile = join(directory, "credentials.json");
writeFileSync(credentialsFile, JSON.stringify([{ sha256: createHash("sha256").update(bearer).digest("hex"), tenant: who.organization,
  subject: "live-acceptance", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), canReconcile: true }]), { mode: 0o600 });
const configFile = join(directory, "service.json");
const reportingUrl = `http://${process.env.AGYN_LIVE_HOST_IP ?? "192.168.5.2"}:${address.port}/reporting`;
writeFileSync(configFile, JSON.stringify({ environmentProfile: "trusted-local", dbPath: join(directory, "tasks.sqlite"), credentialsFile,
  reportingSetupExecutable: new URL("../service/agyn-reporting-installer.js", import.meta.url).pathname, publicUrl: base,
  reportingUrl, host: "0.0.0.0", port: address.port,
  defaultProfile: "codex-gated-live-v1", profiles: [{ id: "codex-gated-live-v1", agentId }], concurrency: 2, turnTimeoutMs: parallel ? 300_000 : 180_000 }), { mode: 0o600 });
const startService = () => {
  const child = spawn(process.execPath, [new URL("../service/main.js", import.meta.url).pathname], { env: {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  A2A_SERVICE_CONFIG_FILE: configFile, AGYN_GATEWAY_URL: who.gateway_url, AGYN_TOKEN: token,
  AGYN_ORGANIZATION_ID: who.organization, AGYN_IDENTITY_ID: who.user_id, A2A_ALLOW_INSECURE_LOCAL_REPORTING: "true"
  }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolveExit, reject) => { child.once("close", () => resolveExit()); child.once("error", reject); });
  child.stdout.on("data", data => process.stdout.write(data));
  child.stderr.on("data", data => process.stderr.write(data));
  return { child, exited };
};
let { child, exited } = startService();
// Synchronous operator probes can outlast HTTP keep-alive. Do not reuse idle
// sockets across those probes, or retry a possibly accepted SendMessage.
const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json", "A2A-Version": "1.0", connection: "close" };
const rpc = async (method: string, params: unknown): Promise<any> => {
  const response = await fetch(`${base}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }), signal: AbortSignal.timeout(10_000) });
  const result = await response.json() as any;
  if (result.error) throw new Error(`A2A ${method} failed (${result.error.code})`);
  return result.result;
};
const tasks: string[] = [];
const evidence: Record<string, unknown>[] = [];
const snapshots: Record<number, any[]> = {};
let networkFixtures: NetworkFixtures | undefined;
let workloadsReleased = false;
const networkEvidence: any = { enabled: false };
const waitService = async () => {
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`${base}/healthz`).then(r => r.ok).catch(() => false)) break;
    if (attempt > 100 || child.exitCode !== null) throw new Error("service did not start");
    await delay(100);
  }
};
const inspectInstance = (instanceId: string): any[] => {
  const found: any[] = [];
  for (const pod of instancePods(kubeconfig, instanceId)) {
    if (networkEvidence.enabled) {
      assert.equal(pod.metadata.labels?.["agent-id"], agentId, "ingress policy does not select the live agent pod");
      assert.equal(pod.metadata.labels?.[managedLabel], "agents-orchestrator");
      for (const policy of networkEvidence.policies) {
        const current = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "-n", "agyn-workloads", "get",
          "networkpolicy", policy.metadata.name, "-o", "json"], { encoding: "utf8", timeout: 10_000 }));
        assertPolicyUnchanged(current, policy);
      }
    }
    const container = pod.spec.containers.find((item: any) => item.env?.some((entry: any) => entry.name === "AGENT_INSTANCE_ID" && entry.value === instanceId));
    if (!container) continue;
    try {
      const state = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "exec", pod.metadata.name, "-n", "agyn-workloads", "-c", container.name,
        "--", "/agyn/bin/node", "-e", `const fs=require("node:fs");
          const records=p=>fs.readdirSync(p).filter(n=>n.endsWith(".json")).map(n=>JSON.parse(fs.readFileSync(p+"/"+n,"utf8")));
          const control=fs.existsSync("/workspace/cancel-control.json")?JSON.parse(fs.readFileSync("/workspace/cancel-control.json","utf8")):null;
          let alive=false;if(control)try{process.kill(control.pid,0);alive=true;}catch{}
          console.log(JSON.stringify({mapping:records("/workspace/.codex/agyn/thread-mapping"),
            journal:records("/workspace/.agyn/inbox-journal/"+process.env.AGENT_INSTANCE_ID),
            marker:fs.readFileSync("/workspace/reporting-proof.txt","utf8"),
            cancellation:control?{...control,alive,signals:fs.readFileSync("/workspace/cancel-signals.txt","utf8"),heartbeat:fs.readFileSync("/workspace/cancel-heartbeat.txt","utf8")}:null,
            configured:fs.existsSync("/run/agyn-execution/configured.json")}));`],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
      if (state.mapping.length) found.push({ name: pod.metadata.name, uid: pod.metadata.uid, labels: pod.metadata.labels,
        pvc: pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim).map((v: any) => v.persistentVolumeClaim.claimName), ...state });
    } catch { /* A starting or removed pod is not yet inspectable. */ }
  }
  return found;
};
const cancelRunningTurn = async (taskId: string) => {
  let initial: any[] = [];
  for (let attempt = 0; attempt < 180; attempt++) {
    initial = (await fetch(`${base}/tasks/${taskId}/events`, { headers }).then(r => r.json()) as any).events;
    assert(!initial.some(event => event.kind === "execution.uncertain" || event.kind === "agent.outcome"), "turn ended before cancellation injection");
    const binding = initial.find(event => event.kind === "runtime.bound")?.payload;
    if (binding && initial.some(event => event.kind === "execution.dispatched")) {
      snapshots[1] = inspectInstance(binding.instanceId);
      if (snapshots[1].length === 1 && snapshots[1][0].cancellation?.alive) break;
    }
    await delay(1000);
  }
  const pod = snapshots[1]?.[0];
  assert(pod?.cancellation?.alive, "no running cancellation fixture");
  assert.equal(pod.marker, suffix);
  assert.equal(pod.cancellation.nonce, suffix);
  assert.equal(pod.journal[0]?.state, "pending");
  const binding = initial.find(event => event.kind === "runtime.bound")!.payload;
  const main = instancePods(kubeconfig, binding.instanceId)[0].spec.containers.find((item: any) => item.env?.some(
    (entry: any) => entry.name === "AGENT_INSTANCE_ID" && entry.value === binding.instanceId));
  execFileSync("kubectl", ["--kubeconfig", kubeconfig, "exec", pod.name, "-n", "agyn-workloads", "-c", main.name, "--", "/agyn/bin/node", "-e",
    `const c=JSON.parse(require("node:fs").readFileSync("/workspace/cancel-control.json","utf8"));if(c.nonce!==${JSON.stringify(suffix)}||!Number.isInteger(c.pid)||c.pid<=1)throw Error("wrong fixture");process.kill(c.pid,"SIGTERM");`], { encoding: "utf8", timeout: 5000 });
  await delay(1000);
  snapshots[1] = inspectInstance(binding.instanceId);
  assert(snapshots[1][0]?.cancellation.alive && snapshots[1][0].cancellation.signals.includes("SIGTERM"), "fixture did not survive SIGTERM");
  let deletionObservedAt: number | undefined;
  const waiter = spawn("kubectl", ["--kubeconfig", kubeconfig, "wait", "--for=delete", `pod/${pod.name}`, "-n", "agyn-workloads", "--timeout=40s"], { stdio: "ignore" });
  const deleted = new Promise<boolean>(resolveDeleted => {
    waiter.once("error", () => resolveDeleted(false));
    waiter.once("close", code => { if (code === 0) deletionObservedAt = Date.now(); resolveDeleted(code === 0); });
  });
  const requestedAt = Date.now();
  try {
    await rpc("CancelTask", { id: taskId });
    let task: any;
    for (let attempt = 0; attempt < 60; attempt++) {
      task = await rpc("GetTask", { id: taskId });
      if (task.metadata?.resourcesReleased) break;
      await delay(500);
    }
    const elapsedMs = Date.now() - requestedAt;
    assert.equal(task.status.state, "TASK_STATE_CANCELED");
    assert.equal(task.metadata?.resourcesReleased, true);
    assert(elapsedMs < 30_000, "active cancellation exceeded 30 seconds");
    assert(deletionObservedAt, "task settled before pod deletion was observed");
    assertInstanceAbsent(kubeconfig, binding.instanceId);
    const events = (await fetch(`${base}/tasks/${taskId}/events`, { headers }).then(r => r.json()) as any).events;
    const stopped = events.find((event: any) => event.kind === "runtime.stopped");
    assert(stopped && deletionObservedAt <= Date.parse(stopped.at), "runtime.stopped preceded the physical-deletion observation");
    assert((await gateway.workloads(binding.instanceId)).every(workload => workload.removedAt), "unremoved workload remains");
    assert.equal(pod.pvc.length, 1, "expected one fixture workspace");
    const cancellationEvidence: Record<string, unknown> = { task, events, snapshots: snapshots[1], requestedAt, deletionObservedAt, elapsedMs };
    evidence.push(cancellationEvidence);
    const retained = await inspectRetainedCancellationPvc(kubeconfig, inspectorImage!, pod.pvc[0]);
    cancellationEvidence.retained = retained;
    assert.equal(retained.first.marker, suffix);
    assert.equal(retained.first.lateSideEffect, false, "canceled process reached its late side effect");
    assert(retained.first.signals.includes("SIGTERM"));
    assert.deepEqual(retained.first, retained.second, "canceled process kept changing the retained workspace");
    await assert.rejects(rpc("SendMessage", { message: { taskId, messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "must not resume a canceled task" }] } }));
    console.log(JSON.stringify({ kind: "live.passed", taskId, scenario, elapsedMs, deletionObservedAt, stoppedAt: stopped.at }));
  } finally {
    waiter.kill("SIGTERM");
    await deleted;
  }
};
const runSingleTask = async () => {
  const first = await rpc("SendMessage", { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text:
    cancellation ? `Cancellation acceptance test. Report progress, then use exec_command to run /agyn/bin/node with this JavaScript and wait for it to finish. Do not detach the process, report an outcome, or run other commands while it is running. JavaScript: const fs=require("node:fs");fs.writeFileSync("/workspace/cancel-signals.txt","");process.on("SIGTERM",()=>fs.appendFileSync("/workspace/cancel-signals.txt","SIGTERM\\n"));fs.writeFileSync("/workspace/reporting-proof.txt",${JSON.stringify(suffix)});fs.writeFileSync("/workspace/cancel-heartbeat.txt",String(Date.now()));fs.writeFileSync("/workspace/cancel-control.json",JSON.stringify({pid:process.pid,nonce:${JSON.stringify(suffix)}}));setInterval(()=>fs.writeFileSync("/workspace/cancel-heartbeat.txt",String(Date.now())),250);setTimeout(()=>{fs.writeFileSync("/workspace/cancel-late.txt","unexpected completion");process.exit(0)},120000);`
      : interrupted ? `Interruption acceptance test. Append the line ${suffix} to /workspace/reporting-proof.txt using >>, unconditionally and exactly once. This append is deliberately not idempotent. Report progress and publish the file's exact contents as a text artifact. Then run sleep 120. Do not report an outcome until that sleep finishes. Do not repeat the append on a stop reminder.`
      : `Create /workspace/reporting-proof.txt containing exactly ${suffix}. Report a progress event and publish that value as a text artifact, then run sleep 3 to leave a native-session inspection window. For this stop-hook acceptance test only, give your first final answer without reporting an outcome. If the stop hook reminds you, follow its instruction and report turn_done. Do not rewrite the file on reminders.` }] }, configuration: { returnImmediately: true } });
  const taskId = first.task.id; tasks.push(taskId);
  console.log(JSON.stringify({ kind: "live.task", taskId, directory }));
  const waitTurn = async (turn: number) => {
    let last = "";
    for (let attempt = 0; attempt < 300; attempt++) {
      const page = await fetch(`${base}/tasks/${taskId}/events`, { headers }).then(r => r.json()) as any;
      const events = page.events as any[];
      const executionId = events.filter(event => event.kind === "execution.queued")[turn - 1]?.executionId;
      if (events.some(event => event.executionId === executionId && event.kind === "execution.uncertain")) throw new Error("live execution quarantined; inspect retained task events");
      const newest = events.at(-1)?.kind;
      const binding = events.find(event => event.kind === "runtime.bound")?.payload;
      if (binding && events.some(event => event.executionId === executionId && event.kind === "agent.artifact") && !snapshots[turn]?.length) {
        snapshots[turn] = inspectInstance(binding.instanceId);
      }
      if (newest && newest !== last) { last = newest; console.log(JSON.stringify({ kind: "live.event", turn, event: newest })); }
      if (events.filter(event => event.kind === "runtime.stopped").length >= turn) {
        assertInstanceAbsent(kubeconfig, binding.instanceId);
        const task = await rpc("GetTask", { id: taskId });
        evidence.push({ turn, task, events, snapshots: snapshots[turn] ?? [] });
        assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED", "turn must finish resumably after releasing compute");
        assert(!task.metadata?.recoveryRequired, "turn was quarantined");
        assert(events.filter(event => event.kind === "agent.outcome" && event.payload.outcome === "turn_done").length >= turn - (interrupted ? 1 : 0), "missing real MCP outcome");
        assert(events.filter(event => event.kind === "agent.artifact" && event.payload.text.trim() === suffix).length >= turn, "missing persistent file artifact");
        if (turn === 1) assert(events.some(event => event.kind === "execution.stop_check" && event.payload.action === "remind"), "native stop hook did not remind");
        return;
      }
      await delay(1000);
    }
    throw new Error("live turn did not release resources in time");
  };
  if (cancellation) await cancelRunningTurn(taskId);
  else {
    if (interrupted) {
      let initial: any[] = [];
      for (let attempt = 0; attempt < 180; attempt++) {
        initial = (await fetch(`${base}/tasks/${taskId}/events`, { headers }).then(r => r.json()) as any).events;
        assert(!initial.some(event => event.kind === "execution.uncertain" || event.kind === "agent.outcome"), "turn ended before fault injection");
        const binding = initial.find(event => event.kind === "runtime.bound")?.payload;
        if (binding && initial.some(event => event.kind === "agent.artifact") && initial.some(event => event.kind === "execution.dispatched")) {
          snapshots[1] = inspectInstance(binding.instanceId);
          if (snapshots[1].length) break;
        }
        await delay(1000);
      }
      assert.equal(snapshots[1]?.length, 1, "no side-effect inspection window");
      assert.equal(snapshots[1][0].marker, `${suffix}\n`, "fixture must append exactly once before interruption");
      assert.equal(snapshots[1][0].journal[0]?.state, "pending", "journal must precede side effects");
      const binding = initial.find(event => event.kind === "runtime.bound")!.payload;
      const executionId = initial.find(event => event.kind === "execution.queued")!.executionId;
      child.kill("SIGKILL"); await exited;
      execFileSync("kubectl", ["--kubeconfig", kubeconfig, "delete", "pod", snapshots[1][0].name, "-n", "agyn-workloads", "--grace-period=1", "--wait=true", "--timeout=60s"], { encoding: "utf8", timeout: 65000 });
      let gated: any[] = [];
      for (let attempt = 0; attempt < 60; attempt++) {
        gated = inspectInstance(binding.instanceId);
        if (gated.length) break;
        await delay(1000);
      }
      assert.equal(gated.length, 1, "Agyn did not recreate the unacked workload");
      assert.notEqual(gated[0].uid, snapshots[1][0].uid);
      assert.equal(gated[0].configured, false, "replacement must not authorize the old execution");
      assert.equal(gated[0].marker, `${suffix}\n`, "replacement replayed the append");
      assert.deepEqual(gated[0].journal, snapshots[1][0].journal);
      ({ child, exited } = startService()); await waitService();
      let quarantined: any;
      for (let attempt = 0; attempt < 150; attempt++) {
        quarantined = await rpc("GetTask", { id: taskId });
        if (quarantined.metadata?.resourcesReleased && quarantined.metadata?.recoveryRequired) break;
        await delay(1000);
      }
      assert.equal(quarantined.metadata?.recoveryRequired, true);
      assert.equal(quarantined.metadata?.resourcesReleased, true);
      assert.equal(quarantined.metadata?.uncertainSideEffects, true);
      assert((await gateway.workloads(binding.instanceId)).every(workload => workload.removedAt), "quarantine left compute running");
      assertInstanceAbsent(kubeconfig, binding.instanceId);
      const recoveredEvents = (await fetch(`${base}/tasks/${taskId}/events`, { headers }).then(r => r.json()) as any).events;
      evidence.push({ turn: 1, task: quarantined, events: recoveredEvents, snapshots: snapshots[1], gatedReplacement: gated });
      await assert.rejects(rpc("SendMessage", { message: { taskId, messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "must not run before reconciliation" }] } }));
      const response = await fetch(`${base}/tasks/${taskId}/executions/${executionId}/reconcile`, { method: "POST", headers,
        body: JSON.stringify({ resolution: "continue", reason: "Operator inspected the durable marker and pending journal in the gated replacement; append already happened once. Retire the old request without replay." }) });
      assert.equal(response.status, 200, "explicit reconciliation failed");
      console.log(JSON.stringify({ kind: "live.interruption-reconciled", taskId, executionId }));
    } else await waitTurn(1);
    await rpc("SendMessage", { message: { taskId, messageId: randomUUID(), role: "ROLE_USER", parts: [{ text:
      "Read /workspace/reporting-proof.txt. Publish its exact existing contents as an artifact. Do not create or rewrite it. Run sleep 3 to leave an inspection window, then report turn_done." }] }, configuration: { returnImmediately: true } });
    await waitTurn(2);
    assert(snapshots[1]?.length && snapshots[2]?.length, "native session evidence was not captured");
    assert.notEqual(snapshots[1][0].uid, snapshots[2][0].uid, "follow-up must run in a recreated pod");
    assert.deepEqual(snapshots[1][0].pvc, snapshots[2][0].pvc, "task PVC changed");
    const identity = (records: any[]) => records.map(record => ({ instanceId: record.instance_id, sessionId: record.codex_thread_id, createdAt: record.created_at_unix_ms }));
    assert.deepEqual(identity(snapshots[1][0].mapping), identity(snapshots[2][0].mapping), "native session mapping changed");
    assert.equal(snapshots[2][0].marker, interrupted ? `${suffix}\n` : suffix, "follow-up repeated a side effect or changed the file");
    if (interrupted) assert.equal(snapshots[2][0].journal.find((record: any) => record.message_id === snapshots[1][0].journal[0].message_id)?.state, "ack_only", "old inbox request was not retired explicitly");
    console.log(JSON.stringify({ kind: "live.passed", taskId, turns: 2, scenario }));
  }
};
try {
  if (networkTemplate) {
    const config = new KubeConfig(); config.loadFromFile(kubeconfig);
    const run = randomUUID().slice(0, 8);
    networkFixtures = new NetworkFixtures(KubernetesObjectApi.makeApiClient(config), run, resources => {
      networkEvidence.resources = resources;
      writeFileSync(join(directory, "network.json"), JSON.stringify(networkEvidence, null, 2), { mode: 0o600 });
    });
    networkEvidence.policies = [];
    for (const policy of agentNetworkPolicies(networkTemplate, run, agentId, reportingUrl)) {
      networkEvidence.policies.push(await networkFixtures.create(policy));
    }
    networkEvidence.enabled = true;
    networkEvidence.templateSha256 = createHash("sha256").update(networkTemplate).digest("hex");
    console.log(JSON.stringify({ kind: "live.network-configured", agentId, policyNames: networkEvidence.policies.map((p: any) => p.metadata.name) }));
  }
  await waitService();
  if (parallel) await runParallelAcceptance({ kubeconfig, directory, agentId, suffix, gateway, tasks, rpc, inspect: inspectInstance,
    events: async taskId => {
      const response = await fetch(`${base}/tasks/${taskId}/events`, { headers, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      return ((await response.json()) as any).events;
    } });
  else await runSingleTask();
} finally {
  try {
    for (const taskId of tasks) await rpc("CancelTask", { id: taskId }).catch(() => {});
    const instances = await gateway.instances(agentId);
    for (const instance of instances) await gateway.pauseInstance(instance.meta.id, "Live acceptance cleanup; retain state");
    for (let attempt = 0; ; attempt++) {
      let active = false;
      for (const instance of instances) if ((await gateway.workloads(instance.meta.id)).some(workload => !workload.removedAt) || instancePods(kubeconfig, instance.meta.id).length) active = true;
      if (!active) break;
      if (attempt >= 90) throw new Error("fixture workloads did not release during cleanup");
      await delay(1000);
    }
    workloadsReleased = true;
    console.log(JSON.stringify({ kind: "live.cleanup", directory, instances: instances.map(i => i.meta.id) }));
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer);
    try {
      if (networkFixtures && workloadsReleased) { await networkFixtures.close(); networkEvidence.cleanedUp = true; }
      else if (networkFixtures) networkEvidence.retained = "Workload cleanup was not confirmed; keep isolation policies until operator reconciliation";
    } finally {
      writeFileSync(join(directory, "evidence.json"), JSON.stringify({ environmentId, agentId, tasks, scenario, snapshots, evidence, network: networkEvidence }, null, 2), { mode: 0o600 });
    }
  }
}
