<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Kubernetes A2A Deployment

The A2A execution service and assistant-ui web application are installed on the
existing single-node Agyn K3s cluster as of September 24, 2026. This is a
**trusted-local deployment against the installed Agyn backend**, not a production
release. The subsequent [workspace migration and in-place backend
upgrade](AGYN-WORKSPACE-MIGRATION.md) installs the rebased services through registry
schema `0027`; the A2A app image and routing code are unchanged.

## Access

Open **http://127.0.0.1:8084/ui/**. The owner-scoped A2A access token is in:

```text
/home/alex/work/aira-a2a-lab/.state/agyn-upstream-deploy-94iKDb/access-token
```

That mode-0600 file is private and excluded from Git. It is not an OpenAI,
Anthropic or Agyn token. The initial credential expires October 1, 2026 and has
operator reconciliation permission. Do not share it as an ordinary user token.

The enabled user unit `aira-a2a-k8s-forward.service` maintains a **loopback-only**
8084-to-8080 Kubernetes port-forward and reconnects after app Pod replacement.
Its template is [ops/aira-a2a-k8s-forward.service](ops/aira-a2a-k8s-forward.service).
The existing host service at port 8083, its database and browser credentials are
unchanged. These are separate task databases, not two writers to one database.

```sh
systemctl --user status aira-a2a-k8s-forward.service
kubectl --kubeconfig .state/agyn-kubeconfig -n aira-a2a get deployment,pod,pvc,service
curl --fail http://127.0.0.1:8084/readyz
```

## Installed Shape

- Namespace `aira-a2a`, one replica, `Recreate` strategy, ClusterIP Service only.
- App image source `13db0a522212aac9bc3327cc05e5ead83dc6ec7b`, pinned to
  `docker.io/library/aira-a2a-service@sha256:348ead39a2f275f6e29e8d3d6c2378be5e49b3047f213ebd4a15f04089a6dbba`.
  Node 24.21.0, SQLite 3.53.4 and UID 1000 are verified in the running Pod.
- PVC `aira-a2a-data`, 1 GiB, `local-path`; SQLite at
  `/data/private/tasks.sqlite`. This claim must outlive app Pod replacement.
- App requests 50m CPU / 128 MiB, limits 500m / 512 MiB. Restricted Pod Security,
  read-only root filesystem, RuntimeDefault seccomp, all capabilities dropped,
  no privilege escalation and no mounted service-account token or RBAC grant.
- Secret `aira-a2a-config` holds service configuration, access-token digests,
  Agyn identity credentials and the public local CA. Private files are copied
  into a memory volume with 0700/0600 permissions. Provider tokens are not copied
  into the app Pod. TLS verification stays enabled for Agyn Gateway/terminal.
- Exactly two existing web-agent profiles are selected: Codex (`gpt-5.5`) and
  Claude (`claude-sonnet-5`). The service admits two executions concurrently.
  Different tasks get different Agyn instances, sessions and PVCs; follow-ups
  retain their original binding. Workload Pods are removed between turns.

The new app policy permits port 8080 only from the two exact agent IDs in
`agyn-workloads`. A separate, additive policy permits their reporting egress.
App egress is limited to DNS and the existing ingress gateway. The app's
restricted Pod settings do **not** harden the existing root agent runtime.
Reporting uses cluster HTTP with explicit
`A2A_ALLOW_INSECURE_LOCAL_REPORTING=true`. These are trusted-local policies,
not a claim of comprehensive network, credential or hostile-code isolation.

## Packaging And Changes

[ops/Dockerfile.a2a-service](ops/Dockerfile.a2a-service) builds the service,
reporting bundle and web assets. The deny-by-default Docker context excludes
operator state, credentials, Git metadata and host dependencies.

```sh
docker build -f ops/Dockerfile.a2a-service \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t aira-a2a-service:reviewed .
agyn local load-image --instance agyn aira-a2a-service:reviewed
node --test scripts/k8s-manifests.test.mjs
npm test
npm run test:web
```

Wait for image import to finish. Register and independently verify its immutable
digest reference in the VM's containerd before a rollout; a host Docker tag is
not sufficient. The current OCI index, platform manifest and configuration blobs
were independently hashed and checked through CRI.

