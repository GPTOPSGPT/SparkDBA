#!/usr/bin/env bash
# Post-install check: seed the lab tables, then inject every PostgreSQL fault and classify it (PASS per scenario).
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . "$H/.env"; set +a
export SPARKDBA_DATA=$H/data SPARKDBA_JOURNAL=$H/data/remediation.jsonl SPARKDBA_ENV=$H/.env SPARKDBA_PY=$H/venv/bin/python
cd "$H/app"
"$H/venv/bin/python" -c "from server import chaos; chaos.setup()" && exec "$H/venv/bin/python" -m server.smoke "$@"
