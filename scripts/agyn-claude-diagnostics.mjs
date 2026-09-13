// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only native failure proof. No Agyn credentials or persistent volumes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoreV1Api, KubeConfig, NetworkingV1Api } from "@kubernetes/client-node";

assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local");
const kubeconfig = process.env.AGYN_KUBECONFIG;
assert(kubeconfig, "explicit kubeconfig is required");
const image = process.env.AGYN_CLAUDE_DIAGNOSTIC_IMAGE;
const runtimeImage = process.env.AGYN_CLAUDE_DIAGNOSTIC_RUNTIME_IMAGE;
for (const selected of [image, runtimeImage]) assert(selected && /@sha256:[a-f0-9]{64}$/.test(selected), "reviewed digest-pinned images are required");
const config = new KubeConfig(); config.loadFromFile(resolve(kubeconfig));
const core = config.makeApiClient(CoreV1Api), networking = config.makeApiClient(NetworkingV1Api);
const namespace = "agyn-workloads", run = randomUUID(), name = `a2a-claude-diagnostic-${run.slice(0, 8)}`;
const labels = { "a2a-lab-diagnostic": run };
assert.equal((await core.listNamespacedPod({ namespace })).items.length, 0, "workload namespace must be idle");
const claims = (await core.listNamespacedPersistentVolumeClaim({ namespace })).items.map(pvc => ({ name: pvc.metadata.name, uid: pvc.metadata.uid, phase: pvc.status.phase }));
mkdirSync(resolve(".state"), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(".state/agyn-claude-diagnostic-live-"));
const evidence = { run, name, directory, image, runtimeImage, startedAt: new Date().toISOString(), passed: false, cleanedUp: false, claims };
const save = () => writeFileSync(`${directory}/evidence.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
const removed = async read => {
  for (let i = 0; i < 60; i++) {
    try { await read(); } catch (error) { if (error.code === 404) return; throw error; }
    await delay(1000);
  }
  throw new Error("owned resource removal was not observed");
};
let pod, policy;
try {
  evidence.policyCreateAttempted = true; save();
  policy = await networking.createNamespacedNetworkPolicy({ namespace, body: {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name, labels },
    spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] }
  } });
  evidence.policyUid = policy.metadata.uid; save();
  evidence.podCreateAttempted = true; save();
  pod = await core.createNamespacedPod({ namespace, body: {
    apiVersion: "v1", kind: "Pod", metadata: { name, labels }, spec: {
      restartPolicy: "Never", activeDeadlineSeconds: 150, terminationGracePeriodSeconds: 5,
      automountServiceAccountToken: false, enableServiceLinks: false,
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
      initContainers: [{ name: "runtime", image: runtimeImage, imagePullPolicy: "IfNotPresent",
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
        volumeMounts: [{ name: "runtime", mountPath: "/agyn" }] }],
      containers: [{ name: "diagnostic", image, imagePullPolicy: "Never",
        args: ["-test.run=^TestClaudeDiagnosticNative401$", "-test.v", "-test.timeout=100s"],
        securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "2", memory: "2Gi" } },
        env: [{ name: "AGYN_CLAUDE_DIAGNOSTIC_TEST", value: "true" }, { name: "AGYN_CLAUDE_DIAGNOSTIC_BINARY", value: "/agyn/bin/claude" },
          { name: "LD_LIBRARY_PATH", value: "/agyn/bin/lib" }, { name: "TMPDIR", value: "/tmp" }],
        volumeMounts: [{ name: "runtime", mountPath: "/agyn", readOnly: true }, { name: "temporary", mountPath: "/tmp" }] }],
      volumes: [{ name: "runtime", emptyDir: { sizeLimit: "1Gi" } }, { name: "temporary", emptyDir: { sizeLimit: "256Mi" } }]
    }
  } });
  evidence.podUid = pod.metadata.uid; save();
  console.log(JSON.stringify({ kind: "diagnostic.started", directory, name, uid: pod.metadata.uid }));
  let finished = false;
  for (let i = 0; i < 180; i++) {
    const current = await core.readNamespacedPod({ namespace, name });
    assert.equal(current.metadata.uid, pod.metadata.uid, "Pod ownership changed");
    evidence.podStatus = current.status; save();
    if (["Succeeded", "Failed"].includes(current.status.phase)) {
      evidence.output = await core.readNamespacedPodLog({ namespace, name, container: "diagnostic" });
      assert.equal(current.status.phase, "Succeeded", "native diagnostic failed; inspect the private evidence");
      assert(evidence.output.includes("--- PASS: TestClaudeDiagnosticNative401") && evidence.output.includes("api_status=401"));
      finished = true; break;
    }
    await delay(1000);
  }
  assert(finished, "native diagnostic timed out");
  const currentPolicy = await networking.readNamespacedNetworkPolicy({ namespace, name });
  assert.equal(currentPolicy.metadata.uid, policy.metadata.uid);
  assert.deepEqual(currentPolicy.spec, policy.spec, "diagnostic isolation policy changed");
  evidence.passed = true;
} catch (error) {
  evidence.error = error.message; throw error;
} finally {
  try {
    assert(!evidence.podCreateAttempted || pod, "Pod create acknowledgement missing; retain isolation and reconcile by recorded name");
    assert(!evidence.policyCreateAttempted || policy, "policy create acknowledgement missing; reconcile by recorded name");
    if (pod) {
      await core.deleteNamespacedPod({ namespace, name, body: { preconditions: { uid: pod.metadata.uid } } });
      await removed(() => core.readNamespacedPod({ namespace, name }));
    }
    // Keep the deny policy if compute removal cannot be confirmed.
    if (policy) {
      await networking.deleteNamespacedNetworkPolicy({ namespace, name, body: { preconditions: { uid: policy.metadata.uid } } });
      await removed(() => networking.readNamespacedNetworkPolicy({ namespace, name }));
    }
    const after = (await core.listNamespacedPersistentVolumeClaim({ namespace })).items;
    for (const claim of claims) {
      const current = after.find(pvc => pvc.metadata.name === claim.name);
      assert.equal(current?.metadata.uid, claim.uid); assert.equal(current.status.phase, claim.phase);
    }
    evidence.cleanedUp = true;
  } finally { evidence.finishedAt = new Date().toISOString(); save(); }
  console.log(JSON.stringify({ kind: "diagnostic.finished", directory, passed: evidence.passed, cleanedUp: evidence.cleanedUp, unchangedClaims: claims.length }));
}
