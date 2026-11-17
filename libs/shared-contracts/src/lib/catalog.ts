import { z } from 'zod';
import { uuidSchema } from './common';

const dec = (label: string, max = 6) =>
  z
    .union([z.number(), z.string().trim()])
    .transform((v) => String(v).replace(',', '.'))
    .refine((v) => new RegExp(`^\\d{1,12}(\\.\\d{1,${max}})?$`).test(v), `${label}: número inválido`);

const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

// ───────── Catálogos simples ─────────

export const unitSchema = z.object({
  code: z.string().trim().min(1, 'Ingrese el código').max(20).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1, 'Ingrese el nombre').max(60),
  allowsDecimal: z.boolean().default(false),
  active: z.boolean().default(true),
});
export const namedSchema = z.object({ name: z.string().trim().min(1, 'Ingrese el nombre').max(120), active: z.boolean().default(true) });
export const priceListSchema = z.object({
  code: z.string().trim().min(1).max(20).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1, 'Ingrese el nombre').max(80),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
});
export type UnitRequest = z.input<typeof unitSchema>;
export type NamedRequest = z.input<typeof namedSchema>;
export type PriceListRequest = z.input<typeof priceListSchema>;

export interface UnitItem { id: string; code: string; name: string; allowsDecimal: boolean; active: boolean }
export interface NamedItem { id: string; name: string; active: boolean; productCount?: number }
export interface PriceListItem { id: string; code: string; name: string; isDefault: boolean; sortOrder: number; active: boolean }

export interface CatalogLookups {
  units: UnitItem[];
  categories: NamedItem[];
  brands: NamedItem[];
  priceLists: PriceListItem[];
  taxRates: { id: string; label: string; name: string; rate: string; percentageCode: string }[];
  warehouses: { id: string; name: string; establishment: string; isDefault: boolean }[];
}

// ───────── Productos ─────────

