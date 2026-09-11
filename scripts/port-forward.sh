#!/usr/bin/env bash
set -euo pipefail
lab_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kubectl --kubeconfig "$lab_root/.state/kubeconfig" --context kind-aira-a2a-lab -n aira-a2a-lab port-forward service/aira-controller 8081:8081
