// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in, real-model acceptance. This creates separate Agyn fixtures and retains their durable state.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoreV1Api, KubeConfig, KubernetesObjectApi } from "@kubernetes/client-node";
import { SendMessageRequest, StreamResponse, SubscribeToTaskRequest, Task, TaskState } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { AgynClient } from "../agyn-client.js";
import { assertInstanceAbsent, assertReviewedDeployment, inspectRetainedCancellationPvc, instancePods } from "./kubernetes-proof.js";
import { agentNetworkPolicies, assertPolicyUnchanged, managedLabel, NetworkFixtures } from "./network-proof.js";
import { runParallelAcceptance } from "./agyn-parallel.js";
import { assertCgroupComputeBounds, assertPodComputeBounds, parseComputeBounds, type ComputeBounds } from "./resource-proof.js";
import { observeA2aStream, assertStreamMatchesDurable, type StreamProbe } from "./a2a-stream-proof.js";
import { serviceCard } from "../service/card.js";
import { claudeNativeProbe, liveAgentProfileSchema, nativeIdentities, persistentAgentEnv } from "./agent-profile.js";
import { assertConfirmedWorkloads } from "./removal-proof.js";
import { parseQuotaBudget, quotaFixture, QuotaFixture } from "./quota-proof.js";
import { runQuotaRejectedTurn } from "./agyn-quota.js";
import { assertProvisioningInventory, assertReopenedVolume, provisioningInventory, runProvisioningRejectedTurn } from "./agyn-provisioning.js";
import { startRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { assertPreparedSchema, collectPreparedUpgradeState } from "./prepared-upgrade.js";
import { assertPreparedRemoval, capturePreparedPod, type PreparedPodProof } from "./prepared-proof.js";

if (process.env.AGYN_LIVE_ACCEPTANCE !== "trusted-local") throw new Error("Set AGYN_LIVE_ACCEPTANCE=trusted-local to run real-model tests");
const interrupted = process.env.AGYN_LIVE_SCENARIO === "interrupted";
const cancellation = process.env.AGYN_LIVE_SCENARIO === "cancellation";
const parallel = process.env.AGYN_LIVE_SCENARIO === "parallel";
const streaming = process.env.AGYN_LIVE_SCENARIO === "streaming";
const quotaRecovery = process.env.AGYN_LIVE_SCENARIO === "quota-recovery";
const provisioningRecovery = process.env.AGYN_LIVE_SCENARIO === "provisioning-recovery";
const quotaEnabled = quotaRecovery || provisioningRecovery;
const deniedResource = provisioningRecovery ? "persistentvolumeclaims" : "count/pods";
if (process.env.AGYN_LIVE_SCENARIO && !interrupted && !cancellation && !parallel && !streaming && !quotaEnabled) throw new Error("Unknown live scenario");
if (parallel) assert(process.env.AGYN_LIVE_RUNNER_CHART, "parallel acceptance requires explicit workload network policies");
const scenario = process.env.AGYN_LIVE_SCENARIO || "completed";
const bounded = process.env.AGYN_LIVE_COMPUTE_RESOURCES === "true";
assert(!process.env.AGYN_LIVE_COMPUTE_RESOURCES || bounded, "invalid compute resource opt-in");
const prepared = process.env.AGYN_LIVE_PREPARED_WORKLOADS === "true";
assert(!process.env.AGYN_LIVE_PREPARED_WORKLOADS || prepared, "invalid prepared workload opt-in");
if (prepared) assert(bounded, "prepared acceptance requires bounded execution");
const preparedEvidence: { enabled: boolean; pods: Record<string, PreparedPodProof>; confirmed: Record<string, unknown> } = { enabled: prepared, pods: {}, confirmed: {} };
if (quotaEnabled) assert(bounded && process.env.AGYN_LIVE_RUNNER_CHART, "quota acceptance requires the bounded resource/network profile");
if (quotaEnabled) assert(isAbsolute(process.env.AGYN_KUBECONFIG ?? ""), "quota acceptance requires an explicit absolute kubeconfig");
const quotaBudget = quotaEnabled ? parseQuotaBudget(JSON.parse(process.env.AGYN_LIVE_QUOTA_HARD ?? "null"), deniedResource) : undefined;
const quotaRun = randomUUID();
const quotaEvidence: any = { enabled: quotaEnabled, deniedResource, samples: [], turns: [], inventories: [] };
let quotaOperator: QuotaFixture | undefined;
const resourceEvidence: any = { enabled: bounded, pods: {} };
const protocolEvidence: Record<string, unknown> = { enabled: streaming };
const streamProbes: StreamProbe[] = [];
const streamAbort = new AbortController();
let mainBounds: ComputeBounds | undefined;
const supportingBounds = bounded ? parseComputeBounds(JSON.parse(process.env.AGYN_LIVE_SUPPORTING_RESOURCES ?? "null")) : undefined;
const inspectorImage = process.env.AGYN_LIVE_INSPECTOR_IMAGE;
if (cancellation) assert(inspectorImage && /@sha256:[a-f0-9]{64}$/.test(inspectorImage), "cancellation requires a digest-pinned Node inspector image");
const expectedImage = process.env.AGYN_LIVE_INIT_IMAGE;
if (!expectedImage) throw new Error("AGYN_LIVE_INIT_IMAGE must identify the reviewed required-init/session-persistence integration image");
const kubeconfig = resolve(process.env.AGYN_KUBECONFIG ?? ".state/agyn-kubeconfig");
const preparedScope = prepared ? { postgresPod: process.env.AGYN_AUDIT_POSTGRES_POD ?? "", postgresPodUid: process.env.AGYN_AUDIT_POSTGRES_UID ?? "",
  postgresUser: process.env.AGYN_AUDIT_POSTGRES_USER ?? "", runnerId: process.env.AGYN_AUDIT_RUNNER_ID ?? "", namespaceUid: process.env.AGYN_AUDIT_NAMESPACE_UID ?? "" } : undefined;
if (preparedScope) assertPreparedSchema(collectPreparedUpgradeState((args, input) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args],
  { input, encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }), preparedScope));
