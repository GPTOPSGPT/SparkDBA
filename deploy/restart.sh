#!/usr/bin/env bash
# (Re)start a SparkDBA service (vllm | app | sampler | plant | monitor | openclaw | eval) as a transient systemd unit.
# SPARKDBA_HOME picks the install (default /opt/sparkdba); SPARKDBA_UNIT names the units, so a second
# install on the same host (e.g. SPARKDBA_UNIT=sparkdba-fresh) never stops the first one's services.
H=${SPARKDBA_HOME:-/opt/sparkdba}
u=${SPARKDBA_UNIT:-sparkdba}-$1
shift_args=("${@:2}")
mkdir -p "$H/logs" "$H/data"
systemctl stop "$u" 2>/dev/null; sleep 1
systemd-run --unit="$u" --collect -p Restart=on-failure \
  -E SPARKDBA_HOME="$H" -E SPARKDBA_PORT="${SPARKDBA_PORT:-9000}" \
  -p StandardOutput=append:"$H/logs/$1.log" -p StandardError=append:"$H/logs/$1.log" \
  "$H/app/deploy/$1.sh" "${shift_args[@]}"
