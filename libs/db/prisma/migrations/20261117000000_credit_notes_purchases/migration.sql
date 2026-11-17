-- AlterEnum
ALTER TYPE "movement_type" ADD VALUE 'PURCHASE_RETURN';

-- AlterTable
ALTER TABLE "cash_movement" ADD COLUMN     "document_id" UUID;

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "reason" VARCHAR(300),
ADD COLUMN     "related_document_id" UUID;

-- AlterTable
ALTER TABLE "document_line" ADD COLUMN     "restock" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "source_line_id" UUID;

-- CreateTable
CREATE TABLE "purchase" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "doc_type" CHAR(2) NOT NULL DEFAULT '01',
    "number" VARCHAR(17) NOT NULL,
    "authorization" VARCHAR(49),
    "issue_date" DATE NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "total_discount" DECIMAL(14,2) NOT NULL,
    "total_tax" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "tax_summary" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'REGISTERED',
    "notes" TEXT,
    "from_xml" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "void_reason" VARCHAR(300),

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID,
    "product_unit_id" UUID,
    "unit_factor" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "supplier_code" VARCHAR(25),
    "description" VARCHAR(300) NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_cost" DECIMAL(18,6) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax_code" VARCHAR(2) NOT NULL DEFAULT '2',
    "percentage_code" VARCHAR(4) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "purchase_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_product_code" (
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_code" VARCHAR(25) NOT NULL,
    "product_id" UUID NOT NULL,
    "product_unit_id" UUID,

    CONSTRAINT "supplier_product_code_pkey" PRIMARY KEY ("supplier_id","supplier_code")
);

-- CreateIndex
CREATE INDEX "purchase_tenant_id_issue_date_idx" ON "purchase"("tenant_id", "issue_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_tenant_id_supplier_id_doc_type_number_key" ON "purchase"("tenant_id", "supplier_id", "doc_type", "number");

-- CreateIndex
CREATE INDEX "purchase_line_product_id_idx" ON "purchase_line"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_line_purchase_id_line_no_key" ON "purchase_line"("purchase_id", "line_no");

-- CreateIndex
CREATE INDEX "supplier_product_code_tenant_id_idx" ON "supplier_product_code"("tenant_id");

-- CreateIndex
CREATE INDEX "document_related_document_id_idx" ON "document"("related_document_id");

-- CreateIndex
CREATE INDEX "document_line_source_line_id_idx" ON "document_line"("source_line_id");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_related_document_id_fkey" FOREIGN KEY ("related_document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───── Fase 5: RLS de compras (los permisos llegan por default privileges) ─────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase', 'purchase_line', 'supplier_product_code'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
