-- AlterTable
ALTER TABLE "document" ADD COLUMN     "purchase_id" UUID;

-- CreateTable
CREATE TABLE "withholding_code" (
    "id" UUID NOT NULL,
    "tax" CHAR(1) NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "percentage" DECIMAL(5,2),
    "percentage_note" VARCHAR(300),
    "residence" VARCHAR(20) NOT NULL DEFAULT 'RESIDENT',
    "valid_from" DATE,
    "valid_to" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "withholding_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withholding_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "tax" CHAR(1) NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "base" DECIMAL(14,2) NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "withholding_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "withholding_code_tax_code_valid_from_key" ON "withholding_code"("tax", "code", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "withholding_line_document_id_line_no_key" ON "withholding_line"("document_id", "line_no");

-- CreateIndex
CREATE INDEX "document_purchase_id_idx" ON "document"("purchase_id");

-- AddForeignKey
ALTER TABLE "withholding_line" ADD CONSTRAINT "withholding_line_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───── Fase 6: RLS de las líneas de retención ─────
ALTER TABLE withholding_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE withholding_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON withholding_line USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
