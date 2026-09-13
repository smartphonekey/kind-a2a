// SPDX-License-Identifier: AGPL-3.0-only
// Operator-only probes; the A2A service has no Kubernetes credentials.
import assert from "node:assert/strict";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { type KubernetesObject, type KubernetesObjectApi, loadAllYaml } from "@kubernetes/client-node";

export const proofLabel = "a2a-lab.agyn.dev/network-proof";
export const roleLabel = "a2a-lab.agyn.dev/network-role";
export const managedLabel = "agyn.dev/managed-by";
export const namespace = "agyn-workloads";
export const tcpPort = 19081;
export const udpPort = 19082;

export type Fixture = KubernetesObject & {
  metadata: { name: string; namespace: string; labels: Record<string, string>; uid?: string };
  spec?: any;
  status?: any;
};

export function scopedIngressPolicy(rendered: string, run: string): Fixture {
  const documents = loadAllYaml(rendered);
  assert.equal(documents.length, 1, "render only the ingress policy, not the entire chart");
  const policy = documents[0] as Fixture;
  assert.equal(policy.apiVersion, "networking.k8s.io/v1");
  assert.equal(policy.kind, "NetworkPolicy");
  assert.equal(policy.metadata?.namespace, namespace);
  assert.deepEqual(policy.spec?.policyTypes, ["Ingress"]);
  assert.deepEqual(policy.spec?.ingress, []);
  assert.equal(policy.spec?.egress, undefined);
  assert.deepEqual(policy.spec?.podSelector, { matchLabels: { [managedLabel]: "agents-orchestrator" } });
  return { apiVersion: policy.apiVersion, kind: policy.kind,
    metadata: { name: `a2a-net-${run}`, namespace, labels: { [proofLabel]: run } },
    spec: { ...policy.spec, podSelector: { matchLabels: { ...policy.spec.podSelector.matchLabels, [proofLabel]: run } } } };
}

export function agentNetworkPolicies(rendered: string, run: string, agentId: string, reportingUrl: string): Fixture[] {
  assert(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(agentId), "an exact fixture agent UUID is required");
  const endpoint = new URL(reportingUrl);
  assert.equal(endpoint.protocol, "http:", "only the explicit trusted-local callback is supported here");
  assert.equal(isIP(endpoint.hostname), 4, "reporting callback must name an explicit IPv4 address");
  assert(endpoint.port && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  assert.equal(endpoint.pathname, "/reporting");
  const ingress = scopedIngressPolicy(rendered, run);
  const selector = { matchLabels: { [managedLabel]: "agents-orchestrator", "agent-id": agentId } };
  ingress.spec.podSelector = selector;
  const reporting: Fixture = { apiVersion: ingress.apiVersion, kind: "NetworkPolicy",
    metadata: { name: `a2a-net-${run}-reporting`, namespace, labels: { [proofLabel]: run } }, spec: {
      podSelector: structuredClone(selector), policyTypes: ["Egress"], egress: [{
        to: [{ ipBlock: { cidr: `${endpoint.hostname}/32` } }], ports: [{ protocol: "TCP", port: Number(endpoint.port) }]
      }]
    } };
  return [ingress, reporting];
}

export function assertPolicyUnchanged(current: Fixture, expected: Fixture): void {
  assert(expected.metadata.uid, "policy identity was not captured");
  assert.equal(current.metadata.uid, expected.metadata.uid, "live network policy was replaced");
  // SDK responses have generated model prototypes; compare Kubernetes wire data.
  assert.deepEqual(JSON.parse(JSON.stringify(current.spec)), JSON.parse(JSON.stringify(expected.spec)), "live network policy changed");
}

// Both listeners echo a fresh challenge, so a wrong endpoint cannot pass a probe.
const listener = `const net=require('node:net'),dgram=require('node:dgram');
const token=process.argv[1];
const reply=message=>JSON.stringify({nonce:JSON.parse(message).nonce,token})+'\\n';
net.createServer(socket=>{socket.setTimeout(3000,()=>socket.destroy());let data='';
  socket.on('error',()=>{});socket.on('data',chunk=>{data+=chunk;
    if(data.length>1024)return socket.destroy();if(!data.includes('\\n'))return;
    try{socket.end(reply(data));}catch{socket.destroy();}});
}).listen(${tcpPort},'0.0.0.0');
const udp=dgram.createSocket('udp4');udp.on('message',(message,remote)=>{
  if(message.length>1024)return;try{udp.send(reply(message),remote.port,remote.address);}catch{}
});udp.bind(${udpPort},'0.0.0.0');`;

export function probePod(run: string, role: string, image: string): Fixture {
  assert(/@sha256:[a-f0-9]{64}$/.test(image), "probe image must be digest-pinned");
  return { apiVersion: "v1", kind: "Pod", metadata: {
    name: `a2a-net-${run}-${role}`, namespace,
    labels: { [proofLabel]: run, [roleLabel]: role, ...(role === "control" ? {} : { [managedLabel]: "agents-orchestrator" }) }
  }, spec: {
    automountServiceAccountToken: false, restartPolicy: "Never", activeDeadlineSeconds: 600,
    terminationGracePeriodSeconds: 2, enableServiceLinks: false,
    securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
    containers: [{ name: "probe", image, imagePullPolicy: "IfNotPresent", command: ["node", "-e", listener, `${run}:${role}`],
      securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "200m", memory: "96Mi" } },
      readinessProbe: { tcpSocket: { port: tcpPort }, periodSeconds: 1 }
    }]
  } };
}

