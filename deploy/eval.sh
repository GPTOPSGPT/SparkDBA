#!/usr/bin/env bash
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . $H/.env; set +a
export SPARKDBA_DATA=$H/data SPARKDBA_JOURNAL=$H/data/remediation.jsonl PYTHONUNBUFFERED=1
cd $H/app
exec $H/venv/bin/python -m evals.run "$@"
