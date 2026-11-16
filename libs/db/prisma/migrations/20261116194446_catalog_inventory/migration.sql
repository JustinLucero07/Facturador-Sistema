-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('INITIAL', 'PURCHASE', 'SALE', 'SALE_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_IN', 'TRANSFER_OUT');

-- AlterTable
ALTER TABLE "document_line" ADD COLUMN     "product_unit_id" UUID,
ADD COLUMN     "unit_factor" DECIMAL(18,6) NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "unit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "allows_decimal" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "parent_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(25) NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "category_id" UUID,
    "brand_id" UUID,
    "unit_id" UUID NOT NULL,
    "tax_rate_id" UUID NOT NULL,
    "aux_code" VARCHAR(25),
    "is_service" BOOLEAN NOT NULL DEFAULT false,
    "avg_cost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "last_cost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "min_stock" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "image_url" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_unit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,
    "is_base" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_barcode" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_unit_id" UUID,
    "barcode" VARCHAR(64) NOT NULL,

    CONSTRAINT "product_barcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_price" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "product_unit_id" UUID NOT NULL,
    "price" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "product_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "id_type" CHAR(2) NOT NULL,
    "identification" VARCHAR(20) NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "trade_name" VARCHAR(300),
    "email" VARCHAR(300),
    "phone" VARCHAR(30),
    "address" VARCHAR(300),
    "is_customer" BOOLEAN NOT NULL DEFAULT true,
    "is_supplier" BOOLEAN NOT NULL DEFAULT false,
    "price_list_id" UUID,
    "credit_limit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit_days" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock" (
    "tenant_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_pkey" PRIMARY KEY ("warehouse_id","product_id")
);

-- CreateTable
CREATE TABLE "inventory_movement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "type" "movement_type" NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_cost" DECIMAL(18,6) NOT NULL,
    "total_cost" DECIMAL(18,6) NOT NULL,
    "avg_cost_after" DECIMAL(18,6) NOT NULL,
    "balance_after" DECIMAL(18,6) NOT NULL,
    "document_id" UUID,
    "batch_id" UUID,
    "reason" VARCHAR(300),
    "created_by" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PREVIEW',
    "file_name" VARCHAR(300) NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "valid_count" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "rows" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMPTZ(3),

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unit_tenant_id_code_key" ON "unit"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "category_tenant_id_name_key" ON "category"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "brand_tenant_id_name_key" ON "brand"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_tenant_id_code_key" ON "price_list"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "product_tenant_id_name_idx" ON "product"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_tenant_id_code_key" ON "product"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "product_unit_product_id_unit_id_key" ON "product_unit"("product_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcode_tenant_id_barcode_key" ON "product_barcode"("tenant_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "product_price_price_list_id_product_unit_id_key" ON "product_price"("price_list_id", "product_unit_id");

-- CreateIndex
CREATE INDEX "party_tenant_id_name_idx" ON "party"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "party_tenant_id_identification_key" ON "party"("tenant_id", "identification");

-- CreateIndex
CREATE INDEX "stock_tenant_id_product_id_idx" ON "stock"("tenant_id", "product_id");

-- CreateIndex
CREATE INDEX "inventory_movement_tenant_id_product_id_at_idx" ON "inventory_movement"("tenant_id", "product_id", "at");

-- CreateIndex
CREATE INDEX "inventory_movement_warehouse_id_product_id_at_idx" ON "inventory_movement"("warehouse_id", "product_id", "at");

-- CreateIndex
CREATE INDEX "import_job_tenant_id_created_at_idx" ON "import_job"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_unit" ADD CONSTRAINT "product_unit_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcode" ADD CONSTRAINT "product_barcode_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcode" ADD CONSTRAINT "product_barcode_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price" ADD CONSTRAINT "product_price_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price" ADD CONSTRAINT "product_price_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price" ADD CONSTRAINT "product_price_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───── RLS de las tablas de catálogo, clientes e inventario (Fase 2) ─────
-- Los privilegios para vektra_app llegan por ALTER DEFAULT PRIVILEGES (no usar GRANT ON ALL TABLES).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'unit', 'category', 'brand', 'price_list', 'product', 'product_unit', 'product_barcode',
    'product_price', 'party', 'stock', 'inventory_movement', 'import_job'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END $$;

-- El kárdex es de solo inserción para la app (las correcciones se hacen con ajustes).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektra_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON inventory_movement FROM vektra_app;
  END IF;
END $$;

-- Búsqueda rápida por nombre (sin distinguir mayúsculas) para el POS y el buscador.
CREATE INDEX product_name_lower_idx ON product (tenant_id, lower(name) text_pattern_ops);
CREATE INDEX party_name_lower_idx ON party (tenant_id, lower(name) text_pattern_ops);
