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
import { AgynClient } from "../agyn-client.js";

if (process.env.AGYN_LIVE_ACCEPTANCE !== "trusted-local") throw new Error("Set AGYN_LIVE_ACCEPTANCE=trusted-local to run real-model tests");
const expectedImage = process.env.AGYN_LIVE_INIT_IMAGE;
if (!expectedImage) throw new Error("AGYN_LIVE_INIT_IMAGE must identify the reviewed required-init/CODEX_HOME integration image");
const kubeconfig = resolve(process.env.AGYN_KUBECONFIG ?? ".state/agyn-kubeconfig");
const deployment = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "get", "deployment", "agents-orchestrator", "-n", "agyn-platform", "-o", "json"], { encoding: "utf8" }));
assert(deployment.spec.template.spec.containers.some((container: any) => container.env.some((env: any) => env.name === "AGYND_CLI_INIT_IMAGE" && env.value === expectedImage)), "expected integration image is not deployed");
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
writeFileSync(configFile, JSON.stringify({ environmentProfile: "trusted-local", dbPath: join(directory, "tasks.sqlite"), credentialsFile,
  reportingSetupExecutable: new URL("../service/agyn-reporting-installer.js", import.meta.url).pathname, publicUrl: base,
  reportingUrl: `http://${process.env.AGYN_LIVE_HOST_IP ?? "192.168.5.2"}:${address.port}/reporting`, host: "0.0.0.0", port: address.port,
  defaultProfile: "codex-gated-live-v1", profiles: [{ id: "codex-gated-live-v1", agentId }], concurrency: 2, turnTimeoutMs: 180_000 }), { mode: 0o600 });
