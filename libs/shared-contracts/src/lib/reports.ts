import { z } from 'zod';
import { uuidSchema } from './common';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida');

// ───────────────────────── Reportes ─────────────────────────

export const REPORT_KINDS = [
  'sales_daily',
  'sales_product',
  'sales_category',
  'sales_user',
  'sales_payment',
  'profit',
  'inventory',
  'purchases_supplier',
  'vat',
  'receivables',
  'payables',
  'cash_sessions',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Reportes que necesitan reports.tax (el resto, reports.read). */
export const TAX_REPORTS: ReportKind[] = ['vat'];
/** Reportes con fecha de corte "hoy" (no usan el rango de fechas). */
export const SNAPSHOT_REPORTS: ReportKind[] = ['inventory', 'receivables', 'payables'];

export const reportQuerySchema = z
  .object({
    kind: z.enum(REPORT_KINDS, { message: 'Reporte desconocido' }),
    from: day,
    to: day,
    establishmentId: uuidSchema.optional(),
    warehouseId: uuidSchema.optional(),
    format: z.enum(['json', 'xlsx']).default('json'),
  })
  .refine((q) => q.from <= q.to, { message: 'La fecha inicial no puede ser posterior a la final', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86400000 <= 400, { message: 'El rango máximo es de 400 días', path: ['to'] });
export type ReportQuery = z.output<typeof reportQuerySchema>;

export type ReportColumnType = 'text' | 'money' | 'number' | 'date' | 'percent';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

export type ReportCell = string | number | null;

export interface ReportResult {
  kind: ReportKind;
  title: string;
  /** Rango o fecha de corte, para mostrar y para el Excel */
  subtitle: string;
  columns: ReportColumn[];
  rows: Record<string, ReportCell>[];
  totals: Record<string, ReportCell> | null;
  notes: string[];
}

// ───────────────────────── ATS ─────────────────────────

export const atsQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2020, 'Año inválido').max(2100, 'Año inválido'),
    month: z.coerce.number().int().min(1, 'Mes inválido').max(12, 'Mes inválido'),
    /** RIMPE semestral: mes 06 (enero–junio) o 12 (julio–diciembre) */
    semiannual: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    format: z.enum(['json', 'xml', 'zip']).default('json'),
  })
  .refine((q) => !q.semiannual || q.month === 6 || q.month === 12, { message: 'El ATS semestral se presenta con mes 06 o 12', path: ['month'] });
export type AtsQuery = z.output<typeof atsQuerySchema>;

export interface AtsIssue {
  level: 'error' | 'warning';
  message: string;
  /** Ruta de la pantalla donde se corrige (p. ej. /compras?ver=…) */
  link?: string | null;
}

export interface AtsPreview {
  year: number;
  month: number;
  semiannual: boolean;
  fileName: string;
  /** Desde – hasta (AAAA-MM-DD) */
  from: string;
  to: string;
  establishmentsCount: number;
  totalSales: string;
  purchases: { count: number; base: string; iva: string; ivaWithheld: string; rentaWithheld: string };
  sales: { rows: number; documents: number; base: string; iva: string; ivaWithheld: string; rentaWithheld: string };
  creditNotes: { documents: number; base: string };
  salesByEstablishment: { code: string; total: string }[];
  options: { includeElectronicSales: boolean; electronicSalesInTotals: boolean };
  issues: AtsIssue[];
  /** El XML cumple el at.xsd del DIMM */
  valid: boolean;
  xsdErrors: string[];
}
