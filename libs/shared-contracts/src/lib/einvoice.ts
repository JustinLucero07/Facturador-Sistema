import { z } from 'zod';
import { uuidSchema } from './common';
import type { PaymentMethodDef } from './pos';

const decimalInput = (label: string, max = 6) =>
  z
    .union([z.number(), z.string().trim()])
    .transform((v) => String(v).replace(',', '.'))
    .refine((v) => new RegExp(`^\\d{1,12}(\\.\\d{1,${max}})?$`).test(v), `${label}: número inválido (máximo ${max} decimales)`);

export const ID_TYPES = { RUC: '04', CEDULA: '05', PASSPORT: '06', FINAL_CONSUMER: '07', FOREIGN: '08' } as const;

export const buyerSchema = z.object({
  idType: z.enum(['04', '05', '06', '07', '08'], { message: 'Tipo de identificación inválido' }),
  id: z.string().trim().min(1, 'Ingrese la identificación').max(20),
  name: z.string().trim().min(1, 'Ingrese el nombre o razón social').max(300),
  address: z.string().trim().max(300).nullable().optional(),
  email: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
});
export type BuyerInput = z.infer<typeof buyerSchema>;

export const invoiceLineSchema = z.object({
  /** Producto del catálogo (descuenta stock); opcional para líneas libres */
  productId: uuidSchema.nullable().optional(),
  /** Presentación vendida (caja, metro…); null = unidad base */
  productUnitId: uuidSchema.nullable().optional(),
  mainCode: z.string().trim().max(25).nullable().optional(),
  auxCode: z.string().trim().max(25).nullable().optional(),
  description: z.string().trim().min(1, 'Ingrese la descripción').max(300),
  unit: z.string().trim().max(50).nullable().optional(),
  quantity: decimalInput('Cantidad'),
  unitPrice: decimalInput('Precio'),
  discount: decimalInput('Descuento', 2).optional(),
  taxRateId: uuidSchema,
  additional: z.array(z.object({ name: z.string().max(300), value: z.string().max(300) })).max(3).optional(),
});

export const invoicePaymentSchema = z.object({
  /** Tabla 24 del SRI */
  sriCode: z.string().regex(/^\d{2}$/),
  /** Medio interno: efectivo, tarjeta, transferencia, deuna, payphone, credito */
  method: z.string().trim().min(1).max(30),
  amount: decimalInput('Valor del pago', 2),
  term: z.number().int().min(0).max(3650).nullable().optional(),
  timeUnit: z.string().max(10).nullable().optional(),
  reference: z.string().max(100).nullable().optional(),
  /** Efectivo entregado (para el vuelto en el ticket) */
  cashReceived: decimalInput('Efectivo recibido', 2).nullable().optional(),
});

export const issueInvoiceSchema = z.object({
  emissionPointId: uuidSchema,
  buyer: buyerSchema,
  lines: z.array(invoiceLineSchema).min(1, 'Agregue al menos un producto').max(400),
  payments: z.array(invoicePaymentSchema).min(1, 'Indique la forma de pago').max(10),
  tip: decimalInput('Propina', 2).optional(),
  additionalInfo: z.array(z.object({ name: z.string().trim().min(1).max(300), value: z.string().trim().min(1).max(300) })).max(10).optional(),
  /** Venta del POS: caja abierta del punto de emisión */
  cashSessionId: uuidSchema.nullable().optional(),
  /** Proforma que se convierte en esta factura */
  quoteId: uuidSchema.nullable().optional(),
});
export type IssueInvoiceRequest = z.input<typeof issueInvoiceSchema>;
export type IssueInvoiceParsed = z.output<typeof issueInvoiceSchema>;

// ───────── Nota de crédito (Fase 5) ─────────

/** Ficha v2.34, Tabla 6: la nota de crédito no admite consumidor final (07). */
export const creditNoteBuyerSchema = buyerSchema.extend({
  idType: z.enum(['04', '05', '06', '08'], { message: 'La nota de crédito debe identificar al cliente (RUC, cédula o pasaporte)' }),
});

export const creditNoteSchema = z.object({
  invoiceId: uuidSchema,
  emissionPointId: uuidSchema,
  reason: z.string().trim().min(3, 'Indique el motivo de la nota de crédito').max(300),
  /** Obligatorio si la factura fue a consumidor final; si no, se usa el cliente de la factura */
  buyer: creditNoteBuyerSchema.nullable().optional(),
  lines: z
    .array(
      z.object({
        sourceLineId: uuidSchema,
        quantity: decimalInput('Cantidad'),
        /** false = no vuelve al stock (producto dañado) */
        restock: z.boolean().default(true),
      }),
    )
    .min(1, 'Elija al menos un producto a devolver')
    .max(400),
  /** Cómo se devuelve el dinero. Efectivo con caja abierta = egreso de esa caja. */
  refund: z.object({
    method: z.string().trim().min(1).max(30),
    cashSessionId: uuidSchema.nullable().optional(),
  }),
});
export type CreditNoteRequest = z.input<typeof creditNoteSchema>;
export type CreditNoteParsed = z.output<typeof creditNoteSchema>;