export function probeService(pod: Fixture): Fixture {
  return { apiVersion: "v1", kind: "Service", metadata: {
    name: pod.metadata.name, namespace: pod.metadata.namespace, labels: { ...pod.metadata.labels }
  }, spec: {
    type: "ClusterIP", selector: { [proofLabel]: pod.metadata.labels[proofLabel], [roleLabel]: pod.metadata.labels[roleLabel] },
    ports: [{ name: "tcp", port: tcpPort, targetPort: tcpPort, protocol: "TCP" },
      { name: "udp", port: udpPort, targetPort: udpPort, protocol: "UDP" }]
  } };
}

export interface ProbeInput { protocol: "tcp" | "udp"; host: string; port: number; token: string; timeoutMs?: number }
export interface ProbeResult { ok: boolean; error?: string; elapsedMs: number }

// Self-contained so exactly the same implementation runs in the test pod and unit tests.
export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
  const { randomUUID } = await import("node:crypto");
  const { isIP } = await import("node:net");
  if (!isIP(input.host) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 ||
    !["tcp", "udp"].includes(input.protocol)) throw new Error("invalid probe destination");
  const nonce = randomUUID();
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? 1500;
  const transport = input.protocol === "tcp" ? await import("node:net") : await import("node:dgram");
  return new Promise(resolve => {
    let finished = false;
    const socket: any = input.protocol === "tcp" ? new (transport as typeof import("node:net")).Socket() :
      (transport as typeof import("node:dgram")).createSocket("udp4");
    const finish = (ok: boolean, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (input.protocol === "tcp") socket.destroy(); else socket.close();
      resolve({ ok, ...(error ? { error } : {}), elapsedMs: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    const receive = (message: string) => {
      try {
        const result = JSON.parse(message);
        const ok = result.nonce === nonce && result.token === input.token;
        finish(ok, ok ? undefined : "unexpected_response");
      } catch { finish(false, "invalid_response"); }
    };
    socket.on("error", (error: NodeJS.ErrnoException) => finish(false, error.code ?? "socket_error"));
    const payload = `${JSON.stringify({ nonce })}\n`;
    if (input.protocol === "tcp") {
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 1024) finish(false, "oversized_response");
        else if (data.includes("\n")) receive(data);
      });
      socket.on("end", () => finish(false, "closed_without_response"));
      socket.connect(input.port, input.host, () => socket.write(payload));
    } else {
      socket.on("message", (message: Buffer, remote: { address: string; port: number }) => {
        if (remote.address === input.host && remote.port === input.port) receive(message.toString());
      });
      socket.send(payload, input.port, input.host);
    }
  });
}

