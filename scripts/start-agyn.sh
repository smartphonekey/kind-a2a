#!/usr/bin/env bash
set -euo pipefail

profile="${AGYN_PROFILE:-local}"
whoami="$(agyn auth whoami --profile "$profile" -o json)"

json_field() {
  node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const value = JSON.parse(data)[process.argv[1]]; if (!value) process.exit(1); process.stdout.write(String(value)); });' "$1"
}

export AGYN_GATEWAY_URL="${AGYN_GATEWAY_URL:-$(printf '%s' "$whoami" | json_field gateway_url)}"
export AGYN_ORGANIZATION_ID="${AGYN_ORGANIZATION_ID:-$(printf '%s' "$whoami" | json_field organization)}"
export AGYN_IDENTITY_ID="${AGYN_IDENTITY_ID:-$(printf '%s' "$whoami" | json_field user_id)}"
export AGYN_TOKEN="${AGYN_TOKEN:-$(agyn profile token "$profile")}"
export AGYN_AGENT_HANDLE="${AGYN_AGENT_HANDLE:-@a2a-codex}"
if [[ -z "${NODE_EXTRA_CA_CERTS:-}" && -f "$HOME/.agyn/local/certs/agyn-local-ca.pem" ]]; then
  export NODE_EXTRA_CA_CERTS="$HOME/.agyn/local/certs/agyn-local-ca.pem"
fi
export AIRA_DB_PATH="${AIRA_DB_PATH:-$PWD/.state/agyn-controller.sqlite}"
export AIRA_PORT="${AIRA_PORT:-8082}"
export AIRA_PUBLIC_URL="${AIRA_PUBLIC_URL:-http://127.0.0.1:$AIRA_PORT}"

exec node dist/agyn-controller.js
