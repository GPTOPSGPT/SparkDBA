#!/usr/bin/env bash
# Self-signed TLS certificate for the app (used by deploy/app.sh when present).
# The node's public address comes from PUBLIC_IP in $SPARKDBA_HOME/.env, never from the repo.
# A trusted certificate (Let's Encrypt) needs port 80 or 443 reachable for validation; use one when you have it
# by dropping cert.pem / key.pem into $SPARKDBA_HOME/tls instead.
set -euo pipefail
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . "$H/.env"; set +a
mkdir -p "$H/tls"; chmod 700 "$H/tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
  -subj "/CN=SparkDBA" -addext "subjectAltName=IP:${PUBLIC_IP:?set PUBLIC_IP in .env},IP:127.0.0.1" \
  -keyout "$H/tls/key.pem" -out "$H/tls/cert.pem" 2>/dev/null
chmod 600 "$H/tls/key.pem"
openssl x509 -in "$H/tls/cert.pem" -noout -subject -ext subjectAltName -enddate
