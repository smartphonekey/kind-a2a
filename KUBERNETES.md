<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Kubernetes A2A Deployment

Recorded installation: the A2A service and web application on the existing
single-node Agyn K3s cluster, upgraded in place through registry schema `0027`.
The [deployment evidence](docs/archive/README.md#deployment-evidence) establishes
the inventory below, not current health. This is a **trusted-local deployment**,
not a production release; release gates are in [PRODUCTION.md](PRODUCTION.md).

## Access

Open **https://agents.spkey.co/ui/** and use Google sign-in with a
`@smartphonekey.com` account. No A2A token is needed for the browser.

The loopback operator/machine API remains `http://127.0.0.1:8084`, not a browser
sign-in bypass. Its owner-scoped A2A access token is in:

```text
/home/alex/work/aira-a2a-lab/.state/agyn-upstream-deploy-94iKDb/access-token
```

This mode-0600 file is excluded from Git. It is not an OpenAI, Anthropic or Agyn
token. The installed credential expires October 1, 2026 and has reconciliation
permission; do not distribute it as an ordinary user credential.

The enabled user unit is
[aira-a2a-k8s-forward.service](ops/aira-a2a-k8s-forward.service). Keep its access
loopback-only; check the tunnel and app before signing in:

```sh
systemctl --user status aira-a2a-k8s-forward.service
kubectl --kubeconfig .state/agyn-kubeconfig -n aira-a2a get deployment,pod,pvc,service
curl --fail http://127.0.0.1:8084/readyz
```

The host service on port 8083 has a separate database and credentials. It is not
a replica or failover target for the Kubernetes app, and it has not received
the Cloudflare rollout. Do not copy a database and start another writer.

## Installed App

- App source `ecfbab5`, image
  `docker.io/library/aira-a2a-service@sha256:a104f390b1aa4d8c484c962c4d643be29aadc09ce763a3b1576ea091c25ca8a3`.
  The recorded running SQLite version is 3.53.4.
- Preserve PVC `aira-a2a-data` and configuration Secret `aira-a2a-config` in
  namespace `aira-a2a`; the database is `/data/private/tasks.sqlite`.
- The installed Codex and Claude profiles share a two-execution admission ceiling.
  Changing it requires the [drained procedure](SERVICE.md#shared-execution-admission).

Resource settings and network policies are owned by
[serviceManifests](scripts/k8s-manifests.mjs). Reporting uses cluster HTTP in this
trusted-local installation; that exception and the app's restricted settings do
not harden the root agent runtime or establish hostile-code isolation. Keep
provider tokens out of the app Pod and Gateway/terminal TLS verification enabled.

## Backend Revisions

The fork branches below are pushed but not merged into their `main` branches.
They identify the installed backend combination, not a public Agyn release.

| Component | Fork branch | Source revision |
| --- | --- | --- |
| API | `spk-ai/api:feat/volume-anchor-migration` | `0b9feaf` |
| Registry | `spk-ai/runners:feat/volume-anchor-migration` | `627a1aa` |
| Orchestrator | `spk-ai/agents-orchestrator:feat/volume-anchor-migration` | `fc93b1d` |
| Native runner | `spk-ai/k8s-runner:sync/2026-09-24-volume-adoption` | `0ed8c5c` |
| Gateway | `spk-ai/gateway:sync/2026-09-24-resource-lifecycle` | `7d8267d`, generated against the selected API |

| Deployment | Installed immutable image |
| --- | --- |
| `runners` | `docker.io/library/a2a-agyn-migration-runners@sha256:30135da84301c64f0d1ef8005fef54c397fd898dbf4d340a6498df676818d716` |
| `gateway` | `docker.io/library/a2a-agyn-migration-gateway@sha256:6d8f558893437d0820c677f066b8f6d27a8ec4afc03f7c3cccd6f596b6b25372` |
| `agents-orchestrator` | `docker.io/library/a2a-agyn-migration-orchestrator@sha256:2de348ad22ec7af3c641d85971208c0103d5ebd2e2be28bf2d6761cc7b568000` |
| `k8s-runner` | `docker.io/library/a2a-agyn-candidate-runner@sha256:7c921e48156fb470d194880ce0f56536b08c4e6753d5c070e27308e7c072f7e3` |

These are locally imported images. The runner image name does not imply a
separate candidate deployment. Daemon/SDK integration and independent review
units are described in [CONTRIBUTING-AGYN.md](CONTRIBUTING-AGYN.md); this inventory
is not yet a complete reproducible production release manifest.

## Cloudflare Access

The approved public workspace is `https://agents.spkey.co/ui/`, restricted to
Google accounts on `smartphonekey.com`. Use a dedicated managed Tunnel, not a
Quick Tunnel or an existing application's connector. The existing Google IdP
and Access organization belong to the operator; this stack does not own them.
The operator selected Google sign-in without an additional Cloudflare MFA
challenge. Google account requirements remain unchanged; this stack does not
alter organization-wide MFA settings.

The [Terraform root](infra/cloudflare/main.tf) is separate from Agyn agent state.
It requires Terraform 1.16.x and a short-lived Cloudflare token restricted to
SPK's Access applications/policies and Tunnels plus DNS changes on `spkey.co`.
Inject `CLOUDFLARE_API_TOKEN` privately; review an exact saved plan before applying.
Never upload plans, state or credentials to CI. Its local bootstrap state at
`.state/cloudflare-access/terraform.tfstate` needs encrypted off-node backup;
loss of the workstation must not lose infrastructure ownership.

```sh
terraform -chdir=infra/cloudflare init
terraform -chdir=infra/cloudflare validate
terraform -chdir=infra/cloudflare test
terraform -chdir=infra/cloudflare plan -out=../../.state/cloudflare-access/deploy.tfplan
terraform -chdir=infra/cloudflare apply ../../.state/cloudflare-access/deploy.tfplan
```

Use the [additive manifest factory](scripts/cloudflare-manifests.mjs) for the
connector namespace and app network rules. Supply the connector token separately
in its referenced Kubernetes Secret; it is not an account-wide API token. Revoke
the bootstrap API token after provisioning. Secret rotation requires a connector
restart; retain the old connector until its replacement is healthy.

Merge the Terraform `browser` output into the private app configuration, keeping
its assets path and all unrelated settings. Perform a drained configuration/image
rollout, preserving the existing Secret and PVC. Never replace the service with
fresh-install manifests. The machine and reporting routes stay internal; their
credentials and URLs are unchanged. The loopback forward remains an operator
health/machine-API path, not a bypass around Google browser authentication.

Two connectors tolerate a connector restart, not node loss. Keep the explicit
cluster HTTP exception and the [browser trust boundary](WEB.md#browser-boundary)
visible; Cloudflare does not make the agent sandboxes production-safe.

## Agent Definitions In Git

Use Agyn's Terraform provider for agent classes; the existing execution service
still owns per-task instances, thread recovery and workload release. Review the
[Git definitions](infra/agyn/agents.tf) and [module boundary](infra/modules/a2a-agents/main.tf),
then use the [plan/apply helper](scripts/agyn-terraform.mjs). Changes to existing
profiles require a new versioned profile; do not repoint stored task identities.

Upstream provider v0.12.0 lacks native `model_name` support. The
[build manifest](infra/agyn/provider-source.json) pins our focused fork fix and
API generators. This is an explicit project-local development override, not a
signed provider release. It does not change global Terraform configuration;
replace it with an upstream release after acceptance.

Prerequisites: the repository's Node runtime, Terraform 1.16.x, Go with race-test
support, Buf, and access to the pinned public sources. Build and validate without
cluster credentials, then select the local backend and verified Gateway CA:

```sh
npm run agents:provider
npm run test:gitops
npm run agents:check
export KUBE_CONFIG_PATH="$PWD/.state/agyn-kubeconfig"
export SSL_CERT_FILE="$HOME/.agyn/local/certs/agyn-local-ca.pem"
npm run agents:plan -- --profile local
```

These commands remain the manual recovery path: review the private plan/log and
approve its exact digest. Use the helper's `--help` for apply/render arguments.
Keep plans, logs, tokens and state out of Git and public CI artifacts. The Agyn
operator token is separate from provider subscriptions.

Terraform uses a separate Kubernetes Secret state and Lease lock in namespace
`aira-a2a`. It does not adopt the application's PVC. Back up this state with
encrypted off-node retention; deleting the namespace can lose agent ownership.
State access needs a reviewed least-privilege deployment identity before CI apply.

The chosen deployment policy is **automatic apply after merge**, following
successful validation, without a second human plan approval. The
[workflow](.github/workflows/agyn-agents.yml) and [CI guard](scripts/agyn-terraform-ci.mjs)
own the event, concurrency and plan checks. Merge review remains the authority
for adding agent profiles; existing definitions are not updated or destroyed.

The owner has confirmed PR-review protection on `main`, the main-only
`agyn-agents` environment and the workflow-restricted `agyn-deploy` group.
Required status checks remain disabled; the group has no runners, the environment
has no deployment credentials, and `AGYN_AUTO_APPLY_ENABLED` remains unset.
These external settings need rechecking before activation; the push-only coding
login cannot administer them.

Remaining activation gates:

1. After unconditional PR validation is merged and observed on agent-definition
   and unrelated-file PRs, require GitHub Actions' `validate` status check on
   `main`. Preserve required PR review, stale-review dismissal and the prohibition
   on direct/force pushes, deletion and bypasses. Keep the `agyn-agents` environment
   main-branch-only, with no required reviewers or wait timer.
2. Provision clean, single-job deployment runners in group `agyn-deploy`, with
   no host home, Docker socket, ambient cluster credentials or reusable workspace.
   Restrict the group to this repository and exactly
   `smartphonekey/kind-a2a/.github/workflows/agyn-agents.yml@refs/heads/main`.
   Group-level workflow restrictions are mandatory; labels and YAML conditions
   do not protect a public repository from untrusted PR jobs. Verify the
   organization's [runner-group controls](https://docs.github.com/en/rest/actions/self-hosted-runner-groups)
   support this before registering any runner.
3. Supply the step-scoped environment secrets and HTTPS/CA variables named in
   the apply job. Use a dedicated Agyn deployment identity and Kubernetes state
   identity, not the workstation login or admin kubeconfig. Verify state/Lease
   access and denied access to unrelated secrets; if the shared namespace prevents
   that boundary, migrate the Terraform state to a dedicated namespace first.
   Runners need verified network access to the selected Gateway and Kubernetes API.
4. Set repository variable `AGYN_AUTO_APPLY_ENABLED=true` only after those checks.
   Until then, a green validation run does not mean deployment ran. Do not add
   public plan/log artifacts; inspect a failure privately and reconcile partial
   changes before manually rerunning it. Destroy the runner workspace after each job.

A successful Terraform apply alone does not publish a profile in the running
A2A app: render a candidate service config from Terraform outputs, then use the
drained configuration rollout below. No automatic app restart is performed.

## Packaging And Upgrades

Build with the reviewed [image recipe](ops/Dockerfile.a2a-service) and
[context allowlist](.dockerignore). Do not add private operator state to the context.

```sh
docker build -f ops/Dockerfile.a2a-service \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t aira-a2a-service:reviewed .
agyn local load-image --instance agyn aira-a2a-service:reviewed
node --test scripts/k8s-manifests.test.mjs
npm test
npm run test:web
```

Wait for import to finish and independently verify the immutable digest in the
VM's containerd. A host Docker tag alone does not identify the running image.

Prepare resources using the [manifest factory and client conversion contract](scripts/k8s-manifests.mjs).
Secret creation, subscription binding and backend migration remain separate
operator steps. Do not overwrite an existing namespace with fresh-install resources.
Verify stored specs and both allowed and denied traffic after applying resources.

For an app update, drain submissions and active work first. Use UID/resource-
version preconditions and patch only the owned Deployment's init/main image
references. Preserve its PVC and Secret. Secret rotation also requires a drained
restart; see the manifest factory's initialization contract.
Browser reauthentication is expected; task history must survive.

Backend upgrades require compatible API/client/schema revisions and verified
writer drain. Existing workspaces have already been adopted through `0027`;
do not recreate them, fabricate adoption receipts or restore older backend
images against the upgraded schema. Resume an ambiguous migration using its
existing plan. No automatic rollback or blind retry is authorized.

Preserve the reviewed namespaced RBAC profile across platform upgrades and remove
superseded broad grants. Recheck effective authorization as the runtime identity;
a chart reset can restore permissions outside the intended boundary. The
[RBAC record](docs/archive/2026-09-25/AGYN-RUNNER-RBAC.md#boundary) explains why the
local overlay is not a substitute for production packaging.

## Credentials And Recovery

Provider credentials belong to Agyn subscription bindings, not browser login.
Browser users share the operator-provisioned provider accounts and execution
budget, even though task ownership is private. Google authentication does not
provide each user with a separate Codex or Claude subscription.
The installed Codex binding contains only an access token, valid until
October 8, 2026 at 07:37 UTC. Renew that binding from the matching authorized
account before expiry; the workstation refresh token is intentionally not copied
to agent runtimes. This is manual rotation, not a durable credential broker.
Claude's existing secret-manager token was synchronized into its Agyn binding.
Future secret-manager rotations must also update Agyn; automatic propagation
and the existing token's expiry have not been established. See the
[Agyn trust boundary](AGYN.md).

For interrupted executions, follow [service recovery](SERVICE.md#recovery-and-operations)
and inspect side effects before authorizing a new turn.

## Backup And Restore Scope

Use only trusted database sources: restoring a dump can execute database code
supplied by its source. Run rehearsals in an isolated, newly owned environment
without access to the installed stack, host mounts or production credentials.
Keep admission closed and fence the old owner before a real restore. Dumps and
workspace/session archives remain sensitive even when their receipts are redacted.

Recorded local acceptance covers app SQLite online backup/offline restore, fresh-PVC
restore with schema/content/integrity checks, registry migration rehearsal and
workspace/session archive comparisons. The coordinated migration recovery point
contains the registry, 109 workspace/app claims and both app databases.

That coordinated snapshot predates later Claude tasks and credential changes.
The app-only image update has a separately verified SQLite backup, not a new
coordinated whole-stack backup. Neither proves replacement-node recovery,
off-node encrypted retention or restoration of every Agyn database/key.
A PVC on the same node is not a backup; deleting the namespace or data claim can
destroy local-path state.

Current verification scope is in [ACCEPTANCE.md](ACCEPTANCE.md).
Detailed [migration evidence](docs/archive/2026-09-25/AGYN-WORKSPACE-MIGRATION.md)
and [Claude/transport evidence](docs/archive/2026-09-25/AGYN-CLAUDE-A2A.md) are
archived records, not commands to replay on the installed stack.
