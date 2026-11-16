import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '@vektra/shared-domain';

export const IS_PUBLIC = 'vk:isPublic';
export const REQUIRED_PERMISSIONS = 'vk:permissions';
export const SUPPORT_ONLY = 'vk:supportOnly';
export const ALLOW_WITHOUT_LICENSE = 'vk:allowWithoutLicense';

/** Ruta sin autenticación. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Requiere TODOS los permisos indicados. */
export const RequirePermissions = (...codes: PermissionCode[]) => SetMetadata(REQUIRED_PERMISSIONS, codes);

/** Solo técnicos de Soporte Vektra. */
export const SupportOnly = () => SetMetadata(SUPPORT_ONLY, true);

/** Escritura permitida aunque la licencia esté vencida (ej. activar licencia, cambiar contraseña). */
export const AllowWithoutLicense = () => SetMetadata(ALLOW_WITHOUT_LICENSE, true);