for (const [name, variable] of [["runners", "AGYN_LIVE_RUNNERS_IMAGE"], ["gateway", "AGYN_LIVE_GATEWAY_IMAGE"]]) {
  const image = process.env[variable];
  assert(image, `${variable} must identify the reviewed removal-confirmation API image; older stacks cannot run this acceptance`);
  const current = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "-n", "agyn-platform", "get", "deployment", name, "-o", "json"], { encoding: "utf8", timeout: 10_000 }));
  assertReviewedDeployment(current, name, image);
}
const networkTemplate = process.env.AGYN_LIVE_RUNNER_CHART ? execFileSync("helm", ["template", "a2a-network-proof",
  resolve(process.env.AGYN_LIVE_RUNNER_CHART), "--set", "workloadIngressNetworkPolicy.enabled=true",
  "--set", "workloadNamespace=agyn-workloads", "--show-only", "templates/workload-ingress-networkpolicy.yaml"],
{ encoding: "utf8", timeout: 30_000 }) : undefined;
const quotaTemplate = quotaEnabled ? execFileSync("helm", ["template", "a2a-quota-proof", resolve(process.env.AGYN_LIVE_RUNNER_CHART!),
  "-f", "-", "--show-only", "templates/workload-resourcequota.yaml"], { encoding: "utf8", timeout: 30_000, input: JSON.stringify({
    workloadNamespace: "agyn-workloads", env: [{ name: "KUBE_NAMESPACE", value: "agyn-workloads" }],
    workloadResourceQuota: { enabled: true, name: `a2a-quota-${quotaRun}`, hard: quotaBudget }
  }) }) : undefined;
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
if (preparedScope) assert.equal(template.runnerId, preparedScope.runnerId, "prepared fixture template selects another runner");
const templateAttachments = await call("LLMGateway", "ListSubscriptionAttachments", { organizationId: who.organization, environmentId: templateId });
const agentProfile = liveAgentProfileSchema.parse(process.env.AGYN_LIVE_AGENT_PROFILE_FILE
  ? JSON.parse(readFileSync(resolve(process.env.AGYN_LIVE_AGENT_PROFILE_FILE), "utf8"))
  : { version: 1, sdk: "codex", model: "gpt-5.5", runtimeImageId: template.agentRuntimeImageId,
    runtimeImageTag: template.agentRuntimeImageTag, subscriptionId: templateAttachments.subscriptionAttachments?.[0]?.subscriptionId });
