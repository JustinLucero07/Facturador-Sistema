-- AlterTable
ALTER TABLE "device" ADD COLUMN     "app_version" VARCHAR(40),
ADD COLUMN     "created_by" UUID,
ADD COLUMN     "failed_ops" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_sync_at" TIMESTAMPTZ(3),
ADD COLUMN     "pairing_code_hash" CHAR(64),
ADD COLUMN     "pairing_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "pending_ops" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "revoked_at" TIMESTAMPTZ(3),
ADD COLUMN     "token_hash" CHAR(64);

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "device_id" UUID;

-- CreateTable
CREATE TABLE "sync_op" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "message" TEXT,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "client_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_op_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_op_device_id_processed_at_idx" ON "sync_op"("device_id", "processed_at" DESC);

-- CreateIndex
CREATE INDEX "sync_op_tenant_id_status_idx" ON "sync_op"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "device_token_hash_key" ON "device"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "device_pairing_code_hash_key" ON "device"("pairing_code_hash");

-- AddForeignKey
ALTER TABLE "sync_op" ADD CONSTRAINT "sync_op_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───── Fase 4: caja de escritorio ─────

-- RLS de la bitácora de sincronización (los permisos de tabla llegan por default privileges).
ALTER TABLE sync_op ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_op FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_op USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE INDEX "document_device_id_idx" ON "document"("device_id") WHERE device_id IS NOT NULL;

-- La caja se autentica con un token (o se vincula con un código) sin saber aún su empresa:
-- esta función busca SOLO por el hash y devuelve lo mínimo para fijar el contexto de la empresa.
-- SECURITY DEFINER: en producción el dueño del esquema debe tener BYPASSRLS (ver instance_usage).
CREATE OR REPLACE FUNCTION device_lookup(p_token_hash text, p_code_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, emission_point_id uuid, status varchar, pairing_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.tenant_id, d.emission_point_id, d.status, d.pairing_expires_at
  FROM device d
  WHERE (p_token_hash IS NOT NULL AND d.token_hash = p_token_hash)
     OR (p_code_hash IS NOT NULL AND d.pairing_code_hash = p_code_hash)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION device_lookup(text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektra_app') THEN
    GRANT EXECUTE ON FUNCTION device_lookup(text, text) TO vektra_app;
  END IF;
END $$;

-- Parámetros nuevos (editables; no se sobrescriben si ya existen).
INSERT INTO sri_setting (key, value, note, updated_at) VALUES
  ('desktop.max_offline_hours', '48', 'Horas que una caja de escritorio puede vender sin sincronizar con el servidor', now()),
  ('offline.send_deadline_hours', 'null', 'Plazo para enviar al SRI un comprobante emitido sin conexión (error 65 "Fecha de emisión extemporánea"). La Ficha v2.34 no lo fija: confirmar con el contador. null = solo alertar por antigüedad', now())
ON CONFLICT (key) DO NOTHING;
