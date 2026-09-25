#!/usr/bin/env bash
# Create database `lab`, the four SparkDBA roles and exactly the grants they need. Idempotent.
# Run as root on the database host:  SPARKDBA_HOME=/opt/sparkdba bash deploy/setup-postgres.sh
# Passwords come from $SPARKDBA_HOME/.env (PG_RO_PASS, PG_REPO_PASS, PG_OPS_PASS, PG_CHAOS_PASS);
# the port from PGPORT in that file (default 5432). Requires shared_preload_libraries = 'pg_stat_statements'.
set -euo pipefail
H=${SPARKDBA_HOME:-/opt/sparkdba}
set -a; . "$H/.env"; set +a
P=${PGPORT:-5432}
psql() { sudo -u postgres psql -p "$P" -v ON_ERROR_STOP=1 -q "$@"; }

psql -tc "select 1 from pg_database where datname='lab'" | grep -q 1 || psql -c "create database lab"
psql -v ro="$PG_RO_PASS" -v repo="$PG_REPO_PASS" -v ops="$PG_OPS_PASS" -v chaos="$PG_CHAOS_PASS" <<'SQL'
select format('create role %I login', r) from unnest(array['sparkdba_ro','sparkdba_repo','sparkdba_ops','sparkdba_chaos']) r
 where not exists (select from pg_roles where rolname = r) \gexec
alter role sparkdba_ro    password :'ro';
alter role sparkdba_repo  password :'repo';
alter role sparkdba_ops   password :'ops';
alter role sparkdba_chaos password :'chaos';

-- read-only diagnosis role: every agent read path
grant pg_monitor, pg_read_all_data to sparkdba_ro;
alter role sparkdba_ro set default_transaction_read_only = on;
alter role sparkdba_ro set statement_timeout = '10s';
-- workload repository writer (schema repo only)
grant pg_monitor, pg_read_all_stats to sparkdba_repo;
grant create on database lab to sparkdba_repo;
-- remediation catalog: signal backends, act as table owner, one ALTER SYSTEM parameter + reload
grant pg_monitor, pg_signal_backend, sparkdba_chaos to sparkdba_ops;
grant alter system on parameter idle_in_transaction_session_timeout to sparkdba_ops;
alter role sparkdba_ops set statement_timeout = '60s';
SQL
# function grants are per database, so they go in lab, where the app connects
psql -d lab <<'SQL'
create extension if not exists pg_stat_statements;
grant execute on function pg_reload_conf() to sparkdba_ops;
grant execute on function pg_stat_reset() to sparkdba_chaos;
grant create on schema public to sparkdba_chaos;
select format('grant execute on function %s to sparkdba_chaos', p.oid::regprocedure)
  from pg_proc p where p.proname = 'pg_stat_statements_reset' \gexec
SQL
echo "postgres ready on port $P"
