#!/bin/sh
# Se ejecuta UNA vez al crear el volumen de Postgres.
# - $POSTGRES_USER es dueño del esquema y ejecuta las migraciones.
# - vektra_app es el usuario con el que se conectan las apps: RLS SIEMPRE se aplica.
# - VEKTRA_EXTRA_DBS: bases adicionales (en desarrollo: "vektra_hub vektra_test").
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektra_app') THEN
      CREATE ROLE vektra_app LOGIN PASSWORD '${VEKTRA_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
  END \$\$;
SQL

for db in ${VEKTRA_EXTRA_DBS:-}; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "SELECT 'CREATE DATABASE \"$db\" OWNER \"$POSTGRES_USER\"' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$db')" \
    -tA | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres
done

for db in "$POSTGRES_DB" ${VEKTRA_EXTRA_DBS:-}; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-SQL
    GRANT CONNECT ON DATABASE "$db" TO vektra_app;
    GRANT USAGE ON SCHEMA public TO vektra_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vektra_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO vektra_app;
SQL
done
