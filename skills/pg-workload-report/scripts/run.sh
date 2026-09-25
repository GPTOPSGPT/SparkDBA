#!/usr/bin/env bash
# Entry point for OpenClaw and the SparkDBA harness. Reads use the read-only role; setup/sample/snapshot the repo writer.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; . "${SPARKDBA_ENV:-${SPARKDBA_HOME:-/opt/sparkdba}/.env}"; set +a
export SPARKDBA_RO_DSN="host=${PG_HOST:-127.0.0.1} dbname=${PG_DB:-lab} user=sparkdba_ro password=${PG_RO_PASS}"
export SPARKDBA_REPO_DSN="host=${PG_HOST:-127.0.0.1} dbname=${PG_DB:-lab} user=sparkdba_repo password=${PG_REPO_PASS:-}"
exec "${SPARKDBA_PY:-${SPARKDBA_HOME:-/opt/sparkdba}/venv/bin/python}" "$DIR/pwr.py" "$@"
