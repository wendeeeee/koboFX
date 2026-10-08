#!/bin/sh
# Postgres entrypoint hook: create fx_owner / fx_app from roles.sql.
set -eu

# SQL-escape single quotes, then escape sed replacement metacharacters (\ & |).
escape() { printf '%s' "$1" | sed -e "s/'/''/g" -e 's/[\\&|]/\\&/g'; }

owner_pw=$(escape "${FX_OWNER_PASSWORD:?FX_OWNER_PASSWORD is required}")
app_pw=$(escape "${FX_APP_PASSWORD:?FX_APP_PASSWORD is required}")

sed -e "s|{{FX_OWNER_PASSWORD}}|${owner_pw}|g" \
    -e "s|{{FX_APP_PASSWORD}}|${app_pw}|g" \
    /opt/kobofx/roles.sql \
  | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"
