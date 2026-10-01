#!/usr/bin/env bash
# Local-only helper: creates DUMMY roles/databases for development and tests.
# Requires a running PostgreSQL (16+) and superuser access via `sudo -u postgres` or $PGADMIN_URL.
set -euo pipefail

PW="${PANTAU_DB_PASSWORD:-pantau_dev_pw}"

su postgres -c "psql -v ON_ERROR_STOP=1" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pantau_owner') THEN
    CREATE ROLE pantau_owner LOGIN PASSWORD '${PW}' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pantau_app') THEN
    CREATE ROLE pantau_app LOGIN PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS;
  END IF;
END \$\$;
-- dummy password so the integration tests can connect over TCP as the superuser (local dev only)
ALTER ROLE postgres PASSWORD 'postgres';
SQL
su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='pantau'\"" | grep -q 1 \
  || su postgres -c "createdb -O pantau_owner pantau"
echo "roles pantau_owner / pantau_app and database 'pantau' are ready"
