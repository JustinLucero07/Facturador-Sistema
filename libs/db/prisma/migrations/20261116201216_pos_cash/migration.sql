-- CreateEnum
CREATE TYPE "cash_session_status" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "cash_session_id" UUID;

-- AlterTable
ALTER TABLE "document_payment" ADD COLUMN     "cash_received" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "cash_session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "emission_point_id" UUID NOT NULL,
    "status" "cash_session_status" NOT NULL DEFAULT 'OPEN',
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_amount" DECIMAL(14,2) NOT NULL,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "expected" JSONB,
    "counted" JSONB,
    "denominations" JSONB,
    "difference" DECIMAL(14,2),
    "notes" TEXT,

    CONSTRAINT "cash_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "created_by" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "emission_point_id" UUID NOT NULL,
    "number" BIGINT NOT NULL,
    "buyer_id_type" CHAR(2) NOT NULL,
    "buyer_id" VARCHAR(20) NOT NULL,
    "buyer_name" VARCHAR(300) NOT NULL,
    "buyer_email" VARCHAR(300),
    "price_list_id" UUID,
    "lines" JSONB NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "valid_until" DATE NOT NULL,
    "notes" TEXT,
    "document_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_session_tenant_id_opened_at_idx" ON "cash_session"("tenant_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "quote_tenant_id_created_at_idx" ON "quote"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "quote_emission_point_id_number_key" ON "quote"("emission_point_id", "number");

-- CreateIndex
CREATE INDEX "document_cash_session_id_idx" ON "document"("cash_session_id");

-- AddForeignKey
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───── RLS (Fase 3) ─────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_session', 'cash_movement', 'quote'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END $$;

-- Una sola caja abierta por punto de emisión.
CREATE UNIQUE INDEX cash_session_one_open ON cash_session (emission_point_id) WHERE status = 'OPEN';

-- Los movimientos de caja no se editan ni borran.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektra_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON cash_movement FROM vektra_app;
  END IF;
END $$;
