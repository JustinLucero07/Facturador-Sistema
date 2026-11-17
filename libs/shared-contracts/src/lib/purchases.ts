import { z } from 'zod';
import { uuidSchema } from './common';

const dec = (label: string, max = 6) =>
  z
    .union([z.number(), z.string().trim()])
    .transform((v) => String(v).replace(',', '.'))
    .refine((v) => new RegExp(`^\\d{1,12}(\\.\\d{1,${max}})?$`).test(v), `${label}: número inválido`);

export const purchaseLineSchema = z.object({
  /** Producto del catálogo (suma stock). Null = gasto o línea sin inventario. */
  productId: uuidSchema.nullable().optional(),
  productUnitId: uuidSchema.nullable().optional(),
  supplierCode: z.string().trim().max(25).nullable().optional(),
  description: z.string().trim().min(1, 'Ingrese la descripción').max(300),
  quantity: dec('Cantidad').refine((v) => Number(v) > 0, 'La cantidad debe ser mayor a cero'),
  /** Costo unitario SIN IVA */
  unitCost: dec('Costo'),
  discount: dec('Descuento', 2).default('0'),
  taxRateId: uuidSchema,
});

export const purchaseSchema = z
  .object({
    /** Proveedor existente… */
    supplierId: uuidSchema.nullable().optional(),
    /** …o nuevo (se crea como proveedor al registrar la compra) */
    newSupplier: z
      .object({
        idType: z.enum(['04', '05', '06', '08']),
        identification: z.string().trim().min(1).max(20),
        name: z.string().trim().min(1).max(300),
        email: z.string().trim().max(300).nullable().optional(),
        address: z.string().trim().max(300).nullable().optional(),
      })
      .nullable()
      .optional(),
    /** Tabla 3: 01 factura, 02 nota de venta, 03 liquidación de compra */
    docType: z.enum(['01', '02', '03']).default('01'),
    number: z.string().trim().regex(/^\d{3}-\d{3}-\d{9}$/, 'Número del comprobante con formato 001-001-000000123'),
    authorization: z
      .string()
      .trim()
      .regex(/^\d{10,49}$/, 'Autorización / clave de acceso: solo números (10 a 49 dígitos)')
      .nullable()
      .optional()
      .or(z.literal('').transform(() => null)),
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
    warehouseId: uuidSchema,
    lines: z.array(purchaseLineSchema).min(1, 'Agregue al menos una línea').max(500),
    notes: z.string().trim().max(1000).nullable().optional(),
    fromXml: z.boolean().default(false),
    /** ATS: sustento tributario (Catálogo ATS Tabla 5) */
    sustentoCode: z.string().regex(/^\d{2}$/, 'Elija el sustento tributario').nullable().optional(),
    /** ATS: forma de pago (Tabla 13); obligatoria en el ATS sobre el monto que fija el SRI */
    paymentCode: z.string().regex(/^\d{2}$/, 'Elija la forma de pago').nullable().optional(),
    /** ATS: el proveedor es parte relacionada */
    relatedParty: z.boolean().optional(),
    /** Recordar el código del proveedor para cada producto (próxima carga de XML) */
    rememberCodes: z.boolean().default(true),
    /** Contado (se registra el pago) o crédito (queda por pagar hasta el vencimiento) */
    payment: z
      .object({
        mode: z.enum(['CASH', 'CREDIT']),
        /** Medio del pago al contado (efectivo, transferencia…) */
        method: z.string().trim().max(30).nullable().optional(),
        /** Caja abierta de la que sale el efectivo */
        cashSessionId: uuidSchema.nullable().optional(),
        /** Vencimiento a crédito (vacío = días de crédito del proveedor) */
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
      .default({ mode: 'CREDIT' }),
  })
  .refine((v) => !!v.supplierId || !!v.newSupplier, { message: 'Elija o registre el proveedor', path: ['supplierId'] });
export type PurchaseRequest = z.input<typeof purchaseSchema>;
export type PurchaseParsed = z.output<typeof purchaseSchema>;

/** Datos del ATS de una compra ya registrada (se pueden corregir antes de presentar el anexo). */
export const purchaseAtsSchema = z.object({
  sustentoCode: z.string().regex(/^\d{2}$/, 'Elija el sustento tributario'),
  paymentCode: z.string().regex(/^\d{2}$/, 'Elija la forma de pago').nullable(),
  relatedParty: z.boolean(),
});
export type PurchaseAtsRequest = z.input<typeof purchaseAtsSchema>;

export interface PurchaseAtsCatalogs {
  sustento: { code: string; description: string }[];
  paymentForms: { code: string; description: string }[];
}

export const voidPurchaseSchema = z.object({ reason: z.string().trim().min(3, 'Indique el motivo').max(300) });

export interface PurchaseListItem {
  id: string;
  supplierName: string;
  supplierId: string;
  supplierIdentification: string;
  docType: string;
  number: string;
  issueDate: string;
  total: string;
  status: 'REGISTERED' | 'VOID';
  lines: number;
  fromXml: boolean;
  createdAt: string;
}

export interface PurchaseDetail extends PurchaseListItem {
  /** Cuenta por pagar de esta compra */
  payable: { dueDate: string; balance: string; status: 'OPEN' | 'PAID' | 'VOID' } | null;
  authorization: string | null;
  /** ATS */
  sustentoCode: string | null;
  paymentCode: string | null;
  relatedParty: boolean;
  warehouse: string;
  subtotal: string;
  totalDiscount: string;
  totalTax: string;
  taxSummary: { label: string; base: string; amount: string }[];
  notes: string | null;
  voidReason: string | null;
  items: {
    description: string;
    supplierCode: string | null;
    product: { id: string; code: string; name: string } | null;
    quantity: string;
    unitCost: string;
    discount: string;
    subtotal: string;
    taxLabel: string;
  }[];
}

/** Vista previa del XML autorizado del proveedor (nada se guarda). */
export interface PurchaseXmlPreview {
  supplier: { idType: string; identification: string; name: string; address: string | null; id: string | null };
  /** El XML no está emitido a nombre de esta empresa */
  buyerMismatch: string | null;
  docType: string;
  number: string;
  authorization: string;
  issueDate: string;
  duplicate: boolean;
  /** Forma de pago declarada en el XML del proveedor (Tabla 24), para el ATS */
  paymentCode: string | null;
  lines: {
    supplierCode: string | null;
    description: string;
    quantity: string;
    unitCost: string;
    discount: string;
    subtotal: string;
    percentageCode: string;
    taxRateId: string | null;
    taxLabel: string;
    match: { productId: string; productUnitId: string | null; code: string; name: string; by: 'remembered' | 'code' | 'barcode' } | null;
  }[];
  totals: { subtotal: string; tax: string; total: string };
}
