#!/usr/bin/env bash
# Plant module: TDengine users + database `plant` + lab tables. Idempotent. Run as root on the TDengine host.
# Needs TD_ROOT_PASS, TD_RO_PASS, TD_SIM_PASS in $SPARKDBA_HOME/.env. Change TDengine's default root
# password first (taos -u root -ptaosdata -s "alter user root pass '...'") and put it in TD_ROOT_PASS.
# TDengine OSS has no GRANT: read-only for the agent is enforced by the td-connector SQL allowlist.
set -euo pipefail
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . "$H/.env"; set +a
td() { taos -u root -p"$TD_ROOT_PASS" -s "$1" >/dev/null; }
taos -u root -p"$TD_ROOT_PASS" -s "show users" | grep -q sparkdba_ro  || td "create user sparkdba_ro pass '$TD_RO_PASS'"
taos -u root -p"$TD_ROOT_PASS" -s "show users" | grep -q sparkdba_sim || td "create user sparkdba_sim pass '$TD_SIM_PASS'"
td "create database if not exists plant keep 30 duration 1"
cd "$H/app" && "$H/venv/bin/python" -c "from server import plant; print(plant.setup())"
