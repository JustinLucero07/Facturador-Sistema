import { Controller, Get, Query } from '@nestjs/common';
import type { AuditItem, Paginated } from '@vektra/shared-contracts';
import { pageQuerySchema } from '@vektra/shared-contracts';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { ZodPipe } from '@vektra/nest-common';

const auditQuerySchema = pageQuerySchema.extend({
  entity: z.string().optional(),
  action: z.string().optional(),
  userId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('audit.read')
  async list(@Query(new ZodPipe(auditQuerySchema)) q: z.infer<typeof auditQuerySchema>): Promise<Paginated<AuditItem>> {
    const where = {
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.from || q.to ? { at: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [total, rows] = await this.prisma.tx((tx) =>
      Promise.all([
        tx.auditLog.count({ where }),
        tx.auditLog.findMany({ where, orderBy: { at: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      ]),
    );
    const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
    const users = await this.prisma.client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        userId: r.userId,
        userName: r.userId ? (names.get(r.userId) ?? null) : null,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        ip: r.ip,
      })),
    };
  }
}
