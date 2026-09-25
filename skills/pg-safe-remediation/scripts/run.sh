#!/usr/bin/env bash
# Entry point for OpenClaw and the SparkDBA harness. Loads DSNs from the 0600 env file.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; . "${SPARKDBA_ENV:-${SPARKDBA_HOME:-/opt/sparkdba}/.env}"; set +a
export SPARKDBA_OPS_DSN="host=${PG_HOST:-127.0.0.1} dbname=${PG_DB:-lab} user=sparkdba_ops password=${PG_OPS_PASS}"
exec "${SPARKDBA_PY:-${SPARKDBA_HOME:-/opt/sparkdba}/venv/bin/python}" "$DIR/remediate.py" "$@"
