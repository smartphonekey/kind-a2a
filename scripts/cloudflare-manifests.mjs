// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dedicated, unprivileged Tunnel connectors and additive app network rules.
 * @module
 * @remarks These resources never replace the app Deployment, Secret or PVC.
 * The caller creates the connector-only token Secret out of band. The HTTP
 * origin hop is cluster HTTP, not end-to-end TLS or hostile-code isolation.
 * Test deployments stay scaled to zero; production requires an explicit node
 * so applying these manifests to the workstation cannot expose it by accident.
 * @see infra/cloudflare/main.tf
 * @see scripts/cloudflare-manifests.test.mjs
 */
import assert from 'node:assert/strict';

export const cloudflaredImage = 'docker.io/cloudflare/cloudflared@sha256:2fa795d0271a71c133a8f17c19a2a625e1976ad716329e0e61789f9fd8ee0091';
// https://api.cloudflare.com/client/v4/ips; changes require a reviewed network rollout.
export const cloudflareCidrs = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22',
  '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15',
  '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];

export function cloudflareManifests({ environment, nodeName, image = cloudflaredImage } = {}) {
  assert(['test', 'production'].includes(environment), 'explicit test or production environment required');
  if (environment === 'production') {
    assert(typeof nodeName === 'string' && nodeName.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(nodeName),
      'explicit production node name required');
  }
  assert(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image), 'digest-pinned connector image required');
  const namespace = 'aira-a2a-edge', name = 'kind-a2a-tunnel';
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'aira-a2a' };
  const app = { matchLabels: { 'app.kubernetes.io/name': 'aira-a2a', 'app.kubernetes.io/part-of': 'aira-a2a' } };
  const ns = value => ({ matchLabels: { 'kubernetes.io/metadata.name': value } });
  const meta = (objectName = name, objectNamespace = namespace) => ({ name: objectName, namespace: objectNamespace, labels });
  const dns = { to: [{ namespaceSelector: ns('kube-system'), podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
    ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] };
  const certificates = { to: cloudflareCidrs.map(cidr => ({ ipBlock: { cidr } })), ports: [{ protocol: 'TCP', port: 443 }] };
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { ...labels,
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/enforce-version': environment === 'production' ? 'v1.35' : 'v1.33' } } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(), automountServiceAccountToken: false },
    { apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta(), spec: { hard: {
      'count/pods': '3', 'requests.cpu': '250m', 'requests.memory': '256Mi', 'limits.cpu': '1', 'limits.memory': '768Mi' } } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(), spec: {
      podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [dns, certificates,
        { to: [{ namespaceSelector: ns('aira-a2a'), podSelector: app }], ports: [{ protocol: 'TCP', port: 8080 }] },
        { to: ['198.41.192.0/24', '198.41.200.0/24'].map(cidr => ({ ipBlock: { cidr } })),
          ports: [{ protocol: 'UDP', port: 7844 }, { protocol: 'TCP', port: 7844 }] },
      ] } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta('aira-a2a-cloudflare', 'aira-a2a'), spec: {
      podSelector: app, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ namespaceSelector: ns(namespace), podSelector: { matchLabels: labels } }],
        ports: [{ protocol: 'TCP', port: 8080 }] }], egress: [certificates] } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(), spec: {
      replicas: environment === 'production' ? 2 : 0, revisionHistoryLimit: 2, selector: { matchLabels: labels },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: { metadata: { labels, annotations: { 'sidecar.istio.io/inject': 'false' } }, spec: {
        serviceAccountName: name, automountServiceAccountToken: false, enableServiceLinks: false,
        ...(environment === 'production' ? { nodeSelector: { 'kubernetes.io/hostname': nodeName } } : {}),
        terminationGracePeriodSeconds: 45,
        securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532,
          seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'cloudflared', image, imagePullPolicy: 'IfNotPresent',
          args: ['tunnel', '--no-autoupdate', '--metrics', '0.0.0.0:2000', '--edge-ip-version', '4',
            'run', '--token-file', '/etc/cloudflared/token'],
          securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
          resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '250m', memory: '256Mi' } },
          ports: [{ name: 'metrics', containerPort: 2000 }],
          startupProbe: { httpGet: { path: '/ready', port: 'metrics' }, periodSeconds: 5, failureThreshold: 24 },
          readinessProbe: { httpGet: { path: '/ready', port: 'metrics' }, periodSeconds: 5 },
          livenessProbe: { httpGet: { path: '/ready', port: 'metrics' }, periodSeconds: 15, failureThreshold: 4 },
          volumeMounts: [{ name: 'token', mountPath: '/etc/cloudflared', readOnly: true }] }],
        volumes: [{ name: 'token', secret: { secretName: 'kind-a2a-tunnel-token', defaultMode: 0o440,
          items: [{ key: 'token', path: 'token' }] } }],
      } },
    } },
  ];
}