const child = spawn(process.execPath, [new URL("../service/main.js", import.meta.url).pathname], { env: {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  A2A_SERVICE_CONFIG_FILE: configFile, AGYN_GATEWAY_URL: who.gateway_url, AGYN_TOKEN: token,
  AGYN_ORGANIZATION_ID: who.organization, AGYN_IDENTITY_ID: who.user_id, A2A_ALLOW_INSECURE_LOCAL_REPORTING: "true"
}, stdio: ["ignore", "pipe", "pipe"] });
const exited = new Promise<void>((resolveExit, reject) => { child.once("close", () => resolveExit()); child.once("error", reject); });
child.stdout.on("data", data => process.stdout.write(data));
child.stderr.on("data", data => process.stderr.write(data));
const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json", "A2A-Version": "1.0" };
const rpc = async (method: string, params: unknown): Promise<any> => {
  const response = await fetch(`${base}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }), signal: AbortSignal.timeout(10_000) });
  const result = await response.json() as any;
  if (result.error) throw new Error(`A2A ${method} failed (${result.error.code})`);
  return result.result;
};
const tasks: string[] = [];
const evidence: Record<string, unknown>[] = [];
const snapshots: Record<number, any[]> = {};
try {
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`${base}/healthz`).then(r => r.ok).catch(() => false)) break;
    if (attempt > 100 || child.exitCode !== null) throw new Error("service did not start");
    await delay(100);
  }
  const first = await rpc("SendMessage", { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text:
    `Create /workspace/reporting-proof.txt containing exactly ${suffix}. Report a progress event and publish that value as a text artifact, then run sleep 3 to leave a native-session inspection window. For this stop-hook acceptance test only, give your first final answer without reporting an outcome. If the stop hook reminds you, follow its instruction and report turn_done. Do not rewrite the file on reminders.` }] }, configuration: { returnImmediately: true } });
  const taskId = first.task.id; tasks.push(taskId);
  console.log(JSON.stringify({ kind: "live.task", taskId, directory }));
  const waitTurn = async (turn: number) => {
    let last = "";
    for (let attempt = 0; attempt < 300; attempt++) {
      const page = await fetch(`${base}/tasks/${taskId}/events`, { headers }).then(r => r.json()) as any;
      const events = page.events as any[];
      if (events.some(event => event.kind === "execution.uncertain")) throw new Error("live execution quarantined; inspect retained task events");
      const newest = events.at(-1)?.kind;
      const binding = events.find(event => event.kind === "runtime.bound")?.payload;
      const executionId = events.filter(event => event.kind === "execution.queued")[turn - 1]?.executionId;
      if (binding && events.some(event => event.executionId === executionId && event.kind === "agent.artifact") && !snapshots[turn]?.length) {
        const pods = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "get", "pods", "-n", "agyn-workloads", "-o", "json"], { encoding: "utf8" }));
        for (const pod of pods.items) {
          const container = pod.spec.containers.find((item: any) => item.env?.some((entry: any) => entry.name === "AGENT_INSTANCE_ID" && entry.value === binding.instanceId));
          if (!container) continue;
          try {
            const mapping = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "exec", pod.metadata.name, "-n", "agyn-workloads", "-c", container.name,
              "--", "/agyn/bin/node", "-e", 'const fs=require("node:fs"); const p="/workspace/.codex/agyn/thread-mapping"; const records=fs.readdirSync(p).map(n=>JSON.parse(fs.readFileSync(p+"/"+n,"utf8"))); console.log(JSON.stringify(records));'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
            if (mapping.length) snapshots[turn] = [{ uid: pod.metadata.uid, pvc: pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim).map((v: any) => v.persistentVolumeClaim.claimName), mapping }];
          } catch { /* Mapping is created only after the native session starts. */ }
        }
      }
      if (newest && newest !== last) { last = newest; console.log(JSON.stringify({ kind: "live.event", turn, event: newest })); }
      if (events.filter(event => event.kind === "runtime.stopped").length >= turn) {
        const task = await rpc("GetTask", { id: taskId });
        evidence.push({ turn, task, events, snapshots: snapshots[turn] ?? [] });
        assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED", "turn must finish resumably after releasing compute");
        assert(!task.metadata?.recoveryRequired, "turn was quarantined");
        assert(events.filter(event => event.kind === "agent.outcome" && event.payload.outcome === "turn_done").length >= turn, "missing real MCP outcome");
        assert(events.filter(event => event.kind === "agent.artifact" && event.payload.text.trim() === suffix).length >= turn, "missing persistent file artifact");
        if (turn === 1) assert(events.some(event => event.kind === "execution.stop_check" && event.payload.action === "remind"), "native stop hook did not remind");
        return;
      }
      await delay(1000);
    }
    throw new Error("live turn did not release resources in time");
  };
  await waitTurn(1);
  await rpc("SendMessage", { message: { taskId, messageId: randomUUID(), role: "ROLE_USER", parts: [{ text:
    "Read /workspace/reporting-proof.txt. Publish its exact existing contents as an artifact. Do not create or rewrite it. Run sleep 3 to leave an inspection window, then report turn_done." }] }, configuration: { returnImmediately: true } });
  await waitTurn(2);
  assert(snapshots[1]?.length && snapshots[2]?.length, "native session evidence was not captured");
  assert.notEqual(snapshots[1][0].uid, snapshots[2][0].uid, "follow-up must run in a recreated pod");
  assert.deepEqual(snapshots[1][0].pvc, snapshots[2][0].pvc, "task PVC changed");
  const identity = (records: any[]) => records.map(record => ({ instanceId: record.instance_id, sessionId: record.codex_thread_id, createdAt: record.created_at_unix_ms }));
  assert.deepEqual(identity(snapshots[1][0].mapping), identity(snapshots[2][0].mapping), "native session mapping changed");
  console.log(JSON.stringify({ kind: "live.passed", taskId, turns: 2 }));
} finally {
  try {
    for (const taskId of tasks) await rpc("CancelTask", { id: taskId }).catch(() => {});
    const instances = await gateway.instances(agentId);
    for (const instance of instances) await gateway.pauseInstance(instance.meta.id, "Live acceptance cleanup; retain state");
    console.log(JSON.stringify({ kind: "live.cleanup", directory, instances: instances.map(i => i.meta.id) }));
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer);
    writeFileSync(join(directory, "evidence.json"), JSON.stringify({ environmentId, agentId, tasks, evidence }, null, 2), { mode: 0o600 });
  }
}
