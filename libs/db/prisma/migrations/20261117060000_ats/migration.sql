-- Fase 8: datos para el ATS (Anexo Transaccional Simplificado)
ALTER TABLE "purchase" ADD COLUMN "sustento_code" CHAR(2);
ALTER TABLE "purchase" ADD COLUMN "payment_code" CHAR(2);
ALTER TABLE "purchase" ADD COLUMN "related_party" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "party" ADD COLUMN "person_type" CHAR(2);
ALTER TABLE "party" ADD COLUMN "related_party" BOOLEAN NOT NULL DEFAULT false;

-- Compras que ya tienen retención: tomar sustento, forma de pago y parte relacionada de ella
UPDATE "purchase" p
SET "sustento_code" = d."tax_summary"->>'sustentoCode',
    "payment_code" = d."tax_summary"->>'paymentCode',
    "related_party" = COALESCE((d."tax_summary"->>'relatedParty')::boolean, false)
FROM "document" d
WHERE d."purchase_id" = p."id" AND d."doc_type" = '07' AND d."status" = 'ISSUED';
