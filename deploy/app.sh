#!/usr/bin/env bash
# SparkDBA API + UI on port SPARKDBA_PORT (default 9000). Token-gated.
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . $H/.env; set +a
export SPARKDBA_DATA=$H/data SPARKDBA_JOURNAL=$H/data/remediation.jsonl
cd $H/app
TLS=()
# HTTPS when a certificate exists (deploy/make-tls.sh); plain HTTP otherwise.
[ -f "$H/tls/cert.pem" ] && TLS=(--ssl-certfile "$H/tls/cert.pem" --ssl-keyfile "$H/tls/key.pem")
exec $H/venv/bin/uvicorn server.app:app --host 0.0.0.0 --port ${SPARKDBA_PORT:-9000} --workers 1 "${TLS[@]}"
