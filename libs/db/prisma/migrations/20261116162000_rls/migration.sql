-- Row Level Security: aislamiento por empresa (tenant).
-- La app fija el contexto en cada transacción:
--   SELECT set_config('app.tenant_id', '<uuid>', true), set_config('app.user_id', '<uuid>', true);
-- Sin contexto, las políticas no devuelven filas (seguro por defecto).

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- Política estándar: solo filas de la empresa actual, lectura y escritura.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_module', 'role', 'role_permission', 'membership_role',
    'establishment', 'emission_point', 'sequence_counter', 'warehouse', 'device'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END $$;

-- Membership: el usuario puede ver sus propias membresías (necesario al iniciar sesión,
-- antes de elegir empresa); escribir solo dentro de la empresa actual.
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON membership FOR SELECT
  USING (tenant_id = app_current_tenant() OR user_id = app_current_user());
CREATE POLICY membership_write ON membership FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- Auditoría: eventos sin empresa (p. ej. intento de login con usuario inexistente) quedan con tenant NULL.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_isolation ON audit_log
  USING (tenant_id IS NOT DISTINCT FROM app_current_tenant())
  WITH CHECK (tenant_id IS NOT DISTINCT FROM app_current_tenant());

-- Endurecimiento del rol de aplicación (si existe en este servidor).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektra_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vektra_app;
    -- La bitácora es de solo inserción para la app.
    REVOKE UPDATE, DELETE ON audit_log FROM vektra_app;
    -- La app no toca el historial de migraciones.
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
      REVOKE ALL ON _prisma_migrations FROM vektra_app;
    END IF;
  END IF;
END $$;
