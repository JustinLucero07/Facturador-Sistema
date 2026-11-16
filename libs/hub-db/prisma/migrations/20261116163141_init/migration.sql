-- CreateEnum
CREATE TYPE "installation_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "hub_user" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "price_monthly" DECIMAL(10,2) NOT NULL,
    "price_yearly" DECIMAL(10,2),
    "limits" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" UUID NOT NULL,
    "ruc" VARCHAR(13) NOT NULL,
    "legal_name" VARCHAR(300) NOT NULL,
    "trade_name" VARCHAR(300),
    "contact_name" VARCHAR(200),
    "email" VARCHAR(254),
    "phone" VARCHAR(30),
    "city" VARCHAR(80),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installation" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "public_id" VARCHAR(64) NOT NULL,
    "secret_hash" VARCHAR(64) NOT NULL,
    "base_url" VARCHAR(300),
    "status" "installation_status" NOT NULL DEFAULT 'ACTIVE',
    "grace_hours" INTEGER NOT NULL DEFAULT 48,
    "limit_overrides" JSONB,
    "last_seen_at" TIMESTAMPTZ(3),
    "last_ip" VARCHAR(64),
    "app_version" VARCHAR(40),
    "last_report" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_issue" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "issued_by" UUID,

    CONSTRAINT "license_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hub_user_email_key" ON "hub_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "plan_code_key" ON "plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "client_ruc_key" ON "client"("ruc");

-- CreateIndex
CREATE UNIQUE INDEX "installation_public_id_key" ON "installation"("public_id");

-- CreateIndex
CREATE INDEX "license_issue_installation_id_issued_at_idx" ON "license_issue"("installation_id", "issued_at" DESC);

-- AddForeignKey
ALTER TABLE "installation" ADD CONSTRAINT "installation_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation" ADD CONSTRAINT "installation_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_issue" ADD CONSTRAINT "license_issue_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
