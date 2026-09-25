#!/usr/bin/env bash
# Entry point for OpenClaw / Hermes / the SparkDBA harness. Uses the td-connector's guarded read path.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; . "${SPARKDBA_ENV:-${SPARKDBA_HOME:-/opt/sparkdba}/.env}"; set +a
export PYTHONPATH="$DIR/../../td-connector/scripts:$DIR${PYTHONPATH:+:$PYTHONPATH}"
exec "${SPARKDBA_PY:-${SPARKDBA_HOME:-/opt/sparkdba}/venv/bin/python}" "$DIR/monitor.py" "$@"
