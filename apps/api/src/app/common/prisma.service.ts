import { Injectable, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { createPrismaClient, DbContext, PrismaClient, Tx, withContext } from '@vektra/db';
import { getEnv } from '../config/env';
import { currentContext } from './request-context';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  /** Cliente con el rol `vektra_app`: RLS aplica siempre. Úselo directo SOLO para tablas globales. */
  readonly client: PrismaClient = createPrismaClient(getEnv().DATABASE_URL);

  /** Transacción con el contexto de la empresa/usuario de la solicitud actual. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = currentContext();
    if (!ctx.tenantId) throw new UnauthorizedException('No hay una empresa seleccionada');
    return withContext(this.client, { tenantId: ctx.tenantId, userId: ctx.userId }, fn);
  }

  /** Transacción con un contexto explícito (login, tareas del sistema). */
  as<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withContext(this.client, ctx, fn);
  }

  async instanceUsage(): Promise<{ tenants: number; establishments: number; emissionPoints: number; users: number }> {
    const [row] = await this.client.$queryRaw<
      { tenants: bigint; establishments: bigint; emission_points: bigint; users: bigint }[]
    >`SELECT * FROM instance_usage()`;
    return {
      tenants: Number(row.tenants),
      establishments: Number(row.establishments),
      emissionPoints: Number(row.emission_points),
      users: Number(row.users),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
