// SPDX-License-Identifier: AGPL-3.0-only
// Model-free native CLI probe. Only loopback DNS and fake API servers are used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoreV1Api, AppsV1Api, KubeConfig, KubernetesObjectApi } from "@kubernetes/client-node";
import { NetworkFixtures, namespace, proofLabel, assertPolicyUnchanged } from "../dist/live/network-proof.js";

assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local");
assert(process.env.AGYN_KUBECONFIG, "explicit kubeconfig required");
const mode = process.argv[2]; assert(["mixed", "single", "unavailable"].includes(mode));
const image = process.env.AGYN_NATIVE_DNS_IMAGE;
const runtimeImage = process.env.AGYN_NATIVE_DNS_RUNTIME_IMAGE;
for (const value of [image, runtimeImage]) assert(typeof value === "string" && /@sha256:[a-f0-9]{64}$/.test(value), "digest-pinned images required");
const config = new KubeConfig(); config.loadFromFile(resolve(process.env.AGYN_KUBECONFIG));
const core = config.makeApiClient(CoreV1Api), apps = config.makeApiClient(AppsV1Api), objects = KubernetesObjectApi.makeApiClient(config);
assert.equal((await core.listNamespacedPod({ namespace })).items.length, 0, "workload namespace must be idle");
const claims = async () => (await core.listNamespacedPersistentVolumeClaim({ namespace })).items.map(p => ({ name: p.metadata.name, uid: p.metadata.uid, spec: p.spec, phase: p.status.phase }));
const deployments = async () => {
  const result = [];
  for (const name of ["runners", "gateway", "k8s-runner", "agents-orchestrator", "llm-proxy"]) {
    const d = await apps.readNamespacedDeployment({ namespace: "agyn-platform", name });
    result.push({ name, uid: d.metadata.uid, spec: d.spec });
  }
  return result;
};
const before = { claims: await claims(), deployments: await deployments() };
const run = randomUUID().slice(0, 8), name = `a2a-net-${run}-native-dns`, labels = { [proofLabel]: run };
mkdirSync(resolve(".state"), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(".state/agyn-native-dns-live-"));
const evidence = { mode, run, directory, image, runtimeImage, startedAt: new Date().toISOString(), before,
  providerCredentials: false, persistentVolumes: false, resources: [], passed: false, cleanedUp: false };
const save = () => writeFileSync(`${directory}/evidence.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
const fixtures = new NetworkFixtures(objects, run, resources => { evidence.resources = resources; save(); });
try {
  const policy = await fixtures.create({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name, namespace, labels },
    spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] } });
  const pod = await fixtures.create({ apiVersion: "v1", kind: "Pod", metadata: { name, namespace, labels }, spec: {
    restartPolicy: "Never", activeDeadlineSeconds: 150, terminationGracePeriodSeconds: 5,
    automountServiceAccountToken: false, enableServiceLinks: false, dnsPolicy: "None",
    dnsConfig: { nameservers: ["127.0.0.2", ...(mode === "mixed" ? ["127.0.0.3"] : [])], options: [{ name: "ndots", value: "1" }, { name: "timeout", value: "1" }, { name: "attempts", value: "1" }] },
    securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
    initContainers: [{ name: "runtime", image: runtimeImage, imagePullPolicy: "IfNotPresent",
      securityContext: { runAsUser: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
      resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
      volumeMounts: [{ name: "runtime", mountPath: "/agyn" }] }],
    containers: [{ name: "diagnostic", image, imagePullPolicy: "Never",
      args: ["-test.run=^TestNativeDNSInterception$", "-test.v", "-test.timeout=100s"],
      securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] } },
      resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "2", memory: "2Gi" } },
      env: [{ name: "AGYN_NATIVE_DNS_TEST", value: "true" }, { name: "AGYN_NATIVE_DNS_MODE", value: mode },
        { name: "AGYN_NATIVE_DNS_BINARY", value: "/agyn/bin/claude" }, { name: "LD_LIBRARY_PATH", value: "/agyn/bin/lib" }, { name: "TMPDIR", value: "/tmp" }],
      volumeMounts: [{ name: "runtime", mountPath: "/agyn", readOnly: true }, { name: "temporary", mountPath: "/tmp" }] }],
    volumes: [{ name: "runtime", emptyDir: { sizeLimit: "1Gi" } }, { name: "temporary", emptyDir: { sizeLimit: "256Mi" } }]
  } });
  console.log(JSON.stringify({ kind: "native-dns.started", mode, directory, podUid: pod.metadata.uid }));
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const current = await core.readNamespacedPod({ namespace, name }); assert.equal(current.metadata.uid, pod.metadata.uid);
    evidence.phase = current.status.phase; save();
    if (["Succeeded", "Failed"].includes(current.status.phase)) {
      const output = await core.readNamespacedPodLog({ namespace, name, container: "diagnostic", limitBytes: 32768 });
      evidence.testOutput = output;
      const line = output.split("\n").find(line => line.includes("native_dns_result="));
      if (line) evidence.result = JSON.parse(line.slice(line.indexOf("native_dns_result=") + "native_dns_result=".length));
      save();
      assert.equal(current.status.phase, "Succeeded", "native DNS fixture failed; inspect private evidence");
      assert(output.includes("--- PASS: TestNativeDNSInterception") && !output.includes("--- SKIP:"));
      assert.equal(evidence.result.mode, mode); assert.equal(evidence.result.provider_credentials, false);
      assertPolicyUnchanged(await objects.read(policy), policy);
      evidence.passed = true; break;
    }
    await delay(1000);
  }
  assert(evidence.passed, "native DNS fixture did not complete");
} finally {
  try {
    // Keep isolation in place when compute removal cannot be confirmed.
    for (const pod of fixtures.resources.filter(r => r.kind === "Pod")) await fixtures.remove(pod);
    for (const policy of fixtures.resources.filter(r => r.kind === "NetworkPolicy")) await fixtures.remove(policy);
    assert.equal((await core.listNamespacedPod({ namespace })).items.length, 0);
    assert.deepEqual(await claims(), before.claims, "existing workspace identity/spec/phase changed");
    assert.deepEqual(await deployments(), before.deployments, "platform deployment changed");
    evidence.cleanedUp = true;
  } finally { evidence.endedAt = new Date().toISOString(); save(); }
  console.log(JSON.stringify({ kind: "native-dns.finished", directory, mode, passed: evidence.passed, cleanedUp: evidence.cleanedUp, result: evidence.result }));
}
