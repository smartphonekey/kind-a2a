#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
cd "$(dirname "$0")/.."

export A2A_SERVICE_CONFIG_FILE="${A2A_SERVICE_CONFIG_FILE:-$PWD/.state/a2a-web/service.json}"
if [[ ! -f "$A2A_SERVICE_CONFIG_FILE" || ! -f web/dist/index.html ]]; then
  printf '%s\n' 'A service configuration and built web app are required. See WEB.md.' >&2
  exit 1
fi
profile="${AGYN_PROFILE:-local}"
whoami="$(agyn auth whoami --profile "$profile" -o json)"
json_field() {
  node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const value = JSON.parse(data)[process.argv[1]]; if (!value) process.exit(1); process.stdout.write(String(value)); });' "$1"
}
export AGYN_GATEWAY_URL="${AGYN_GATEWAY_URL:-$(printf '%s' "$whoami" | json_field gateway_url)}"
export AGYN_ORGANIZATION_ID="${AGYN_ORGANIZATION_ID:-$(printf '%s' "$whoami" | json_field organization)}"
export AGYN_IDENTITY_ID="${AGYN_IDENTITY_ID:-$(printf '%s' "$whoami" | json_field user_id)}"
export AGYN_TOKEN="${AGYN_TOKEN:-$(agyn profile token "$profile")}"
if [[ -z "${NODE_EXTRA_CA_CERTS:-}" && -f "$HOME/.agyn/local/certs/agyn-local-ca.pem" ]]; then
  export NODE_EXTRA_CA_CERTS="$HOME/.agyn/local/certs/agyn-local-ca.pem"
fi
exec node dist/service/main.js
