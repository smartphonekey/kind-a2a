// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ObjectSerializer } from '@kubernetes/client-node/dist/serializer.js';
import { serviceManifests, asKubernetesClientObject } from './k8s-manifests.mjs';

const options = { image: `docker.io/library/a2a@sha256:${'a'.repeat(64)}`, ingressIp: '10.43.1.2',
  gatewayHost: 'gateway.agyn.dev', terminalHost: 'terminal.agyn.dev', agentIds: ['00000000-0000-0000-0000-000000000001'] };
test('single durable writer, nonroot bounded containers, no cluster credentials or public ingress', () => {
  const all = serviceManifests(options);
  const find = kind => all.find(x => x.kind === kind);
  assert.equal(find('Namespace').metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted');
  assert.equal(find('Deployment').spec.replicas, 1);
  assert.equal(find('Deployment').spec.strategy.type, 'Recreate');
  assert.equal(find('Service').spec.type, 'ClusterIP');
  assert.equal(find('PersistentVolumeClaim').spec.resources.requests.storage, '1Gi');
  assert(!all.some(x => /Role|Ingress|Secret/.test(x.kind)));
  const pod = find('Deployment').spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsUser, 1000);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  for (const c of [...pod.containers, ...pod.initContainers]) {
    assert.equal(c.image, options.image);
    assert(c.securityContext.readOnlyRootFilesystem);
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(c.securityContext.capabilities.drop, ['ALL']);
    for (const part of ['requests', 'limits']) for (const resource of ['cpu', 'memory']) assert(c.resources[part][resource]);
  }
  assert(pod.containers[0].volumeMounts.find(x => x.name === 'private').readOnly);
  assert(pod.initContainers[0].args[0].includes('mode:0o600'));
  assert.equal(pod.containers[0].env.find(x => x.name === 'AGYN_TOKEN').valueFrom.secretKeyRef.key, 'AGYN_TOKEN');
  const policies = all.filter(x => x.kind === 'NetworkPolicy');
  assert.equal(policies.length, 2);
  assert.deepEqual(policies[1].spec.podSelector.matchExpressions[0].values, options.agentIds);
  assert.deepEqual(policies[1].spec.egress[0].ports, [{ protocol: 'TCP', port: 8080 }]);
  assert(policies[0].spec.egress.every(x => x.to.every(peer => peer.namespaceSelector && peer.podSelector)));
  assert(!JSON.stringify(all).includes('0.0.0.0/0'));
});
test('rejects unpinned images, wildcard agents and invalid destinations', () => {
  for (const change of [{ image: 'a2a:latest' }, { ingressIp: 'not-an-ip' }, { gatewayHost: '*.agyn.dev' },
    { agentIds: [] }, { agentIds: ['*'] }, { agentIds: [options.agentIds[0], options.agentIds[0]] }]) {
    assert.throws(() => serviceManifests({ ...options, ...change }));
  }
});
test('client conversion preserves all wire fields, especially ingress source restrictions', () => {
  for (const manifest of serviceManifests(options)) {
    const model = asKubernetesClientObject(manifest);
    const wire = JSON.parse(JSON.stringify(ObjectSerializer.serialize(model, `V1${manifest.kind}`, '')));
    assert.deepEqual(wire, manifest);
    if (manifest.kind === 'NetworkPolicy' && manifest.spec.ingress) {
      assert.deepEqual(wire.spec.ingress[0].from[0].podSelector.matchExpressions[0].values, options.agentIds);
      assert.equal(wire.spec.ingress[0].from[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'agyn-workloads');
    }
  }
  assert.throws(() => asKubernetesClientObject({ apiVersion: 'v1', kind: 'Unknown' }));
  assert.throws(() => asKubernetesClientObject({ apiVersion: 'v1', kind: 'Namespace', unexpected: true }));
});
test('container build excludes operator state and uses the patched pinned Node runtime', () => {
  const ignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.equal(ignore.split('\n')[1], '**');
  assert(!ignore.includes('!.state') && !ignore.includes('!.git') && !ignore.includes('!node_modules'));
  for (const dir of ['web', 'scripts', 'ops']) assert(ignore.includes(`!${dir}/\n${dir}/**\n`));
  const file = readFileSync(new URL('../ops/Dockerfile.a2a-service', import.meta.url), 'utf8');
  assert.equal((file.match(/FROM node:24\.21\.0-bookworm-slim@sha256:[a-f0-9]{64}/g) ?? []).length, 2);
  assert(file.includes('USER 1000:1000'));
});

test('the default ingress topology is byte-identical to the original factory output', () => {
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const expected = '83088ab36797defb9d7db4290c7d56946a9d0c9b704d240e8201d2c0761230b8';
  assert.equal(digest(serviceManifests(options)), expected);
  assert.equal(digest(serviceManifests({ ...options, topology: 'ingress' })), expected);
  assert.throws(() => serviceManifests({ ...options, topology: 'mesh' }), /unknown deployment topology/);
});

const platformLabels = name => ({ 'app.kubernetes.io/name': name, 'app.kubernetes.io/instance': 'agyn-platform' });
const native = { topology: 'native', image: options.image, agentIds: options.agentIds, storageClassName: 'retained-local',
  nodeName: 'node-a', platform: { namespace: 'agyn-platform',
    gateway: { service: 'gateway', port: 8080, podLabels: platformLabels('gateway') },
    terminalProxy: { service: 'terminal-proxy', port: 8080, podLabels: platformLabels('terminal-proxy') } } };

test('native topology dials explicit in-cluster HTTP Services with no ingress, host aliases or mesh', () => {
  const all = serviceManifests(native);
  const find = kind => all.find(x => x.kind === kind);
  const text = JSON.stringify(all);
  assert.equal(find('Namespace').metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted');
  assert.equal(find('Namespace').metadata.labels['pod-security.kubernetes.io/enforce-version'], 'v1.35');
  assert.equal(find('PersistentVolumeClaim').spec.storageClassName, 'retained-local');
  assert.equal(find('PersistentVolumeClaim').spec.resources.requests.storage, find('ResourceQuota').spec.hard['requests.storage']);
  for (const absent of ['hostAliases', 'istio', 'NODE_EXTRA_CA_CERTS', 'ca.pem', '0.0.0.0/0', ':443', 'https:']) assert(!text.includes(absent), absent);
  assert(!all.some(x => /Role|Ingress|Secret|ConfigMap/.test(x.kind)));
  const pod = find('Deployment').spec.template.spec;
  assert.deepEqual(pod.nodeSelector, { 'kubernetes.io/hostname': 'node-a' });
  assert.equal(find('Deployment').spec.strategy.type, 'Recreate');
  const env = Object.fromEntries(pod.containers[0].env.map(x => [x.name, x.value ?? x.valueFrom.secretKeyRef]));
  assert.equal(env.AGYN_GATEWAY_URL, 'http://gateway.agyn-platform.svc.cluster.local:8080');
  for (const key of ['AGYN_TOKEN', 'AGYN_ORGANIZATION_ID', 'AGYN_IDENTITY_ID']) assert.deepEqual(env[key], { name: 'aira-a2a-config', key });
  assert.equal(env.A2A_ALLOW_INSECURE_LOCAL_REPORTING, 'true');
  assert.deepEqual(pod.volumes.find(x => x.name === 'configuration').secret.items.map(x => x.key), ['service.json', 'credentials.json']);
  assert(pod.initContainers[0].args[0].includes("['service.json','credentials.json']"));
  for (const c of [...pod.containers, ...pod.initContainers]) {
    assert(c.securityContext.readOnlyRootFilesystem);
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(c.securityContext.capabilities.drop, ['ALL']);
  }
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(pod.automountServiceAccountToken, false);
  for (const manifest of all) asKubernetesClientObject(manifest);
});

test('native egress reaches only DNS and the exact platform gateway and terminal proxy pods', () => {
  const all = serviceManifests(native);
  const [app, reporting] = all.filter(x => x.kind === 'NetworkPolicy');
  assert.equal(app.metadata.namespace, 'aira-a2a');
  assert.deepEqual(app.spec.ingress, serviceManifests(options).find(x => x.kind === 'NetworkPolicy').spec.ingress);
  assert.deepEqual(app.spec.egress.slice(1), ['gateway', 'terminal-proxy'].map(name => ({
    to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'agyn-platform' } }, podSelector: { matchLabels: platformLabels(name) } }],
    ports: [{ protocol: 'TCP', port: 8080 }] })));
  assert(app.spec.egress.every(rule => rule.to.every(peer => peer.namespaceSelector && peer.podSelector && !peer.ipBlock)));
  assert.equal(reporting.metadata.namespace, 'agyn-workloads');
  assert.deepEqual(reporting.spec.podSelector.matchExpressions[0].values, options.agentIds);
  assert.deepEqual(reporting.spec.egress[0].ports, [{ protocol: 'TCP', port: 8080 }]);
});

