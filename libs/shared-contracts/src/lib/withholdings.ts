import { z } from 'zod';
import { uuidSchema } from './common';
import type { EDocStatusCode } from './einvoice';

const money2 = (label: string) =>
  z
    .union([z.number(), z.string().trim()])
    .transform((v) => String(v).replace(',', '.'))
    .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), `${label}: número inválido (máximo 2 decimales)`);

/** Comprobante de retención (07) sobre una compra registrada. */
export const withholdingSchema = z.object({
  purchaseId: uuidSchema,
  emissionPointId: uuidSchema,
  /** Catálogo ATS, Tabla 5 */
  sustentoCode: z.string().regex(/^\d{2}$/, 'Elija el sustento tributario'),
  /** Tabla 24 de la Ficha: cómo se pagó la compra */
  paymentCode: z.string().regex(/^\d{2}$/, 'Elija la forma de pago'),
  /** ¿El proveedor es parte relacionada? */
  relatedParty: z.boolean().default(false),
  items: z
    .array(
      z.object({
        withholdingCodeId: uuidSchema,
        base: money2('Base imponible'),
        /** Solo para códigos de porcentaje variable */
        percentage: money2('Porcentaje').nullable().optional(),
      }),
    )
    .min(1, 'Agregue al menos una retención')
    .max(20),
});
export type WithholdingRequest = z.input<typeof withholdingSchema>;
export type WithholdingParsed = z.output<typeof withholdingSchema>;

export interface WithholdingCodeItem {
  id: string;
  /** 1 renta, 2 IVA, 6 ISD */
  tax: string;
  code: string;
  description: string;
  percentage: string | null;
  percentageNote: string | null;
  residence: string;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
}

export const withholdingCodeSchema = z.object({
  tax: z.enum(['1', '2', '6']),
  code: z.string().trim().min(1).max(10),
  description: z.string().trim().min(3).max(500),
  percentage: money2('Porcentaje').nullable().optional(),
  percentageNote: z.string().trim().max(300).nullable().optional(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  active: z.boolean().default(true),
});
export type WithholdingCodeRequest = z.input<typeof withholdingCodeSchema>;

/** Datos para preparar la retención de una compra. */
export interface WithholdingDraft {
  purchase: {
    id: string;
    number: string;
    docType: string;
    issueDate: string;
    supplier: { id: string; idType: string; identification: string; name: string; email: string | null };
    subtotal: string;
    /** IVA de la compra (base de la retención de IVA) */
    iva: string;
    total: string;
  };
  /** Última retención hecha a este proveedor (para sugerir) */
  previous: { sustentoCode: string; paymentCode: string | null; relatedParty?: boolean; items: { withholdingCodeId: string; percentage: string }[] } | null;
  existing: { id: string; number: string; total: string; status: EDocStatusCode }[];
  sustento: { code: string; description: string }[];
}

export interface WithholdingView {
  tax: string;
  code: string;
  description: string;
  base: string;
  percentage: string;
  amount: string;
}