export function probeProgram(input: ProbeInput): string[] {
  assert.equal(isIP(input.host), 4, "this acceptance fixture currently verifies IPv4 only");
  return ["node", "-e", `(${probeConnection.toString()})(JSON.parse(process.argv[1])).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;})`, JSON.stringify(input)];
}

export function assertProbe(result: ProbeResult, allowed: boolean, listener?: ProbeResult): void {
  assert.equal(typeof result.elapsedMs, "number");
  if (allowed) assert.equal(result.ok, true, `positive control failed: ${result.error}`);
  else {
    assert.equal(result.ok, false, "unexpected cross-pod connection succeeded");
    if (result.error === "ECONNREFUSED") {
      assert(listener, "connection refusal alone cannot distinguish policy rejection from a dead listener");
      assertProbe(listener, true);
      return;
    }
    assert(["timeout", "EHOSTUNREACH", "ENETUNREACH", "EACCES", "ETIMEDOUT"].includes(result.error ?? ""),
      `failure is not evidence of policy denial: ${result.error}`);
  }
}

type ObjectClient = Pick<KubernetesObjectApi, "create" | "read" | "delete">;
type RecordChange = (resources: Fixture[]) => void;
const isMissing = (error: unknown) => (error as { code?: number })?.code === 404;

export class NetworkFixtures {
  readonly resources: Fixture[] = [];
  constructor(private api: ObjectClient, private run: string, private record: RecordChange = () => {}) {}

  async create(spec: Fixture): Promise<Fixture> {
    assert(["Pod", "Service", "NetworkPolicy"].includes(spec.kind ?? ""));
    assert.equal(spec.metadata.namespace, namespace);
    assert.equal(spec.metadata.labels[proofLabel], this.run);
    assert(spec.metadata.name.startsWith(`a2a-net-${this.run}`));
    assert.equal(spec.metadata.uid, undefined);
    this.resources.push(structuredClone(spec));
    this.record(this.resources);
    let created: Fixture;
    try { created = await this.api.create(spec); } catch (error) {
      if ((error as { code?: number })?.code === 409) {
        this.resources.pop(); this.record(this.resources);
      }
      throw error;
    }
    assert(created.metadata.uid, "create response has no UID");
    this.resources[this.resources.length - 1].metadata.uid = created.metadata.uid;
    this.record(this.resources);
    return created;
  }

  async remove(spec: Fixture): Promise<void> {
    const owned = this.resources.find(item => item.kind === spec.kind && item.metadata.name === spec.metadata.name);
    assert(owned, "refusing to remove a resource not created by this run");
    let current: Fixture;
    try { current = await this.api.read<Fixture>(owned); } catch (error) { if (isMissing(error)) return; throw error; }
    assert.equal(current.metadata.labels?.[proofLabel], this.run, "fixture ownership changed");
    // A create can succeed even when its response is lost. The random run label
    // and exact name bind that pending creation before capturing its UID.
    if (owned.metadata.uid) assert.equal(current.metadata.uid, owned.metadata.uid, "fixture UID changed");
    assert(current.metadata.uid, "fixture has no UID");
    owned.metadata.uid = current.metadata.uid;
    this.record(this.resources);
    await this.api.delete(owned, undefined, undefined, undefined, undefined, undefined,
      { preconditions: { uid: owned.metadata.uid } });
    for (let attempt = 0; attempt < 40; attempt++) {
      try { current = await this.api.read<Fixture>(owned); } catch (error) { if (isMissing(error)) return; throw error; }
      assert.equal(current.metadata.uid, owned.metadata.uid, "fixture was replaced during removal");
      await delay(250);
    }
    throw new Error(`fixture removal timed out: ${owned.kind}/${owned.metadata.name}`);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const resource of [...this.resources].reverse()) {
      try { await this.remove(resource); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "network fixture cleanup incomplete; inspect evidence.json");
  }
}
