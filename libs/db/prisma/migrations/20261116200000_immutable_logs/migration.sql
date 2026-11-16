-- Corrige 20261116190504_sri_core: su "GRANT ... ON ALL TABLES" volvió a dar UPDATE/DELETE sobre audit_log.
-- REGLA para futuras migraciones: no usar GRANT ON ALL TABLES; los privilegios de tablas nuevas
-- ya llegan por ALTER DEFAULT PRIVILEGES (docker/postgres/init/01-roles.sh). Si se necesita, re-revocar aquí.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektra_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM vektra_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON electronic_document_event FROM vektra_app;
  END IF;
END $$;
