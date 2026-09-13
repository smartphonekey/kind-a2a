// SPDX-License-Identifier: AGPL-3.0-only
// Credential-free, operator-only CNI acceptance. No agent or PVC is created.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoreV1Api, KubeConfig, KubernetesObjectApi, NetworkingV1Api } from "@kubernetes/client-node";
import { assertProbe, type Fixture, managedLabel, namespace, NetworkFixtures, probePod, probeProgram,
  probeService, proofLabel, roleLabel, scopedIngressPolicy, tcpPort, udpPort } from "./network-proof.js";

assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local", "explicit trusted-local opt-in required");
const image = process.env.AGYN_LIVE_INSPECTOR_IMAGE;
assert(image && /@sha256:[a-f0-9]{64}$/.test(image), "set a digest-pinned Node probe image");
assert(process.env.AGYN_LIVE_RUNNER_CHART, "set AGYN_LIVE_RUNNER_CHART to the reviewed chart checkout");
const kubeconfig = resolve(process.env.AGYN_KUBECONFIG ?? ".state/agyn-kubeconfig");
const chart = resolve(process.env.AGYN_LIVE_RUNNER_CHART);
const rendered = execFileSync("helm", ["template", "a2a-network-proof", chart, "--set", "workloadIngressNetworkPolicy.enabled=true",
  "--set", `workloadNamespace=${namespace}`, "--show-only", "templates/workload-ingress-networkpolicy.yaml"], { encoding: "utf8", timeout: 30_000 });
const run = randomUUID().slice(0, 8);
const policy = scopedIngressPolicy(rendered, run);
const config = new KubeConfig(); config.loadFromFile(kubeconfig);
const core = config.makeApiClient(CoreV1Api);
const networking = config.makeApiClient(NetworkingV1Api);
const objects = KubernetesObjectApi.makeApiClient(config);
const podsBefore = await core.listNamespacedPod({ namespace });
assert.equal(podsBefore.items.length, 0, "network acceptance requires an idle workload namespace");
const policiesBefore = await networking.listNamespacedNetworkPolicy({ namespace });
assert(policiesBefore.items.some(item => item.spec?.podSelector.matchLabels?.[managedLabel] === "agents-orchestrator" &&
  item.spec.policyTypes?.includes("Egress")), "installed workload egress policy is required");

mkdirSync(resolve(".state"), { mode: 0o700, recursive: true });
const directory = mkdtempSync(resolve(".state/agyn-network-live-"));
const evidence: any = { run, startedAt: new Date().toISOString(), image, chart,
  ingressTemplateSha256: createHash("sha256").update(rendered).digest("hex"),
  policiesBefore: policiesBefore.items.map(item => ({ name: item.metadata?.name, uid: item.metadata?.uid, spec: item.spec })),
  nodes: (await core.listNode()).items.map(node => ({ name: node.metadata?.name, podCIDRs: node.spec?.podCIDRs,
    kubeletVersion: node.status?.nodeInfo?.kubeletVersion, runtime: node.status?.nodeInfo?.containerRuntimeVersion })),
  resources: [], probes: [], passed: false, cleanedUp: false };
