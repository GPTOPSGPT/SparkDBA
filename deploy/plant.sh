#!/usr/bin/env bash
# Plant telemetry writer (TDengine, 1 row/device/s). Faults are switched via data/plant_control.json.
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . $H/.env; set +a
export SPARKDBA_DATA=$H/data
cd $H/app
exec $H/venv/bin/python -m server.plant serve
