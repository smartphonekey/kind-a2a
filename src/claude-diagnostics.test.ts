// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/agyn-claude-diagnostics.mjs", import.meta.url));
const image = `fixture@sha256:${"a".repeat(64)}`;
for (const mode of ["success", "busy", "missing-image", "native-failure", "pod-ack-lost", "policy-ack-lost", "pod-identity-changed", "policy-identity-changed", "claim-identity-changed"]) {
  test(`native diagnostic operator: ${mode}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "a2a-diagnostic-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const pods = "/api/v1/namespaces/agyn-workloads/pods";
    const policies = "/apis/networking.k8s.io/v1/namespaces/agyn-workloads/networkpolicies";
    const calls: { method: string; path: string; body: any }[] = [];
    let pod: any, policy: any, claimReads = 0;
    const respond = async (request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url!, "http://fixture").pathname;
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const method = request.method!; calls.push({ method, path, body });
      const send = (status: number, value: any) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const failure = (status: number) => send(status, { apiVersion: "v1", kind: "Status", status: "Failure", code: status, reason: "fixture" });
      if (path === pods && method === "GET") return send(200, { items: mode === "busy" ? [{ metadata: { name: "user-workload" } }] : [] });
      if (path.endsWith("/persistentvolumeclaims") && method === "GET") {
        claimReads++;
        return send(200, { items: [{ metadata: { name: "user-claim", uid: mode === "claim-identity-changed" && claimReads > 1 ? "foreign-claim" : "original-claim" }, status: { phase: "Bound" } }] });
      }
      if (path === policies && method === "POST") {
        policy = { ...body, metadata: { ...body.metadata, uid: "original-policy" } };
        return mode === "policy-ack-lost" ? failure(500) : send(201, policy);
      }
      if (path === pods && method === "POST") {
        pod = { ...body, metadata: { ...body.metadata, uid: "original-pod" }, status: { phase: mode === "native-failure" ? "Failed" : "Succeeded" } };
        return mode === "pod-ack-lost" ? failure(500) : send(201, pod);
      }
      if (path === `${pods}/${pod?.metadata.name}/log` && method === "GET") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(mode === "native-failure" ? "--- FAIL: TestClaudeDiagnosticNative401" : "--- PASS: TestClaudeDiagnosticNative401\napi_status=401\nPASS\n"); return;
      }
      if (path.startsWith(`${pods}/`)) {
        if (!pod) return failure(404);
        if (mode === "pod-identity-changed") pod.metadata.uid = "foreign-pod";
        if (method === "GET") return send(200, pod);
        if (method === "DELETE") {
          if (body.preconditions.uid !== pod.metadata.uid) return failure(409);
          const deleted = pod; pod = undefined; return send(200, deleted);
        }
      }
      if (path.startsWith(`${policies}/`)) {
        if (!policy) return failure(404);
        if (mode === "policy-identity-changed") policy.metadata.uid = "foreign-policy";
        if (method === "GET") return send(200, policy);
        if (method === "DELETE") {
          if (body.preconditions.uid !== policy.metadata.uid) return failure(409);
          const deleted = policy; policy = undefined; return send(200, deleted);
        }
      }
      failure(400);
    };
    const server = createServer((request, response) => { void respond(request, response).catch(() => { response.writeHead(500); response.end(); }); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address(); assert(address && typeof address !== "string");
    const kubeconfig = join(directory, "kubeconfig.json");
    writeFileSync(kubeconfig, JSON.stringify({ apiVersion: "v1", kind: "Config", clusters: [{ name: "fixture", cluster: { server: `http://127.0.0.1:${address.port}`, "insecure-skip-tls-verify": true } }],
      users: [{ name: "fixture", user: {} }], contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }], "current-context": "fixture" }));
    const child = spawn(process.execPath, [script], { cwd: directory, timeout: 15_000, env: { ...process.env,
      AGYN_LIVE_ACCEPTANCE: "trusted-local", AGYN_KUBECONFIG: kubeconfig,
      AGYN_CLAUDE_DIAGNOSTIC_IMAGE: mode === "missing-image" ? "" : image, AGYN_CLAUDE_DIAGNOSTIC_RUNTIME_IMAGE: image } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    const [code, signal] = await once(child, "close"); assert.equal(signal, null, stderr);
    assert.equal(code === 0, mode === "success", stdout + stderr);
    for (const call of calls.filter(call => call.method === "DELETE")) {
      assert.deepEqual(call.body.preconditions, { uid: call.path.startsWith(pods) ? "original-pod" : "original-policy" });
    }
    assert(!calls.some(call => call.path.includes("persistentvolumeclaims") && call.method !== "GET"));
    if (["busy", "missing-image"].includes(mode)) {
      assert(!calls.some(call => call.method !== "GET")); assert(!existsSync(join(directory, ".state")));
      if (mode === "busy") { assert.equal(calls.length, 1); assert.match(stderr, /workload namespace must be idle/); }
      else { assert.equal(calls.length, 0); assert.match(stderr, /reviewed digest-pinned images are required/); }
      return;
    }
    const evidenceDirectory = join(directory, ".state", readdirSync(join(directory, ".state"))[0]);
    const evidence = JSON.parse(readFileSync(join(evidenceDirectory, "evidence.json"), "utf8"));
    const uncertain = ["pod-ack-lost", "policy-ack-lost", "pod-identity-changed", "policy-identity-changed"].includes(mode);
    assert.equal(evidence.cleanedUp, !uncertain && mode !== "claim-identity-changed");
    if (uncertain) assert(policy, "isolation was removed while creation/ownership/removal remained uncertain");
    else { assert.equal(pod, undefined); assert.equal(policy, undefined); }
    if (mode.endsWith("ack-lost")) assert(!calls.some(call => call.method === "DELETE"));
    if (mode === "native-failure") assert.equal(evidence.passed, false);
    if (mode === "success") {
      const created = calls.find(call => call.path === pods && call.method === "POST")!.body.spec;
      assert.equal(created.automountServiceAccountToken, false);
      assert(created.volumes.every((volume: any) => volume.emptyDir && !volume.persistentVolumeClaim && !volume.hostPath));
      assert.equal(created.securityContext.seccompProfile.type, "RuntimeDefault");
      assert.equal(created.containers[0].securityContext.runAsNonRoot, true);
      assert.equal(created.containers[0].securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(created.containers[0].securityContext.capabilities.drop, ["ALL"]);
    }
  });
}
