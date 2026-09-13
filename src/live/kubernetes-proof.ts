// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only acceptance checks. The A2A service never receives kubeconfig access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function assertReviewedDeployment(deployment: any, name: string, image: string): void {
  assert(image, `explicit reviewed ${name} image is required`);
  assert.equal(deployment.metadata?.name, name);
  assert(deployment.metadata.uid && Number.isInteger(deployment.metadata.generation) && !deployment.metadata.deletionTimestamp);
  assert.equal(deployment.spec?.template?.spec?.containers?.find((container: any) => container.name === name)?.image, image,
    `reviewed ${name} image is not deployed`);
  const replicas = deployment.spec.replicas ?? 1;
  assert(Number.isInteger(replicas) && replicas > 0);
  assert.equal(deployment.status?.observedGeneration, deployment.metadata.generation, `${name} generation is not observed`);
  for (const field of ["replicas", "updatedReplicas", "readyReplicas", "availableReplicas"]) {
    assert.equal(deployment.status?.[field], replicas, `${name} rollout is incomplete (${field})`);
  }
}

export function instancePods(kubeconfig: string, instanceId: string): any[] {
  const pods = JSON.parse(execFileSync("kubectl", ["--kubeconfig", kubeconfig, "get", "pods", "-n", "agyn-workloads", "-o", "json"], { encoding: "utf8", timeout: 10_000 }));
  return pods.items.filter((pod: any) => pod.spec.containers.some((container: any) => container.env?.some(
    (entry: any) => entry.name === "AGENT_INSTANCE_ID" && entry.value === instanceId)));
}

export function assertInstanceAbsent(kubeconfig: string, instanceId: string): void {
  assert.equal(instancePods(kubeconfig, instanceId).length, 0, "A2A settled before all instance pods disappeared");
}

export async function inspectRetainedCancellationPvc(kubeconfig: string, image: string, pvc: string): Promise<any> {
  const script = `const fs=require("node:fs");
    const read=()=>({marker:fs.readFileSync("/workspace/reporting-proof.txt","utf8"),
      heartbeat:fs.readFileSync("/workspace/cancel-heartbeat.txt","utf8"),
      signals:fs.readFileSync("/workspace/cancel-signals.txt","utf8"),
      lateSideEffect:fs.existsSync("/workspace/cancel-late.txt")});
    const first=read();setTimeout(()=>console.log(JSON.stringify({first,second:read()})),1500);`;
  return inspectRetainedPvc(kubeconfig, image, pvc, "cancellation", script);
}

export async function inspectRetainedStartupFailurePvc(kubeconfig: string, image: string, pvc: string): Promise<any> {
  const script = `const fs=require("node:fs");console.log(JSON.stringify({
    record:JSON.parse(fs.readFileSync("/workspace/startup-failure.json","utf8")),
    cliStarted:fs.existsSync("/workspace/startup-cli-started.jsonl"),
    nativeMapping:fs.existsSync("/workspace/.codex/agyn/thread-mapping"),
    nativeSessions:fs.existsSync("/workspace/.codex/sessions") }));`;
  return inspectRetainedPvc(kubeconfig, image, pvc, "startup-failure", script);
}

async function inspectRetainedPvc(kubeconfig: string, image: string, pvc: string, purpose: string, script: string): Promise<any> {
  assert(/^[a-z0-9][a-z0-9.-]{0,252}$/.test(pvc), "invalid fixture PVC name");
  assert(/@sha256:[a-f0-9]{64}$/.test(image), "inspector image must be digest-pinned");
  const name = `a2a-${purpose === "cancellation" ? "cancel" : "startup"}-inspect-${randomUUID().slice(0, 8)}`;
  const args = ["--kubeconfig", kubeconfig, "-n", "agyn-workloads"];
  const pod = { apiVersion: "v1", kind: "Pod", metadata: { name, labels: { "a2a-lab-proof": purpose } }, spec: {
    restartPolicy: "Never", automountServiceAccountToken: false, activeDeadlineSeconds: 45,
    securityContext: { seccompProfile: { type: "RuntimeDefault" } },
    containers: [{ name: "inspect", image, imagePullPolicy: "IfNotPresent", command: ["node", "-e", script],
      securityContext: { runAsUser: 0, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "100m", memory: "96Mi" } },
      volumeMounts: [{ name: "workspace", mountPath: "/workspace", readOnly: true }] }],
    volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: pvc, readOnly: true } }]
  } };
  const created = JSON.parse(execFileSync("kubectl", [...args, "create", "-f", "-", "-o", "json"], { input: JSON.stringify(pod), encoding: "utf8", timeout: 15_000 }));
  try {
    for (let attempt = 0; attempt < 45; attempt++) {
      const current = JSON.parse(execFileSync("kubectl", [...args, "get", "pod", name, "-o", "json"], { encoding: "utf8", timeout: 10_000 }));
      assert.equal(current.metadata.uid, created.metadata.uid, "inspector ownership changed");
      if (current.status.phase === "Succeeded") {
        return JSON.parse(execFileSync("kubectl", [...args, "logs", name, "-c", "inspect"], { encoding: "utf8", timeout: 10_000 }));
      }
      if (current.status.phase === "Failed") {
        const logs = execFileSync("kubectl", [...args, "logs", name, "-c", "inspect", "--tail=30"], { encoding: "utf8", timeout: 10_000 });
        throw new Error(`read-only PVC inspector failed: ${logs.slice(0, 4000)}`);
      }
      await delay(1000);
    }
    throw new Error("read-only PVC inspector timed out");
  } finally {
    const current = JSON.parse(execFileSync("kubectl", [...args, "get", "pod", name, "-o", "json"], { encoding: "utf8", timeout: 10_000 }));
    assert.equal(current.metadata.uid, created.metadata.uid, "refusing to delete a replaced inspector");
    execFileSync("kubectl", [...args, "delete", "pod", name, "--wait=true", "--timeout=30s"], { encoding: "utf8", timeout: 35_000 });
  }
}