/** Factura con lo que aún se puede devolver por línea. */
export interface CreditableInvoice {
  id: string;
  number: string;
  issueDate: string;
  status: EDocStatusCode;
  buyer: { idType: string; id: string; name: string; email: string | null; phone: string | null; address: string | null };
  total: string;
  /** Ya acreditado en notas de crédito vigentes */
  credited: string;
  lines: {
    id: string;
    mainCode: string | null;
    description: string;
    quantity: string;
    unitPrice: string;
    discount: string;
    subtotal: string;
    taxLabel: string;
    taxRate: string;
    productId: string | null;
    credited: string;
    creditedDiscount: string;
    remaining: string;
  }[];
  creditNotes: { id: string; number: string; total: string; status: EDocStatusCode; reason: string | null; issueDate: string }[];
}

export type EDocStatusCode =
  | 'DRAFT'
  | 'SIGNED'
  | 'SENT'
  | 'RECEIVED'
  | 'RETURNED'
  | 'AUTHORIZED'
  | 'NOT_AUTHORIZED'
  | 'CONTINGENCY'
  /** Solo en la caja de escritorio: venta guardada en la computadora, aún no llega al servidor */
  | 'PENDING_SYNC'
  /** Solo en la caja de escritorio: el servidor rechazó la venta al sincronizar */
  | 'REJECTED_SYNC';

export const EDOC_STATUS_LABELS: Record<EDocStatusCode, string> = {
  DRAFT: 'Borrador',
  SIGNED: 'Firmado',
  SENT: 'Enviado',
  RECEIVED: 'Recibido por el SRI',
  RETURNED: 'Devuelto',
  AUTHORIZED: 'Autorizado',
  NOT_AUTHORIZED: 'No autorizado',
  CONTINGENCY: 'En contingencia',
  PENDING_SYNC: 'Pendiente de sincronizar',
  REJECTED_SYNC: 'Rechazada al sincronizar',
};

export interface SriMessageView {
  identifier: string;
  title: string;
  hint: string;
  message: string;
  additionalInfo: string | null;
  isError: boolean;
}

export interface EDocListItem {
  id: string;
  docType: string;
  number: string;
  issueDate: string;
  buyerName: string;
  buyerId: string;
  total: string;
  status: EDocStatusCode;
  accessKey: string;
  environment: number;
  emailStatus: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  attempts: number;
  updatedAt: string;
}

export interface EDocDetail extends EDocListItem {
  buyerEmail: string | null;
  subtotal: string;
  totalTax: string;
  authorizationNumber: string | null;
  authorizedAt: string | null;
  messages: SriMessageView[];
  emailError: string | null;
  lines: { description: string; quantity: string; unitPrice: string; discount: string; subtotal: string; taxLabel: string }[];
  taxSummary: { label: string; base: string; amount: string }[];
  payments: { label: string; amount: string }[];
  events: { at: string; from: EDocStatusCode | null; to: EDocStatusCode; note: string | null; messages: SriMessageView[] }[];
  /** Nota de crédito: factura que modifica y motivo */
  related: { id: string; number: string } | null;
  reason: string | null;
  /** Factura: notas de crédito emitidas sobre ella */
  creditNotes: { id: string; number: string; total: string; status: EDocStatusCode }[];
  /** Comprobante de retención: retenciones y compra que sustenta */
  withholdings: { tax: string; code: string; description: string; base: string; percentage: string; amount: string }[];
  purchase: { id: string; number: string } | null;
}

export interface TaxRateItem {
  id: string;
  taxCode: string;
  percentageCode: string;
  name: string;
  label: string;
  rate: string;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
  sortOrder: number;
}

export const taxRateSchema = z.object({
  taxCode: z.enum(['2', '3', '5']),
  percentageCode: z.string().trim().regex(/^\d{1,4}$/, 'Código de porcentaje inválido'),
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(40),
  rate: z.union([z.number(), z.string()]).transform((v) => String(v)).refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v), 'Tarifa inválida'),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type TaxRateRequest = z.input<typeof taxRateSchema>;

export interface EInvoiceConfig {
  taxRates: TaxRateItem[];
  paymentMethods: { code: string; description: string }[];
  idTypes: { code: string; description: string }[];
  finalConsumer: { id: string; name: string; maxAmount: string };
  emissionPoints: { id: string; label: string; establishmentId: string }[];
  /** Medios de pago del POS con su código SRI (parámetro payment_methods) */
  posPaymentMethods: PaymentMethodDef[];
  environment: number;
  certificate: CertificateStatus;
}

export interface CertificateStatus {
  present: boolean;
  holderName: string | null;
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysLeft: number | null;
  level: 'ok' | 'warn' | 'danger' | 'missing';
  message: string;
}

export const mailConfigSchema = z.object({
  host: z.string().trim().min(1, 'Ingrese el servidor SMTP').max(200),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().max(200).nullable().optional(),
  /** Vacío = mantener la contraseña guardada */
  password: z.string().max(300).nullable().optional(),
  fromName: z.string().trim().min(1, 'Ingrese el nombre del remitente').max(200),
  fromEmail: z.string().trim().email('Correo del remitente inválido'),
  replyTo: z.string().trim().email('Correo de respuesta inválido').nullable().optional().or(z.literal('')),
  enabled: z.boolean().default(true),
});
export type MailConfigRequest = z.input<typeof mailConfigSchema>;

export interface MailConfigView {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  hasPassword: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  enabled: boolean;
}

export const sendEmailSchema = z.object({ email: z.string().trim().email('Correo inválido').optional() });
export const testMailSchema = z.object({ to: z.string().trim().email('Correo inválido') });
export const sriSettingSchema = z.object({ value: z.unknown() });