const { subscription: selectedSubscription } = await call("LLMGateway", "GetSubscription", { id: agentProfile.subscriptionId });
assert.equal(selectedSubscription.vendor, agentProfile.sdk === "claude" ? "VENDOR_ANTHROPIC" : "VENDOR_OPENAI", "subscription vendor does not match the selected agent");
const profileId = `${agentProfile.sdk}-gated-live-v1`;
if (bounded) {
  assert(networkTemplate, "resource acceptance requires explicit network policy");
  const runnerDeployment = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "get", "deployment", "k8s-runner", "-n", "agyn-platform", "-o", "json"], { encoding: "utf8", timeout: 10_000 }));
  const runnerContainer = runnerDeployment.spec.template.spec.containers.find((item: any) => item.name === "k8s-runner");
  assert(process.env.AGYN_LIVE_RUNNER_IMAGE && runnerContainer?.image === process.env.AGYN_LIVE_RUNNER_IMAGE, "expected resource runner is not deployed");
  assert.deepEqual(parseComputeBounds(JSON.parse(runnerContainer.env.find((entry: any) => entry.name === "SUPPORTING_CONTAINER_RESOURCES")?.value ?? "null")), supportingBounds);
  let runner: any;
  for (let attempt = 0; attempt < 60; attempt++) {
    ({ runner } = await call("RunnersGateway", "GetRunner", { id: template.runnerId }));
    if (runner.capabilities?.includes("compute-resources")) break;
    await delay(1000);
  }
  assert(runner?.capabilities?.includes("compute-resources"), "selected runner did not advertise compute-resources");
  const flavors: any[] = [];
  let pageToken = "";
  do {
    const page = await call("RunnersGateway", "ListFlavors", { runnerId: template.runnerId, pageSize: 100, pageToken });
    flavors.push(...(page.flavors ?? [])); pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  const selected = flavors.filter(item => item.runnerId === template.runnerId && item.name === template.flavor);
  assert.equal(selected.length, 1, "selected flavor is absent or ambiguous");
  mainBounds = parseComputeBounds(selected[0].resources);
  Object.assign(resourceEvidence, { runnerId: template.runnerId, capabilities: runner.capabilities, flavor: template.flavor,
    main: mainBounds, supporting: supportingBounds, runnerImage: runnerContainer.image });
  console.log(JSON.stringify({ kind: "live.resources-configured", ...resourceEvidence }));
}
const { environment } = await call("AgentsGateway", "CreateEnvironment", {
  organizationId: who.organization, name: `a2a-reporting-${suffix}`, runnerId: template.runnerId, flavor: template.flavor,
  workspaceImageId: template.workspaceImageId, workspaceImageTag: template.workspaceImageTag,
  agentRuntimeImageId: agentProfile.runtimeImageId, agentRuntimeImageTag: agentProfile.runtimeImageTag,
  llmMode: "LLM_MODE_NATIVE", llmAllowedModels: [agentProfile.model], persistentShells: false, availability: "ENVIRONMENT_AVAILABILITY_PRIVATE"
});
const environmentId = environment.meta.id;
await call("AgentsGateway", "CreateVolume", { environmentId, persistent: true, name: "task-workspace", mountPath: "/workspace", size: "1Gi" });
for (const [name, value] of Object.entries({ ...persistentAgentEnv(agentProfile.sdk), AGYN_INIT_SCRIPTS_REQUIRED: "true",
  AGYN_INBOX_JOURNAL_DIR: "/workspace/.agyn/inbox-journal", AGYN_INBOX_CONTROL_FILE: "/run/agyn-execution/inbox-control.json",
  A2A_REPORTING_RUNTIME_SHA256: createHash("sha256").update(bundle).digest("hex") })) {
  await call("AgentsGateway", "CreateEnv", { environmentId, name, value });
}
await call("AgentsGateway", "CreateInitScript", { environmentId, description: "Trusted-local execution reporting gate; fail closed before the agent starts",
  script: `/agyn/bin/node <<'AGYN_EXECUTION_GATE'\n${gate}\nAGYN_EXECUTION_GATE\n` });
