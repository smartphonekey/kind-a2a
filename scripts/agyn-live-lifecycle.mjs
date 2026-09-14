// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only, opt-in deployment wrapper. Restore only the fields this run owns.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local");
const image = process.env.AGYN_LIVE_ORCHESTRATOR_IMAGE;
const initImage = process.env.AGYN_LIVE_INIT_IMAGE;
assert(image && initImage, "explicit reviewed orchestrator and daemon integration images are required");
const runnersImage = process.env.AGYN_LIVE_RUNNERS_IMAGE;
const gatewayImage = process.env.AGYN_LIVE_GATEWAY_IMAGE;
assert(runnersImage && gatewayImage, "explicit reviewed Runners and Gateway removal-confirmation images are required");
const llmProxyImage = process.env.AGYN_LIVE_LLM_PROXY_IMAGE;
if (llmProxyImage) assert(/^\S+@sha256:[a-f0-9]{64}$/.test(llmProxyImage), "proxy diagnostics require a reviewed digest-pinned image");
const bounded = process.env.AGYN_LIVE_COMPUTE_RESOURCES === "true";
assert(!process.env.AGYN_LIVE_COMPUTE_RESOURCES || bounded, "AGYN_LIVE_COMPUTE_RESOURCES must be true when set");
const prepared = process.env.AGYN_LIVE_PREPARED_WORKLOADS === "true";
assert(!process.env.AGYN_LIVE_PREPARED_WORKLOADS || prepared, "AGYN_LIVE_PREPARED_WORKLOADS must be true when set");
if (prepared) {
  assert(bounded, "prepared acceptance requires the bounded resource profile");
  assert.equal(process.env.AGYN_LIVE_PREPARED_RETAIN, "true", "prepared upgrades retain reviewed deployments; explicit retention acknowledgement required");
  assert(isAbsolute(process.env.AGYN_KUBECONFIG ?? ""), "prepared upgrades require an explicit absolute kubeconfig");
} else assert(!process.env.AGYN_LIVE_PREPARED_RETAIN && !process.env.AGYN_LIVE_PREPARED_BACKUP_FILE, "prepared upgrade settings require prepared acceptance");
const runnerImage = process.env.AGYN_LIVE_RUNNER_IMAGE;
const supportingResources = process.env.AGYN_LIVE_SUPPORTING_RESOURCES;
if (bounded) {
  assert(runnerImage && supportingResources, "resource acceptance requires explicit runner image and supporting bounds");
  const bounds = JSON.parse(supportingResources);
  assert(bounds && typeof bounds === "object" && !Array.isArray(bounds));
  assert.deepEqual(Object.keys(bounds).sort(), ["limitsCpu", "limitsMemory", "requestsCpu", "requestsMemory"]);
  assert(Object.values(bounds).every(value => typeof value === "string" && value.trim()), "supporting bounds must be complete strings");
  assert(process.env.AGYN_LIVE_RUNNER_CHART, "resource acceptance requires the reviewed network policy chart");
} else assert(!runnerImage && !supportingResources, "resource settings require AGYN_LIVE_COMPUTE_RESOURCES=true");
const scenarios = process.argv.slice(2);
assert(scenarios.length && scenarios.every(value => ["completed", "interrupted", "cancellation", "parallel", "streaming", "startup-failure", "quota-recovery", "provisioning-recovery"].includes(value)), "supply one or more known acceptance scenarios");
const provisioningRecovery = scenarios.includes("provisioning-recovery");
if (provisioningRecovery) assert.equal(scenarios.length, 1, "first-provision acceptance needs a dedicated PVC budget/run");
const quotaRecovery = scenarios.includes("quota-recovery") || provisioningRecovery;
let quotaBudget;
if (quotaRecovery) {
  assert(bounded, "quota acceptance requires the bounded resource profile");
  assert(isAbsolute(process.env.AGYN_KUBECONFIG ?? ""), "quota acceptance requires an explicit absolute kubeconfig");
  const { parseQuotaBudget } = await import("../dist/live/quota-proof.js");
  quotaBudget = parseQuotaBudget(JSON.parse(process.env.AGYN_LIVE_QUOTA_HARD ?? "null"), provisioningRecovery ? "persistentvolumeclaims" : "count/pods");
} else assert(!process.env.AGYN_LIVE_QUOTA_HARD, "quota budget requires a quota acceptance scenario");
if (scenarios.includes("startup-failure")) {
  assert(bounded, "startup-failure acceptance requires the bounded resource profile");
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(process.env.AGYN_LIVE_PLATFORM_MODEL_ID ?? ""),
    "startup-failure requires an explicit platform model metadata UUID; it never invokes that model");
}
if (scenarios.includes("parallel")) assert(process.env.AGYN_LIVE_RUNNER_CHART, "parallel acceptance requires the reviewed network policy chart");
const kubeconfig = resolve(process.env.AGYN_KUBECONFIG ?? ".state/agyn-kubeconfig");
const k = (args, input) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], { input, encoding: "utf8", timeout: 90_000 });
const deployment = name => JSON.parse(k(["get", "deployment", name, "-n", "agyn-platform", "-o", "json"]));
const container = (value, name) => value.spec.template.spec.containers.find(item => item.name === name);
const targets = [
  { name: "runners", image: runnersImage, managed: new Map() },
  { name: "gateway", image: gatewayImage, managed: new Map() },
  ...(bounded ? [{ name: "k8s-runner", image: runnerImage, managed: new Map([["SUPPORTING_CONTAINER_RESOURCES", supportingResources]]) }] : []),
  ...(llmProxyImage ? [{ name: "llm-proxy", image: llmProxyImage, managed: new Map() }] : []),
  { name: "agents-orchestrator", image, managed: new Map([["AGYND_CLI_INIT_IMAGE", initImage], ["STOP_INACTIVE_INSTANCES", "true"], ["STOP_TIMEOUT_SEC", "5"]]) }
].map(target => {
  const original = deployment(target.name), previous = container(original, target.name);
  assert(previous, `${target.name} container not found`);
  return { ...target, original, previous, attempted: false };
});
const preparedTools = await import("../dist/live/prepared-upgrade.js");
const preparedScope = prepared ? { postgresPod: process.env.AGYN_AUDIT_POSTGRES_POD ?? "", postgresPodUid: process.env.AGYN_AUDIT_POSTGRES_UID ?? "",
  postgresUser: process.env.AGYN_AUDIT_POSTGRES_USER ?? "", runnerId: process.env.AGYN_AUDIT_RUNNER_ID ?? "", namespaceUid: process.env.AGYN_AUDIT_NAMESPACE_UID ?? "" } : undefined;
