#!/bin/sh
# 10-databases-and-roles.sh — provision the two logical databases and their
# least-privilege owner roles, then enforce database-per-service isolation by
# CONNECT privilege. See infra/postgres/README.md for the ownership model.
#
# Runs ONCE, on an empty data dir, as the bootstrap superuser (POSTGRES_USER),
# via the official image's /docker-entrypoint-initdb.d hook. Passwords are read
# from the environment (compose injects them from .env) and are NEVER written to
# any committed file. Non-idempotent by design: init runs only on first boot.
set -e

# Roles, databases, and CONNECT-privilege isolation.
# The `balance` database already exists (created by the entrypoint from
# POSTGRES_DB); only `keycloak` is created here. Postgres grants CONNECT to
# PUBLIC by default, so it is revoked and granted back only to each owning role —
# this is the safety-critical isolation, not mere convention.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v balance_user="$POSTGRES_BALANCE_USER" \
  -v balance_password="$POSTGRES_BALANCE_PASSWORD" \
  -v keycloak_user="$POSTGRES_KEYCLOAK_USER" \
  -v keycloak_password="$POSTGRES_KEYCLOAK_PASSWORD" <<'EOSQL'
  CREATE ROLE :"balance_user"  WITH LOGIN PASSWORD :'balance_password';
  CREATE ROLE :"keycloak_user" WITH LOGIN PASSWORD :'keycloak_password';

  CREATE DATABASE keycloak OWNER :"keycloak_user";
  ALTER DATABASE balance   OWNER TO :"balance_user";

  REVOKE CONNECT ON DATABASE balance  FROM PUBLIC;
  REVOKE CONNECT ON DATABASE keycloak FROM PUBLIC;
  GRANT  CONNECT ON DATABASE balance  TO :"balance_user";
  GRANT  CONNECT ON DATABASE keycloak TO :"keycloak_user";
EOSQL

# Hand each owning role full control of its own `public` schema so it can create
# its tables/migrations later. PG15+ no longer grants CREATE on `public` to
# PUBLIC, so ownership + GRANT ALL is required for the app role to build its schema.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname balance \
  -v balance_user="$POSTGRES_BALANCE_USER" <<'EOSQL'
  ALTER SCHEMA public OWNER TO :"balance_user";
  GRANT ALL ON SCHEMA public TO :"balance_user";
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname keycloak \
  -v keycloak_user="$POSTGRES_KEYCLOAK_USER" <<'EOSQL'
  ALTER SCHEMA public OWNER TO :"keycloak_user";
  GRANT ALL ON SCHEMA public TO :"keycloak_user";
EOSQL
