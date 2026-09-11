#!/usr/bin/env bash
set -euo pipefail

lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kubeconfig="${AIRA_KUBECONFIG:-$lab_root/.state/kubeconfig}"
context="${AIRA_CONTEXT:-kind-aira-a2a-lab}"
namespace="${AIRA_NAMESPACE:-aira-a2a-lab}"
base_url="${AIRA_URL:-http://127.0.0.1:8081}"

curl --fail --silent "$base_url/healthz" | jq -e '.ok and (.defaultProfileId | type == "string")' >/dev/null
curl --fail --silent "$base_url/.well-known/agent-card.json" | jq -e '.version == "0.2.0" and .capabilities.streaming' >/dev/null

mapfile -t runners < <(kubectl --kubeconfig "$kubeconfig" --context "$context" -n "$namespace" get sandbox -o json |
  jq -r '.items[] | select((.spec.operatingMode // "Running") != "Suspended") | .metadata.name')
test "${#runners[@]}" -le 2

for runner in "${runners[@]}"; do
  kubectl --kubeconfig "$kubeconfig" --context "$context" -n "$namespace" exec "$runner" -- node -e \
    'fetch("http://127.0.0.1:8080/healthz").then(async response => { const health = await response.json(); if (!response.ok || health.capabilities.protocol !== "acp" || health.capabilities.fsCallbacks || health.capabilities.terminalCallbacks) process.exit(1); })'
done

for task_id in "$@"; do
  transcript="$(curl --fail --silent "$base_url/transcripts/$task_id")"
  printf '%s' "$transcript" | jq -e '.events | type == "array" and length > 0' >/dev/null
  if printf '%s' "$transcript" | grep -Eq '(sk-|sess-|eyJ)[A-Za-z0-9._-]{12,}'; then
    echo "credential-shaped value found in transcript $task_id" >&2
    exit 1
  fi
done

kubectl --kubeconfig "$kubeconfig" --context "$context" -n "$namespace" get sandbox,pvc