test('native topology mounts a private CA only when explicitly requested', () => {
  const pod = serviceManifests({ ...native, caCertificate: true }).find(x => x.kind === 'Deployment').spec.template.spec;
  assert.deepEqual(pod.volumes.find(x => x.name === 'configuration').secret.items.map(x => x.key), ['service.json', 'credentials.json', 'ca.pem']);
  assert.equal(pod.containers[0].env.find(x => x.name === 'NODE_EXTRA_CA_CERTS').value, '/run/a2a/private/ca.pem');
  assert(pod.initContainers[0].args[0].includes("['service.json','credentials.json','ca.pem']"));
  assert.equal(serviceManifests({ ...native, nodeName: undefined }).find(x => x.kind === 'Deployment').spec.template.spec.nodeSelector, undefined);
});

test('native topology names a private registry pull Secret only when one is given', () => {
  const deployment = manifests => manifests.find(x => x.kind === 'Deployment');
  assert.equal(deployment(serviceManifests(native)).spec.template.spec.imagePullSecrets, undefined);
  const pulled = serviceManifests({ ...native, imagePullSecret: 'registry-pull' });
  assert.deepEqual(deployment(pulled).spec.template.spec.imagePullSecrets, [{ name: 'registry-pull' }]);
  for (const manifest of pulled) asKubernetesClientObject(manifest);
  assert(!pulled.some(x => x.kind === 'Secret'));
  assert.throws(() => serviceManifests({ ...native, imagePullSecret: 'Registry Pull' }), /pull Secret/);
});

test('native topology rejects implicit storage, platform targets and selectors', () => {
  const target = (key, change) => ({ ...native, platform: { ...native.platform, [key]: { ...native.platform[key], ...change } } });
  for (const change of [{ storageClassName: undefined }, { storageClassName: 'Local Path' }, { nodeName: 'NODE' }, { caCertificate: 'yes' },
    { platform: undefined }, { platform: { ...native.platform, namespace: '' } }, { platform: { ...native.platform, namespace: 'aira-a2a' } },
    target('gateway', { service: 'gateway.agyn-platform' }), target('gateway', { port: 0 }), target('gateway', { port: '8080' }),
    target('gateway', { podLabels: {} }), target('gateway', { podLabels: { 'app.kubernetes.io/name': '*' } }),
    target('gateway', { url: 'http://elsewhere:8080' }), target('terminalProxy', { podLabels: platformLabels('gateway') }),
    { image: 'a2a:latest' }, { agentIds: [] }, { ingressIp: '10.43.1.2' }]) {
    assert.throws(() => serviceManifests({ ...native, ...change }), JSON.stringify(change));
  }
});
