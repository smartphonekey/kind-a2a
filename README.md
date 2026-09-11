# AIRA A2A Lab

Trusted local proof of concept for persistent coding-agent workspaces:

```text
A2A client -> A2A controller/session coordinator -> runner harness -> ACP agent over stdio
                                                       |               |
                                                       |               +-- Codex ACP -> Codex app-server
                                                       +-- persistent workspace and agent state PVC
```

The controller owns A2A state, workspace provisioning, approvals, transcripts, artifacts, and the operator-selected agent profile. The runner owns a small protocol-neutral harness interface. New workspaces use `codex-acp-review-v1`; migrated workspaces retain `codex-direct-v1` so no existing session is silently switched.

Pinned components include Kubernetes Agent Sandbox `v0.5.2`, A2A JS SDK `1.x`, ACP SDK `1.4.0`, Codex ACP `1.11.0`, Codex CLI `0.153.4`, and Gemini CLI `0.46.0`.

## Run

`./scripts/deploy.sh` creates or updates only `kind-aira-a2a-lab`. It copies `$HOME/.codex/auth.json` into the namespaced `aira-codex-auth` Secret and never prints or commits it. ChatGPT subscription authentication must already work with `codex login`; this does not switch to API-billed inference.

```bash
npm run build
./scripts/deploy.sh
./scripts/port-forward.sh
```

Create an ACP-backed workspace by submitting its first task. The profile is selected by `AIRA_DEFAULT_PROFILE` in `manifests/controller.yaml`, not by the request:

```bash
npm run client -- submit acp-three "Create a small function and tests" \
  33333333-3333-4333-8333-333333333333 acp-three-turn-1
```

The lab allows two running Sandboxes. If both slots are occupied, an operator can suspend one while retaining its PVC before creating another:

```bash
kubectl --kubeconfig .state/kubeconfig --context kind-aira-a2a-lab \
  -n aira-a2a-lab patch sandbox runner-acp-one --type merge \
  -p '{"spec":{"operatingMode":"Suspended"}}'
```

Follow up with the same workspace and context IDs and a new idempotency key:

```bash
npm run client -- submit acp-three "Run the tests and fix any failure" \
  33333333-3333-4333-8333-333333333333 acp-three-turn-2
```

When an update reaches `INPUT_REQUIRED`, URL-encode its `requestId` and resolve it through the coordinator:

```bash
curl -X POST -H 'content-type: application/json' --data '{"decision":"accept"}' \
  'http://127.0.0.1:8081/workspaces/acp-three/approvals/<url-encoded-request-id>'
```

`accept` selects an ACP `allow_once` option when offered; `decline` selects `reject_once`. An absent, invalid, timed-out, or disconnected response is canceled, never approved. Inspect and cancel tasks with:

```bash
npm run client -- task <task-id>
npm run client -- cancel <task-id>
curl 'http://127.0.0.1:8081/transcripts/<task-id>'
```

Run non-destructive cluster/protocol checks, optionally including transcript redaction checks for known task IDs:

```bash
npm run test:live -- <task-id> [<task-id> ...]
```

## Profiles

| Profile | Harness | Approval behavior | Status |
| --- | --- | --- | --- |
| `codex-acp-review-v1` | ACP via `codex-acp` | Explicit coordinator approval | Default; live tested |
| `codex-acp-v1` | ACP via `codex-acp` | Adapter agent mode | Live tested |
| `codex-direct-v1` | Codex app-server fallback | Direct translation | Rollback and migrated workspaces |
| `gemini-acp-v1` | Native `gemini --acp` | Negotiated ACP permission requests | Added; live initialization blocked by current login |

