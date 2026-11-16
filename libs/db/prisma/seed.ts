/**
 * Seed idempotente de la instancia. Se ejecuta con el usuario dueño (DATABASE_OWNER_URL).
 *  - Catálogo de permisos (siempre, se sincroniza con el código).
 *  - Usuario de Soporte Vektra (si no existe).
 *  - En desarrollo: empresa demo "Ferretería Demo" con usuario admin@demo.local.
 */
import { hash } from '@node-rs/argon2';
import { config } from 'dotenv';
import { join } from 'node:path';
import { PERMISSIONS } from '@vektra/shared-domain';
import { createPrismaClient } from '../src/lib/client';
import { provisionTenant } from '../src/lib/provision-tenant';
import { seedSriConfig } from '../src/lib/sri-seed';
import { uuidv7 } from '../src/lib/uuid';

config({ path: join(__dirname, '../../../.env'), quiet: true });

async function main() {
  const url = process.env['DATABASE_OWNER_URL'];
  if (!url) throw new Error('Falta DATABASE_OWNER_URL');
  const prisma = createPrismaClient(url);

  try {
    for (const p of PERMISSIONS) {
      await prisma.permission.upsert({
        where: { code: p.code },
        create: { code: p.code, module: p.module, description: p.description },
        update: { module: p.module, description: p.description },
      });
    }
    console.log(`✔ ${PERMISSIONS.length} permisos sincronizados`);
    await seedSriConfig(prisma);
    console.log('✔ Configuración tributaria SRI (tarifas, catálogos, parámetros)');

    const supportEmail = process.env['SEED_SUPPORT_EMAIL'];
    const supportPassword = process.env['SEED_SUPPORT_PASSWORD'];
    if (supportEmail && supportPassword) {
      const exists = await prisma.user.findUnique({ where: { email: supportEmail } });
      if (!exists) {
        await prisma.user.create({
          data: {
            id: uuidv7(),
            email: supportEmail,
            fullName: 'Soporte Vektra',
            passwordHash: await hash(supportPassword),
            isSupport: true,
          },
        });
        console.log(`✔ Usuario de soporte creado: ${supportEmail}`);
      }
    }

    if (process.env['NODE_ENV'] !== 'production') {
      const demo = await prisma.tenant.findUnique({ where: { ruc: '1790012344001' } });
      if (!demo) {
        await provisionTenant(prisma, {
          ruc: '1790012344001',
          legalName: 'FERRETERIA DEMO S.A.',
          tradeName: 'Ferretería Demo',
          mainAddress: 'Av. Huayna Cápac y Calle Larga, Cuenca',
          businessTemplate: 'hardware',
          admin: { email: 'admin@demo.local', fullName: 'Administrador Demo', passwordHash: await hash('Demo.2026!') },
        });
        console.log('✔ Empresa demo creada (admin@demo.local / Demo.2026!)');
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
