// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Build nonsecret Kubernetes wire manifests and lossless generated-client models.
 *
 * @module
 * @remarks This is a pure deployment description, not an installer or an Agyn
 * migration. The caller owns the private Secret and must preserve durable state;
 * imports do not contact a cluster or load kubeconfig.
 * @see KUBERNETES.md#packaging-and-upgrades
 * @see scripts/k8s-manifests.test.mjs
 */
import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { ObjectSerializer } from '@kubernetes/client-node/dist/serializer.js';

/**
 * Convert supported wire JSON before passing it to KubernetesObjectApi.create.
 * The generated client's ingress.from field is named _from; passing wire data
 * directly can silently drop source restrictions. A full serialization round
 * trip must equal the input or conversion fails, including on unknown fields.
 */
export function asKubernetesClientObject(manifest) {
  const types = { Namespace: 'v1', Secret: 'v1', ServiceAccount: 'v1', PersistentVolumeClaim: 'v1',
    ResourceQuota: 'v1', Service: 'v1', NetworkPolicy: 'networking.k8s.io/v1', Deployment: 'apps/v1' };
  assert.equal(manifest.apiVersion, types[manifest.kind], 'unsupported deployment object');
  const type = `V1${manifest.kind}`;
  const model = ObjectSerializer.deserialize(manifest, type, '');
  assert.deepEqual(JSON.parse(JSON.stringify(ObjectSerializer.serialize(model, type, ''))), manifest,
    'Kubernetes client serialization changed the deployment manifest');
  return model;
}

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dnsSubdomain = value => typeof value === 'string' && value.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value);
const labelKey = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\/)?[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
const labelValue = /^(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)?$/;

function assertImage(image) {
  assert(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image), 'digest-pinned image required');
}

function assertAgentIds(agentIds) {
  assert(Array.isArray(agentIds) && agentIds.length > 0 && agentIds.length <= 100);
  assert.equal(new Set(agentIds).size, agentIds.length, 'duplicate agent');
  for (const id of agentIds) assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id), 'exact agent UUID required');
}

/**
 * Return the deployment objects for one topology. Without `topology` (or with
 * `'ingress'`) this is the original Istio-ingress shape, unchanged; `'native'`
 * targets an Agyn platform reached only through in-cluster Services.
 * @see nativeServiceManifests
 */
export function serviceManifests(options = {}) {
  const { topology, ...rest } = options;
  if (topology === 'native') return nativeServiceManifests(rest);
  assert(topology === undefined || topology === 'ingress', 'unknown deployment topology');
  return ingressServiceManifests(rest);
}

/**
 * Native in-cluster topology: the Agyn gateway and terminal proxy are plain
 * HTTP Services in the platform namespace, with no ingress, TLS hostnames,
 * hostAliases or mesh. The gateway URL is derived from the explicit Service
 * target and set as a literal, so the egress NetworkPolicy and the URL the
 * service dials cannot drift apart. The terminal proxy needs only egress: its
 * WebSocket URL comes from the gateway's terminal-session response.
 *
 * @remarks The `aira-a2a-config` Secret is still caller-owned and must hold
 * service.json, credentials.json, AGYN_TOKEN, AGYN_ORGANIZATION_ID and
 * AGYN_IDENTITY_ID, plus ca.pem only when `caCertificate` is true. Plain HTTP
 * is acceptable only on a cluster network the operator trusts; NetworkPolicy
 * rules here are additive and do not prove isolation. Platform pod labels must
 * be the exact selector labels of the platform's Deployments; a label that
 * matches nothing silently blocks egress, it does not widen it.
 */
