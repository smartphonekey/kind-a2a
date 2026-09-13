// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";
import test from "node:test";
import type { KubernetesObjectApi } from "@kubernetes/client-node";
import { agentNetworkPolicies, assertPolicyUnchanged, assertProbe, type Fixture, managedLabel, namespace, NetworkFixtures, probeConnection, probePod,
  probeProgram, probeService, proofLabel, scopedIngressPolicy } from "./live/network-proof.js";

const image = `node:22@sha256:${"a".repeat(64)}`;
const run = "test1234";
const rendered = JSON.stringify({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
  metadata: { name: "agent-workload-ingress", namespace }, spec: { podSelector: { matchLabels: { [managedLabel]: "agents-orchestrator" } },
    policyTypes: ["Ingress"], ingress: [] } });

test("network proof narrows the reviewed chart policy to its own fixtures", () => {
  const policy = scopedIngressPolicy(rendered, run);
  assert.deepEqual(policy.spec.podSelector.matchLabels, { [managedLabel]: "agents-orchestrator", [proofLabel]: run });
  assert.deepEqual(policy.spec.ingress, []);
  for (const changed of [
    (p: any) => { p.spec.ingress = [{}]; },
    (p: any) => { p.spec.egress = []; },
    (p: any) => { p.spec.policyTypes = ["Ingress", "Egress"]; },
    (p: any) => { p.spec.podSelector = {}; },
    (p: any) => { p.metadata.namespace = "default"; },
    (p: any) => { p.kind = "Secret"; }
  ]) {
    const policy = JSON.parse(rendered); changed(policy);
    assert.throws(() => scopedIngressPolicy(JSON.stringify(policy), run));
  }
  assert.throws(() => scopedIngressPolicy(`${rendered}\n---\n${rendered}`, run));
});

