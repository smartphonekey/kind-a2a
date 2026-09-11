#!/usr/bin/env bash
set -euo pipefail

base_url="${AIRA_URL:-http://127.0.0.1:8082}"
kubeconfig="${AGYN_KUBECONFIG:-$PWD/.state/agyn-kubeconfig}"

curl --fail --silent --show-error "$base_url/healthz" >/dev/null
curl --fail --silent --show-error "$base_url/.well-known/agent-card.json" >/dev/null

for task_id in "$@"; do
  runtime="$(curl --fail --silent --show-error "$base_url/tasks/$task_id/runtime")"
  printf '%s' "$runtime" | node -e '
    let data = "";
    process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => {
      const runtime = JSON.parse(data);
      if (runtime.provider !== "agyn" || runtime.profileId !== "codex-agyn-v1" || runtime.releaseAccepted !== true) process.exit(1);
    });'
  curl --fail --silent --show-error "$base_url/transcripts/$task_id" | node -e '
    let data = "";
    process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => {
      const secretKey = /^(token|authorization|api[_-]?key|secret)$/i;
      const tokenValue = /(?:sk-|sess-|eyJ)[A-Za-z0-9._-]{12,}/;
      const walk = value => {
        if (typeof value === "string") return tokenValue.test(value);
        if (Array.isArray(value)) return value.some(walk);
        if (value && typeof value === "object") return Object.entries(value).some(([key, child]) =>
          (secretKey.test(key) && typeof child === "string" && child !== "[REDACTED]") || walk(child));
        return false;
      };
      if (walk(JSON.parse(data))) process.exit(1);
    });'
done

if [[ -f "$kubeconfig" ]]; then
  for _ in $(seq 1 24); do
    pod_count="$(KUBECONFIG="$kubeconfig" kubectl -n agyn-workloads get pods --no-headers 2>/dev/null | wc -l)"
    [[ "$pod_count" -eq 0 ]] && break
    sleep 5
  done
  [[ "${pod_count:-1}" -eq 0 ]] || { echo "Agyn workload pods remain after the release window" >&2; exit 1; }
fi

echo "Agyn A2A verification passed"
