-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('ISSUED', 'VOIDED');

-- CreateEnum
CREATE TYPE "edoc_status" AS ENUM ('DRAFT', 'SIGNED', 'SENT', 'RECEIVED', 'RETURNED', 'AUTHORIZED', 'NOT_AUTHORIZED', 'CONTINGENCY');

-- CreateEnum
CREATE TYPE "email_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL,
    "tax_code" VARCHAR(2) NOT NULL,
    "percentage_code" VARCHAR(4) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "rate" DECIMAL(6,2) NOT NULL,
    "valid_from" DATE,
    "valid_to" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sri_catalog" (
    "catalog" VARCHAR(40) NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sri_catalog_pkey" PRIMARY KEY ("catalog","code")
);

-- CreateTable
CREATE TABLE "sri_setting" (
    "key" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "note" VARCHAR(300),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sri_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "certificate" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "p12_enc" TEXT NOT NULL,
    "password_enc" TEXT NOT NULL,
    "subject" VARCHAR(500) NOT NULL,
    "issuer" VARCHAR(500) NOT NULL,
    "serial_number" VARCHAR(80) NOT NULL,
    "holder_name" VARCHAR(300) NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "valid_to" TIMESTAMPTZ(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "alerts_sent" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_config" (
    "tenant_id" UUID NOT NULL,
    "host" VARCHAR(200) NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "username" VARCHAR(200),
    "password_enc" TEXT,
    "from_name" VARCHAR(200) NOT NULL,
    "from_email" VARCHAR(254) NOT NULL,
    "reply_to" VARCHAR(254),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mail_config_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "doc_type" CHAR(2) NOT NULL,
    "establishment_id" UUID NOT NULL,
    "emission_point_id" UUID NOT NULL,
    "sequential" BIGINT NOT NULL,
    "issue_date" DATE NOT NULL,
    "buyer_id_type" CHAR(2) NOT NULL,
    "buyer_id" VARCHAR(20) NOT NULL,
    "buyer_name" VARCHAR(300) NOT NULL,
    "buyer_address" VARCHAR(300),
    "buyer_email" VARCHAR(300),
    "buyer_phone" VARCHAR(30),
    "subtotal" DECIMAL(14,2) NOT NULL,
    "total_discount" DECIMAL(14,2) NOT NULL,
    "total_tax" DECIMAL(14,2) NOT NULL,
    "tip" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "tax_summary" JSONB NOT NULL,
    "additional_info" JSONB NOT NULL DEFAULT '[]',
    "status" "document_status" NOT NULL DEFAULT 'ISSUED',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID,
    "main_code" VARCHAR(25),
    "aux_code" VARCHAR(25),
    "description" VARCHAR(300) NOT NULL,
    "unit" VARCHAR(50),
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_price" DECIMAL(18,6) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "additional" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "document_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_line_tax" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "tax_rate_id" UUID,
    "tax_code" VARCHAR(2) NOT NULL,
    "percentage_code" VARCHAR(4) NOT NULL,
    "rate" DECIMAL(6,2) NOT NULL,
    "base" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "document_line_tax_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "sri_code" CHAR(2) NOT NULL,
    "method" VARCHAR(30) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "term" INTEGER,
    "time_unit" VARCHAR(10),
    "reference" VARCHAR(100),

    CONSTRAINT "document_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "electronic_document" (
    "document_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "access_key" CHAR(49) NOT NULL,
    "environment" SMALLINT NOT NULL,
    "doc_type" CHAR(2) NOT NULL,
    "xml_version" VARCHAR(10) NOT NULL,
    "status" "edoc_status" NOT NULL DEFAULT 'DRAFT',
    "signed_xml" TEXT,
    "authorized_xml" TEXT,
    "authorization_number" VARCHAR(49),
    "authorized_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_messages" JSONB NOT NULL DEFAULT '[]',
    "email_status" "email_status" NOT NULL DEFAULT 'PENDING',
    "email_sent_at" TIMESTAMPTZ(3),
    "email_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "electronic_document_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "electronic_document_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "from_status" "edoc_status",
    "to_status" "edoc_status" NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "electronic_document_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_tax_code_percentage_code_valid_from_key" ON "tax_rate"("tax_code", "percentage_code", "valid_from");

-- CreateIndex
CREATE INDEX "certificate_tenant_id_active_idx" ON "certificate"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "document_tenant_id_issue_date_idx" ON "document"("tenant_id", "issue_date" DESC);

-- CreateIndex
CREATE INDEX "document_tenant_id_buyer_id_idx" ON "document"("tenant_id", "buyer_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_emission_point_id_doc_type_sequential_key" ON "document"("emission_point_id", "doc_type", "sequential");

-- CreateIndex
CREATE UNIQUE INDEX "document_line_document_id_line_no_key" ON "document_line"("document_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "electronic_document_access_key_key" ON "electronic_document"("access_key");

-- CreateIndex
CREATE INDEX "electronic_document_tenant_id_status_idx" ON "electronic_document"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "electronic_document_event_document_id_at_idx" ON "electronic_document_event"("document_id", "at");

-- AddForeignKey
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_config" ADD CONSTRAINT "mail_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_establishment_id_fkey" FOREIGN KEY ("establishment_id") REFERENCES "establishment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_emission_point_id_fkey" FOREIGN KEY ("emission_point_id") REFERENCES "emission_point"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_line" ADD CONSTRAINT "document_line_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_line_tax" ADD CONSTRAINT "document_line_tax_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "document_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_payment" ADD CONSTRAINT "document_payment_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "electronic_document" ADD CONSTRAINT "electronic_document_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "electronic_document_event" ADD CONSTRAINT "electronic_document_event_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "electronic_document"("document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───── RLS para las tablas por empresa de la Fase 1 ─────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'certificate', 'mail_config', 'document', 'document_line', 'document_line_tax',
    'document_payment', 'electronic_document', 'electronic_document_event'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END $$;

-- El historial de estados del SRI es de solo inserción para la app (igual que la auditoría).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektra_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vektra_app;
    REVOKE UPDATE, DELETE ON electronic_document_event FROM vektra_app;
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
      REVOKE ALL ON _prisma_migrations FROM vektra_app;
    END IF;
  END IF;
END $$;
