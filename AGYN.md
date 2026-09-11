# Agyn Backend

Agyn is the preferred execution backend for this lab. Agyn provides the self-hosted Kubernetes control plane, Codex runtime, per-agent persistent volumes, workload networking, and instance pause/resume lifecycle. This repository supplies the missing A2A adapter and durable A2A-task-to-Agyn-instance mapping.

## Install And Provision

Install the current Agyn CLI and its local prerequisites, then create the local platform:

```bash
brew install agynio/tap/agyn lima xz
agyn local doctor
agyn local start --no-ca
agyn local upgrade
agyn auth login --profile local
agyn organizations select --profile local
```

In Agyn, provision an operator-controlled Codex agent with:

- native LLM mode and a Codex runtime image;
- an OpenAI/ChatGPT subscription attached through an Agyn subscription secret;
- one persistent volume definition mounted at `/workspace`;
- an idle timeout suitable for the local lab (30 seconds here);
- final messages delivered to the default thread;
- handle `@a2a-codex` (or set `AGYN_AGENT_HANDLE`).

The checked-in adapter never accepts an executable, image, secret binding, or Agyn agent handle from an A2A request. Rotate the Agyn subscription when its stored access token expires. Do not put the token in this repository or an A2A message.

Export the Agyn VM kubeconfig only for operational verification:

```bash
mkdir -p .state
agyn local kubeconfig > .state/agyn-kubeconfig
```

## Run

```bash
npm ci
npm run build
npm run start:agyn
```

The start script derives the Gateway URL, organization, identity and bearer token from `AGYN_PROFILE` (default `local`). It listens on `127.0.0.1:8082` by default. Override `AGYN_AGENT_HANDLE`, `AIRA_PORT`, or `AIRA_DB_PATH` in the operator environment when needed.

```bash
AIRA_URL=http://127.0.0.1:8082 npm run client -- submit \
  "Create a function and tests" unique-request-key
AIRA_URL=http://127.0.0.1:8082 npm run client -- continue <task-id> \
  "Continue in the same workspace" unique-continuation-key
AIRA_URL=http://127.0.0.1:8082 npm run client -- finish <task-id> \
  "Run the tests and report the result" unique-finish-key
AIRA_URL=http://127.0.0.1:8082 npm run client -- cancel <task-id>
```

Ordinary successful turns end in A2A `INPUT_REQUIRED`, request an Agyn pause, and retain the task's thread, instance and PVC. A later message resumes that exact instance. `finish` sets `metadata.endTask=true`, resulting in A2A `COMPLETED` after the response and pause request. Agyn removes the workload pod asynchronously while retaining the PVC.

Each new A2A task creates a new Agyn thread and instance. Agyn therefore schedules concurrent tasks as separate Kubernetes workloads. The adapter persists the binding before sending the first prompt, so cancellation and process recovery can still locate the instance.

## Verification

```bash
npm test
AIRA_URL=http://127.0.0.1:8082 ./scripts/verify-agyn.sh <task-id> [<task-id> ...]
```

The live verifier checks discovery, adapter/runtime identity, accepted release state, transcript credential patterns and, when the Agyn kubeconfig exists, actual scale-to-zero of workload pods.

## Boundaries

- Agyn has no native A2A server, so `src/agyn-controller.ts` and the A2A/ConnectRPC translation are local code.
- The adapter currently exports the agent's response text as its A2A artifact; arbitrary workspace file export remains a separate policy-controlled feature.
- The current Agyn Codex daemon configures noninteractive `approval_policy=never`. The earlier ACP backend supports explicit coordinator approvals; the Agyn backend does not currently provide equivalent human approval requests.
- Agyn pause is cooperative. Cancellation requests a pause and marks side effects uncertain; a command already executing may finish before its pod exits. It must not be automatically retried.
- Completed-turn recovery is live tested. Automatic reconciliation of an adapter crash during an in-flight turn is not implemented; that case remains uncertain and requires explicit operator recovery.
- This remains a trusted local execution lab. Agyn improves lifecycle ownership and private workload networking, but its containers share the local VM kernel and should not receive unrelated credentials or untrusted repositories without further hardening.
