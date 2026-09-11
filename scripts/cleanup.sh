#!/usr/bin/env bash
set -euo pipefail
lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kubeconfig="$lab_root/.state/kubeconfig"
context="kind-aira-a2a-lab"
delete_data=false
if [[ "${1:-}" == "--delete-data" ]]; then delete_data=true; fi
if [[ "$delete_data" == true ]]; then
  kind delete cluster --name aira-a2a-lab
  rm -rf "$lab_root/.state"
else
  kubectl --kubeconfig "$kubeconfig" --context "$context" -n aira-a2a-lab scale deployment/aira-controller --replicas=0
  kubectl --kubeconfig "$kubeconfig" --context "$context" -n aira-a2a-lab patch sandboxes --all --type=merge -p '{"spec":{"operatingMode":"Suspended"}}' || true
  echo "Lab workloads are suspended and PVC-backed state is retained. Use --delete-data to delete only the lab cluster and local kubeconfig."
fi