[scripts/k8s-manifests.mjs](scripts/k8s-manifests.mjs) exports the eight
nonsecret resources, given a digest-pinned image, the ingress Service IP, exact
TLS hostnames and agent UUIDs. Configuration Secret creation is a separate
operator step. It intentionally does not install Agyn, migrate its registry or
attach subscriptions. Never overwrite an existing namespace with this installer.

The manifest factory returns **wire JSON** for kubectl. When using the generated
JavaScript client, pass each object through `asKubernetesClientObject()` before
`KubernetesObjectApi.create()`. The client's model calls ingress `from` `_from`;
passing plain wire JSON silently drops that restriction. The converter uses the
client's structured serializer and verifies a lossless round trip. Always check
the actual stored specifications and test both allowed and denied traffic.

Drain work before changing the app image or credentials. Patch only the owned
Deployment with UID/resource-version preconditions, updating both init and main
container image references. Keep its PVC and Secret. The private configuration
copy is made at initialization, so Secret rotation requires a drained restart.
Browser sessions must sign in again; task state survives. Do not run a second
worker against a copied database or assume interrupted requests can be retried.

## Live Acceptance

Private evidence is under `.state/agyn-upstream-deploy-94iKDb/`; it contains
operator metadata and must not be committed or published.

| Check | Result |
| --- | --- |
| Service build/tests | 505 pass; one opt-in PostgreSQL fixture skipped |
| Desktop/mobile browser tests | 12 pass; includes slow/failed task restoration and stale-response fencing |
| Manifest/security tests | Four pass, including full client-serialization round trips |
| Two concurrent Codex tasks | Distinct instance, native session and exact PVC UIDs; distinct proof-file contents |
| Completed-turn continuation | Both original tasks resume in new Pods with the same native session, exact PVC UID and retained file |
| App Pod replacement | Same app PVC and durable task history; loopback tunnel reconnects; browser reauthentication works |
| Reporting and compute release | Real MCP progress/artifact/outcome calls; no task Pods after settlement |
| Corrected policy positive control | A real same-task Codex follow-up reports successfully and releases compute |
| SQLite fresh-PVC restore | Pass; 208,896-byte archive, all ten table hashes and schema match, integrity/FK checks pass |
| Unrelated-Pod denial | Six denied probes across Service/Pod IPs, with fresh successful listener controls |
| Browser inspection | 1440px, 390px and 320px screenshots; no horizontal overflow or page errors |

The two final parallel tasks are `7045e28d-0f19-4401-aa8e-7cfccb802c0b` and
`75ee63ae-0c16-4f53-b57d-62c09d2d0ec6`. Each has exactly two settled executions;
their continuation receipts assert that earlier requests were not changed or
replayed. This proves recovery **after completed turns**, not safe automatic
retry during an interrupted turn. No interruption, approval or Claude live
acceptance was performed for this app deployment.

### Failures Retained

Three early requests failed because the existing Agyn Codex access token had
expired. The existing subscription Secret was renewed with a matching account's
valid access token only; the host login was unchanged and no refresh token was
exported. The renewed token expires September 28, 2026. A separate reporting
setup attempt returned remote exit 137 without its acknowledgement; the cause
is unresolved. Those four executions remain explicitly uncertain/read-only with
compute released. They were not automatically retried or silently deleted.

The first completed-turn browser attempt exposed a real restoration race:
after login, the new-task composer appeared before the URL-selected task loaded.
The fix gates the composer until restoration succeeds, with explicit retry on
failure. The new regression cases fail against the old assets and pass with the
fix. Web tests now build their assets first to prevent testing stale bundles.

Two continuation observation assertions also required correction: a queued turn
can still show the preceding turn's release metadata, and an initial PVC sample
can precede binding. Acceptance now correlates the exact execution ID and terminal
phase, compares claim UID/name, and checks the bound PV's claim reference. Only
observation was resumed; the accepted follow-up was sent once.

The first two restore runs verified SQLite data but failed the network check:
an unrelated Pod received HTTP 200. The installed ingress selector had been
dropped by the JavaScript serialization issue above. Only the new app policy
was corrected with identity checks; no original policy or CNI configuration was
changed. Those failed receipts and cleanup evidence are retained.

