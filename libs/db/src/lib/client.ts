import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

export type Tx = Prisma.TransactionClient;

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export interface DbContext {
  tenantId?: string | null;
  userId?: string | null;
}

/**
 * Ejecuta `fn` dentro de una transacción con el contexto RLS fijado (`app.tenant_id`, `app.user_id`).
 * TODO acceso a tablas con tenant debe pasar por aquí: sin contexto, RLS no devuelve filas.
 */
export async function withContext<T>(
  prisma: PrismaClient,
  ctx: DbContext,
  fn: (tx: Tx) => Promise<T>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true), set_config('app.user_id', ${ctx.userId ?? ''}, true)`;
    return fn(tx);
  }, options);
}
