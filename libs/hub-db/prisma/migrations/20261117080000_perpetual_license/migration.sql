-- Pago único: licencia permanente atada a los RUC autorizados de cada instalación
ALTER TABLE "installation" ADD COLUMN "rucs" VARCHAR(13)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(13)[];
ALTER TABLE "license_issue" ALTER COLUMN "expires_at" DROP NOT NULL;

-- Instalaciones existentes: autorizar el RUC del cliente
UPDATE "installation" i SET "rucs" = ARRAY[c."ruc"] FROM "client" c WHERE c."id" = i."client_id" AND cardinality(i."rucs") = 0;