test("network probes are credential-free nonroot pods with bounded resources", () => {
  const pod = probePod(run, "a", image);
  assert.equal(pod.metadata.namespace, namespace);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  assert.equal(pod.spec.securityContext.runAsUser, 1000);
  assert.deepEqual(pod.spec.securityContext.seccompProfile, { type: "RuntimeDefault" });
  assert.equal(pod.spec.volumes, undefined);
  assert.equal(pod.spec.hostNetwork, undefined);
  assert.equal(pod.spec.hostPID, undefined);
  assert.equal(pod.spec.containers[0].env, undefined);
  assert.deepEqual(pod.spec.containers[0].securityContext, { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
  assert(pod.spec.activeDeadlineSeconds > 0 && pod.spec.containers[0].resources.limits.memory);
  assert.equal(probePod(run, "control", image).metadata.labels[managedLabel], undefined);
  assert.equal(probeService(pod).spec.type, "ClusterIP");
  assert.equal(probeService(pod).metadata.uid, undefined);
  const returnedPod = { ...pod, metadata: { ...pod.metadata, uid: "pod-uid", resourceVersion: "123", creationTimestamp: new Date("2026-09-13T00:00:00Z") } };
  assert.deepEqual(probeService(returnedPod).metadata, { name: pod.metadata.name, namespace, labels: pod.metadata.labels });
  assert.throws(() => probePod(run, "a", "node:latest"));
});

test("live agent policies bind one exact agent and one explicit reporting endpoint", () => {
  const agentId = "12345678-1234-1234-1234-123456789abc";
  const policies = agentNetworkPolicies(rendered, run, agentId, "http://192.168.5.2:49123/reporting");
  for (const policy of policies) assert.deepEqual(policy.spec.podSelector, {
    matchLabels: { [managedLabel]: "agents-orchestrator", "agent-id": agentId }
  });
  assert.deepEqual(policies[0].spec.ingress, []);
  assert.deepEqual(policies[1].spec.policyTypes, ["Egress"]);
  assert.deepEqual(policies[1].spec.egress, [{ to: [{ ipBlock: { cidr: "192.168.5.2/32" } }], ports: [{ protocol: "TCP", port: 49123 }] }]);
  for (const url of ["http://example.com:8080/reporting", "http://192.168.5.2/reporting", "http://192.168.5.2:8080/",
    "http://user:pass@192.168.5.2:8080/reporting", "http://192.168.5.2:8080/reporting?token=secret"]) {
    assert.throws(() => agentNetworkPolicies(rendered, run, agentId, url));
  }
  assert.throws(() => agentNetworkPolicies(rendered, run, "", "http://192.168.5.2:8080/reporting"));
});

test("live policy comparisons check UID and wire data, not SDK model prototypes", () => {
  const current = scopedIngressPolicy(rendered, run); current.metadata.uid = "policy-uid";
  const expected = structuredClone(current);
  expected.spec = Object.assign(Object.create({ sdkModel: true }), expected.spec);
  assertPolicyUnchanged(current, expected);
  expected.metadata.uid = "replacement";
  assert.throws(() => assertPolicyUnchanged(current, expected), /replaced/);
  expected.metadata.uid = current.metadata.uid;
  expected.spec.ingress = [{}];
  assert.throws(() => assertPolicyUnchanged(current, expected), /changed/);
});

test("TCP and UDP probe programs require the listener's nonce and identity", async () => {
  const tcp = createServer(socket => socket.on("data", data => socket.end(JSON.stringify({ nonce: JSON.parse(data.toString()).nonce, token: "target" }) + "\n")));
  const udp = createSocket("udp4");
  udp.on("message", (data, remote) => udp.send(JSON.stringify({ nonce: JSON.parse(data.toString()).nonce, token: "target" }), remote.port, remote.address));
  tcp.listen(0, "127.0.0.1"); await once(tcp, "listening");
  udp.bind(0, "127.0.0.1"); await once(udp, "listening");
  try {
    const tcpAddress = tcp.address(); assert(tcpAddress && typeof tcpAddress !== "string");
    for (const protocol of ["tcp", "udp"] as const) {
      const input = { protocol, host: "127.0.0.1", port: protocol === "tcp" ? tcpAddress.port : udp.address().port, token: "target" };
      assertProbe(await probeConnection(input), true);
      const command = probeProgram(input);
      const result = await promisify(execFile)(command[0], command.slice(1));
      assertProbe(JSON.parse(result.stdout), true);
      const wrong = await probeConnection({ ...input, token: "wrong" });
      assert.equal(wrong.error, "unexpected_response");
      assert.throws(() => assertProbe(wrong, false));
    }
    await assert.rejects(probeConnection({ protocol: "tcp", host: "invalid", port: 1, token: "target" }));
  } finally { udp.close(); await new Promise<void>(resolve => tcp.close(() => resolve())); }
});

test("timeouts are denial evidence; bad responses and dead listeners are not", async () => {
  const server = createSocket("udp4");
  server.bind(0, "127.0.0.1"); await once(server, "listening");
  try {
    const result = await probeConnection({ protocol: "udp", host: "127.0.0.1", port: server.address().port, token: "target", timeoutMs: 25 });
    assertProbe(result, false);
    assert.throws(() => assertProbe(result, true));
    for (const error of ["ECONNREFUSED", "invalid_response", "closed_without_response", "socket_error"]) {
      assert.throws(() => assertProbe({ ok: false, error, elapsedMs: 1 }, false));
    }
    const rejected = { ok: false, error: "ECONNREFUSED", elapsedMs: 1 };
    assertProbe(rejected, false, { ok: true, elapsedMs: 1 });
    assert.throws(() => assertProbe(rejected, false, { ok: false, error: "timeout", elapsedMs: 1 }));
    assert.throws(() => assertProbe({ ok: true, elapsedMs: 1 }, false));
  } finally { server.close(); }
});

function fakeApi() {
  const resources = new Map<string, Fixture>();
  const deletes: any[] = [];
  let loseCreateResponse = false;
  const key = (spec: Fixture) => `${spec.kind}/${spec.metadata.name}`;
  const api = {
    async create(spec: Fixture) {
      if (resources.has(key(spec))) throw { code: 409 };
      const created = { ...structuredClone(spec), metadata: { ...spec.metadata, uid: `uid-${resources.size}` } };
      resources.set(key(spec), created);
      if (loseCreateResponse) throw { code: 503 };
      return structuredClone(created);
    },
    async read(spec: Fixture) {
      const current = resources.get(key(spec));
      if (!current) throw { code: 404 };
      return structuredClone(current);
    },
    async delete(spec: Fixture, _a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, options: any) {
      assert.equal(options.preconditions.uid, resources.get(key(spec))?.metadata.uid);
      deletes.push({ spec, options }); resources.delete(key(spec));
    }
  } as unknown as Pick<KubernetesObjectApi, "create" | "read" | "delete">;
  return { api, resources, deletes, loseResponse: () => { loseCreateResponse = true; } };
}

test("fixture cleanup uses UID preconditions and refuses replacement or foreign resources", async () => {
  const fake = fakeApi(); const fixtures = new NetworkFixtures(fake.api, run);
  const a = await fixtures.create(probePod(run, "a", image));
  const b = await fixtures.create(probePod(run, "b", image));
  const changed = fake.resources.get(`Pod/${a.metadata.name}`)!; changed.metadata.uid = "someone-else";
  await assert.rejects(fixtures.close(), /cleanup incomplete/);
  assert.equal(fake.deletes.length, 1); assert.equal(fake.deletes[0].spec.metadata.name, b.metadata.name);
  assert(fake.resources.has(`Pod/${a.metadata.name}`));
  await assert.rejects(fixtures.remove(probePod("other123", "a", image)), /not created/);
  await assert.rejects(fixtures.create({ ...probePod(run, "a", image), kind: "PersistentVolumeClaim" }));
  const foreign = probePod(run, "a", image); foreign.metadata.namespace = "default";
  await assert.rejects(fixtures.create(foreign));
});

test("lost create responses recover only owned fixtures; conflicts are never adopted", async () => {
  const fake = fakeApi(); const fixtures = new NetworkFixtures(fake.api, run);
  const pod = probePod(run, "a", image);
  fake.loseResponse(); await assert.rejects(fixtures.create(pod));
  assert.equal(fake.resources.size, 1);
  await fixtures.close(); assert.equal(fake.resources.size, 0);

  const conflict = fakeApi(); conflict.resources.set(`Pod/${pod.metadata.name}`, pod);
  const conflicting = new NetworkFixtures(conflict.api, run);
  await assert.rejects(conflicting.create(pod));
  await conflicting.close(); assert.equal(conflict.deletes.length, 0);
});
