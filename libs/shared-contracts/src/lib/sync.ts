import { z } from 'zod';
import { uuidSchema } from './common';
import type { CertificateStatus, TaxRateItem } from './einvoice';
import { creditNoteBuyerSchema, issueInvoiceSchema } from './einvoice';
import type { LicenseStatus } from './company';
import { closeCashSchema, quoteSchema, type PaymentMethodDef } from './pos';

/*
 * Caja de escritorio (Fase 4): vinculación y sincronización con el servidor.
 * La caja vende siempre contra su base local (SQLite) y sincroniza en segundo plano:
 *   - push: cola de operaciones hechas en la caja (idempotentes por id)
 *   - pull: catálogo, clientes, usuarios, parámetros, stock y estado SRI de sus comprobantes
 */

// ───────── Administración (web) ─────────

export const createDeviceSchema = z.object({
  emissionPointId: uuidSchema,
  name: z.string().trim().min(2, 'Ingrese un nombre para la caja').max(120),
});
export type CreateDeviceRequest = z.input<typeof createDeviceSchema>;

export interface DeviceItem {
  id: string;
  name: string;
  emissionPointId: string;
  emissionPoint: string;
  status: 'pending' | 'active' | 'revoked';
  appVersion: string | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  pendingOps: number;
  failedOps: number;
  /** Comprobantes de esta caja que aún no autoriza el SRI */
  unauthorized: number;
  pairingExpiresAt: string | null;
  createdAt: string;
}

/** Código de vinculación: se muestra UNA vez al crear la caja o al regenerarlo. */
export interface DevicePairingCode {
  device: DeviceItem;
  code: string;
  expiresAt: string;
}

export interface SyncOpItem {
  id: string;
  type: string;
  status: 'APPLIED' | 'REJECTED';
  message: string | null;
  clientAt: string;
  processedAt: string;
}

// ───────── Vinculación (desde la caja) ─────────

export const pairDeviceSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .refine((v) => v.length === 10, 'El código de vinculación tiene 10 caracteres'),
  fingerprint: z.string().trim().min(8).max(128),
  appVersion: z.string().trim().max(40),
});
export type PairDeviceRequest = z.input<typeof pairDeviceSchema>;

export interface PairDeviceResponse {
  deviceId: string;
  tenantId: string;
  emissionPointId: string;
  /** Token permanente de la caja (enviar en X-Device-Token). Solo se entrega aquí. */
  token: string;
  /** Llave para firmar los enlaces públicos al RIDE que imprime la caja sin conexión. */
  linkKey: string;
  publicBaseUrl: string;
  serverTime: string;
}

// ───────── Pull ─────────

export interface SyncUser {
  id: string;
  email: string;
  fullName: string;
  /** Hash argon2id (formato PHC) para el ingreso sin conexión */
  passwordHash: string;
  active: boolean;
  permissions: string[];
}

export interface SyncProduct {
  id: string;
  code: string;
  name: string;
  auxCode: string | null;
  unitId: string;
  taxRateId: string;
  isService: boolean;
  active: boolean;
  units: { id: string; unitId: string; factor: string; isBase: boolean }[];
  barcodes: { barcode: string; productUnitId: string | null }[];
  prices: { priceListId: string; productUnitId: string; price: string }[];
  updatedAt: string;
}

export interface SyncParty {
  id: string;
  idType: string;
  identification: string;
  name: string;
  tradeName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  isCustomer: boolean;
  priceListId: string | null;
  creditLimit: string;
  creditDays: number;
  active: boolean;
  updatedAt: string;
}

export interface SyncDocumentStatus {
  id: string;
  status: string;
  authorizationNumber: string | null;
  authorizedAt: string | null;
  /** Último mensaje del SRI (si fue devuelto o no autorizado) */
  message: string | null;
}

export interface SyncPullResponse {
  serverTime: string;
  /** Pasar en el próximo pull (?since=) */
  cursor: string;
  /** true = respuesta completa (primer pull o reinicio): la caja reemplaza su catálogo */
  full: boolean;
  device: { id: string; name: string; status: string };
  company: {
    ruc: string;
    legalName: string;
    tradeName: string | null;
    mainAddress: string;
    keepsAccounting: boolean;
    specialTaxpayerNumber: string | null;
    withholdingAgentNumber: string | null;
    rimpeLegend: string | null;
    logoBase64: string | null;
    environment: number;
    allowNegativeStock: boolean;
  };
  emissionPoint: {
    id: string;
    code: string;
    name: string;
    establishmentId: string;
    establishmentCode: string;
    establishmentName: string;
    establishmentAddress: string | null;
    warehouseId: string | null;
  };
  /** Próximo secuencial que el servidor conoce para este punto (la caja usa el mayor). */
  sequences: Record<string, number>;
  taxRates: TaxRateItem[];
  units: { id: string; code: string; name: string; allowsDecimal: boolean }[];
  priceLists: { id: string; code: string; name: string; isDefault: boolean }[];
  paymentMethods: PaymentMethodDef[];
  finalConsumer: { id: string; name: string; maxAmount: string };
  idTypes: { code: string; description: string }[];
  certificate: CertificateStatus;
  license: LicenseStatus;
  maxOfflineHours: number;
  users: SyncUser[];
  products: SyncProduct[];
  parties: SyncParty[];
  /** Stock de la bodega del punto de emisión (unidades base) */
  stock: { productId: string; quantity: string }[];
  documents: SyncDocumentStatus[];
}