export const productSchema = z.object({
  code: z.string().trim().min(1, 'Ingrese el código').max(25),
  name: z.string().trim().min(1, 'Ingrese el nombre').max(300),
  description: optText(2000),
  categoryId: uuidSchema.nullable().optional(),
  brandId: uuidSchema.nullable().optional(),
  unitId: uuidSchema,
  taxRateId: uuidSchema,
  auxCode: optText(25),
  isService: z.boolean().default(false),
  minStock: dec('Stock mínimo').default('0'),
  imageUrl: optText(500_000),
  active: z.boolean().default(true),
  /** Códigos de barras de la unidad base */
  barcodes: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  /** Presentaciones adicionales: CAJA × 12, etc. */
  units: z
    .array(z.object({ unitId: uuidSchema, factor: dec('Factor'), barcodes: z.array(z.string().trim().min(1).max(64)).max(10).default([]) }))
    .max(10)
    .default([]),
  /** Precios SIN IVA por lista y unidad (unitId = unidad base o presentación) */
  prices: z.array(z.object({ priceListId: uuidSchema, unitId: uuidSchema, price: dec('Precio') })).max(100).default([]),
  customFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type ProductRequest = z.input<typeof productSchema>;
export type ProductParsed = z.output<typeof productSchema>;

export interface ProductListItem {
  id: string;
  code: string;
  name: string;
  category: string | null;
  brand: string | null;
  unit: string;
  taxLabel: string;
  price: string | null;
  priceWithTax: string | null;
  stock: string;
  minStock: string;
  avgCost: string | null;
  isService: boolean;
  active: boolean;
  lowStock: boolean;
  imageUrl: string | null;
}

export interface ProductDetail extends Omit<ProductParsed, 'units' | 'prices' | 'barcodes'> {
  id: string;
  avgCost: string | null;
  lastCost: string | null;
  barcodes: string[];
  units: { unitId: string; factor: string; barcodes: string[] }[];
  prices: { priceListId: string; unitId: string; price: string }[];
  stock: { warehouseId: string; warehouse: string; quantity: string }[];
}

/** Resultado del buscador (POS / factura) */
export interface ProductSearchItem {
  id: string;
  code: string;
  name: string;
  auxCode: string | null;
  isService: boolean;
  taxRateId: string;
  taxLabel: string;
  taxRate: string;
  /** Presentación sugerida (la del código de barras escaneado, si aplica) */
  matchedUnitId: string | null;
  units: { productUnitId: string; unitId: string; code: string; name: string; factor: string; allowsDecimal: boolean; isBase: boolean; price: string | null }[];
  stock: string | null;
}

// ───────── Clientes y proveedores ─────────

export const partySchema = z.object({
  idType: z.enum(['04', '05', '06', '08'], { message: 'Tipo de identificación inválido' }),
  identification: z.string().trim().min(1, 'Ingrese la identificación').max(20),
  name: z.string().trim().min(1, 'Ingrese el nombre o razón social').max(300),
  tradeName: optText(300),
  email: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => !v || v.split(/[;,]/).every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())), 'Correo inválido (varios separados por coma)'),
  phone: optText(30),
  address: optText(300),
  isCustomer: z.boolean().default(true),
  isSupplier: z.boolean().default(false),
  priceListId: uuidSchema.nullable().optional(),
  creditLimit: dec('Límite de crédito', 2).default('0'),
  creditDays: z.number().int().min(0).max(3650).default(0),
  /** ATS Tabla 14 (01 persona natural, 02 sociedad): con pasaporte o identificación del exterior */
  personType: z.enum(['01', '02']).nullable().optional().transform((v) => v ?? null),
  /** ATS: parte relacionada */
  relatedParty: z.boolean().default(false),
  notes: optText(2000),
  active: z.boolean().default(true),
  customFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type PartyRequest = z.input<typeof partySchema>;
export type PartyParsed = z.output<typeof partySchema>;

export interface PartyItem extends PartyParsed {
  id: string;
  priceListName: string | null;
  createdAt: string;
}

// ───────── Inventario ─────────

export const adjustmentSchema = z.object({
  warehouseId: uuidSchema,
  direction: z.enum(['IN', 'OUT']),
  reason: z.string().trim().min(3, 'Indique el motivo del ajuste').max(300),
  items: z
    .array(z.object({ productId: uuidSchema, quantity: dec('Cantidad'), unitCost: dec('Costo').nullable().optional() }))
    .min(1, 'Agregue al menos un producto')
    .max(500),
});
export type AdjustmentRequest = z.input<typeof adjustmentSchema>;

export const transferSchema = z.object({
  fromWarehouseId: uuidSchema,
  toWarehouseId: uuidSchema,
  reason: optText(300),
  items: z.array(z.object({ productId: uuidSchema, quantity: dec('Cantidad') })).min(1, 'Agregue al menos un producto').max(500),
});
export type TransferRequest = z.input<typeof transferSchema>;

export interface StockItem {
  productId: string;
  code: string;
  name: string;
  unit: string;
  quantity: string;
  minStock: string;
  avgCost: string | null;
  value: string | null;
  lowStock: boolean;
}

export interface KardexItem {
  id: string;
  at: string;
  type: string;
  typeLabel: string;
  warehouse: string;
  quantity: string;
  unitCost: string | null;
  totalCost: string | null;
  balanceAfter: string;
  avgCostAfter: string | null;
  reason: string | null;
  documentId: string | null;
  userName: string | null;
}

export const MOVEMENT_LABELS: Record<string, string> = {
  INITIAL: 'Saldo inicial',
  PURCHASE: 'Compra',
  SALE: 'Venta',
  SALE_RETURN: 'Devolución de venta',
  ADJUSTMENT_IN: 'Ajuste (entrada)',
  ADJUSTMENT_OUT: 'Ajuste (salida)',
  TRANSFER_IN: 'Transferencia (entrada)',
  TRANSFER_OUT: 'Transferencia (salida)',
};

// ───────── Importación ─────────

export type ImportKind = 'products' | 'parties' | 'initial_stock';

export const IMPORT_KINDS: Record<ImportKind, string> = {
  products: 'Productos',
  parties: 'Clientes y proveedores',
  initial_stock: 'Saldos iniciales de inventario',
};

export interface ImportRowError {
  row: number;
  column: string;
  message: string;
}

export interface ImportPreview {
  id: string;
  kind: ImportKind;
  fileName: string;
  total: number;
  valid: number;
  errors: ImportRowError[];
  /** Primeras filas válidas para mostrar */
  sample: Record<string, unknown>[];
  /** Cuántas filas actualizarán registros existentes */
  updates: number;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  ms: number;
}
