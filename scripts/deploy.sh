#!/usr/bin/env bash
set -euo pipefail
lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="$lab_root/.state"
kubeconfig="$state_dir/kubeconfig"
context="kind-aira-a2a-lab"
mkdir -p "$state_dir"
if ! kubectl --kubeconfig "$kubeconfig" --context "$context" get nodes >/dev/null 2>&1; then
  kind create cluster --name aira-a2a-lab --config "$lab_root/kind-config.yaml" --kubeconfig "$kubeconfig"
fi
kubectl --kubeconfig "$kubeconfig" --context "$context" apply -f "$lab_root/manifests/namespace.yaml"
kubectl --kubeconfig "$kubeconfig" --context "$context" label namespace aira-a2a-lab pod-security.kubernetes.io/enforce- pod-security.kubernetes.io/audit- pod-security.kubernetes.io/warn-
kubectl --kubeconfig "$kubeconfig" --context "$context" apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2/sandbox.yaml"
kubectl --kubeconfig "$kubeconfig" --context "$context" -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
if [[ ! -f "$HOME/.codex/auth.json" ]]; then
  echo "Expected ChatGPT subscription credentials at $HOME/.codex/auth.json; run codex login first." >&2
  exit 1
fi
if ! kubectl --kubeconfig "$kubeconfig" --context "$context" -n aira-a2a-lab get secret aira-codex-auth >/dev/null 2>&1; then
  kubectl --kubeconfig "$kubeconfig" --context "$context" -n aira-a2a-lab create secret generic aira-codex-auth --from-file=auth.json="$HOME/.codex/auth.json"
fi
kubectl --kubeconfig "$kubeconfig" --context "$context" -n aira-a2a-lab create configmap aira-host-ca \
  --from-file=ca-certificates.crt=/etc/ssl/certs/ca-certificates.crt --dry-run=client -o yaml | \
  kubectl --kubeconfig "$kubeconfig" --context "$context" apply -f -
docker build -f "$lab_root/Dockerfile.runner" -t aira-a2a-runner:0.1.0 "$lab_root"
docker build -f "$lab_root/Dockerfile.controller" -t aira-a2a-controller:0.1.0 "$lab_root"
kind load docker-image --name aira-a2a-lab --nodes aira-a2a-lab-control-plane aira-a2a-runner:0.1.0 aira-a2a-controller:0.1.0
kubectl --kubeconfig "$kubeconfig" --context "$context" apply -f "$lab_root/manifests/rbac.yaml"
kubectl --kubeconfig "$kubeconfig" --context "$context" apply -f "$lab_root/manifests/controller.yaml"
kubectl --kubeconfig "$kubeconfig" --context "$context" -n aira-a2a-lab rollout restart deployment/aira-controller
kubectl --kubeconfig "$kubeconfig" --context "$context" -n aira-a2a-lab rollout status deployment/aira-controller --timeout=180s
echo "Run in a separate terminal: $lab_root/scripts/port-forward.sh"