// ───────── Push ─────────

const at = z.iso.datetime({ offset: true });

/** Producto creado en la caja (alta rápida): la caja fija los ids para poder venderlo de inmediato. */
export const quickProductSchema = z.object({
  id: uuidSchema,
  productUnitId: uuidSchema,
  code: z.string().trim().min(1, 'Ingrese el código').max(25),
  name: z.string().trim().min(1, 'Ingrese el nombre').max(300),
  unitId: uuidSchema,
  taxRateId: uuidSchema,
  isService: z.boolean().default(false),
  barcode: z.string().trim().max(64).nullable().optional(),
  /** Precio SIN IVA en la lista por defecto */
  price: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Precio inválido'),
});
export type QuickProductRequest = z.input<typeof quickProductSchema>;

export const syncPartySchema = z.object({
  id: uuidSchema,
  idType: z.enum(['04', '05', '06', '08']),
  identification: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(300),
  email: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
});

const money = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/);

export const syncOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('party.upsert'), payload: syncPartySchema }),
  z.object({ type: z.literal('product.create'), payload: quickProductSchema }),
  z.object({
    type: z.literal('cash.open'),
    payload: z.object({ id: uuidSchema, openedAt: at, openingAmount: money }),
  }),
  z.object({
    type: z.literal('cash.movement'),
    payload: z.object({ id: uuidSchema, sessionId: uuidSchema, type: z.enum(['IN', 'OUT']), amount: money, reason: z.string().trim().min(1).max(300), at }),
  }),
  z.object({
    type: z.literal('cash.close'),
    payload: closeCashSchema.extend({
      sessionId: uuidSchema,
      closedAt: at,
      expected: z.record(z.string(), money),
      difference: money,
    }),
  }),
  z.object({
    type: z.literal('invoice.issue'),
    payload: z.object({
      documentId: uuidSchema,
      issuedAt: at,
      sequential: z.number().int().min(1).max(999_999_999),
      accessKey: z.string().regex(/^\d{49}$/),
      request: issueInvoiceSchema,
    }),
  }),
  z.object({
    type: z.literal('credit_note.issue'),
    payload: z.object({
      documentId: uuidSchema,
      issuedAt: at,
      sequential: z.number().int().min(1).max(999_999_999),
      accessKey: z.string().regex(/^\d{49}$/),
      /** Egreso de caja del reembolso en efectivo (mismo id en la caja y en el servidor) */
      cashMovementId: uuidSchema.nullable().optional(),
      request: z.object({
        invoiceId: uuidSchema,
        emissionPointId: uuidSchema,
        reason: z.string().trim().min(3).max(300),
        buyer: creditNoteBuyerSchema.nullable().optional(),
        /** La caja no conoce los ids de línea del servidor: se referencia por número de línea */
        lines: z.array(z.object({ lineNo: z.number().int().min(1), quantity: z.string(), restock: z.boolean() })).min(1).max(400),
        refund: z.object({ method: z.string().min(1).max(30), cashSessionId: uuidSchema.nullable().optional() }),
      }),
    }),
  }),
  z.object({
    type: z.literal('quote.create'),
    payload: z.object({ id: uuidSchema, number: z.number().int().min(1), createdAt: at, request: quoteSchema }),
  }),
  z.object({ type: z.literal('document.email'), payload: z.object({ documentId: uuidSchema, email: z.string().trim().max(300).nullable().optional() }) }),
]);

export const syncPushSchema = z.object({
  ops: z
    .array(
      z.intersection(
        z.object({
          /** uuidv7 generado en la caja */
          opId: uuidSchema,
          /** Usuario que hizo la operación en la caja */
          userId: uuidSchema,
          clientAt: at,
        }),
        syncOpSchema,
      ),
    )
    .max(200),
  /** Estado de la cola en la caja (para el panel de administración) */
  pending: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  appVersion: z.string().max(40).optional(),
});
export type SyncPushRequest = z.input<typeof syncPushSchema>;
export type SyncPushParsed = z.output<typeof syncPushSchema>;
export type SyncOp = z.input<typeof syncOpSchema>;
export type SyncOpType = SyncOp['type'];

export interface SyncOpResult {
  opId: string;
  /** applied = aplicada ahora · duplicate = ya estaba aplicada · rejected = error de datos (no reintentar) */
  status: 'applied' | 'duplicate' | 'rejected';
  message?: string;
  data?: Record<string, unknown>;
}

export interface SyncPushResponse {
  serverTime: string;
  results: SyncOpResult[];
}

/** Modo de ejecución que la web consulta en /api/runtime (la caja de escritorio responde "desktop"). */
export interface RuntimeInfo {
  mode: 'web' | 'desktop';
  online?: boolean;
  paired?: boolean;
  lastSyncAt?: string | null;
  pendingOps?: number;
  failedOps?: number;
  /** Horas restantes para vender sin sincronizar (null = sin límite / en línea) */
  offlineHoursLeft?: number | null;
  serverUrl?: string | null;
  deviceName?: string | null;
  appVersion?: string;
}
