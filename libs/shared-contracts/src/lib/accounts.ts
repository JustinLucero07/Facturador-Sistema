import { z } from 'zod';
import { uuidSchema } from './common';

/** AR = cuentas por cobrar (clientes) · AP = cuentas por pagar (proveedores) */
export type AccountSide = 'AR' | 'AP';

const money2 = (label: string) =>
  z
    .union([z.number(), z.string().trim()])
    .transform((v) => String(v).replace(',', '.'))
    .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), `${label}: número inválido (máximo 2 decimales)`);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida');

export interface AgingBuckets {
  current: string;
  d30: string;
  d60: string;
  d90: string;
  over90: string;
}

export interface PartyAccountSummary {
  partyId: string;
  name: string;
  identification: string;
  owed: string;
  overdue: string;
  /** Saldo a favor (anticipos, notas de crédito sin aplicar) */
  credit: string;
  creditLimit: string;
  openItems: number;
  oldestDue: string | null;
  buckets: AgingBuckets;
}

export interface AccountsOverview {
  totals: { owed: string; overdue: string; credit: string; buckets: AgingBuckets; parties: number };
  total: number;
  page: number;
  pageSize: number;
  items: PartyAccountSummary[];
}

export interface AccountStatementItem {
  id: string;
  number: string;
  sourceType: 'INVOICE' | 'PURCHASE' | 'OPENING';
  sourceId: string | null;
  issueDate: string;
  dueDate: string;
  amount: string;
  balance: string;
  status: 'OPEN' | 'PAID' | 'VOID';
  daysOverdue: number;
  notes: string | null;
}

export interface AccountStatementMovement {
  id: string;
  kind: 'PAYMENT' | 'WITHHOLDING' | 'CREDIT_NOTE' | 'ADVANCE';
  date: string;
  method: string | null;
  amount: string;
  unapplied: string;
  reference: string | null;
  documentId: string | null;
  notes: string | null;
  voided: boolean;
  voidReason: string | null;
  allocations: { itemId: string; number: string; amount: string }[];
}

export interface AccountStatement {
  side: AccountSide;
  party: { id: string; name: string; identification: string; email: string | null; phone: string | null; creditLimit: string; creditDays: number };
  owed: string;
  overdue: string;
  credit: string;
  /** Crédito disponible (solo clientes con límite) */
  available: string | null;
  buckets: AgingBuckets;
  items: AccountStatementItem[];
  movements: AccountStatementMovement[];
}

/** Cobro (clientes) o pago (proveedores). Sin documentos = se aplica a los más antiguos. */
export const accountPaymentSchema = z.object({
  partyId: uuidSchema,
  /** PAYMENT aplica a documentos; ADVANCE queda como anticipo (saldo a favor) */
  kind: z.enum(['PAYMENT', 'ADVANCE']).default('PAYMENT'),
  date: day,
  method: z.string().trim().min(1, 'Elija el medio de pago').max(30),
  amount: money2('Valor'),
  reference: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
  /** Caja abierta: el efectivo entra (cobro) o sale (pago) de ella */
  cashSessionId: uuidSchema.nullable().optional(),
  allocations: z.array(z.object({ itemId: uuidSchema, amount: money2('Valor aplicado') })).max(200).nullable().optional(),
});
export type AccountPaymentRequest = z.input<typeof accountPaymentSchema>;
export type AccountPaymentParsed = z.output<typeof accountPaymentSchema>;

/** Retención que le hizo un cliente (comprobante 07 recibido) sobre una factura a crédito. */
export const receivedWithholdingSchema = z.object({
  itemId: uuidSchema,
  number: z.string().trim().regex(/^\d{3}-\d{3}-\d{9}$/, 'Número del comprobante de retención (001-001-000000123)'),
  authorization: z.string().trim().regex(/^\d{10,49}$/, 'Autorización / clave de acceso: solo números'),
  date: day,
  items: z
    .array(
      z.object({
        tax: z.enum(['1', '2', '6']),
        code: z.string().trim().min(1).max(10),
        base: money2('Base'),
        percentage: money2('Porcentaje'),
        amount: money2('Valor retenido'),
      }),
    )
    .min(1, 'Agregue al menos una retención')
    .max(20),
});
export type ReceivedWithholdingRequest = z.input<typeof receivedWithholdingSchema>;
export type ReceivedWithholdingParsed = z.output<typeof receivedWithholdingSchema>;

/** Lectura del XML de una retención recibida (nada se guarda). */
export interface ReceivedWithholdingPreview {
  partyId: string | null;
  customerName: string;
  customerId: string;
  /** Documento por cobrar de la factura retenida, si existe */
  itemId: string | null;
  invoiceNumber: string;
  number: string;
  authorization: string;
  date: string;
  items: { tax: '1' | '2' | '6'; code: string; base: string; percentage: string; amount: string }[];
  total: string;
  warnings: string[];
}

/** Saldo inicial (deudas que ya existían antes de usar el sistema). */
export const openingItemSchema = z.object({
  partyId: uuidSchema,
  number: z.string().trim().min(1, 'Ingrese el número del documento').max(40),
  issueDate: day,
  dueDate: day,
  amount: money2('Valor'),
  notes: z.string().trim().max(300).nullable().optional(),
});
export type OpeningItemRequest = z.input<typeof openingItemSchema>;

export const applyCreditSchema = z.object({ movementId: uuidSchema, itemId: uuidSchema, amount: money2('Valor') });
export const voidAccountMovementSchema = z.object({ reason: z.string().trim().min(3, 'Indique el motivo').max(300) });
