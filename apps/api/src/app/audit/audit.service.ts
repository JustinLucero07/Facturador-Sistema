import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Tx, uuidv7 } from '@vektra/db';
import { PrismaService } from '../common/prisma.service';
import { tryCurrentContext } from '../common/request-context';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

const SENSITIVE = new Set(['passwordHash', 'totpSecretEnc', 'tokenHash', 'password', 'newPassword', 'currentPassword']);

function sanitize(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return JSON.parse(
    JSON.stringify(value, (k, v) => (SENSITIVE.has(k) ? '***' : typeof v === 'bigint' ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Registra dentro de la transacción de negocio (se guarda solo si la operación se confirma). */
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const ctx = tryCurrentContext();
    await tx.auditLog.create({
      data: {
        id: uuidv7(),
        tenantId: ctx?.tenantId ?? null,
        userId: ctx?.userId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: sanitize(entry.before),
        after: sanitize(entry.after),
        ip: ctx?.ip ?? null,
      },
    });
  }

  /** Eventos fuera de una transacción de negocio (login, bloqueos). Nunca lanza. */
  async recordStandalone(tenantId: string | null, userId: string | null, entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.as({ tenantId, userId }, (tx) =>
        tx.auditLog.create({
          data: {
            id: uuidv7(),
            tenantId,
            userId,
            action: entry.action,
            entity: entry.entity,
            entityId: entry.entityId ?? null,
            before: sanitize(entry.before),
            after: sanitize(entry.after),
            ip: tryCurrentContext()?.ip ?? null,
          },
        }),
      );
    } catch (e) {
      this.logger.error(`No se pudo registrar auditoría: ${(e as Error).message}`);
    }
  }
}
