import {
  findBusinessTemplate,
  MODULES,
  resolveRolePermissions,
  SYSTEM_ROLES,
} from '@vektra/shared-domain';
import { PrismaClient, TaxRegime } from '../generated/prisma/client';
import { ensureCatalogDefaults } from './catalog-defaults';
import { withContext } from './client';
import { uuidv7 } from './uuid';

export interface ProvisionTenantInput {
  ruc: string;
  legalName: string;
  tradeName?: string | null;
  mainAddress: string;
  taxRegime?: TaxRegime;
  keepsAccounting?: boolean;
  businessTemplate?: string;
  establishment?: { name: string; address: string };
  /** Usuario administrador: existente (userId) o nuevo. */
  admin: { userId: string } | { email: string; fullName: string; passwordHash: string };
}

export interface ProvisionTenantResult {
  tenantId: string;
  adminUserId: string;
  establishmentId: string;
  emissionPointId: string;
  warehouseId: string;
}

/**
 * Crea una empresa completa lista para usar: establecimiento 001, punto de emisión 001 (web),
 * bodega principal, roles del sistema, módulos de la plantilla y el usuario administrador.
 * Todo en una sola transacción.
 */
export async function provisionTenant(prisma: PrismaClient, input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
  const tenantId = uuidv7();
  const template = findBusinessTemplate(input.businessTemplate ?? 'general');

  return withContext(prisma, { tenantId }, async (tx) => {
    await tx.tenant.create({
      data: {
        id: tenantId,
        ruc: input.ruc,
        legalName: input.legalName,
        tradeName: input.tradeName ?? null,
        mainAddress: input.mainAddress,
        taxRegime: input.taxRegime ?? 'GENERAL',
        keepsAccounting: input.keepsAccounting ?? false,
        businessTemplate: template.code,
        settings: template.settings,
      },
    });

    await tx.tenantModule.createMany({
      data: (Object.keys(MODULES) as (keyof typeof MODULES)[]).map((code) => ({
        tenantId,
        moduleCode: code,
        enabled: template.modules.includes(code),
      })),
    });

    const establishmentId = uuidv7();
    await tx.establishment.create({
      data: {
        id: establishmentId,
        tenantId,
        code: '001',
        name: input.establishment?.name ?? 'Matriz',
        address: input.establishment?.address ?? input.mainAddress,
      },
    });

    const emissionPointId = uuidv7();
    await tx.emissionPoint.create({
      data: { id: emissionPointId, tenantId, establishmentId, code: '001', name: 'Caja web 1', kind: 'WEB' },
    });

    const warehouseId = uuidv7();
    await tx.warehouse.create({
      data: { id: warehouseId, tenantId, establishmentId, name: 'Bodega principal', isDefault: true },
    });

    await ensureCatalogDefaults(tx, tenantId);

    let adminRoleId = '';
    for (const def of SYSTEM_ROLES) {
      const roleId = uuidv7();
      if (def.code === 'ADMIN') adminRoleId = roleId;
      await tx.role.create({
        data: { id: roleId, tenantId, name: def.name, description: def.description, isSystem: true, systemCode: def.code },
      });
      await tx.rolePermission.createMany({
        data: resolveRolePermissions(def).map((permissionCode) => ({ tenantId, roleId, permissionCode })),
      });
    }

    let adminUserId: string;
    if ('userId' in input.admin) {
      adminUserId = input.admin.userId;
    } else {
      adminUserId = uuidv7();
      await tx.user.create({
        data: {
          id: adminUserId,
          email: input.admin.email.toLowerCase().trim(),
          fullName: input.admin.fullName,
          passwordHash: input.admin.passwordHash,
        },
      });
    }

    const membershipId = uuidv7();
    await tx.membership.create({
      data: { id: membershipId, tenantId, userId: adminUserId, defaultEstablishmentId: establishmentId },
    });
    await tx.membershipRole.create({ data: { tenantId, membershipId, roleId: adminRoleId } });

    return { tenantId, adminUserId, establishmentId, emissionPointId, warehouseId };
  });
}
