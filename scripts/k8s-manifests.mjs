// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { isIP } from 'node:net';

// A single SQLite writer in a new namespace, using an existing compatible Agyn.
// The caller creates the private configuration Secret separately. No credentials
// belong in these objects, an image layer, or a checked-in values file.
export function serviceManifests({ image, ingressIp, gatewayHost, terminalHost, agentIds }) {
  assert(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image), 'digest-pinned image required');
  assert.equal(isIP(ingressIp), 4, 'explicit ingress Service IPv4 required');
  for (const host of [gatewayHost, terminalHost]) assert(typeof host === 'string' && host.length <= 253 &&
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) && !isIP(host), 'TLS hostname required');
  assert(Array.isArray(agentIds) && agentIds.length > 0 && agentIds.length <= 100);
  assert.equal(new Set(agentIds).size, agentIds.length, 'duplicate agent');
  for (const id of agentIds) assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id), 'exact agent UUID required');
  const namespace = 'aira-a2a', name = 'aira-a2a';
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'aira-a2a' };
  const meta = (objectName = name, ns = namespace) => ({ name: objectName, namespace: ns, labels: { ...labels } });
  const nsSelector = ns => ({ matchLabels: { 'kubernetes.io/metadata.name': ns } });
  const agentSelector = { matchLabels: { 'agyn.dev/managed-by': 'agents-orchestrator' },
    matchExpressions: [{ key: 'agent-id', operator: 'In', values: agentIds }] };
  const security = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
  const resources = { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } };
  const env = ['AGYN_GATEWAY_URL', 'AGYN_TOKEN', 'AGYN_ORGANIZATION_ID', 'AGYN_IDENTITY_ID'].map(key => ({ name: key,
    valueFrom: { secretKeyRef: { name: `${name}-config`, key } } }));
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { ...labels,
      'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'v1.33' } } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(), automountServiceAccountToken: false },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta(`${name}-data`), spec: {
      accessModes: ['ReadWriteOnce'], storageClassName: 'local-path', resources: { requests: { storage: '1Gi' } } } },
    { apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta(), spec: { hard: {
      'count/pods': '2', 'requests.cpu': '250m', 'requests.memory': '512Mi',
      'limits.cpu': '1', 'limits.memory': '1Gi', persistentvolumeclaims: '1', 'requests.storage': '1Gi' } } },
    { apiVersion: 'v1', kind: 'Service', metadata: meta(), spec: { type: 'ClusterIP', selector: labels,
      ports: [{ name: 'http', port: 8080, targetPort: 'http', protocol: 'TCP' }] } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(), spec: {
      podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ namespaceSelector: nsSelector('agyn-workloads'), podSelector: agentSelector }],
        ports: [{ protocol: 'TCP', port: 8080 }] }],
      egress: [
        { to: [{ namespaceSelector: nsSelector('kube-system'), podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
          ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        { to: [{ namespaceSelector: nsSelector('istio-gateway'), podSelector: { matchLabels: { app: 'istio-ingressgateway' } } }],
          ports: [{ protocol: 'TCP', port: 443 }, { protocol: 'TCP', port: 2496 }] }
      ]
    } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(`${name}-reporting`, 'agyn-workloads'), spec: {
      podSelector: agentSelector, policyTypes: ['Egress'], egress: [{ to: [{ namespaceSelector: nsSelector(namespace), podSelector: { matchLabels: labels } }],
        ports: [{ protocol: 'TCP', port: 8080 }] }]
    } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(), spec: {
      replicas: 1, strategy: { type: 'Recreate' }, revisionHistoryLimit: 2, selector: { matchLabels: labels },
      template: { metadata: { labels, annotations: { 'sidecar.istio.io/inject': 'false' } }, spec: {
        serviceAccountName: name, automountServiceAccountToken: false, enableServiceLinks: false,
        terminationGracePeriodSeconds: 90,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000,
          fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
        hostAliases: [{ ip: ingressIp, hostnames: [...new Set([gatewayHost, terminalHost])] }],
        initContainers: [{ name: 'private-config', image, imagePullPolicy: 'IfNotPresent', securityContext: security,
          resources: { requests: { cpu: '25m', memory: '32Mi' }, limits: { cpu: '250m', memory: '128Mi' } },
          command: ['node', '--input-type=module', '-e'], args: [
            "import{mkdirSync,readFileSync,writeFileSync}from'node:fs';mkdirSync('/run/a2a/private',{mode:0o700});for(const name of ['service.json','credentials.json','ca.pem'])writeFileSync('/run/a2a/private/'+name,readFileSync('/config/'+name),{mode:0o600,flag:'wx'});"
          ], volumeMounts: [{ name: 'configuration', mountPath: '/config', readOnly: true }, { name: 'private', mountPath: '/run/a2a' }] }],
        containers: [{ name, image, imagePullPolicy: 'IfNotPresent', securityContext: security, resources,
          ports: [{ name: 'http', containerPort: 8080 }], env: [...env,
            { name: 'A2A_SERVICE_CONFIG_FILE', value: '/run/a2a/private/service.json' },
            { name: 'NODE_EXTRA_CA_CERTS', value: '/run/a2a/private/ca.pem' },
            { name: 'A2A_ALLOW_INSECURE_LOCAL_REPORTING', value: 'true' }],
          startupProbe: { httpGet: { path: '/healthz', port: 'http' }, periodSeconds: 2, failureThreshold: 30 },
          readinessProbe: { httpGet: { path: '/readyz', port: 'http' }, periodSeconds: 5 },
          livenessProbe: { httpGet: { path: '/healthz', port: 'http' }, periodSeconds: 15 },
          volumeMounts: [{ name: 'data', mountPath: '/data' }, { name: 'private', mountPath: '/run/a2a', readOnly: true },
            { name: 'tmp', mountPath: '/tmp' }]
        }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } },
          { name: 'configuration', secret: { secretName: `${name}-config`, defaultMode: 0o440,
            items: ['service.json', 'credentials.json', 'ca.pem'].map(key => ({ key, path: key })) } },
          { name: 'private', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
          { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } }]
      } }
    } }
  ];
}