Claude's short-lived local login expired during the initial deployment. The
September 25 [Claude follow-up](AGYN-CLAUDE-A2A.md) replaces the existing Agyn
subscription credential with the OAuth token already stored in Doppler; real
parallel work and same-task continuation now pass. The web login token and
provider subscription credentials remain separate. This is a one-time sync,
not automatic propagation of future Doppler rotations. Explicit interrupted-turn
recovery also passes; unreconciled REST follow-ups are blocked but incorrectly
return 500 instead of 409, so that HTTP acceptance check remains failed.

## Backup And Restore Scope

The final check uses SQLite's online backup API, exports an owner-only archive,
restores it onto a newly provisioned PVC in a unique restricted namespace, then
compares all table row counts/content hashes, schema hash, `integrity_check` and
`foreign_key_check`. The inspector never starts an A2A worker and has no provider
or Kubernetes credentials. It tests denied access over both Service and Pod IPs,
with fresh positive listener controls from the node. Owned fixture namespace,
Pod and PVC/PV deletion is confirmed afterward; source database hashes must
remain unchanged. See `service-backup-restore-confirmed.json` and
`a2a-tasks-backup-confirmed.sqlite` in the evidence directory.

Separately, a fresh installed-registry dump was restored offline and migrations
`0023` through `0026` rehearsed without changing installed data. The successful
`backup-jIU4so/receipt.json` preserves legacy lifecycle history; the earlier
wrong-migration-path attempt and its cleanup are also recorded. Subsequent real
agent tests create legitimate registry records, so that initial dump is not a
current all-system recovery point or a release authorization.

Those initial checks were **database restore tests**, not complete disaster
recovery. The subsequent migration also restore-tests coordinated task workspace,
native session and app data archives. Still missing: all Agyn databases and keys,
encrypted off-node retention, and a complete replacement-node restore with
fencing and no replay. Deleting `aira-a2a-data` or its namespace can destroy the
local-path data. A PVC on the same node is not a backup.

## Backend Upgrade Boundary

The following paragraph records the **earlier app-only deployment**, before
[workspace migration](AGYN-WORKSPACE-MIGRATION.md). It is not the current backend
state: registry `0027` and the compatible four backend images are now installed
in place. The original 107 active workspaces were retained and adopted, while
one unbound failed record remains quarantined. A namespaced ConfigMap permission
was added for native anchors/journals; no cluster-wide RBAC was changed. Claude
was not tested during that upgrade; its later credential and acceptance results
are recorded [separately](AGYN-CLAUDE-A2A.md).

The current audit preserves all 116 pre-upgrade PVCs/PVs and all 53 Deployment
identities, with only the four reviewed backend images changed. One additional
test workspace brings the cluster to 117 claims. Completed-turn and interrupted
Codex recovery pass separately, both services are ready, and no task Pods remain.
The latest coordinated local backup restore-checks 109 workspace/app claims and
the registry; see the migration report for its scope and remaining recovery gaps.

The [rebased backend](AGYN-UPSTREAM-SYNC.md) was built, imported and verified,
but its four service images were **not deployed at that stage**. Registry schema
then remained `0022`; candidates required the resource-anchor schema through `0026`.
Native adoption RPCs alone do not implement registry admission/persistence or
the coordinator needed to migrate existing workspaces safely. The rollout guard
was not widened, and no workspace/database reset or fabricated adoption receipt
was used. Do not run candidate controllers against the installed database,
notification stream or overlay as a supposed isolated deployment.

That app-deployment audit matched all 10 original namespace identities, 108 PVCs/PVs,
52 Deployment specs/readiness states, 96 ClusterRoles, 76 ClusterRoleBindings,
25 Docker container IDs and every original network policy. All eight generated
app manifests also match their stored fields after the policy correction and
image update. Additions are one app namespace/Deployment, eight PVCs/PVs (seven
task workspaces plus the app database), and the scoped policies. No RBAC was
added. There are zero task Pods or unconfirmed workload removals, and both web
services are ready. The explicitly renewed Codex subscription is an intentional
Secret change. [PRODUCTION.md](PRODUCTION.md) remains the release checklist.