The ACP client implements stable ACP v1 `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, session updates, and permission requests. It advertises no client filesystem or terminal capabilities, so host callbacks cannot run. The selected agents operate directly inside the remote sandbox, which is the authoritative workspace. MCP servers are an operator-controlled empty list; prompts cannot inject MCP commands.

ACP session IDs are opaque coordinator data. Provider resume metadata is stored separately. Codex ACP currently maps its ACP session to a Codex thread internally, but controller/workflow code does not depend on that detail.

## Identity And Recovery

The SQLite coordinator store separately records workspace, A2A context/task, execution/turn, profile/harness, ACP session, provider resume metadata, Sandbox/PVC, and Pod UID identities. `/state/workspace` and agent state live on the workspace PVC. Transcripts live on the controller PVC.

Only one runner turn writes a workspace at a time. A repeated `(workspaceId, metadata.idempotencyKey)` returns the original persisted task without another turn. This idempotency key is an AIRA extension, not native A2A idempotency.

Completed-turn Pod replacement resumes the same ACP session and PVC. Mid-turn disconnects fail the task with `uncertainSideEffects: true` and `automaticRetry: false`; explicit follow-up work is required. Session restoration does not imply that retrying a potentially completed command is safe.

An ACP prompt completion means the harness turn ended. AIRA marks the A2A task complete only after the terminal turn event and artifact export succeed; it does not prove project-specific acceptance criteria unless the task itself runs and checks them.

## Migration And Rollback

Opening an older database performs additive migrations. Existing `thread_id` values are copied to `session_id`, and those workspaces are pinned to `codex-direct-v1`. Existing PVCs, Sandbox names, histories, and credentials are not deleted.

To roll back an ACP workspace, create a fresh workspace while `AIRA_DEFAULT_PROFILE=codex-direct-v1`. Automatic in-place profile changes are intentionally unsupported because their session formats and auth bindings may differ. To roll the controller code back, redeploy an earlier image; the added SQLite columns are backward-compatible and should be left in place.

## Gemini Portability Profile

Gemini CLI has maintained native ACP mode. The installed login currently fails before `initialize` with `UNSUPPORTED_CLIENT` / ineligible Code Assist tier, so no cross-agent compatibility claim is made. Gemini CLI `0.46.0` also has upstream reports affecting `session/load` and sequential prompts; revalidate those before treating it as production-compatible.

After obtaining an eligible existing Gemini login without changing billing, create the dedicated secret without printing it:

```bash
kubectl --kubeconfig .state/kubeconfig --context kind-aira-a2a-lab \
  -n aira-a2a-lab create secret generic aira-gemini-auth \
  --from-file="$HOME/.gemini/oauth_creds.json" \
  --from-file="$HOME/.gemini/google_accounts.json" \
  --from-file="$HOME/.gemini/settings.json"
```

Then set `AIRA_DEFAULT_PROFILE=gemini-acp-v1`, deploy, and use a fresh workspace. Do not migrate a Codex workspace into this profile.

## Editor Access

No editor bridge is implemented. A safe bridge needs an authenticated localhost client transport into the same coordinator, a per-workspace control lease, takeover only after completion or explicit cancellation, blocked workflow dispatch while held, and explicit return of control. Direct editor-to-runner attachment would bypass coordinator ownership and is unsupported. Real editor compatibility remains unverified.

## Security Boundaries

This remains a trusted local execution lab, not an untrusted-repository service. Pods share the kind node kernel. Runners are non-root, non-privileged, drop capabilities, deny privilege escalation, and receive no service-account token, Docker socket, host mounts, Kubernetes credentials, host home, or other workspace PVCs. The controller alone has namespace-scoped Sandbox/PVC RBAC.

kindnet does not enforce NetworkPolicy here, so outbound network isolation is not claimed. Codex workspace-write currently needs bubblewrap user namespaces blocked by Docker's default seccomp; runner `Unconfined` seccomp remains explicit in the Sandbox profile. The copied auth seed and public host CA are the only host-derived files mounted. Do not use this setup with untrusted repositories or broader credentials until network enforcement and sandbox hardening are in place.

`./scripts/cleanup.sh` suspends lab workloads while preserving PVCs. `./scripts/cleanup.sh --delete-data` deletes this lab cluster and its local-path data; it is never run automatically.

## Protocol References

- [Agent Client Protocol](https://agentclientprotocol.com/)
- [Maintained Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
- [A2A Protocol](https://a2a-protocol.org/)
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Gemini CLI ACP mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)
- [Gemini `session/load` issue](https://github.com/google-gemini/gemini-cli/issues/27913) and [sequential prompt issue](https://github.com/google-gemini/gemini-cli/issues/24017)
