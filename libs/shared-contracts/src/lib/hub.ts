import { z } from 'zod';
import { emailSchema, nonEmpty } from './common';

const limitsSchema = z.object({
  maxTenants: z.number().int().min(0),
  maxEstablishments: z.number().int().min(0),
  maxEmissionPoints: z.number().int().min(0),
  maxUsers: z.number().int().min(0),
  maxDocumentsPerMonth: z.number().int().min(0),
  modules: z.array(z.string()),
});

export const hubLoginSchema = z.object({ email: emailSchema, password: z.string().min(1, 'Ingrese su contraseña') });

export const planSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, 'Código: minúsculas, números y guiones'),
  name: nonEmpty('El nombre', 80),
  priceMonthly: z.number().min(0),
  priceYearly: z.number().min(0).nullable().optional(),
  limits: limitsSchema,
  active: z.boolean().default(true),
});
export type PlanRequest = z.infer<typeof planSchema>;

export const clientSchema = z.object({
  ruc: z.string().trim().regex(/^\d{13}$/, 'El RUC debe tener 13 dígitos'),
  legalName: nonEmpty('La razón social', 300),
  tradeName: z.string().trim().max(300).nullable().optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  email: emailSchema.nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type ClientRequest = z.infer<typeof clientSchema>;

export const createInstallationSchema = z.object({
  clientId: z.uuid(),
  planId: z.uuid(),
  name: nonEmpty('El nombre', 120),
  baseUrl: z.string().trim().max(300).nullable().optional(),
  graceHours: z.number().int().min(1).max(720).default(48),
});
export type CreateInstallationRequest = z.infer<typeof createInstallationSchema>;

export const updateInstallationSchema = z.object({
  planId: z.uuid().optional(),
  name: nonEmpty('El nombre', 120).optional(),
  baseUrl: z.string().trim().max(300).nullable().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED']).optional(),
  graceHours: z.number().int().min(1).max(720).optional(),
  limitOverrides: limitsSchema.partial().nullable().optional(),
});
export type UpdateInstallationRequest = z.infer<typeof updateInstallationSchema>;

export const offlineCodeSchema = z.object({ days: z.number().int().min(1).max(30) });

/** Lo que envía cada instancia al validar su licencia. */
export const licenseValidateSchema = z.object({
  installationId: z.string().min(1),
  secret: z.string().min(1),
  appVersion: z.string().max(40).optional(),
  report: z
    .object({
      tenants: z.number().int(),
      establishments: z.number().int(),
      emissionPoints: z.number().int(),
      users: z.number().int(),
    })
    .passthrough()
    .optional(),
});
export type LicenseValidateRequest = z.infer<typeof licenseValidateSchema>;

export interface PlanItem extends PlanRequest {
  id: string;
  installationCount: number;
}

export interface ClientItem extends ClientRequest {
  id: string;
  installationCount: number;
  createdAt: string;
}

export interface InstallationItem {
  id: string;
  name: string;
  publicId: string;
  clientId: string;
  clientName: string;
  planId: string;
  planName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  baseUrl: string | null;
  graceHours: number;
  lastSeenAt: string | null;
  appVersion: string | null;
  lastReport: Record<string, unknown> | null;
  createdAt: string;
}

/** Se muestra UNA sola vez al crear la instalación o rotar el secreto. */
export interface InstallationCredentials {
  installationId: string;
  installationSecret: string;
  envSnippet: string;
}