const save = () => writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const fixtures = new NetworkFixtures(objects, run, resources => { evidence.resources = resources; save(); });
const execute = (pod: Fixture, command: string[]) => {
  const result = execFileSync("kubectl", ["--kubeconfig", kubeconfig, "-n", namespace, "exec", pod.metadata.name, "-c", "probe", "--", ...command],
    { encoding: "utf8", timeout: 12_000 });
  return JSON.parse(result);
};
const pods: Record<string, Fixture> = {};
const services: Record<string, Fixture> = {};
let failure: unknown;
try {
  for (const role of ["control", "a", "b"]) {
    const pod = await fixtures.create(probePod(run, role, image));
    pods[role] = pod;
    services[role] = await fixtures.create(probeService(pod));
  }
  for (const role of Object.keys(pods)) {
    const expected = pods[role];
    for (let attempt = 0; ; attempt++) {
      const pod = await core.readNamespacedPod({ namespace, name: expected.metadata.name });
      assert.equal(pod.metadata?.uid, expected.metadata.uid);
      if (pod.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True")) {
        pods[role] = pod as Fixture;
        break;
      }
      assert(attempt < 90 && pod.status?.phase !== "Failed", `probe pod failed to become ready: ${role}`);
      await delay(1000);
    }
  }
  evidence.pods = Object.fromEntries(Object.entries(pods).map(([role, pod]) => [role, { uid: pod.metadata.uid,
    podIP: pod.status.podIP, serviceIP: services[role].spec.clusterIP, spec: pod.spec }]));
  for (const pod of Object.values(pods)) {
    const audit = execute(pod, ["node", "-e", `const fs=require('node:fs');const status=fs.readFileSync('/proc/self/status','utf8');
      console.log(JSON.stringify({uid:process.getuid(),serviceAccountToken:fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token'),
        capEff:status.match(/^CapEff:\\s+(\\w+)/m)?.[1],noNewPrivs:status.match(/^NoNewPrivs:\\s+(\\d+)/m)?.[1],
        seccomp:status.match(/^Seccomp:\\s+(\\d+)/m)?.[1]}));`]);
    assert.equal(audit.uid, 1000); assert.equal(audit.serviceAccountToken, false);
    assert.equal(BigInt(`0x${audit.capEff}`), 0n); assert.equal(audit.noNewPrivs, "1"); assert.equal(audit.seccomp, "2");
    evidence.pods[pod.metadata.labels[roleLabel]].processAudit = audit;
  }
  const probe = (stage: string, source: string, target: string, endpoint: "pod" | "service" | "loopback", protocol: "tcp" | "udp", allowed: boolean, check = true) => {
    const host = endpoint === "loopback" ? "127.0.0.1" : endpoint === "pod" ? pods[target].status.podIP : services[target].spec.clusterIP;
    const result = execute(pods[source], probeProgram({ protocol, host, port: protocol === "tcp" ? tcpPort : udpPort, token: `${run}:${target}` }));
    const listener = !allowed && result.error === "ECONNREFUSED" ? execute(pods[target], probeProgram({
      protocol, host: "127.0.0.1", port: protocol === "tcp" ? tcpPort : udpPort, token: `${run}:${target}`
    })) : undefined;
    evidence.probes.push({ stage, source, target, endpoint, protocol, allowed, at: new Date().toISOString(), result, listener }); save();
    if (check) assertProbe(result, allowed, listener);
    return { result, listener };
  };
  const matrix = (stage: string, targets: string[], allowed: boolean, check = true) => {
    const results = [];
    for (const target of targets) for (const endpoint of ["pod", "service"] as const) for (const protocol of ["tcp", "udp"] as const) {
      results.push(probe(stage, "control", target, endpoint, protocol, allowed, check));
    }
    return results;
  };
  const healthy = (stage: string) => {
    for (const role of Object.keys(pods)) for (const protocol of ["tcp", "udp"] as const) probe(stage, role, role, "loopback", protocol, true);
  };
  const converge = async (stage: string, targets: string[], allowed: boolean) => {
    for (let attempt = 0; ; attempt++) {
      const results = matrix(`${stage}.${attempt}`, targets, allowed, false);
      let valid = true;
      for (const observed of results) { try { assertProbe(observed.result, allowed, observed.listener); } catch { valid = false; } }
      if (valid) return;
      assert(attempt < 5, `${stage} did not converge; see evidence.json`);
      healthy(`${stage}.health`);
      await delay(1000);
    }
  };

  // Existing policies must permit the control before any denial can be attributed
  // to this chart's ingress policy. Managed sources already have egress isolation.
  await converge("baseline.ingress", ["a", "b"], true);
  healthy("baseline.health");
  for (let attempt = 0; ; attempt++) {
    let valid = true;
    for (const source of ["a", "b"]) for (const target of source === "a" ? ["b", "control"] : ["a", "control"]) {
      for (const endpoint of ["pod", "service"] as const) for (const protocol of ["tcp", "udp"] as const) {
        const observed = probe(`installed.egress.${attempt}`, source, target, endpoint, protocol, false, false);
        try { assertProbe(observed.result, false, observed.listener); } catch { valid = false; }
      }
    }
    if (valid) break;
    assert(attempt < 5, "installed egress enforcement did not converge; see evidence.json");
    healthy("installed.egress.health");
    await delay(5000);
  }
  const dns = () => {
    for (const source of ["a", "b"]) {
      const addresses = execute(pods[source], ["node", "-e", "require('node:dns').promises.resolve4('kubernetes.default.svc.cluster.local').then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.code);process.exitCode=1;})"]);
      assert(addresses.length > 0); evidence.probes.push({ stage: "allowed.cluster-dns", source, addresses }); save();
    }
  };
  dns();
  const createdPolicy = await fixtures.create(policy);
  await converge("isolated.ingress", ["a", "b"], false);
  matrix("isolated.ingress.stable", ["a", "b"], false);
  healthy("isolated.health"); dns();

  // Explicitly test additive policy semantics and selector scope, then revoke it.
  const exception = await fixtures.create({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
    metadata: { name: `a2a-net-${run}-allow-a`, namespace, labels: { [proofLabel]: run } }, spec: {
      podSelector: { matchLabels: { [proofLabel]: run, [roleLabel]: "a" } }, policyTypes: ["Ingress"],
      ingress: [{ from: [{ podSelector: { matchLabels: { [proofLabel]: run, [roleLabel]: "control" } } }],
        ports: [{ protocol: "TCP", port: tcpPort }, { protocol: "UDP", port: udpPort }] }]
    } });
  await converge("additive.allow-a", ["a"], true);
  matrix("additive.still-deny-b", ["b"], false);
  await fixtures.remove(exception);
  await converge("additive.revoked", ["a", "b"], false);
  healthy("revoked.health");

  await fixtures.remove(createdPolicy);
  await converge("restored.ingress", ["a", "b"], true);
  healthy("restored.health");
  evidence.checksPassed = true;
} catch (error) {
  failure = error; evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  try { await fixtures.close(); evidence.cleanedUp = true; } catch (error) {
    evidence.cleanupError = error instanceof Error ? error.message : String(error); failure ??= error;
  }
  evidence.finishedAt = new Date().toISOString(); save();
}
try {
  const remainingPods = await core.listNamespacedPod({ namespace, labelSelector: `${proofLabel}=${run}` });
  const remainingServices = await core.listNamespacedService({ namespace, labelSelector: `${proofLabel}=${run}` });
  const remainingPolicies = await networking.listNamespacedNetworkPolicy({ namespace, labelSelector: `${proofLabel}=${run}` });
  assert.equal(remainingPods.items.length + remainingServices.items.length + remainingPolicies.items.length, 0, "fixture resources remain");
  const policiesAfter = await networking.listNamespacedNetworkPolicy({ namespace });
  assert.deepEqual(policiesAfter.items.map(item => ({ name: item.metadata?.name, uid: item.metadata?.uid, spec: item.spec })), evidence.policiesBefore,
    "pre-existing network policies changed during acceptance");
} catch (error) {
  failure ??= error; evidence.verificationError = error instanceof Error ? error.message : String(error);
}
evidence.passed = evidence.checksPassed === true && evidence.cleanedUp && !failure;
save();
console.log(JSON.stringify({ kind: "live.network", run, passed: evidence.passed && !failure, cleanedUp: evidence.cleanedUp, directory,
  probes: evidence.probes.length }));
if (failure) throw failure;
