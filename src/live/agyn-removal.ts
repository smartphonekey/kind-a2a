// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only real service/Pod proof. No model subscription or native CLI runs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KubeConfig, KubernetesObjectApi } from "@kubernetes/client-node";
import { AgynClient } from "../agyn-client.js";
import { assertInstanceAbsent, assertReviewedDeployment, inspectRetainedStartupFailurePvc, instancePods } from "./kubernetes-proof.js";
import { agentNetworkPolicies, NetworkFixtures } from "./network-proof.js";
import { assertCgroupComputeBounds, assertPodComputeBounds, parseComputeBounds } from "./resource-proof.js";
import { assertFixturePod, assertHeldFailure, assertNoFollowupExecution, finalizerPatch, type HeldPod } from "./removal-proof.js";

assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local");
assert.equal(process.env.AGYN_LIVE_SCENARIO, "startup-failure");
assert.equal(process.env.AGYN_LIVE_COMPUTE_RESOURCES, "true");
assert(!process.env.AGYN_LIVE_AGENT_PROFILE_FILE, "startup failure must not use a native subscription profile");
const required = (name: string) => { const value = process.env[name]; assert(value, `${name} is required`); return value; };
const platformModelId = required("AGYN_LIVE_PLATFORM_MODEL_ID");
assert.match(platformModelId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const kubeconfig = resolve(required("AGYN_KUBECONFIG"));
const k = (args: string[]) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
const get = (kind: string, name: string, namespace = "agyn-workloads") => {
  const text = k(["get", kind, name, "-n", namespace, "--ignore-not-found", "-o", "json"]);
  return text.trim() ? JSON.parse(text) : undefined;
};
const deployments: any[] = [];
for (const [name, variable] of [["runners", "AGYN_LIVE_RUNNERS_IMAGE"], ["gateway", "AGYN_LIVE_GATEWAY_IMAGE"],
  ["k8s-runner", "AGYN_LIVE_RUNNER_IMAGE"], ["agents-orchestrator", "AGYN_LIVE_ORCHESTRATOR_IMAGE"]]) {
  const deployment = get("deployment", name, "agyn-platform");
  assertReviewedDeployment(deployment, name, required(variable));
  deployments.push(deployment);
}
const orchestrator = deployments[3].spec.template.spec.containers.find((c: any) => c.name === "agents-orchestrator");
for (const [name, value] of [["AGYND_CLI_INIT_IMAGE", required("AGYN_LIVE_INIT_IMAGE")], ["STOP_INACTIVE_INSTANCES", "true"], ["STOP_TIMEOUT_SEC", "5"]]) {
  assert.equal(orchestrator.env.find((e: any) => e.name === name)?.value, value);
}
const supporting = parseComputeBounds(JSON.parse(required("AGYN_LIVE_SUPPORTING_RESOURCES")));
assert.deepEqual(parseComputeBounds(JSON.parse(deployments[2].spec.template.spec.containers.find((c: any) => c.name === "k8s-runner")
  .env.find((e: any) => e.name === "SUPPORTING_CONTAINER_RESOURCES").value)), supporting);
const inspectorImage = required("AGYN_LIVE_INSPECTOR_IMAGE");
assert.match(inspectorImage, /@sha256:[a-f0-9]{64}$/);
assert.equal(JSON.parse(k(["get", "pods", "-n", "agyn-workloads", "-o", "json"])).items.length, 0, "lab is not idle");
const beforeClaims: any[] = JSON.parse(k(["get", "pvc", "-n", "agyn-workloads", "-o", "json"])).items.map((p: any) => ({ name: p.metadata.name, uid: p.metadata.uid }));
const networkTemplate = execFileSync("helm", ["template", "a2a-removal-proof", resolve(required("AGYN_LIVE_RUNNER_CHART")),
  "--set", "workloadIngressNetworkPolicy.enabled=true", "--set", "workloadNamespace=agyn-workloads",
  "--show-only", "templates/workload-ingress-networkpolicy.yaml"], { encoding: "utf8", timeout: 30_000 });
const profile = process.env.AGYN_PROFILE ?? "local";
const who = JSON.parse(execFileSync("agyn", ["auth", "whoami", "--profile", profile, "-o", "json"], { encoding: "utf8" }));
const token = execFileSync("agyn", ["profile", "token", profile], { encoding: "utf8" }).trim();
const gateway = new AgynClient(who.gateway_url, token, who.organization, who.user_id);
const call = async (service: string, method: string, input: unknown): Promise<any> => {
  const response = await fetch(`${who.gateway_url}/agynio.api.gateway.v1.${service}/${method}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(30_000)
  });
  assert(response.ok, `${service}.${method} failed (${response.status})`);
  return response.json();
};
const waitFor = async <T>(description: string, read: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  do { const value = await read(); if (value !== undefined) return value; await delay(500); } while (Date.now() < deadline);
  throw new Error(`timed out: ${description}`);
};
mkdirSync(resolve(".state"), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(".state/agyn-removal-live-"));
const nonce = randomUUID();
const evidence: any = { nonce, scenario: "startup-failure", startedAt: new Date().toISOString(), beforeClaims, samples: [],
  deployments: deployments.map(d => ({ name: d.metadata.name, uid: d.metadata.uid, generation: d.metadata.generation,
    image: d.spec.template.spec.containers.find((c: any) => c.name === d.metadata.name).image })) };
const save = () => writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const config = new KubeConfig(); config.loadFromFile(kubeconfig);
const fixtures = new NetworkFixtures(KubernetesObjectApi.makeApiClient(config), nonce.slice(0, 8), resources => { evidence.networkResources = resources; save(); });
let environmentId: string | undefined, agentId: string | undefined, taskId: string | undefined, held: HeldPod | undefined;
let child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined;
let rpc: ((method: string, params: unknown) => Promise<any>) | undefined;
const patchFinalizer = (add: boolean) => {
  assert(held);
  const current = get("pod", held.name);
  if (!current && !add) return;
  assertFixturePod(current, held);
  if (!add && !current.metadata.finalizers?.includes(held.finalizer)) return;
  k(["patch", "pod", held.name, "-n", "agyn-workloads", "--type=json", "-p", JSON.stringify(finalizerPatch(current, held, add))]);
};
try {
  const { model } = await call("LLMGateway", "GetModel", { id: platformModelId });
  assert.equal(model.meta.id, platformModelId); evidence.platformModelMetadataId = platformModelId;
  const { environment: template } = await call("AgentsGateway", "GetEnvironment", {
    id: process.env.AGYN_LIVE_TEMPLATE_ENVIRONMENT ?? "618e9cec-45a5-4b9d-8c28-91d40f053b65"
  });
  await waitFor("runner capabilities", async () => {
    const { runner } = await call("RunnersGateway", "GetRunner", { id: template.runnerId });
    return runner.capabilities?.includes("compute-resources") ? runner : undefined;
  });
  const { flavors } = await call("RunnersGateway", "ListFlavors", { runnerId: template.runnerId, pageSize: 100 });
  const selected = flavors.filter((f: any) => f.runnerId === template.runnerId && f.name === template.flavor);
  assert.equal(selected.length, 1);
  const mainBounds = parseComputeBounds(selected[0].resources);
  const { environment } = await call("AgentsGateway", "CreateEnvironment", {
    organizationId: who.organization, name: `a2a-startup-${nonce.slice(0, 8)}`, runnerId: template.runnerId, flavor: template.flavor,
    workspaceImageId: template.workspaceImageId, workspaceImageTag: template.workspaceImageTag,
    agentRuntimeImageId: template.agentRuntimeImageId, agentRuntimeImageTag: template.agentRuntimeImageTag,
    llmMode: "LLM_MODE_PLATFORM", persistentShells: false, availability: "ENVIRONMENT_AVAILABILITY_PRIVATE"
  });
  environmentId = environment.meta.id; evidence.environmentId = environmentId; save();
  const { volume } = await call("AgentsGateway", "CreateVolume", { environmentId, persistent: true, name: "task-workspace", mountPath: "/workspace", size: "1Gi" });
  evidence.volumeDefinitionId = volume.meta.id; assert(!volume.ttl); save();
  const bundle = readFileSync(new URL("../reporting/runtime.mjs", import.meta.url));
  for (const [name, value] of Object.entries({ WORKSPACE_DIR: "/workspace", CODEX_HOME: "/workspace/.codex", AGYN_INIT_SCRIPTS_REQUIRED: "true",
    AGYN_INBOX_JOURNAL_DIR: "/workspace/.agyn/inbox-journal", AGYN_INBOX_CONTROL_FILE: "/run/agyn-execution/inbox-control.json",
    A2A_REPORTING_RUNTIME_SHA256: createHash("sha256").update(bundle).digest("hex"), A2A_STARTUP_FAILURE_NONCE: nonce })) {
    await call("AgentsGateway", "CreateEnv", { environmentId, name, value });
  }
  const gate = readFileSync(new URL("../../scripts/agyn-execution-gate.cjs", import.meta.url), "utf8");
  const failure = readFileSync(new URL("../../scripts/agyn-startup-failure.cjs", import.meta.url), "utf8");
  const { initScript } = await call("AgentsGateway", "CreateInitScript", { environmentId, description: "Required model-free startup failure",
    script: `/agyn/bin/node <<'A2A_STARTUP_FAILURE'\nconst gateSource = ${JSON.stringify(gate)};\n${failure}\nA2A_STARTUP_FAILURE\n` });
  evidence.initScriptId = initScript.meta.id;
  const { agent } = await call("AgentsGateway", "CreateAgent", { organizationId: who.organization, environmentId,
    capabilities: ["compute-resources"], name: `A2A Startup Failure ${nonce.slice(0, 8)}`, nickname: `a2a-startup-${nonce.slice(0, 8)}`,
    model: platformModelId, idleTimeout: "10s", instanceIdleTtl: "24h", availability: "AGENT_AVAILABILITY_PRIVATE",
    finalMessage: "AGENT_FINAL_MESSAGE_DISCARD", configuration: JSON.stringify({ system_prompt: "Startup failure fixture. No agent execution is authorized." }) });
  agentId = agent.meta.id; evidence.agentId = agentId; save();
  await call("AgentsGateway", "SetEnvironmentRole", { environmentId, identityId: agentId, role: "ENVIRONMENT_ROLE_USER" });
  for (const scope of [{ environmentId }, { agentId }]) {
    const attachments = await call("LLMGateway", "ListSubscriptionAttachments", { organizationId: who.organization, ...scope, pageSize: 100 });
    assert.equal(attachments.subscriptionAttachments?.length ?? 0, 0); assert(!attachments.nextPageToken);
  }
  evidence.nativeSubscriptions = 0;
  const finder = createServer(); finder.listen(0, "127.0.0.1"); await once(finder, "listening");
  const address = finder.address(); assert(address && typeof address !== "string"); await new Promise<void>(r => finder.close(() => r()));
  const base = `http://127.0.0.1:${address.port}`, reportingUrl = `http://${process.env.AGYN_LIVE_HOST_IP ?? "192.168.5.2"}:${address.port}/reporting`;
  for (const policy of agentNetworkPolicies(networkTemplate, nonce.slice(0, 8), agentId!, reportingUrl)) await fixtures.create(policy);
  const bearer = randomBytes(32).toString("base64url"), credentialsFile = join(directory, "credentials.json"), configFile = join(directory, "service.json");
  writeFileSync(credentialsFile, JSON.stringify([{ sha256: createHash("sha256").update(bearer).digest("hex"), tenant: who.organization,
    subject: "startup-failure-acceptance", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }]), { mode: 0o600 });
  writeFileSync(configFile, JSON.stringify({ environmentProfile: "trusted-local", dbPath: join(directory, "tasks.sqlite"), credentialsFile,
    reportingSetupExecutable: new URL("../service/agyn-reporting-installer.js", import.meta.url).pathname,
    host: "0.0.0.0", port: address.port, publicUrl: base, reportingUrl,
    defaultProfile: "startup-failure-v1", profiles: [{ id: "startup-failure-v1", agentId }], concurrency: 2, turnTimeoutMs: 300_000 }), { mode: 0o600 });
  child = spawn(process.execPath, [new URL("../service/main.js", import.meta.url).pathname], { env: {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    A2A_SERVICE_CONFIG_FILE: configFile, AGYN_GATEWAY_URL: who.gateway_url, AGYN_TOKEN: token,
    AGYN_ORGANIZATION_ID: who.organization, AGYN_IDENTITY_ID: who.user_id, A2A_ALLOW_INSECURE_LOCAL_REPORTING: "true"
  }, stdio: ["ignore", "pipe", "pipe"] });
  exited = new Promise<void>((resolveExit, reject) => { child!.once("close", () => resolveExit()); child!.once("error", reject); });
  child.stdout!.on("data", data => process.stdout.write(data)); child.stderr!.on("data", data => process.stderr.write(data));
  const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json", "A2A-Version": "1.0", connection: "close" };
  rpc = async (method, params) => {
    const response = await fetch(`${base}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any; assert(!result.error, `A2A ${method} failed (${result.error?.code})`); return result.result;
  };
  const events = async () => {
    const response = await fetch(`${base}/tasks/${taskId}/events?limit=1000`, { headers, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200); return ((await response.json()) as any).events as any[];
  };
  await waitFor("A2A service", async () => {
    assert(child!.exitCode === null && child!.signalCode === null, "A2A process exited");
    return await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok ? true : undefined).catch(() => undefined);
  }, 15_000);
  const first = await rpc("SendMessage", { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "Required-init failure acceptance. Never start the native agent." }] }, configuration: { returnImmediately: true } });
  taskId = first.task.id; evidence.taskId = taskId; save(); console.log(JSON.stringify({ kind: "removal.task", taskId, directory }));
  const bound = await waitFor("runtime binding", async () => (await events()).find(e => e.kind === "runtime.bound"));
  const instanceId = bound.payload.instanceId, executionId = bound.executionId;
  evidence.instanceId = instanceId; evidence.executionId = executionId; save();
  const pod = await waitFor("fixture Pod", async () => { const pods = instancePods(kubeconfig, instanceId); assert(pods.length <= 1); return pods[0]; });
  const main = pod.spec.containers.find((c: any) => c.env?.some((e: any) => e.name === "AGENT_INSTANCE_ID" && e.value === instanceId));
  assert(main);
  held = { name: pod.metadata.name, uid: pod.metadata.uid, agentId: agentId!, instanceId, containerName: main.name, finalizer: `a2a-lab.agyn.dev/removal-${nonce}` };
  evidence.held = held; save();
  assertFixturePod(pod, held);
  assert(!pod.spec.volumes.some((v: any) => v.hostPath), "fixture has host filesystem mounts");
  const binMount = main.volumeMounts.find((m: any) => m.mountPath === "/agyn");
  assert(binMount && pod.spec.volumes.find((v: any) => v.name === binMount.name)?.emptyDir, "CLI sentinel requires a Pod-local emptyDir");
  assert.equal(main.env.find((e: any) => e.name === "LLM_MODE")?.value, "platform");
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) assert(!main.env.some((e: any) => e.name === name));
  evidence.bounds = assertPodComputeBounds(pod, main.name, mainBounds, supporting);
  const claims = pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim).map((v: any) => v.persistentVolumeClaim.claimName);
  assert.equal(claims.length, 1); evidence.pvc = { name: claims[0], uid: get("pvc", claims[0]).metadata.uid }; save();
  evidence.finalizerAttempted = true; save();
  patchFinalizer(true); evidence.finalizerAcquiredAt = new Date().toISOString(); save();
  const receipt = await waitFor("reporting setup acknowledgement", async () => (await events()).find(e => e.kind === "execution.dispatched"));
  assert.equal(receipt.executionId, executionId);
  const accepted = (await events()).find(e => e.kind === "execution.provider_receipt" && e.payload.workloadId);
  assert(accepted); const workloadId = accepted.payload.workloadId; evidence.workloadId = workloadId; save();
  await waitFor("armed failing init", async () => {
    assertFixturePod(get("pod", held!.name), held!);
    try {
      const record = JSON.parse(k(["exec", held!.name, "-n", "agyn-workloads", "-c", held!.containerName, "--", "/agyn/bin/node", "-e",
        'const fs=require("node:fs");console.log(JSON.stringify({record:JSON.parse(fs.readFileSync("/workspace/startup-failure.json","utf8")),cpuMax:fs.readFileSync("/sys/fs/cgroup/cpu.max","utf8").trim(),memoryMax:fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim()}));']));
      assert.deepEqual(record.record, { nonce, instanceId, workloadId, stage: "armed" });
      assertCgroupComputeBounds(record, mainBounds); evidence.armed = record; return true;
    } catch (error) { if ((error as any).status !== undefined) return undefined; throw error; }
  }, 30_000);
  await rpc("SendMessage", { message: { taskId, messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: "Queued follow-up must not run before explicit recovery." }] }, configuration: { returnImmediately: true } });
  assertNoFollowupExecution(await events(), executionId);
  k(["exec", held.name, "-n", "agyn-workloads", "-c", held.containerName, "--", "/agyn/bin/node", "-e",
    `require("node:fs").writeFileSync("/run/agyn-execution/fail-now",${JSON.stringify(nonce)},{flag:"wx",mode:0o600});`]);
  evidence.injectedAt = new Date().toISOString(); save();
  await waitFor("failed Pod with pending controller deletion", async () => {
    const current = get("pod", held!.name); assertFixturePod(current, held!);
    const workloads = await gateway.workloads(instanceId);
    assert(!workloads.some(w => w.removalConfirmedAt), "confirmation preceded finalizer release");
    const task = await rpc!("GetTask", { id: taskId }); assert.equal(task.metadata.resourcesReleased, false);
    const statuses = [...(current.status.containerStatuses ?? []), ...(current.status.initContainerStatuses ?? [])];
    return current.metadata.deletionTimestamp && workloads[0]?.removedAt && ["WORKLOAD_STATUS_FAILED", "WORKLOAD_STATUS_STOPPED"].includes(workloads[0]?.status) &&
      statuses.length && statuses.every((s: any) => s.state?.terminated) ? true : undefined;
  });
  for (let i = 0; i < 15; i++) {
    const sample = { pod: get("pod", held.name), task: await rpc("GetTask", { id: taskId }), workloads: await gateway.workloads(instanceId), events: await events() };
    assertHeldFailure(sample, held, workloadId, executionId);
    const statuses = [...(sample.pod.status.containerStatuses ?? []), ...(sample.pod.status.initContainerStatuses ?? [])];
    assert(statuses.length && statuses.every((s: any) => s.state?.terminated), "containers still running after injected failure");
    evidence.samples.push({ at: new Date().toISOString(), ...sample, pod: { metadata: sample.pod.metadata, status: sample.pod.status } }); save();
    await delay(1000);
  }
  const logs = k(["logs", held.name, "-n", "agyn-workloads", "-c", held.containerName, "--tail=100"]);
  assert(logs.includes(`A2A_STARTUP_FAILURE_INJECTED ${nonce}`));
  assert(logs.includes(`required init script ${evidence.initScriptId} failed with exit code 47`));
  evidence.failureLog = logs.split("\n").filter(line => line.includes(`A2A_STARTUP_FAILURE_`) || line.includes(`required init script ${evidence.initScriptId} failed`));
  patchFinalizer(false); evidence.finalizerReleasedAt = new Date().toISOString(); save();
  const settled = await waitFor("A2A release after observed removal", async () => {
    const task = await rpc!("GetTask", { id: taskId });
    if (!task.metadata?.resourcesReleased) return undefined;
    assertInstanceAbsent(kubeconfig, instanceId); return task;
  });
  assert.equal(settled.metadata.recoveryRequired, true); assert.equal(settled.metadata.uncertainSideEffects, true);
  const workloads = await gateway.workloads(instanceId); assert.equal(workloads.length, 1); assert.equal(workloads[0].meta.id, workloadId);
  assert(Number.isFinite(Date.parse(workloads[0].removalConfirmedAt!)));
  const settledEvents = await events(); assertNoFollowupExecution(settledEvents, executionId);
  assert.equal(settledEvents.filter(e => e.kind === "runtime.stopped").length, 1);
  assert.equal(get("pvc", evidence.pvc.name).metadata.uid, evidence.pvc.uid);
  const retained = await inspectRetainedStartupFailurePvc(kubeconfig, inspectorImage, evidence.pvc.name);
  assert.deepEqual(retained.record, { nonce, instanceId, workloadId, stage: "failed" });
  assert.equal(retained.cliStarted, false); assert.equal(retained.nativeMapping, false); assert.equal(retained.nativeSessions, false);
  assert.equal(get("pvc", evidence.pvc.name).metadata.uid, evidence.pvc.uid);
  evidence.settled = { at: new Date().toISOString(), task: settled, workloads, events: settledEvents, retained }; evidence.passed = true; save();
  console.log(JSON.stringify({ kind: "removal.passed", taskId, workloadId, samples: evidence.samples.length, nativeCliStarted: false, directory }));
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : "unknown failure"; save(); throw error;
} finally {
  try {
    if (taskId && rpc) await rpc("CancelTask", { id: taskId }).catch(() => {});
    const instances = agentId ? await gateway.instances(agentId) : [];
    for (const instance of instances) await gateway.pauseInstance(instance.meta.id, "Startup acceptance cleanup; retain durable state");
    if (held && evidence.finalizerAttempted) patchFinalizer(false);
    await waitFor("fixture cleanup", async () => {
      for (const instance of instances) if (instancePods(kubeconfig, instance.meta.id).length || (await gateway.workloads(instance.meta.id)).some(w => !w.removalConfirmedAt)) return undefined;
      return true;
    });
    await fixtures.close(); evidence.cleanedUp = true;
    for (const prior of beforeClaims) {
      const current = get("pvc", prior.name); assert.equal(current?.metadata.uid, prior.uid); assert(!current.metadata.deletionTimestamp); assert.equal(current.status.phase, "Bound");
    }
    evidence.preexistingClaimsUnchanged = true;
  } finally {
    if (child) { child.kill("SIGTERM"); const timer = setTimeout(() => child!.kill("SIGKILL"), 5000); try { await exited; } finally { clearTimeout(timer); } }
    evidence.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ kind: "removal.cleanup", directory, cleanedUp: Boolean(evidence.cleanedUp), retainedPvc: evidence.pvc?.name }));
  }
}
