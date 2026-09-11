#!/bin/sh
set -eu
mkdir -p /state/workspace
case "${AIRA_PROFILE_ID:-codex-direct-v1}" in
  gemini-*)
    mkdir -p /state/gemini-home/.gemini
    if [ ! -s /state/gemini-home/.gemini/oauth_creds.json ]; then
      cp /auth-seed/* /state/gemini-home/.gemini/
      chmod 600 /state/gemini-home/.gemini/*
    fi
    ;;
  *)
    mkdir -p /state/codex
    if [ ! -s /state/codex/auth.json ]; then
      cp /auth-seed/auth.json /state/codex/auth.json
      chmod 600 /state/codex/auth.json
    fi
    ;;
esac
exec node /app/runner.js
