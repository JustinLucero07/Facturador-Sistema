-- CreateTable
CREATE TABLE "account_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "side" VARCHAR(2) NOT NULL,
    "party_id" UUID NOT NULL,
    "source_type" VARCHAR(20) NOT NULL,
    "source_id" UUID,
    "number" VARCHAR(40) NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "notes" VARCHAR(300),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_movement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "side" VARCHAR(2) NOT NULL,
    "party_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "date" DATE NOT NULL,
    "method" VARCHAR(30),
    "amount" DECIMAL(14,2) NOT NULL,
    "unapplied" DECIMAL(14,2) NOT NULL,
    "reference" VARCHAR(100),
    "document_id" UUID,
    "cash_movement_id" UUID,
    "data" JSONB,
    "notes" VARCHAR(300),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "void_reason" VARCHAR(300),

    CONSTRAINT "account_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_allocation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_item_tenant_id_side_party_id_status_idx" ON "account_item"("tenant_id", "side", "party_id", "status");

-- CreateIndex
CREATE INDEX "account_item_tenant_id_side_due_date_idx" ON "account_item"("tenant_id", "side", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "account_item_side_source_type_source_id_key" ON "account_item"("side", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "account_movement_tenant_id_side_party_id_date_idx" ON "account_movement"("tenant_id", "side", "party_id", "date");

-- CreateIndex
CREATE INDEX "account_movement_document_id_idx" ON "account_movement"("document_id");

-- CreateIndex
CREATE INDEX "account_allocation_item_id_idx" ON "account_allocation"("item_id");

-- CreateIndex
CREATE INDEX "account_allocation_movement_id_idx" ON "account_allocation"("movement_id");

-- AddForeignKey
ALTER TABLE "account_allocation" ADD CONSTRAINT "account_allocation_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "account_movement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_allocation" ADD CONSTRAINT "account_allocation_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "account_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───── Fase 7: RLS del libro de cuentas ─────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_item', 'account_movement', 'account_allocation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
