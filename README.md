# AIRA A2A Lab

Local proof of concept for a ChatGPT-authenticated Codex app-server exposed through A2A and backed by Kubernetes Agent Sandbox `v0.5.2` on a dedicated `kind-aira-a2a-lab` cluster. It uses A2A JS SDK `1.0.0` and Codex CLI `0.153.4`.

## Run

`./scripts/deploy.sh` creates only the lab cluster and reads `$HOME/.codex/auth.json` into the namespaced `aira-codex-auth` Secret. It requires `codex login` to have completed with the ChatGPT subscription. No API key is used, printed, or committed.

In another terminal run `./scripts/port-forward.sh`. Submit work with:

```bash
npm run build
npm run client -- submit beta "Create a small function and tests" 22222222-2222-4222-8222-222222222222 beta-unique-key
```

Submit follow-up work with the same workspace ID and context ID, but a new idempotency key. Use `npm run client -- task <task-id>` to inspect its A2A task, and `curl http://127.0.0.1:8081/transcripts/<task-id>` to export its redacted ordered transcript.

When an A2A update is `INPUT_REQUIRED`, approve the recorded request through the controller only:

```bash
curl -X POST -H 'content-type: application/json' --data '{"decision":"accept"}' \
  'http://127.0.0.1:8081/workspaces/<workspace-id>/approvals/<url-encoded-request-id>'
```

## Identity and persistence

`workspaceId` maps to a stable Agent Sandbox name and PVC. A2A `contextId` groups requests, each task has a separate A2A `taskId`, and the controller records the Codex `threadId` in SQLite on `aira-controller-data`. A repeated `metadata.idempotencyKey` is an AIRA extension, not protocol-native A2A idempotency; it returns the original persisted task without another turn.

Each runner persists `/state/workspace` and `/state/codex` to its PVC. Replacing a runner Pod preserves files and Codex session data; process memory does not survive. Deleting the kind cluster deletes the default kind local-path volumes. `./scripts/cleanup.sh` suspends lab workloads but preserves PVCs; `./scripts/cleanup.sh --delete-data` deletes only this lab cluster and kubeconfig.

## Boundaries

This is container isolation, not VM isolation: Pods share the kind node kernel. Runners are non-root, non-privileged, drop all capabilities, deny privilege escalation, have no service-account token, Docker socket, host mounts, or host namespaces. The controller alone has namespace-scoped RBAC for PVCs and Sandboxes. kindnet does not enforce NetworkPolicy, so no NetworkPolicy guarantee is claimed.

Codex `workspace-write` requires bubblewrap user namespaces. Docker's default seccomp blocks them on this host, so the dedicated runner uses `Unconfined` seccomp while retaining the other controls. The runner receives only a copied Codex auth file and a public host CA ConfigMap, never the host Codex home. The CA mount is needed because the base image otherwise does not trust the local current CA bundle.
