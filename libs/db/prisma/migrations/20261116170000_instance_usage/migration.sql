-- Uso total de la instalación (todas las empresas) para validar límites del plan y reportar al Hub.
-- SECURITY DEFINER: se ejecuta con los privilegios del dueño del esquema.
-- IMPORTANTE (producción): el rol dueño debe tener BYPASSRLS, porque las tablas usan FORCE ROW LEVEL SECURITY.
CREATE OR REPLACE FUNCTION instance_usage()
RETURNS TABLE (tenants bigint, establishments bigint, emission_points bigint, users bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (SELECT count(*) FROM tenant WHERE status = 'ACTIVE'),
    (SELECT count(*) FROM establishment WHERE active),
    (SELECT count(*) FROM emission_point WHERE active),
    (SELECT count(*) FROM app_user WHERE active AND NOT is_support);
$$;

REVOKE ALL ON FUNCTION instance_usage() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektra_app') THEN
    GRANT EXECUTE ON FUNCTION instance_usage() TO vektra_app;
  END IF;
END $$;
