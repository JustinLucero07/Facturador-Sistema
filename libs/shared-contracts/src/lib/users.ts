import { z } from 'zod';
import { emailSchema, nonEmpty, passwordSchema, uuidSchema } from './common';

export const createUserSchema = z.object({
  email: emailSchema,
  fullName: nonEmpty('El nombre', 200),
  /** Obligatoria si el correo no existe aún en la instalación. */
  password: passwordSchema.optional(),
  roleIds: z.array(uuidSchema).min(1, 'Asigne al menos un rol'),
  defaultEstablishmentId: uuidSchema.nullable().optional(),
});
export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: nonEmpty('El nombre', 200).optional(),
  active: z.boolean().optional(),
  roleIds: z.array(uuidSchema).min(1, 'Asigne al menos un rol').optional(),
  defaultEstablishmentId: uuidSchema.nullable().optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({ newPassword: passwordSchema });

export interface UserListItem {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  active: boolean;
  locked: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  roles: { id: string; name: string }[];
  defaultEstablishmentId: string | null;
}

export const roleSchema = z.object({
  name: nonEmpty('El nombre', 80),
  description: z.string().trim().max(300).nullable().optional(),
  permissions: z.array(z.string().min(1)).default([]),
});
export type RoleRequest = z.infer<typeof roleSchema>;

export interface RoleItem {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  systemCode: string | null;
  permissions: string[];
  memberCount: number;
}

export interface PermissionGroup {
  module: string;
  label: string;
  permissions: { code: string; description: string }[];
}
