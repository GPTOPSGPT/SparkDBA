#!/usr/bin/env bash
# SparkDBA API + UI on port SPARKDBA_PORT (default 9000). Token-gated.
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . $H/.env; set +a
export SPARKDBA_DATA=$H/data SPARKDBA_JOURNAL=$H/data/remediation.jsonl
cd $H/app
exec $H/venv/bin/uvicorn server.app:app --host 0.0.0.0 --port ${SPARKDBA_PORT:-9000} --workers 1
