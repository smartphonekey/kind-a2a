#!/bin/sh
set -eu
mkdir -p /state/codex /state/workspace
if [ ! -s /state/codex/auth.json ]; then
  cp /auth-seed/auth.json /state/codex/auth.json
  chmod 600 /state/codex/auth.json
fi
exec node /app/runner.js
