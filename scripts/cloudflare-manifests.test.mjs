// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudflareManifests, cloudflareCidrs } from './cloudflare-manifests.mjs';
import { asKubernetesClientObject } from './k8s-manifests.mjs';

test('Tunnel manifests: isolated connectors, no host/platform credentials, explicit image and bounded resources', () => {
  const objects = cloudflareManifests();
  for (const item of objects) asKubernetesClientObject(item);
  assert(!objects.some(x => ['Secret', 'PersistentVolumeClaim', 'Service'].includes(x.kind)));
  const deployment = objects.find(x => x.kind === 'Deployment');
  assert.equal(deployment.metadata.namespace, 'aira-a2a-edge');
  assert.equal(deployment.spec.replicas, 2);
  const spec = deployment.spec.template.spec, container = spec.containers[0];
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.match(container.image, /@sha256:[a-f0-9]{64}$/);
  assert(container.args.includes('--token-file'));
  assert.equal(spec.volumes.length, 1);
  assert.equal(spec.volumes[0].secret.secretName, 'kind-a2a-tunnel-token');
  assert.throws(() => cloudflareManifests({ image: 'cloudflare/cloudflared:latest' }));
});

test('Tunnel network: only connector-to-app ingress, public Cloudflare certificates and bounded tunnel egress', () => {
  const objects = cloudflareManifests();
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
