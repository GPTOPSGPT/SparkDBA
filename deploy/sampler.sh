#!/usr/bin/env bash
# PSH sampler (1 s) + PWR snapshots (10 min). Runs independently of the app.
H=${SPARKDBA_HOME:-/opt/sparkdba}
exec $H/app/skills/pg-workload-report/scripts/run.sh sample --every 1 --keep-min 180 --snap-every 600
