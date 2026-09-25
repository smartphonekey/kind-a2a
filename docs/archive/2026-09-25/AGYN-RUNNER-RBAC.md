<!-- SPDX-License-Identifier: AGPL-3.0-only -->
> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Runner Workload RBAC

The runner service account belongs in the platform namespace, but its workload
Role and RoleBinding must target `workloadNamespace`. The generic service-base
helper omitted a namespace, placing those grants in the Helm release namespace.
This made the default namespaced mode insufficient for a separate workload
namespace. The installed local runner instead had cluster-wide workload access.

## Focused Contribution

[`fix/workload-namespace-rbac`, `92b25e9`](https://github.com/spk-ai/k8s-runner/tree/fix/workload-namespace-rbac)
is based on upstream `baadc75`. It only changes chart placement and adds tests:

- With `rbac.create=true` and `rbac.clusterWide=false`, both namespaced RBAC
  objects explicitly select `workloadNamespace`. An empty namespace is rejected.
- The binding still selects the configured service account in the release
  namespace. Neither that account nor the runner Deployment is moved.
- `rbac.create=false`, externally managed/default service accounts and explicit
  `rbac.clusterWide=true` remain supported. Policy rules are not broadened.
- Helm rendering tests cover separate/same namespaces, account selection,
  disabled creation and cluster-wide opt-in. The independent race run passes.

The prepared native branch incorporates this as `73c3a20`. Its chart and backend
identity rendering tests also pass. Existing prepared-stack changes separately
provide Secret get/patch, PVC patch and GET of the exact workload Namespace.
Those extra permissions are not bundled into the focused placement proposal.
Both branches are pushed; no upstream PR has been opened.

## Installed Local Evidence

On 2026-09-14 the four rendered RBAC objects were server-dry-run validated,
created and independently read back in the existing installation:

- Role/RoleBinding `agyn-workloads/k8s-runner` grant the reviewed workload rules
  to `agyn-platform/k8s-runner`.
- ClusterRole/ClusterRoleBinding
  `agyn-platform-k8s-runner-volume-backend` grant only GET of the
  `agyn-workloads` Namespace object, restricted by `resourceNames`.
- The old `k8s-runner` ClusterRoleBinding was retained with no subjects. Its
  runner subject was removed using UID, resource-version and exact-subject
  JSON Patch tests. The old ClusterRole and unrelated bindings were untouched.

All **57 authorization probes** pass, including explicit impersonation of the
service account's groups: 21 required operations are allowed and 36 are denied.
Denied checks include Pod/Secret/PVC access in `agyn-platform` and `default`,
Secret listing in the workload namespace, reading other Namespace objects,
Namespace listing, ClusterRoleBinding creation and service-account impersonation.
This is a selected permission matrix, not an exhaustive authorization audit.

All 60 prior task PVC names, UIDs, specs and phases were unchanged. Registry
lifecycle fingerprints were unchanged by the RBAC work. The private evidence is
under `.state/agyn-prepared-live-QuUwHe/`: `rbac-before.json`, `rbac-created.json`,
`rbac-applied.json` and `rbac-probes.json`.

The first create command succeeded but returned concatenated JSON documents,
which the operator capture initially parsed as one document. Exact labeled
objects were read back before proceeding; creation was not repeated. A later
read-only snapshot attempt omitted its SQL input and refused the next step.
Neither failure removed the old binding's subject. The final successful step
revalidated the registry and object identities before the guarded patch.

## Boundary

This is an explicit local RBAC overlay, not an upgraded Helm platform release.
A platform reset/upgrade can restore broader grants and incompatible images.
Production packaging must carry the corrected chart and explicit namespaced
profile, remove superseded grants and repeat effective authorization checks.

The runner remains a trusted controller with access to all task resources in
its workload namespace. This does not provide per-task overlay authorization,
protect against a compromised runner, harden agent containers or establish
node/storage fencing. Those remain [production gates](PRODUCTION.md).
