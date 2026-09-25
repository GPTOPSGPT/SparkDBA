#!/usr/bin/env bash
# td-realtime-monitor evaluator: checks every monitor every 5 s, journals alerts.
H=${SPARKDBA_HOME:-/opt/sparkdba}
exec $H/app/skills/td-realtime-monitor/scripts/run.sh run --every 5
