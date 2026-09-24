// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
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