export function nativeServiceManifests({ image, agentIds, storageClassName, nodeName, platform, caCertificate = false, ...unexpected }) {
  assert.deepEqual(Object.keys(unexpected), [], 'unexpected native option');
  assertImage(image);
  assertAgentIds(agentIds);
  assert(dnsSubdomain(storageClassName), 'explicit storage class required');
  assert(nodeName === undefined || dnsSubdomain(nodeName), 'invalid node name');
  assert.equal(typeof caCertificate, 'boolean', 'caCertificate must be a boolean');
  assert(platform && typeof platform === 'object', 'explicit platform targets required');
  assert(dnsLabel.test(platform.namespace ?? ''), 'explicit platform namespace required');
  assert(!['aira-a2a', 'agyn-workloads'].includes(platform.namespace), 'platform namespace must be separate');
  const targets = ['gateway', 'terminalProxy'].map(key => {
    const target = platform[key];
    assert(target && dnsLabel.test(target.service ?? ''), `${key}: explicit Service name required`);
    assert(Number.isInteger(target.port) && target.port > 0 && target.port <= 65535, `${key}: explicit port required`);
    const labels = Object.entries(target.podLabels ?? {});
    assert(labels.length > 0 && labels.length <= 8, `${key}: exact pod labels required`);
    for (const [k, v] of labels) assert(labelKey.test(k) && typeof v === 'string' && labelValue.test(v) && v !== '', `${key}: invalid pod label`);
    assert.deepEqual(Object.keys(target).sort(), ['podLabels', 'port', 'service'], `${key}: unexpected target field`);
    return target;
  });
  assert.notDeepEqual(targets[0].podLabels, targets[1].podLabels, 'gateway and terminal proxy selectors must differ');
  const [gateway, terminalProxy] = targets;
  const namespace = 'aira-a2a', name = 'aira-a2a';
  const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'aira-a2a' };
  const meta = (objectName = name, ns = namespace) => ({ name: objectName, namespace: ns, labels: { ...labels } });
  const nsSelector = ns => ({ matchLabels: { 'kubernetes.io/metadata.name': ns } });
  const agentSelector = { matchLabels: { 'agyn.dev/managed-by': 'agents-orchestrator' },
    matchExpressions: [{ key: 'agent-id', operator: 'In', values: agentIds }] };
  const security = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
  const resources = { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } };
  const files = ['service.json', 'credentials.json', ...(caCertificate ? ['ca.pem'] : [])];
  const env = [
    { name: 'AGYN_GATEWAY_URL', value: `http://${gateway.service}.${platform.namespace}.svc.cluster.local:${gateway.port}` },
    ...['AGYN_TOKEN', 'AGYN_ORGANIZATION_ID', 'AGYN_IDENTITY_ID'].map(key => ({ name: key,
      valueFrom: { secretKeyRef: { name: `${name}-config`, key } } })),
    { name: 'A2A_SERVICE_CONFIG_FILE', value: '/run/a2a/private/service.json' },
    ...(caCertificate ? [{ name: 'NODE_EXTRA_CA_CERTS', value: '/run/a2a/private/ca.pem' }] : []),
    // In-cluster reporting and the terminal WebSocket are plain HTTP Service hops.
    { name: 'A2A_ALLOW_INSECURE_LOCAL_REPORTING', value: 'true' },
  ];
  const platformEgress = target => ({ to: [{ namespaceSelector: nsSelector(platform.namespace),
    podSelector: { matchLabels: { ...target.podLabels } } }], ports: [{ protocol: 'TCP', port: target.port }] });
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { ...labels,
      'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'v1.35' } } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(), automountServiceAccountToken: false },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta(`${name}-data`), spec: {
      accessModes: ['ReadWriteOnce'], storageClassName, resources: { requests: { storage: '2Gi' } } } },
    { apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta(), spec: { hard: {
      'count/pods': '2', 'requests.cpu': '250m', 'requests.memory': '512Mi',
      'limits.cpu': '1', 'limits.memory': '1Gi', persistentvolumeclaims: '1', 'requests.storage': '2Gi' } } },
    { apiVersion: 'v1', kind: 'Service', metadata: meta(), spec: { type: 'ClusterIP', selector: labels,
      ports: [{ name: 'http', port: 8080, targetPort: 'http', protocol: 'TCP' }] } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(), spec: {
      podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ namespaceSelector: nsSelector('agyn-workloads'), podSelector: agentSelector }],
        ports: [{ protocol: 'TCP', port: 8080 }] }],
      egress: [
        { to: [{ namespaceSelector: nsSelector('kube-system'), podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
          ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        platformEgress(gateway),
        platformEgress(terminalProxy),
      ]
    } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(`${name}-reporting`, 'agyn-workloads'), spec: {
      podSelector: agentSelector, policyTypes: ['Egress'], egress: [{ to: [{ namespaceSelector: nsSelector(namespace), podSelector: { matchLabels: labels } }],
        ports: [{ protocol: 'TCP', port: 8080 }] }]
    } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(), spec: {
      replicas: 1, strategy: { type: 'Recreate' }, revisionHistoryLimit: 2, selector: { matchLabels: labels },
      template: { metadata: { labels }, spec: {
        serviceAccountName: name, automountServiceAccountToken: false, enableServiceLinks: false,
        ...(nodeName ? { nodeSelector: { 'kubernetes.io/hostname': nodeName } } : {}),
        terminationGracePeriodSeconds: 90,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000,
          fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
        initContainers: [{ name: 'private-config', image, imagePullPolicy: 'IfNotPresent', securityContext: security,
          resources: { requests: { cpu: '25m', memory: '32Mi' }, limits: { cpu: '250m', memory: '128Mi' } },
          command: ['node', '--input-type=module', '-e'], args: [
            `import{mkdirSync,readFileSync,writeFileSync}from'node:fs';mkdirSync('/run/a2a/private',{mode:0o700});for(const name of [${files.map(file => `'${file}'`).join(',')}])writeFileSync('/run/a2a/private/'+name,readFileSync('/config/'+name),{mode:0o600,flag:'wx'});`
          ], volumeMounts: [{ name: 'configuration', mountPath: '/config', readOnly: true }, { name: 'private', mountPath: '/run/a2a' }] }],
        containers: [{ name, image, imagePullPolicy: 'IfNotPresent', securityContext: security, resources,
          ports: [{ name: 'http', containerPort: 8080 }], env,
          startupProbe: { httpGet: { path: '/healthz', port: 'http' }, periodSeconds: 2, failureThreshold: 30 },
          readinessProbe: { httpGet: { path: '/readyz', port: 'http' }, periodSeconds: 5 },
          livenessProbe: { httpGet: { path: '/healthz', port: 'http' }, periodSeconds: 15 },
          volumeMounts: [{ name: 'data', mountPath: '/data' }, { name: 'private', mountPath: '/run/a2a', readOnly: true },
            { name: 'tmp', mountPath: '/tmp' }]
        }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } },
          { name: 'configuration', secret: { secretName: `${name}-config`, defaultMode: 0o440,
            items: files.map(key => ({ key, path: key })) } },
          { name: 'private', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
          { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } }]
      } }
    } }
  ];
}

/**
 * Return wire objects for a fresh trusted-local namespace and compatible Agyn:
 * one Recreate SQLite writer, a durable PVC, ClusterIP and scoped network rules.
 * Image digest, IPv4 ingress address, exact TLS hostnames and unique agent UUIDs
 * are mandatory; these objects carry Secret references, never credential values.
 *
 * @remarks Network policies are additive, not proof of isolation. Private config
 * is copied to memory at init, so Secret rotation needs a drained restart.
 * Do not blindly apply this fresh-install set over an existing namespace or
 * delete/recreate its PVC to upgrade. No objects are applied by this function.
 */
function ingressServiceManifests({ image, ingressIp, gatewayHost, terminalHost, agentIds }) {
  assertImage(image);
  assert.equal(isIP(ingressIp), 4, 'explicit ingress Service IPv4 required');
  for (const host of [gatewayHost, terminalHost]) assert(typeof host === 'string' && host.length <= 253 &&
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) && !isIP(host), 'TLS hostname required');
  assertAgentIds(agentIds);
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
