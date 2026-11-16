import { z } from 'zod';
import { emailSchema, passwordSchema, uuidSchema } from './common';

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Ingrese su contraseña'),
});
export type LoginRequest = z.infer<typeof loginSchema>;

export const twoFactorLoginSchema = z.object({
  challenge: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'El código debe tener 6 dígitos'),
});
export type TwoFactorLoginRequest = z.infer<typeof twoFactorLoginSchema>;

export const selectTenantSchema = z.object({
  challenge: z.string().min(1),
  tenantId: uuidSchema,
});
export type SelectTenantRequest = z.infer<typeof selectTenantSchema>;

export const switchTenantSchema = z.object({ tenantId: uuidSchema });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Ingrese su contraseña actual'),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

export const enableTwoFactorSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'El código debe tener 6 dígitos'),
});
export const disableTwoFactorSchema = z.object({
  password: z.string().min(1, 'Ingrese su contraseña'),
  code: z.string().regex(/^\d{6}$/, 'El código debe tener 6 dígitos'),
});

export interface TenantOption {
  id: string;
  ruc: string;
  name: string;
}

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  isSupport: boolean;
  totpEnabled: boolean;
}

export interface SessionTenant {
  id: string;
  ruc: string;
  legalName: string;
  tradeName: string | null;
  environment: number;
  modules: string[];
}

/** Respuesta de /auth/me y de un login completo. */
export interface SessionInfo {
  user: SessionUser;
  tenant: SessionTenant;
  permissions: string[];
  /** Otras empresas a las que el usuario puede cambiar. */
  tenants: TenantOption[];
}

export type LoginResponse =
  | { step: 'done'; accessToken: string; expiresIn: number; session: SessionInfo }
  | { step: '2fa'; challenge: string }
  | { step: 'tenant'; challenge: string; tenants: TenantOption[] };

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

export interface TwoFactorSetupResponse {
  otpauthUrl: string;
  qrDataUrl: string;
  secret: string;
}
