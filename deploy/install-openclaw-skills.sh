#!/usr/bin/env bash
# OpenClaw harness: onboard once against the local vLLM (if not done yet), then copy the skills into its
# workspace (OpenClaw refuses symlinks that escape its root). Gateway: `bash deploy/restart.sh openclaw`.
set -euo pipefail
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . "$H/.env"; set +a
export OPENCLAW_HOME=${OPENCLAW_HOME:-$H/openclaw}
command -v openclaw >/dev/null || { echo "install OpenClaw first: npm i -g openclaw (Node >= 24.16)"; exit 1; }
if [ ! -f "$OPENCLAW_HOME/.openclaw/openclaw.json" ]; then
  mkdir -p "$OPENCLAW_HOME"
  openclaw onboard --non-interactive --accept-risk --mode local --flow quickstart \
    --auth-choice custom-api-key --custom-base-url http://127.0.0.1:8000/v1 --custom-model-id nemotron \
    --custom-text-input --custom-api-key none --gateway-port "${OPENCLAW_PORT:-8888}" --gateway-bind lan \
    --gateway-auth token --gateway-token "$SPARKDBA_TOKEN" --workspace "$OPENCLAW_HOME/workspace" \
    --skip-channels --skip-daemon --skip-search --skip-skills --skip-hooks --skip-ui --skip-health >/dev/null
  openclaw config set agents.defaults.thinkingDefault off >/dev/null
fi
W=$OPENCLAW_HOME/workspace/skills
mkdir -p "$W"
for d in "$H"/app/skills/*/; do
  n=$(basename "$d"); rm -rf "${W:?}/$n"; cp -a "$d" "$W/$n"
done
openclaw skills list --eligible 2>/dev/null | grep -E "ready" | grep -cE "(pg|td)-[a-z-]+" | xargs -I{} echo "{} SparkDBA skills eligible in OpenClaw"