const preparedSnapshot = () => preparedTools.collectPreparedUpgradeState(k, preparedScope);
let preparedBefore;
if (prepared) {
  assert([...targets.map(target => target.image), initImage].every(value => /^\S+@sha256:[a-f0-9]{64}$/.test(value)), "prepared upgrades require digest-pinned images for the complete reviewed stack");
  preparedBefore = preparedSnapshot();
  assert(preparedBefore.registry.migrations.includes("0017_workload_removal_confirmation.sql"), "workload confirmation migration must precede prepared upgrade");
  assert.equal(preparedBefore.registry.workloads.unconfirmed, 0, "unconfirmed registry workloads prevent prepared upgrade");
  preparedTools.verifyPreparedBackup(process.env.AGYN_LIVE_PREPARED_BACKUP_FILE ?? "", preparedBefore);
  for (const target of targets) assert.equal(target.original.spec.replicas, 1, "prepared local acceptance requires one replica per reviewed deployment");
  const native = targets.find(target => target.name === "k8s-runner").previous;
  assert.deepEqual(native.env?.find(e => e.name === "KUBE_NAMESPACE"), { name: "KUBE_NAMESPACE", value: "agyn-workloads" }, "prepared namespace must match the pinned audit scope");
  assert.deepEqual(native.env?.find(e => e.name === "ZITI_ENABLED"), { name: "ZITI_ENABLED", value: "true" }, "prepared acceptance requires the authenticated runner transport mode");
  const selector = targets.find(target => target.name === "agents-orchestrator").original.spec.selector;
  assert(selector?.matchLabels && Object.keys(selector.matchLabels).length && !selector.matchExpressions?.length, "unsupported orchestrator selector");
  if (preparedBefore.registry.migrations.includes("0022_prepared_workloads.sql")) preparedTools.assertPreparedSchema(preparedBefore);
} else preparedTools.assertLegacyRegistrySchema(k);
const assertIdle = message => assert.equal(JSON.parse(k(["get", "pods", "-n", "agyn-workloads", "-o", "json"])).items.length, 0, message);
const assertNoQuotas = () => assert.equal(JSON.parse(k(["get", "resourcequotas", "-n", "agyn-workloads", "-o", "json"])).items.length, 0,
  "quota state is not empty; refusing deployment changes until operator reconciliation");
