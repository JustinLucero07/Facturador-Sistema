/**
 * Seed del Hub: planes por defecto (editables desde el panel) y administrador inicial.
 */
import { hash } from '@node-rs/argon2';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createHubPrismaClient } from '../src';

config({ path: join(__dirname, '../../../.env'), quiet: true });

const PLANS = [
  {
    code: 'emprende',
    name: 'Emprende',
    priceMonthly: '15.00',
    limits: { maxTenants: 1, maxEstablishments: 1, maxEmissionPoints: 1, maxUsers: 2, maxDocumentsPerMonth: 300, modules: ['receivables'] },
  },
  {
    code: 'negocio',
    name: 'Negocio',
    priceMonthly: '35.00',
    limits: {
      maxTenants: 1,
      maxEstablishments: 1,
      maxEmissionPoints: 3,
      maxUsers: 5,
      maxDocumentsPerMonth: 0,
      modules: ['variants', 'lots', 'serials', 'fractional', 'receivables'],
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceMonthly: '69.00',
    limits: { maxTenants: 3, maxEstablishments: 0, maxEmissionPoints: 0, maxUsers: 0, maxDocumentsPerMonth: 0, modules: ['*'] },
  },
];

async function main() {
  const url = process.env['HUB_DATABASE_OWNER_URL'];
  if (!url) throw new Error('Falta HUB_DATABASE_OWNER_URL');
  const prisma = createHubPrismaClient(url);
  try {
    for (const p of PLANS) {
      const exists = await prisma.plan.findUnique({ where: { code: p.code } });
      if (!exists) await prisma.plan.create({ data: { id: randomUUID(), ...p } });
    }
    console.log(`✔ ${PLANS.length} planes verificados`);
    const email = process.env['HUB_SEED_ADMIN_EMAIL'];
    const password = process.env['HUB_SEED_ADMIN_PASSWORD'];
    if (email && password && !(await prisma.hubUser.findUnique({ where: { email } }))) {
      await prisma.hubUser.create({ data: { id: randomUUID(), email, fullName: 'Administrador Vektra', passwordHash: await hash(password) } });
      console.log(`✔ Administrador del Hub creado: ${email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
