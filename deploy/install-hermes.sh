#!/usr/bin/env bash
# Hermes Agent harness: own venv (created if missing), pointed at the local vLLM, same skills (copied).
set -euo pipefail
H=${SPARKDBA_HOME:-/opt/sparkdba}
export HERMES_HOME=${HERMES_HOME:-$H/hermes}
HB=$H/hermes-venv/bin/hermes
if [ ! -x "$HB" ]; then
  python3 -m venv "$H/hermes-venv"
  "$H/hermes-venv/bin/pip" install -q ${PIP_INDEX_URL:+-i "$PIP_INDEX_URL"} hermes-agent==0.19.0
fi
mkdir -p "$HERMES_HOME/skills"
"$HB" config set model.provider custom >/dev/null
"$HB" config set model.base_url http://127.0.0.1:8000/v1 >/dev/null
"$HB" config set model.default nemotron >/dev/null
"$HB" config set model.context_length 65536 >/dev/null
"$HB" config set model.max_tokens 4096 >/dev/null     # else it asks vLLM for 65536 output tokens and every call 400s
grep -q '^OPENAI_API_KEY=' "$HERMES_HOME/.env" 2>/dev/null || echo 'OPENAI_API_KEY=local-vllm' >> "$HERMES_HOME/.env"
for d in "$H"/app/skills/*/; do
  n=$(basename "$d"); rm -rf "${HERMES_HOME:?}/skills/$n"; cp -a "$d" "$HERMES_HOME/skills/$n"
done
"$HB" skills list 2>/dev/null | grep -cE "(pg|td)-[a-z-]+" | xargs -I{} echo "{} SparkDBA skills enabled in Hermes"
