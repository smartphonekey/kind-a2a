// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudflareManifests, cloudflareCidrs } from './cloudflare-manifests.mjs';
import { asKubernetesClientObject } from './k8s-manifests.mjs';

const production = { environment: 'production', nodeName: 'a2a-hz-01' };

test('Tunnel manifests: isolated connectors, no host/platform credentials, explicit image and bounded resources', () => {
  const objects = cloudflareManifests(production);
  for (const item of objects) asKubernetesClientObject(item);
  assert(!objects.some(x => ['Secret', 'PersistentVolumeClaim', 'Service'].includes(x.kind)));
  const deployment = objects.find(x => x.kind === 'Deployment');
  assert.equal(deployment.metadata.namespace, 'aira-a2a-edge');
  assert.equal(deployment.spec.replicas, 2);
  const spec = deployment.spec.template.spec, container = spec.containers[0];
  assert.deepEqual(spec.nodeSelector, { 'kubernetes.io/hostname': 'a2a-hz-01' });
  assert.equal(objects.find(x => x.kind === 'Namespace').metadata.labels['pod-security.kubernetes.io/enforce-version'], 'v1.35');
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.match(container.image, /@sha256:[a-f0-9]{64}$/);
  assert(container.args.includes('--token-file'));
  assert.equal(spec.volumes.length, 1);
  assert.equal(spec.volumes[0].secret.secretName, 'kind-a2a-tunnel-token');
  assert.throws(() => cloudflareManifests({ ...production, image: 'cloudflare/cloudflared:latest' }), /digest-pinned/);
});

test('Tunnel network: only connector-to-app ingress, public Cloudflare certificates and bounded tunnel egress', () => {
  const objects = cloudflareManifests(production);
  const app = objects.find(x => x.kind === 'NetworkPolicy' && x.metadata.namespace === 'aira-a2a');
  assert.deepEqual(app.spec.ingress[0].from, [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'aira-a2a-edge' } },
    podSelector: { matchLabels: { 'app.kubernetes.io/name': 'kind-a2a-tunnel', 'app.kubernetes.io/part-of': 'aira-a2a' } },
  }]);
  assert.deepEqual(app.spec.ingress[0].ports, [{ protocol: 'TCP', port: 8080 }]);
  assert.deepEqual(app.spec.egress[0].ports, [{ protocol: 'TCP', port: 443 }]);
  assert.deepEqual(app.spec.egress[0].to.map(x => x.ipBlock.cidr), cloudflareCidrs);
  const edge = objects.find(x => x.kind === 'NetworkPolicy' && x.metadata.namespace === 'aira-a2a-edge');
  assert.deepEqual(edge.spec.ingress, []);
  assert(!JSON.stringify(objects).includes('0.0.0.0/0'));
  assert(!JSON.stringify(objects).includes('Unconfined'));
});

test('Tunnel manifests: no implicit environment or production node and no test connectors', () => {
  assert.throws(() => cloudflareManifests(), /explicit test or production environment/);
  assert.throws(() => cloudflareManifests({ environment: 'prod' }), /explicit test or production environment/);
  for (const nodeName of [undefined, '', 'node/name', 'NODE', 'a'.repeat(254)]) {
    assert.throws(() => cloudflareManifests({ environment: 'production', nodeName }), /explicit production node/);
  }
  const objects = cloudflareManifests({ environment: 'test' });
  for (const item of objects) asKubernetesClientObject(item);
  assert.equal(objects.find(x => x.kind === 'Deployment').spec.replicas, 0);
  assert(!objects.some(x => x.kind === 'Secret'));
});