const assertClaimSlot = () => {
  if (provisioningRecovery) assert.equal(JSON.parse(k(["get", "persistentvolumeclaims", "-n", "agyn-workloads", "-o", "json"])).items.length,
    Number(quotaBudget.persistentvolumeclaims) - 1, "PVC budget must leave exactly one new workspace slot");
};
const assertStartupRead = () => {
  if (!provisioningRecovery && !prepared) return;
  const account = targets.find(target => target.name === "k8s-runner").original.spec.template.spec.serviceAccountName ?? "default";
  assert.equal(k(["auth", "can-i", "get", "secrets", "-n", "agyn-workloads", `--as=system:serviceaccount:agyn-platform:${account}`]).trim(),
    "yes", "deploy the reviewed startup Secret read permission before changing images");
  if (prepared) {
    assert.equal(k(["auth", "can-i", "patch", "secrets", "-n", "agyn-workloads", `--as=system:serviceaccount:agyn-platform:${account}`]).trim(),
      "yes", "deploy the reviewed Secret ownership patch permission before changing images");
    assert.equal(k(["auth", "can-i", "get", "namespace/agyn-workloads", `--as=system:serviceaccount:agyn-platform:${account}`]).trim(),
      "yes", "deploy the reviewed exact-namespace read permission before changing images");
  }
};
assertIdle("refusing a global image change while workloads exist");
if (quotaRecovery) assertNoQuotas();
assertClaimSlot();
assertStartupRead();
mkdirSync(resolve(".state"), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(".state/agyn-lifecycle-deploy-"));
writeFileSync(join(directory, "before.json"), JSON.stringify({ deployments: targets.map(target => ({ name: target.name,
  uid: target.original.metadata.uid, image: target.previous.image,
  env: (target.previous.env ?? []).filter(entry => target.managed.has(entry.name)) })) }, null, 2), { mode: 0o600 });
