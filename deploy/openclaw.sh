#!/usr/bin/env bash
# OpenClaw gateway with the SparkDBA skills, on port OPENCLAW_PORT (default 8888), token auth.
H=${SPARKDBA_HOME:-/opt/sparkdba}
export OPENCLAW_HOME=$H/openclaw
set -a; . $H/.env; set +a
exec openclaw gateway run --port ${OPENCLAW_PORT:-8888} --bind lan
