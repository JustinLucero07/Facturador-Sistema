import { z } from 'zod';
import { uuidSchema } from './common';

const money = (label: string) =>
  z
    .union([z.number(), z.string().trim()])
    .transform((v) => String(v).replace(',', '.'))
    .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), `${label}: valor inválido`);

/** Medio de pago interno → código de la Tabla 24 del SRI (parámetro `payment_methods`, editable). */
export interface PaymentMethodDef {
  method: string;
  label: string;
  sriCode: string;
  /** Requiere cliente identificado con crédito (cuenta por cobrar) */
  credit?: boolean;
  /** Es efectivo: cuenta para el arqueo y calcula vuelto */
  cash?: boolean;
  /** Pide número de referencia (voucher, transferencia) */
  reference?: boolean;
}

// ───────── Caja ─────────

export const openCashSchema = z.object({
  emissionPointId: uuidSchema,
  openingAmount: money('Monto de apertura'),
});
export type OpenCashRequest = z.input<typeof openCashSchema>;

export const cashMovementSchema = z.object({
  type: z.enum(['IN', 'OUT']),
  amount: money('Monto').refine((v) => Number(v) > 0, 'El monto debe ser mayor a cero'),
  reason: z.string().trim().min(3, 'Indique el motivo').max(300),
});
export type CashMovementRequest = z.input<typeof cashMovementSchema>;

export const closeCashSchema = z.object({
  /** Contado por medio de pago: { efectivo: '125.50', tarjeta_credito: '40.00' } */
  counted: z.record(z.string(), money('Contado')),
  /** Conteo de billetes/monedas: { '20': 3, '0.25': 4 } */
  denominations: z.record(z.string(), z.number().int().min(0)).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type CloseCashRequest = z.input<typeof closeCashSchema>;

export interface CashMethodSummary {
  method: string;
  label: string;
  /** Ventas cobradas con este medio */
  sales: string;
  count: number;
  /** Esperado en caja (para efectivo incluye apertura y movimientos) */
  expected: string;
  counted: string | null;
  difference: string | null;
}

export interface CashSessionSummary {
  id: string;
  status: 'OPEN' | 'CLOSED';
  emissionPointId: string;
  emissionPoint: string;
  openedBy: string;
  openedAt: string;
  openingAmount: string;
  closedBy: string | null;
  closedAt: string | null;
  invoices: number;
  totalSales: string;
  cash: { opening: string; sales: string; in: string; out: string; expected: string };
  methods: CashMethodSummary[];
  byUser: { user: string; invoices: number; total: string }[];
  movements: { id: string; type: 'IN' | 'OUT'; amount: string; reason: string; user: string; at: string }[];
  difference: string | null;
  notes: string | null;
}

// ───────── Proformas ─────────

export const quoteLineSchema = z.object({
  productId: uuidSchema.nullable().optional(),
  productUnitId: uuidSchema.nullable().optional(),
  code: z.string().max(25).nullable().optional(),
  description: z.string().trim().min(1).max(300),
  quantity: z.string(),
  unitPrice: z.string(),
  discount: z.string().default('0'),
  taxRateId: uuidSchema,
  allowsDecimal: z.boolean().optional(),
  unitLabel: z.string().max(60).nullable().optional(),
});
export type QuoteLine = z.infer<typeof quoteLineSchema>;

export const quoteSchema = z.object({
  emissionPointId: uuidSchema,
  buyer: z.object({
    idType: z.enum(['04', '05', '06', '07', '08']),
    id: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(300),
    email: z.string().trim().max(300).nullable().optional(),
  }),
  priceListId: uuidSchema.nullable().optional(),
  lines: z.array(quoteLineSchema).min(1, 'Agregue productos').max(400),
  validDays: z.number().int().min(1).max(365).default(15),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type QuoteRequest = z.input<typeof quoteSchema>;

export interface QuoteView {
  id: string;
  number: string;
  emissionPointId: string;
  buyerIdType: string;
  buyerId: string;
  buyerName: string;
  buyerEmail: string | null;
  priceListId: string | null;
  lines: QuoteLine[];
  total: string;
  validUntil: string;
  notes: string | null;
  documentId: string | null;
  createdAt: string;
  expired: boolean;
}

// ───────── Ticket ─────────

export interface TicketData {
  documentId: string;
  company: {
    legalName: string;
    tradeName: string | null;
    ruc: string;
    mainAddress: string;
    establishmentAddress: string | null;
    keepsAccounting: boolean;
    specialTaxpayerNumber: string | null;
    withholdingAgentNumber: string | null;
    rimpeLegend: string | null;
    logoBase64: string | null;
  };
  number: string;
  accessKey: string;
  environment: number;
  status: string;
  issuedAt: string;
  buyer: { idType: string; id: string; name: string; address: string | null; email: string | null };
  lines: { description: string; quantity: string; unitPrice: string; discount: string; subtotal: string; taxLabel: string }[];
  taxSummary: { label: string; base: string; amount: string }[];
  subtotal: string;
  totalDiscount: string;
  totalTax: string;
  total: string;
  payments: { label: string; amount: string; cashReceived: string | null; change: string | null }[];
  cashier: string | null;
  /** Link público al RIDE (para WhatsApp) */
  publicRideUrl: string;
  buyerPhone: string | null;
}
