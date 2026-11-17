import { z } from 'zod';
import { emailSchema, nonEmpty, passwordSchema } from './common';

export const TAX_REGIMES = {
  GENERAL: 'Régimen general',
  RIMPE_EMPRENDEDOR: 'RIMPE – Emprendedor',
  RIMPE_NEGOCIO_POPULAR: 'RIMPE – Negocio popular',
} as const;
export type TaxRegimeCode = keyof typeof TAX_REGIMES;

const rucSchema = z.string().trim().regex(/^\d{13}$/, 'El RUC debe tener 13 dígitos');

export const updateCompanySchema = z.object({
  legalName: nonEmpty('La razón social', 300),
  tradeName: z.string().trim().max(300).nullable().optional(),
  mainAddress: nonEmpty('La dirección matriz', 300),
  taxRegime: z.enum(['GENERAL', 'RIMPE_EMPRENDEDOR', 'RIMPE_NEGOCIO_POPULAR']),
  keepsAccounting: z.boolean(),
  specialTaxpayerNumber: z.string().trim().max(13).nullable().optional(),
  withholdingAgentNumber: z.string().trim().max(8).nullable().optional(),
  environment: z.union([z.literal(1), z.literal(2)]),
  settings: z
    .object({
      allowNegativeStock: z.boolean(),
      quantityDecimals: z.number().int().min(0).max(4),
    })
    .partial()
    .optional(),
});
export type UpdateCompanyRequest = z.infer<typeof updateCompanySchema>;

export const toggleModuleSchema = z.object({ enabled: z.boolean() });

export interface CompanyInfo {
  id: string;
  ruc: string;
  legalName: string;
  tradeName: string | null;
  mainAddress: string;
  taxRegime: TaxRegimeCode;
  environment: number;
  keepsAccounting: boolean;
  specialTaxpayerNumber: string | null;
  withholdingAgentNumber: string | null;
  businessTemplate: string;
  settings: { allowNegativeStock?: boolean; quantityDecimals?: number };
  modules: { code: string; name: string; description: string; enabled: boolean; allowedByPlan: boolean }[];
}

/** Alta de empresa desde Soporte Vektra. */
export const createTenantSchema = z.object({
  ruc: rucSchema,
  legalName: nonEmpty('La razón social', 300),
  tradeName: z.string().trim().max(300).nullable().optional(),
  mainAddress: nonEmpty('La dirección matriz', 300),
  taxRegime: z.enum(['GENERAL', 'RIMPE_EMPRENDEDOR', 'RIMPE_NEGOCIO_POPULAR']).default('GENERAL'),
  keepsAccounting: z.boolean().default(false),
  businessTemplate: z.string().default('general'),
  admin: z.object({
    email: emailSchema,
    fullName: nonEmpty('El nombre', 200),
    password: passwordSchema,
  }),
});
export type CreateTenantRequest = z.infer<typeof createTenantSchema>;

export interface TenantAdminItem {
  id: string;
  ruc: string;
  legalName: string;
  tradeName: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  businessTemplate: string;
  environment: number;
  createdAt: string;
}

export interface LicenseStatus {
  state: 'valid' | 'suspended' | 'expired' | 'invalid' | 'missing';
  canIssueDocuments: boolean;
  hoursLeft: number | null;
  expiresAt: string | null;
  lastValidatedAt: string | null;
  plan: string | null;
  client: string | null;
  /** perpetual = licencia permanente (pago único) */
  kind: 'perpetual' | 'periodic' | 'offline' | null;
  /** RUC autorizados (licencia permanente) */
  rucs: string[] | null;
  limits: Record<string, unknown> | null;
  message: string;
}

export const activateLicenseSchema = z.object({ code: z.string().trim().min(20, 'Código de activación inválido') });

export interface AuditItem {
  id: string;
  at: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}