const attachments = await call("LLMGateway", "ListSubscriptionAttachments", { organizationId: who.organization, environmentId });
// Resolve only the existing subscription reference; never read or copy its credential.
assert.equal(attachments.subscriptionAttachments?.length ?? 0, 0);
await call("LLMGateway", "CreateSubscriptionAttachment", { environmentId, subscriptionId: agentProfile.subscriptionId });
const { agent } = await call("AgentsGateway", "CreateAgent", { organizationId: who.organization, environmentId,
  ...(bounded ? { capabilities: ["compute-resources"] } : {}),
  name: `A2A Reporting Acceptance ${suffix}`, nickname: `a2a-reporting-${suffix}`, modelName: agentProfile.model,
  idleTimeout: "10s", instanceIdleTtl: "24h", availability: "AGENT_AVAILABILITY_PRIVATE", finalMessage: "AGENT_FINAL_MESSAGE_DISCARD",
  configuration: JSON.stringify({ system_prompt: "Work only on the current task in /workspace. Report progress and artifacts with the execution_reporting MCP. Follow the task's acceptance-test instructions about when to report an outcome. In a stop-hook test, deliberately omit the first outcome, then obey the stop hook's reminder and call report_outcome. Use turn_done to retain the task for follow-up. After the outcome acknowledgement, perform no further work." })
});
const agentId = agent.meta.id;
if (bounded) assert(agent.capabilities?.includes("compute-resources"), "fixture agent lost the required capability");
await call("AgentsGateway", "SetEnvironmentRole", { environmentId, identityId: agentId, role: "ENVIRONMENT_ROLE_USER" });
console.log(JSON.stringify({ kind: "live.fixture", environmentId, agentId, agentProfile }));

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
  defaultProfile: profileId, profiles: [{ id: profileId, agentId }], concurrency: 2, turnTimeoutMs: parallel ? 300_000 : 180_000 }), { mode: 0o600 });
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
    const bounds = bounded ? assertPodComputeBounds(pod, container.name, mainBounds!, supportingBounds!) : undefined;
    let state: any;
    try {
      state = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "exec", pod.metadata.name, "-n", "agyn-workloads", "-c", container.name,
        "--", "/agyn/bin/node", "-e", `const fs=require("node:fs");
          const records=p=>fs.readdirSync(p).filter(n=>n.endsWith(".json")).map(n=>JSON.parse(fs.readFileSync(p+"/"+n,"utf8")));
          const control=fs.existsSync("/workspace/cancel-control.json")?JSON.parse(fs.readFileSync("/workspace/cancel-control.json","utf8")):null;
          let alive=false;if(control)try{process.kill(control.pid,0);alive=true;}catch{}
          console.log(JSON.stringify({...${agentProfile.sdk === "claude" ? `(${claudeNativeProbe.toString()})()` : '{mapping:records("/workspace/.codex/agyn/thread-mapping")}'},
            cgroup:${bounded ? '{cpuMax:fs.readFileSync("/sys/fs/cgroup/cpu.max","utf8").trim(),memoryMax:fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim()}' : "null"},
            journal:records("/workspace/.agyn/inbox-journal/"+process.env.AGENT_INSTANCE_ID),
            marker:fs.readFileSync("/workspace/reporting-proof.txt","utf8"),
            provisioningReplay:fs.existsSync("/workspace/provisioning-replay.txt"),
            cancellation:control?{...control,alive,signals:fs.readFileSync("/workspace/cancel-signals.txt","utf8"),heartbeat:fs.readFileSync("/workspace/cancel-heartbeat.txt","utf8")}:null,
            configured:fs.existsSync("/run/agyn-execution/configured.json")}));`],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
    } catch { continue; /* A starting or removed pod is not yet inspectable. */ }
    state.native = nativeIdentities(agentProfile.sdk, state.mapping);
    assert(state.native.every((identity: any) => identity.instanceId === instanceId), "native mapping belongs to another instance");
    if (agentProfile.sdk === "claude") assert.equal(state.mapping[0].agent_id, agentId);
    if (bounded) {
      assertCgroupComputeBounds(state.cgroup, mainBounds!);
      resourceEvidence.pods[pod.metadata.uid] = { instanceId, name: pod.metadata.name, observedAt: new Date().toISOString(), bounds, cgroup: state.cgroup };
    }
    if (preparedScope && state.mapping.length) {
      const claims = pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim).map((v: any) => JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig,
        "get", "pvc", v.persistentVolumeClaim.claimName, "-n", "agyn-workloads", "-o", "json"], { encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] })));
      const proof = capturePreparedPod(pod, claims, instanceId, agentId, `kubernetes-namespace/v1/agyn-workloads/${preparedScope.namespaceUid}`);
      const old = preparedEvidence.pods[proof.binding.workloadId];
      if (old) assert.deepEqual(proof, old, "same workload identity changed its executed Pod or mounted workspace");
      preparedEvidence.pods[proof.binding.workloadId] = proof;
    }
    if (state.mapping.length) found.push({ name: pod.metadata.name, uid: pod.metadata.uid, labels: pod.metadata.labels,
      pvc: pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim).map((v: any) => v.persistentVolumeClaim.claimName), ...state });
  }
  return found;
};
const verifyPreparedReleased = (instanceId: string, workloads: unknown[], ids: string[]) => {
  if (!preparedScope) return;
  for (const id of new Set(ids)) {
    const observed = preparedEvidence.pods[id];
    assert(observed && observed.instanceId === instanceId, "prepared workload was not independently observed executing");
    const matches = workloads.filter((w: any) => w.meta?.id === id);
    assert.equal(matches.length, 1, "prepared removal evidence missing or duplicated");
    preparedEvidence.confirmed[id] = assertPreparedRemoval(matches[0], observed, preparedScope.runnerId);
  }
};
const confirmedWorkloads = async (instanceId: string, executionId: string, events: any[], pods: any[]) => {
  const pins = events.filter(event => event.executionId === executionId && event.kind === "execution.provider_receipt" && event.payload.workloadId)
    .map(event => event.payload.workloadId as string);
  assert.equal(pins.length, 1, "execution has no unique acknowledged workload");
  assert(pods.some(pod => pod.labels?.workload_key === pins[0]), "acknowledged workload was not independently inspected");
  const workloads = await gateway.workloads(instanceId);
  assertConfirmedWorkloads(instanceId, workloads, [...pins, ...pods.map(pod => pod.labels.workload_key)]);
  verifyPreparedReleased(instanceId, workloads, [...pins, ...pods.map(pod => pod.labels.workload_key)]);
  return workloads;
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
    const workloads = await confirmedWorkloads(binding.instanceId, stopped.executionId, events, snapshots[1]);
    assert.equal(pod.pvc.length, 1, "expected one fixture workspace");
    const cancellationEvidence: Record<string, unknown> = { task, events, workloads, snapshots: snapshots[1], requestedAt, deletionObservedAt, elapsedMs };
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
  const config = new KubeConfig(); config.loadFromFile(kubeconfig);
  const core = config.makeApiClient(CoreV1Api);
  const before = provisioningRecovery ? await provisioningInventory(core) : undefined;
  if (before) quotaEvidence.inventoryBefore = before;
  let rejectedProvisioning: Awaited<ReturnType<typeof runProvisioningRejectedTurn>> | undefined;
  let rejectedTurn: { executionId: string; requestId: string } | undefined;
  const firstInput = { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text:
    cancellation ? `Cancellation acceptance test. Report progress, then use your command-execution tool to run /agyn/bin/node with this JavaScript and wait for it to finish. Do not detach the process, report an outcome, or run other commands while it is running. JavaScript: const fs=require("node:fs");fs.writeFileSync("/workspace/cancel-signals.txt","");process.on("SIGTERM",()=>fs.appendFileSync("/workspace/cancel-signals.txt","SIGTERM\\n"));fs.writeFileSync("/workspace/reporting-proof.txt",${JSON.stringify(suffix)});fs.writeFileSync("/workspace/cancel-heartbeat.txt",String(Date.now()));fs.writeFileSync("/workspace/cancel-control.json",JSON.stringify({pid:process.pid,nonce:${JSON.stringify(suffix)}}));setInterval(()=>fs.writeFileSync("/workspace/cancel-heartbeat.txt",String(Date.now())),250);setTimeout(()=>{fs.writeFileSync("/workspace/cancel-late.txt","unexpected completion");process.exit(0)},120000);`
      : interrupted ? `Interruption acceptance test. Append the line ${suffix} to /workspace/reporting-proof.txt using >>, unconditionally and exactly once. This append is deliberately not idempotent. Report progress and publish the file's exact contents as a text artifact. Then run sleep 120. Do not report an outcome until that sleep finishes. Do not repeat the append on a stop reminder.`
      : `Create /workspace/reporting-proof.txt containing exactly ${suffix}. Report a progress event and publish that value as a text artifact, then run sleep ${streaming ? 35 : 3} to leave a native-session inspection window. Do not report additional progress during that sleep. For this stop-hook acceptance test only, give your first final answer without reporting an outcome. If the stop hook reminds you, follow its instruction and report turn_done. Do not rewrite the file on reminders.` }] }, configuration: { returnImmediately: true } };
  const client = streaming ? await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: async (url, init) => {
    const authenticated = new Headers(init?.headers); authenticated.set("authorization", headers.authorization);
    return fetch(url, { ...init, headers: authenticated });
  } })] }).createFromAgentCard(serviceCard(base)) : undefined;
  const options = { signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(600_000)]) };
  let taskId: string;
  let blocking: Promise<Task> | undefined;
  if (client) {
    const probe = await observeA2aStream(client.sendMessageStream(SendMessageRequest.fromJSON(firstInput), options));
    streamProbes.push(probe); taskId = probe.task.id;
    tasks.push(taskId);
    streamProbes.push(await observeA2aStream(client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: taskId }), options)));
    const startedAt = new Date().toISOString();
    blocking = client.sendMessage(SendMessageRequest.fromJSON({ ...firstInput, configuration: { returnImmediately: false } }), options).then(result => {
      assert("id" in result && result.id === taskId);
      protocolEvidence.blocking = { startedAt, returnedAt: new Date().toISOString(), task: Task.toJSON(result) };
      return result;
    });
    void blocking.catch(() => {});
  } else {
    const first = await rpc("SendMessage", provisioningRecovery ? { ...firstInput, message: { ...firstInput.message, parts: [{ text:
      `Append the line provisioning-replayed-${suffix} to /workspace/provisioning-replay.txt unconditionally, then report turn_done.` }] } } : firstInput);
    taskId = first.task.id; tasks.push(taskId);
  }
  console.log(JSON.stringify({ kind: "live.task", taskId, directory }));
  const quotaCallbacks = {
    taskId, gateway, core, quota: quotaOperator!, rpc,
    events: async () => {
      const response = await fetch(`${base}/tasks/${taskId}/events?limit=1000`, { headers, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200); return ((await response.json()) as any).events;
    }, reconcile: async (executionId: string, reason: string) => {
      const response = await fetch(`${base}/tasks/${taskId}/executions/${executionId}/reconcile`, { method: "POST", headers,
        body: JSON.stringify({ resolution: "continue", reason }), signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, "explicit quota reconciliation failed");
    }, record: (sample: any) => {
      quotaEvidence.samples.push(sample); writeFileSync(join(directory, "quota.json"), JSON.stringify(quotaEvidence, null, 2), { mode: 0o600 });
    }
  };
  const volumes = async (instanceId: string): Promise<any[]> => {
    const page = await call("RunnersGateway", "ListVolumesByAgentInstance", { agentInstanceId: instanceId, pageSize: 100 });
    assert(!page.nextPageToken, "unexpected extra task volume page");
    return page.volumes ?? [];
  };
  if (provisioningRecovery) {
    rejectedProvisioning = await runProvisioningRejectedTurn({ ...quotaCallbacks, before: before!, volumes });
    rejectedTurn = rejectedProvisioning;
    const resumed = await rpc("SendMessage", { ...firstInput, message: { ...firstInput.message, taskId, messageId: randomUUID() } });
    assert.equal(resumed.task.id, taskId, "first-provision recovery created another task");
  }
  const waitTurn = async (turn: number, executionNumber = turn + (provisioningRecovery ? 1 : 0)) => {
    let last = "";
    for (let attempt = 0; attempt < 300; attempt++) {
      const page = await fetch(`${base}/tasks/${taskId}/events`, { headers }).then(r => r.json()) as any;
      const events = page.events as any[];
      const executionId = events.filter(event => event.kind === "execution.queued")[executionNumber - 1]?.executionId;
      if (events.some(event => event.executionId === executionId && event.kind === "execution.uncertain")) throw new Error("live execution quarantined; inspect retained task events");
      const newest = events.at(-1)?.kind;
      const binding = events.find(event => event.kind === "runtime.bound")?.payload;
      if (binding && events.some(event => event.executionId === executionId && event.kind === "agent.artifact") && !snapshots[turn]?.length) {
        snapshots[turn] = inspectInstance(binding.instanceId);
        if (quotaOperator && snapshots[turn]?.length) {
          const quota = await quotaOperator.observe(false);
          assert.equal(quota.status?.used?.["count/pods"], "1", "native turn was not counted by the quota");
          if (provisioningRecovery) {
            assert.equal(quota.status?.used?.persistentvolumeclaims, quotaBudget!.persistentvolumeclaims);
            assert.equal(snapshots[turn][0].provisioningReplay, false, "rejected initial message executed side effects");
            assert.equal(snapshots[turn][0].journal.find((item: any) => item.message_id === rejectedTurn!.requestId)?.state, "ack_only");
          }
          quotaEvidence.turns.push({ turn, executionId, podUid: snapshots[turn][0].uid, quota });
        }
      }
      if (newest && newest !== last) { last = newest; console.log(JSON.stringify({ kind: "live.event", turn, event: newest })); }
      if (events.some(event => event.executionId === executionId && event.kind === "runtime.stopped")) {
        assertInstanceAbsent(kubeconfig, binding.instanceId);
        const task = await rpc("GetTask", { id: taskId });
        const workloads = await confirmedWorkloads(binding.instanceId, executionId, events, snapshots[turn] ?? []);
        evidence.push({ turn, executionNumber, task, events, workloads, snapshots: snapshots[turn] ?? [] });
        assert.equal(task.status.state, streaming && turn === 2 ? "TASK_STATE_COMPLETED" : "TASK_STATE_INPUT_REQUIRED", "unexpected state after releasing compute");
        assert(!task.metadata?.recoveryRequired, "turn was quarantined");
        assert(events.filter(event => event.kind === "agent.outcome" && event.payload.outcome === "turn_done").length >= turn - (interrupted ? 1 : 0), "missing real MCP outcome");
        assert(events.filter(event => event.kind === "agent.artifact" && event.payload.text.trim() === suffix).length >= turn, "missing persistent file artifact");
        if (turn === 1) assert(events.some(event => event.kind === "execution.stop_check" && event.payload.action === "remind"), "native stop hook did not remind");
        if (rejectedProvisioning) {
          const bindings = events.filter(event => event.kind === "runtime.bound");
          assert.equal(bindings.length, 1, "task runtime binding was replaced");
          assert.deepEqual(binding, rejectedProvisioning.binding);
          const inventory = await provisioningInventory(core);
          assertProvisioningInventory(before!, inventory, snapshots[turn][0].pvc[0]);
          if (quotaEvidence.inventories.length) assert.deepEqual(inventory, quotaEvidence.inventories[0], "recovered workspace changed between turns");
          quotaEvidence.inventories.push(inventory);
          let current: any[] = [];
          for (let attempt = 0; attempt < 30; attempt++) {
            current = await volumes(binding.instanceId);
            if (current[0]?.status === "VOLUME_STATUS_ACTIVE") break;
            await delay(1000);
          }
          assert.equal(current.length, 1);
          assertReopenedVolume(rejectedProvisioning.volume, current[0], snapshots[turn][0].pvc[0]);
          quotaCallbacks.record({ kind: "provisioning.reopened", turn, volume: current[0], inventory });
          await quotaOperator!.observe(false, true);
        }
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
      assertInstanceAbsent(kubeconfig, binding.instanceId);
      const recoveredEvents = (await fetch(`${base}/tasks/${taskId}/events`, { headers }).then(r => r.json()) as any).events;
      const workloads = await confirmedWorkloads(binding.instanceId, executionId, recoveredEvents, [...snapshots[1], ...gated]);
      evidence.push({ turn: 1, task: quarantined, events: recoveredEvents, workloads, snapshots: snapshots[1], gatedReplacement: gated });
      await assert.rejects(rpc("SendMessage", { message: { taskId, messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "must not run before reconciliation" }] } }));
      const response = await fetch(`${base}/tasks/${taskId}/executions/${executionId}/reconcile`, { method: "POST", headers,
        body: JSON.stringify({ resolution: "continue", reason: "Operator inspected the durable marker and pending journal in the gated replacement; append already happened once. Retire the old request without replay." }) });
      assert.equal(response.status, 200, "explicit reconciliation failed");
      console.log(JSON.stringify({ kind: "live.interruption-reconciled", taskId, executionId }));
    } else await waitTurn(1);
    if (quotaRecovery) {
      rejectedTurn = await runQuotaRejectedTurn({ ...quotaCallbacks, suffix, first: evidence[0] });
    }
    if (blocking) {
      const result = await blocking;
      assert.equal(result.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
      for (const probe of streamProbes) probe.assertOpen();
      const before = Date.now(); await delay(2000);
      for (const probe of streamProbes) probe.assertOpen();
      protocolEvidence.idleSubscribedMs = Date.now() - before;
    }
    await rpc("SendMessage", { message: { taskId, messageId: randomUUID(), role: "ROLE_USER", parts: [{ text:
      "Read /workspace/reporting-proof.txt. Publish its exact existing contents as an artifact. Do not create or rewrite it. Run sleep 3 to leave an inspection window, then report turn_done." }],
      ...(streaming ? { metadata: { endTask: true } } : {}) }, configuration: { returnImmediately: true } });
    await waitTurn(2, quotaEnabled ? 3 : 2);
    assert(snapshots[1]?.length && snapshots[2]?.length, "native session evidence was not captured");
    assert.notEqual(snapshots[1][0].uid, snapshots[2][0].uid, "follow-up must run in a recreated pod");
    assert.deepEqual(snapshots[1][0].pvc, snapshots[2][0].pvc, "task PVC changed");
    assert.deepEqual(snapshots[1][0].native, snapshots[2][0].native, "native session identity changed");
    assert.equal(snapshots[2][0].marker, interrupted ? `${suffix}\n` : suffix, "follow-up repeated a side effect or changed the file");
    if (interrupted) assert.equal(snapshots[2][0].journal.find((record: any) => record.message_id === snapshots[1][0].journal[0].message_id)?.state, "ack_only", "old inbox request was not retired explicitly");
    if (rejectedTurn) {
      const rejectedRequestId = rejectedTurn.requestId;
      assert.equal(snapshots[2][0].journal.find((record: any) => record.message_id === rejectedRequestId)?.state, "ack_only", "quota-rejected inbox request was not retired without execution");
      assert.equal(quotaEvidence.turns.length, 2, "both native turns must be observed under quota");
      await quotaOperator!.observe(false, true);
      Object.assign(quotaEvidence, { rejectedTurn, passed: true });
    }
    if (streaming) {
      const page = await fetch(`${base}/tasks/${taskId}/events?limit=1000`, { headers }).then(r => r.json()) as any;
      for (const probe of streamProbes) {
        await probe.finished;
        assertStreamMatchesDurable(probe, page.events, TaskState.TASK_STATE_COMPLETED);
        assert(Date.parse(probe.endedAt()!) - Date.parse(probe.observations[0].observedAt) > 30_000, "stream was not exercised beyond the old cutoff");
        assert(probe.observations.some(item => item.event.payload?.$case === "statusUpdate" && item.event.payload.value.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED));
      }
      const receipt = protocolEvidence.blocking as { startedAt: string; returnedAt: string };
      assert(Date.parse(receipt.returnedAt) - Date.parse(receipt.startedAt) > 30_000, "blocking send did not cross the old cutoff");
      assert.equal(page.events.filter((event: any) => event.kind === "execution.queued").length, 2, "blocking duplicate created an execution");
      protocolEvidence.passed = true;
    }
    console.log(JSON.stringify({ kind: "live.passed", taskId, turns: 2, scenario }));
  }
};
let diagnostics: Awaited<ReturnType<typeof startRuntimeDiagnostics>> | undefined;
try {
  diagnostics = await startRuntimeDiagnostics(agentId, kubeconfig, directory);
  if (quotaTemplate) {
    const config = new KubeConfig(); config.loadFromFile(kubeconfig);
    quotaOperator = new QuotaFixture(KubernetesObjectApi.makeApiClient(config), quotaFixture(quotaTemplate, quotaRun, quotaBudget!, deniedResource), sample => {
      quotaEvidence.samples.push(sample); writeFileSync(join(directory, "quota.json"), JSON.stringify(quotaEvidence, null, 2), { mode: 0o600 });
    }, deniedResource);
    await quotaOperator.create();
    if (provisioningRecovery) await quotaOperator.setDenied(true);
  }
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
  if (parallel) await runParallelAcceptance({ kubeconfig, directory, agentId, suffix, gateway, tasks, rpc, inspect: inspectInstance, verifyReleased: verifyPreparedReleased,
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
      for (const instance of instances) if ((await gateway.workloads(instance.meta.id)).some(workload => !workload.removalConfirmedAt) || instancePods(kubeconfig, instance.meta.id).length) active = true;
      if (!active) break;
      if (attempt >= 90) throw new Error("fixture workloads did not release during cleanup");
      await delay(1000);
    }
    workloadsReleased = true;
    console.log(JSON.stringify({ kind: "live.cleanup", directory, instances: instances.map(i => i.meta.id) }));
  } finally {
    try {
      streamAbort.abort();
      for (const probe of streamProbes) await probe.finished.catch(() => {});
      if (streaming) protocolEvidence.streams = streamProbes.map(probe => ({ endedAt: probe.endedAt(), observations: probe.observations.map(item => ({
        observedAt: item.observedAt, event: StreamResponse.toJSON(item.event)
      })) }));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    } finally {
      try {
        const errors: unknown[] = [];
        if (quotaOperator && workloadsReleased) {
          try { await quotaOperator.close(); quotaEvidence.cleanedUp = true; } catch (error) { errors.push(error); }
        } else if (quotaOperator) quotaEvidence.retained = "Workload cleanup was not confirmed; keep quota until operator reconciliation";
        if (networkFixtures && workloadsReleased) {
          try { await networkFixtures.close(); networkEvidence.cleanedUp = true; } catch (error) { errors.push(error); }
        } else if (networkFixtures) networkEvidence.retained = "Workload cleanup was not confirmed; keep isolation policies until operator reconciliation";
        if (errors.length) throw new AggregateError(errors, "quota/network cleanup requires operator reconciliation");
      } finally {
        try { await diagnostics?.stop(); }
        finally {
          writeFileSync(join(directory, "evidence.json"), JSON.stringify({ environmentId, agentId, agentProfile, tasks, scenario, snapshots, evidence,
            network: networkEvidence, resources: resourceEvidence, protocol: protocolEvidence, quota: quotaEvidence, prepared: preparedEvidence,
            runtimeDiagnosticsFile: diagnostics?.file }, null, 2), { mode: 0o600 });
        }
      }
    }
  }
}