if (prepared) writeFileSync(join(directory, "prepared-before.json"), JSON.stringify(preparedBefore, null, 2), { mode: 0o600 });
const patch = (target, current, targetImage, replacements) => {
  assert.equal(current.metadata.uid, target.original.metadata.uid, `${target.name} deployment identity changed`);
  const index = current.spec.template.spec.containers.findIndex(item => item.name === target.name);
  assert(index >= 0, `${target.name} container removed`);
  const currentContainer = container(current, target.name);
  const env = (currentContainer.env ?? []).filter(entry => !target.managed.has(entry.name)).concat(replacements);
  const patchFile = join(directory, "patch.json");
  writeFileSync(patchFile, JSON.stringify([
    { op: "test", path: "/metadata/resourceVersion", value: current.metadata.resourceVersion },
    { op: "replace", path: `/spec/template/spec/containers/${index}/image`, value: targetImage },
    ...(target.managed.size ? [{ op: currentContainer.env ? "replace" : "add", path: `/spec/template/spec/containers/${index}/env`, value: env }] : [])
  ]), { mode: 0o600 });
  try { k(["patch", "deployment", target.name, "-n", "agyn-platform", "--type=json", `--patch-file=${patchFile}`]); }
  finally { rmSync(patchFile, { force: true }); }
};
const rollout = name => k(["rollout", "status", `deployment/${name}`, "-n", "agyn-platform", "--timeout=80s"]);
const proxyStartedAt = new Date().toISOString();
let proxyPod;
const selectProxyPod = () => {
  const target = targets.find(item => item.name === "llm-proxy");
  const labels = target.original.spec.selector.matchLabels;
  assert(labels && Object.keys(labels).length && !target.original.spec.selector.matchExpressions?.length, "unsupported proxy selector");
  const pods = JSON.parse(k(["get", "pods", "-n", "agyn-platform", "-l", Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(","), "-o", "json"])).items;
  const candidates = pods.filter(pod => !pod.metadata.deletionTimestamp && pod.spec.containers.some(c => c.name === "llm-proxy" && c.image === llmProxyImage));
  assert.equal(candidates.length, 1, "expected one diagnostic proxy Pod");
  const pod = candidates[0];
  assert(/^[a-z0-9-]+$/.test(pod.metadata.name) && /^[a-f0-9-]{36}$/.test(pod.metadata.uid));
  assert.equal(pod.status.containerStatuses.find(c => c.name === "llm-proxy").restartCount, 0, "proxy restarted before capture");
  proxyPod = { name: pod.metadata.name, uid: pod.metadata.uid };
};
const captureProxy = async () => {
  const report = { image: llmProxyImage, pod: proxyPod, since: proxyStartedAt, observedAt: new Date().toISOString(),
    rawLogsStored: false, captured: false, refusals: [], streamErrors: [], requests: [] };
  try {
    assert(proxyPod, "diagnostic proxy identity was not observed");
    const current = JSON.parse(k(["get", "pod", proxyPod.name, "-n", "agyn-platform", "-o", "json"]));
    assert.equal(current.metadata.uid, proxyPod.uid, "proxy Pod was replaced");
    assert.equal(current.spec.containers.find(c => c.name === "llm-proxy").image, llmProxyImage, "proxy image changed during acceptance");
    assert.equal(current.status.containerStatuses.find(c => c.name === "llm-proxy").restartCount, 0, "proxy restarted during acceptance");
    const { nativeProxyRefusals, nativeProxyStreamErrors, nativeProxyRequests } = await import("../dist/live/proxy-diagnostics.js");
    const logs = k(["logs", proxyPod.name, "-n", "agyn-platform", "-c", "llm-proxy", "--timestamps=true",
      `--since-time=${proxyStartedAt}`, "--tail=200", "--limit-bytes=65536"]);
    report.refusals = nativeProxyRefusals(logs); report.streamErrors = nativeProxyStreamErrors(logs); report.requests = nativeProxyRequests(logs); report.captured = true;
  } finally {
    writeFileSync(join(directory, "proxy-diagnostics.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
};
const sameManaged = (target, left, right) => left && right && left.image === right.image && [...target.managed.keys()].every(name =>
  JSON.stringify(left.env?.find(entry => entry.name === name)) === JSON.stringify(right.env?.find(entry => entry.name === name)));
const orchestratorTarget = targets.find(target => target.name === "agents-orchestrator");
let preparedStage = "preflight";
const scalePreparedOrchestrator = (from, to) => {
  const current = deployment(orchestratorTarget.name);
  assert.equal(current.metadata.uid, orchestratorTarget.original.metadata.uid, "orchestrator identity changed during coordinated upgrade");
  assert.equal(current.spec.replicas, from, "orchestrator scale changed externally");
  const expected = from === 1 ? orchestratorTarget.previous : { image: orchestratorTarget.image,
    env: [...orchestratorTarget.managed].map(([name, value]) => ({ name, value })) };
  assert(sameManaged(orchestratorTarget, container(current, orchestratorTarget.name), expected), "orchestrator settings changed before scaling");
  k(["scale", "deployment/agents-orchestrator", "-n", "agyn-platform", `--replicas=${to}`, `--current-replicas=${from}`, `--resource-version=${current.metadata.resourceVersion}`]);
  rollout(orchestratorTarget.name);
};
const assertPreparedWriterStopped = (waitForDeletion = false) => {
  const current = deployment(orchestratorTarget.name);
  assert.equal(current.metadata.uid, orchestratorTarget.original.metadata.uid, "orchestrator identity changed while stopped");
  assert.equal(current.spec.replicas, 0, "orchestrator was restarted during coordinated upgrade");
  const selector = orchestratorTarget.original.spec.selector;
  assert(selector?.matchLabels && Object.keys(selector.matchLabels).length && !selector.matchExpressions?.length, "unsupported orchestrator selector");
  const labels = Object.entries(selector.matchLabels).map(([key, value]) => `${key}=${value}`).join(",");
  const pods = JSON.parse(k(["get", "pods", "-n", "agyn-platform", "-l", labels, "-o", "json"])).items;
  if (waitForDeletion && pods.length) {
    // A zero-replica Deployment can finish rolling out before its Pods exit.
    k(["wait", "--for=delete", "pod", "-n", "agyn-platform", "-l", labels, "--timeout=80s"]);
    return assertPreparedWriterStopped();
  }
  assert.equal(pods.length,
    0, "old orchestrator Pods still exist; refusing registry migration");
};
const assertPreparedStackInstalled = (orchestratorReplicas) => {
  for (const target of targets) {
    const current = deployment(target.name);
    assert.equal(current.metadata.uid, target.original.metadata.uid, `${target.name} identity changed during prepared upgrade`);
    assert.equal(current.spec.replicas, target === orchestratorTarget ? orchestratorReplicas : 1, `${target.name} scale changed during prepared upgrade`);
    assert(sameManaged(target, container(current, target.name), { image: target.image,
      env: [...target.managed].map(([name, value]) => ({ name, value })) }), `${target.name} settings changed during prepared upgrade`);
    if (target.name === "k8s-runner") for (const name of ["KUBE_NAMESPACE", "ZITI_ENABLED"]) {
      assert.deepEqual(container(current, target.name).env?.find(e => e.name === name), target.previous.env?.find(e => e.name === name), `runner ${name} changed during prepared upgrade`);
    }
  }
};
try {
  if (prepared) {
    preparedStage = "stopping-old-orchestrator";
    scalePreparedOrchestrator(1, 0);
    assertPreparedWriterStopped(true);
    assertIdle("workload appeared while stopping old orchestrator");
    const stopped = preparedSnapshot();
    assert.equal(stopped.fingerprint, preparedBefore.fingerprint, "database changed while draining; a fresh verified backup is required");
    preparedStage = "upgrading-stopped-stack";
  }
  for (const target of targets) {
    assertIdle("workloads appeared during deployment setup; refusing further changes");
    if (quotaRecovery) assertNoQuotas();
    assertClaimSlot();
    assertStartupRead();
    if (prepared) assertPreparedWriterStopped();
    else preparedTools.assertLegacyRegistrySchema(k);
    const current = deployment(target.name);
    assert(sameManaged(target, container(current, target.name), target.previous), `${target.name} managed settings changed during setup`);
    target.attempted = true;
    patch(target, current, target.image, [...target.managed].map(([name, value]) => ({ name, value })));
    rollout(target.name);
    if (prepared && target.name === "runners") preparedTools.assertPreparedSchema(preparedSnapshot());
    if (!prepared && target.name === "runners") preparedTools.assertLegacyRegistrySchema(k);
    if (target.name === "llm-proxy") selectProxyPod();
  }
  if (prepared) {
    preparedTools.assertPreparedSchema(preparedSnapshot());
    assertPreparedStackInstalled(0);
    scalePreparedOrchestrator(0, 1);
    preparedStage = "reviewed-stack-running";
  }
  console.log(JSON.stringify({ kind: "live.deployed", image, initImage, runnerImage, runnersImage, gatewayImage, llmProxyImage, bounded, prepared, directory }));
  for (const scenario of scenarios) {
    const child = spawn(process.execPath, [scenario === "startup-failure" ? "dist/live/agyn-removal.js" : "dist/live/agyn-reporting.js"], { stdio: "inherit", env: {
      ...process.env, AGYN_LIVE_SCENARIO: scenario === "completed" ? "" : scenario
    } });
    const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("close", resolveExit); });
    if (code !== 0) throw new Error(`${scenario} acceptance failed (${code})`);
  }
} finally {
  const errors = [];
  if (llmProxyImage) try { await captureProxy(); } catch { errors.push(new Error("bounded proxy diagnostic capture failed")); }
  if (prepared) {
    const report = { kind: "prepared-upgrade-retained", stage: preparedStage, automaticRollback: false, deploymentsRestored: false,
      databaseObserved: false, directory };
    try {
      report.database = preparedSnapshot(); report.databaseObserved = true;
      if (preparedStage === "reviewed-stack-running") {
        preparedTools.assertPreparedSchema(report.database);
        assertPreparedStackInstalled(1);
        assert.equal(report.database.registry.workloads.unconfirmed, 0, "prepared workloads are still unconfirmed");
      }
      assertIdle("workload cleanup unconfirmed; retaining prepared deployments for reconciliation");
      if (quotaRecovery) assertNoQuotas();
    } catch { errors.push(new Error("prepared upgrade requires database/workload reconciliation; reviewed or partial deployments are retained")); }
    finally {
      writeFileSync(join(directory, "prepared-retained.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ kind: report.kind, stage: preparedStage, automaticRollback: false, directory }));
    }
    if (errors.length) throw new AggregateError(errors, "prepared upgrade retained for reconciliation");
  } else {
    preparedTools.assertLegacyRegistrySchema(k);
    assertIdle("workload cleanup unconfirmed; retaining integration deployments for reconciliation");
    if (quotaRecovery) assertNoQuotas();
    for (const target of [...targets].reverse().filter(target => target.attempted)) {
      try {
        preparedTools.assertLegacyRegistrySchema(k);
        const current = deployment(target.name), ours = container(current, target.name), previous = target.previous;
        assert.equal(current.metadata.uid, target.original.metadata.uid, `${target.name} deployment identity changed`);
        assert(ours, `${target.name} container removed`);
        if (!sameManaged(target, ours, previous)) {
          assert.equal(ours.image, target.image, `${target.name} image changed externally; refusing to overwrite it`);
          for (const [name, value] of target.managed) {
            assert.deepEqual(ours.env?.find(entry => entry.name === name), { name, value }, `managed setting ${name} changed externally`);
          }
          patch(target, current, previous.image, (previous.env ?? []).filter(entry => target.managed.has(entry.name)));
          rollout(target.name);
        }
        console.log(JSON.stringify({ kind: "live.deployment-restored", deployment: target.name, image: previous.image, directory }));
      } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      throw new AggregateError(errors, "deployment restoration requires operator reconciliation");
    }
  }
}
